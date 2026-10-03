package backups

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCleanName(t *testing.T) {
	for _, ok := range []string{"a", "sched/file.sql.gz", "a/b/c.txt"} {
		if _, err := CleanName(ok); err != nil {
			t.Errorf("%q rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "..", "../x", "/etc/passwd", "a/../../b", "a\\b", "a\x00b", "."} {
		if _, err := CleanName(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestLocalStore(t *testing.T) {
	dir := t.TempDir()
	st := &LocalStore{Dir: dir}
	ctx := context.Background()
	if err := st.Put(ctx, "sched1/file.bin", strings.NewReader("hello"), 5); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dir, "sched1", "file.bin"))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("file mode: %v %v", fi, err)
	}
	if di, _ := os.Stat(filepath.Join(dir, "sched1")); di.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %v", di.Mode())
	}
	rc, err := st.Open(ctx, "sched1/file.bin")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(rc)
	rc.Close()
	if string(b) != "hello" {
		t.Fatalf("read %q", b)
	}
	// A short write is an error and leaves no partial file.
	if err := st.Put(ctx, "sched1/short.bin", strings.NewReader("abc"), 10); err == nil {
		t.Fatal("short write accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "sched1", "short.bin.part")); err == nil {
		t.Fatal("partial file left behind")
	}
	if err := st.Put(ctx, "../escape", strings.NewReader("x"), 1); err == nil {
		t.Fatal("path traversal accepted")
	}
	if err := st.Delete(ctx, "sched1/file.bin"); err != nil {
		t.Fatal(err)
	}
	if err := st.Delete(ctx, "sched1/file.bin"); err != nil {
		t.Fatalf("deleting a missing file must not fail: %v", err)
	}
	if err := st.Test(ctx); err != nil {
		t.Fatalf("Test: %v", err)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, ".pulsenode-test", "*")); len(left) != 0 {
		t.Fatalf("test object not cleaned up: %v", left)
	}
}

// fakeS3 is just enough of S3 (path style PUT/GET/HEAD/DELETE) for minio-go.
type fakeS3 struct {
	mu      sync.Mutex
	objects map[string][]byte
	puts    int
	srv     *httptest.Server
}

func newFakeS3(t *testing.T) *fakeS3 {
	t.Helper()
	f := &fakeS3{objects: map[string][]byte{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeS3) host() string { return strings.TrimPrefix(f.srv.URL, "http://") }

// decodeChunked undoes aws-chunked framing ("<hex>;chunk-signature=…\r\n<data>\r\n…").
func decodeChunked(r io.Reader) ([]byte, error) {
	br := bufio.NewReader(r)
	var out bytes.Buffer
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return nil, err
		}
		sz := strings.TrimSpace(line)
		if i := strings.Index(sz, ";"); i >= 0 {
			sz = sz[:i]
		}
		n, err := strconv.ParseInt(sz, 16, 64)
		if err != nil {
			return nil, fmt.Errorf("bad chunk header %q", line)
		}
		if n == 0 {
			return out.Bytes(), nil
		}
		if _, err := io.CopyN(&out, br, n); err != nil {
			return nil, err
		}
		_, _ = br.Discard(2)
	}
}

func (f *fakeS3) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") == "" {
		http.Error(w, "<Error><Code>AccessDenied</Code><Message>no auth</Message></Error>", http.StatusForbidden)
		return
	}
	key := r.URL.Path
	switch r.Method {
	case http.MethodPut:
		var body []byte
		var err error
		if strings.HasPrefix(r.Header.Get("X-Amz-Content-Sha256"), "STREAMING-") {
			body, err = decodeChunked(r.Body)
		} else {
			body, err = io.ReadAll(r.Body)
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f.objects[key] = body
		f.puts++
		w.Header().Set("ETag", `"fake"`)
		w.WriteHeader(http.StatusOK)
	case http.MethodGet, http.MethodHead:
		b, ok := f.objects[key]
		if !ok {
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusNotFound)
			if r.Method == http.MethodGet {
				fmt.Fprint(w, `<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`)
			}
			return
		}
		start := 0
		status := http.StatusOK
		if rg := r.Header.Get("Range"); strings.HasPrefix(rg, "bytes=") {
			if a, _, _ := strings.Cut(strings.TrimPrefix(rg, "bytes="), "-"); a != "" {
				start, _ = strconv.Atoi(a)
				status = http.StatusPartialContent
			}
		}
		if start > len(b) {
			start = len(b)
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(b)-start))
		w.Header().Set("ETag", `"fake"`)
		w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
		w.Header().Set("Content-Type", "application/octet-stream")
		if status == http.StatusPartialContent {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, len(b)-1, len(b)))
		}
		w.WriteHeader(status)
		if r.Method == http.MethodGet {
			_, _ = w.Write(b[start:])
		}
	case http.MethodDelete:
		delete(f.objects, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "unsupported", http.StatusNotImplemented)
	}
}

