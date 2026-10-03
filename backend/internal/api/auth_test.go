package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pulsenode/backend/internal/auth"
	"pulsenode/backend/internal/db"
)

func newAuthTestServer(t *testing.T) *Server {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	t.Setenv("PULSENODE_SETUP_TOKEN", "test-setup-token-0123456789")
	s := &Server{db: d, auth: auth.NewMiddleware(auth.Config{Secret: strings.Repeat("k", 32)})}
	s.initSetupToken(t.TempDir())
	return s
}

func protectedOK(s *Server) http.Handler {
	return s.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
}

func postSetup(s *Server, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	s.authSetup(rec, httptest.NewRequest(http.MethodPost, "/api/auth/setup", strings.NewReader(body)))
	return rec
}

func TestRequireAuthFailsClosedWithoutAdmin(t *testing.T) {
	s := newAuthTestServer(t)
	rec := httptest.NewRecorder()
	protectedOK(s).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/docker/exec/x", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("fresh install must reject API calls, got %d", rec.Code)
	}
}

func TestRequireAuthInsecureOptOut(t *testing.T) {
	s := newAuthTestServer(t)
	s.insecureNoAuth = true
	rec := httptest.NewRecorder()
	protectedOK(s).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/host", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("PULSENODE_INSECURE_NO_AUTH should allow access, got %d", rec.Code)
	}
}

func TestSetupRequiresToken(t *testing.T) {
	s := newAuthTestServer(t)
	for _, body := range []string{
		`{"username":"admin","password":"password123"}`,
		`{"username":"admin","password":"password123","setup_token":"wrong"}`,
	} {
		if rec := postSetup(s, body); rec.Code != http.StatusUnauthorized {
			t.Fatalf("setup without valid token: got %d for %s", rec.Code, body)
		}
	}
	if u, _ := s.db.GetUser(); u != nil {
		t.Fatal("admin must not be created without the setup token")
	}

	if rec := postSetup(s, `{"username":"admin","password":"password123","setup_token":"test-setup-token-0123456789"}`); rec.Code != http.StatusOK {
		t.Fatalf("setup with token: got %d %s", rec.Code, rec.Body.String())
	}
	// The token is single-use: a second "first admin" call must not succeed.
	if rec := postSetup(s, `{"username":"evil","password":"password123","setup_token":"test-setup-token-0123456789"}`); rec.Code == http.StatusOK {
		t.Fatal("setup token reused to overwrite the admin")
	}
	if u, _ := s.db.GetUser(); u == nil || u.Username != "admin" {
		t.Fatalf("unexpected admin: %+v", u)
	}

	// After setup, protected routes require a session.
	rec := httptest.NewRecorder()
	protectedOK(s).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/host", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no session after setup: got %d", rec.Code)
	}
}

func TestPasswordChangeRevokesSessions(t *testing.T) {
	s := newAuthTestServer(t)
	if rec := postSetup(s, `{"username":"admin","password":"password123","setup_token":"test-setup-token-0123456789"}`); rec.Code != http.StatusOK {
		t.Fatalf("setup: %d", rec.Code)
	}
	u, _ := s.db.GetUser()
	rec := httptest.NewRecorder()
	s.issueSession(rec, httptest.NewRequest(http.MethodPost, "/", nil), u, time.Now().Unix())
	old := rec.Result().Cookies()[0].Value
	if _, ok := s.validSession(old, u); !ok {
		t.Fatal("fresh session should be valid")
	}

	if rec := postSetup(s, `{"username":"admin","password":"newpassword1","current_password":"password123"}`); rec.Code != http.StatusOK {
		t.Fatalf("password change: %d", rec.Code)
	}
	u, _ = s.db.GetUser()
	if _, ok := s.validSession(old, u); ok {
		t.Fatal("session issued before the password change must be rejected")
	}
}

func TestSessionAbsoluteMaxAge(t *testing.T) {
	s := newAuthTestServer(t)
	u := &db.User{Username: "admin", PasswordHash: "hash"}
	rec := httptest.NewRecorder()
	s.issueSession(rec, httptest.NewRequest(http.MethodPost, "/", nil), u, time.Now().Unix()-sessionMaxAge-1)
	if _, ok := s.validSession(rec.Result().Cookies()[0].Value, u); ok {
		t.Fatal("session older than sessionMaxAge must be rejected even if refreshed")
	}
}

func TestSameOriginWrites(t *testing.T) {
	s := &Server{origins: []string{"https://panel.example.com"}}
	h := s.sameOriginWrites(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	cases := []struct {
		method, origin, referer string
		want                    int
	}{
		{http.MethodPost, "https://panel.example.com", "", http.StatusOK},
		{http.MethodPost, "http://panel.example.com", "", http.StatusOK}, // same host behind a TLS proxy
		{http.MethodPost, "https://app.example.com", "", http.StatusForbidden},
		{http.MethodPost, "", "https://evil.test/page", http.StatusForbidden},
		{http.MethodPost, "null", "", http.StatusForbidden},
		{http.MethodPost, "", "", http.StatusOK}, // curl / scripts
		{http.MethodGet, "https://evil.test", "", http.StatusOK},
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, "http://panel.example.com/api/docker/exec/x", nil)
		if c.origin != "" {
			req.Header.Set("Origin", c.origin)
		}
		if c.referer != "" {
			req.Header.Set("Referer", c.referer)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("%s origin=%q referer=%q: got %d want %d", c.method, c.origin, c.referer, rec.Code, c.want)
		}
	}
}

func TestValidHostname(t *testing.T) {
	for _, d := range []string{"app.example.com", "a-b.example.co.uk", "1.2.3.4"} {
		if !validHostname(d) {
			t.Errorf("validHostname(%q) = false", d)
		}
	}
	for _, d := range []string{"", "example", "x.com`) || Host(`panel.com", "x.com\" ", "a b.com", "-a.com", "a..com", "HostRegexp(`.+`)"} {
		if validHostname(d) {
			t.Errorf("validHostname(%q) = true", d)
		}
	}
}

func TestValidSignatureRejectsEmptySecret(t *testing.T) {
	body := []byte(`{"ref":"refs/heads/main"}`)
	mac := hmac.New(sha256.New, []byte(""))
	mac.Write(body)
	if validSignature("", "sha256="+hex.EncodeToString(mac.Sum(nil)), body) {
		t.Fatal("a signature made with an empty key must not validate")
	}
}
