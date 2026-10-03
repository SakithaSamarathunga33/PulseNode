package backups

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Store is a place backup files are kept. Object names are relative, slash
// separated and validated (no "..", no absolute paths).
type Store interface {
	Put(ctx context.Context, name string, r io.Reader, size int64) error
	Open(ctx context.Context, name string) (io.ReadCloser, error)
	Delete(ctx context.Context, name string) error
	// Test proves the destination works: it writes, reads back and deletes a tiny object.
	Test(ctx context.Context) error
}

// CleanName validates and normalises an object name.
func CleanName(name string) (string, error) {
	if name == "" || strings.ContainsAny(name, "\x00\\") {
		return "", fmt.Errorf("invalid object name %q", name)
	}
	c := path.Clean(name)
	if c == "." || c == ".." || strings.HasPrefix(c, "../") || strings.HasPrefix(c, "/") {
		return "", fmt.Errorf("invalid object name %q", name)
	}
	return c, nil
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func testRoundTrip(ctx context.Context, s Store) error {
	name := ".pulsenode-test/" + randHex(8) + ".txt"
	payload := "pulsenode backup destination test " + randHex(8)
	if err := s.Put(ctx, name, strings.NewReader(payload), int64(len(payload))); err != nil {
		return fmt.Errorf("write test object: %w", err)
	}
	rc, err := s.Open(ctx, name)
	if err != nil {
		_ = s.Delete(ctx, name)
		return fmt.Errorf("read test object back: %w", err)
	}
	got, err := io.ReadAll(io.LimitReader(rc, 4096))
	rc.Close()
	if err != nil {
		_ = s.Delete(ctx, name)
		return fmt.Errorf("read test object back: %w", err)
	}
	if string(got) != payload {
		_ = s.Delete(ctx, name)
		return errors.New("test object came back different from what was written")
	}
	if err := s.Delete(ctx, name); err != nil {
		return fmt.Errorf("delete test object: %w", err)
	}
	return nil
}

// LocalStore keeps files under a directory (mode 0700, files 0600).
type LocalStore struct{ Dir string }

func (l *LocalStore) path(name string) (string, error) {
	c, err := CleanName(name)
	if err != nil {
		return "", err
	}
	return filepath.Join(l.Dir, filepath.FromSlash(c)), nil
}

func (l *LocalStore) Put(ctx context.Context, name string, r io.Reader, size int64) error {
	p, err := l.path(name)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	tmp, err := os.OpenFile(p+".part", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	n, err := io.Copy(tmp, &ctxReader{ctx: ctx, r: r})
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil && size >= 0 && n != size {
		err = fmt.Errorf("short write: %d of %d bytes", n, size)
	}
	if err != nil {
		_ = os.Remove(p + ".part")
		return err
	}
	if err := os.Rename(p+".part", p); err != nil {
		_ = os.Remove(p + ".part")
		return err
	}
	return nil
}

func (l *LocalStore) Open(ctx context.Context, name string) (io.ReadCloser, error) {
	p, err := l.path(name)
	if err != nil {
		return nil, err
	}
	return os.Open(p)
}

func (l *LocalStore) Delete(ctx context.Context, name string) error {
	p, err := l.path(name)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	// Tidy up the (now possibly empty) schedule folder; Remove fails harmlessly if not empty.
	_ = os.Remove(filepath.Dir(p))
	return nil
}

func (l *LocalStore) Test(ctx context.Context) error {
	if l.Dir == "" || !filepath.IsAbs(l.Dir) {
		return errors.New("directory must be an absolute path")
	}
	return testRoundTrip(ctx, l)
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c *ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}