func TestS3StoreAgainstFakeServer(t *testing.T) {
	t.Setenv("PULSENODE_BACKUPS_ALLOW_PRIVATE", "true") // the fake listens on 127.0.0.1
	f := newFakeS3(t)
	st, err := NewS3(S3Config{Endpoint: f.host(), Bucket: "backups", Prefix: "pn/prod", AccessKey: "AKIAEXAMPLE", SecretKey: "secret", PathStyle: true})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	payload := bytes.Repeat([]byte("0123456789"), 1000)
	if err := st.Put(ctx, "sched/x.bin", bytes.NewReader(payload), int64(len(payload))); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	got, ok := f.objects["/backups/pn/prod/sched/x.bin"]
	f.mu.Unlock()
	if !ok || !bytes.Equal(got, payload) {
		t.Fatalf("object not stored under bucket/prefix/name (have %d keys)", len(f.objects))
	}
	rc, err := st.Open(ctx, "sched/x.bin")
	if err != nil {
		t.Fatal(err)
	}
	back, _ := io.ReadAll(rc)
	rc.Close()
	if !bytes.Equal(back, payload) {
		t.Fatalf("read back %d bytes", len(back))
	}
	if _, err := st.Open(ctx, "sched/missing.bin"); err == nil || !strings.Contains(err.Error(), "NoSuchKey") {
		t.Fatalf("missing object: %v", err)
	}
	if err := st.Delete(ctx, "sched/x.bin"); err != nil {
		t.Fatal(err)
	}
	if err := st.Test(ctx); err != nil {
		t.Fatalf("Test: %v", err)
	}
	f.mu.Lock()
	left := len(f.objects)
	f.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d objects left behind", left)
	}
	if err := st.Put(ctx, "../escape", strings.NewReader("x"), 1); err == nil {
		t.Fatal("path traversal accepted")
	}
}

func TestS3EndpointGuard(t *testing.T) {
	cfg := func(ep string) S3Config {
		return S3Config{Endpoint: ep, Bucket: "bk", AccessKey: "a", SecretKey: "b", UseSSL: true}
	}
	for _, ep := range []string{"127.0.0.1:9000", "localhost:9000", "10.0.0.5:9000", "192.168.1.9", "169.254.169.254", "[::1]:9000", "minio.internal", "http://127.0.0.1:9000"} {
		if _, err := NewS3(cfg(ep)); err == nil {
			t.Errorf("private endpoint %q accepted", ep)
		}
	}
	if _, err := NewS3(cfg("s3.eu-central-1.amazonaws.com")); err != nil {
		t.Errorf("public endpoint rejected: %v", err)
	}
	t.Setenv("PULSENODE_BACKUPS_ALLOW_PRIVATE", "true")
	if _, err := NewS3(cfg("10.0.0.5:9000")); err != nil {
		t.Errorf("private endpoint rejected despite override: %v", err)
	}
}

// The dial-time guard blocks a hostname that resolves to a private address, which
// the up-front literal check cannot see (DNS rebinding).
func TestS3DialGuardBlocksLoopbackHostname(t *testing.T) {
	f := newFakeS3(t)
	// "localhost" is caught up front; use the numeric host via a name the literal
	// check lets through: nip-style names need DNS, so exercise guardControl directly.
	if err := guardControl("tcp", f.host(), nil); err == nil {
		t.Fatal("loopback dial allowed without override")
	}
	t.Setenv("PULSENODE_BACKUPS_ALLOW_PRIVATE", "true")
	if err := guardControl("tcp", f.host(), nil); err != nil {
		t.Fatalf("override ignored: %v", err)
	}
	if err := guardControl("tcp", "8.8.8.8:443", nil); err != nil {
		t.Fatalf("public address blocked: %v", err)
	}
}

func TestNormalizeEndpoint(t *testing.T) {
	h, ssl, err := NormalizeEndpoint(" https://s3.example.com ")
	if err != nil || h != "s3.example.com" || ssl == nil || !*ssl {
		t.Fatalf("%q %v %v", h, ssl, err)
	}
	h, ssl, err = NormalizeEndpoint("http://minio:9000/")
	if err != nil || h != "minio:9000" || ssl == nil || *ssl {
		t.Fatalf("%q %v %v", h, ssl, err)
	}
	if h, ssl, err = NormalizeEndpoint("s3.example.com"); err != nil || h != "s3.example.com" || ssl != nil {
		t.Fatalf("%q %v %v", h, ssl, err)
	}
	for _, bad := range []string{"", "https://u:p@s3.example.com", "https://s3.example.com/bucket", "ftp://x", "a b", "host/path", "user@host"} {
		if _, _, err := NormalizeEndpoint(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
