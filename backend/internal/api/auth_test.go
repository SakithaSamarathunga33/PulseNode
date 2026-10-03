package api

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

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
