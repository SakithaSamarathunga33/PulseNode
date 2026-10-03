package api

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pulsenode/backend/internal/auth"
	"pulsenode/backend/internal/db"
)

func logoutWith(s *Server, token string) {
	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token})
	s.authLogout(httptest.NewRecorder(), req)
}

func issueToken(s *Server, u *db.User, authTime int64) string {
	rec := httptest.NewRecorder()
	s.issueSession(rec, httptest.NewRequest(http.MethodPost, "/", nil), u, authTime)
	return rec.Result().Cookies()[0].Value
}

// Two logins in the same second used to share an auth_time, so logging one out
// killed the other.
func TestLogoutOnlyEndsThatSessionEvenInTheSameSecond(t *testing.T) {
	s := newAuthTestServer(t)
	postSetup(s, `{"username":"admin","password":"password123","setup_token":"test-setup-token-0123456789"}`)
	u, _ := s.db.GetUser()
	now := time.Now().Unix()
	a, b := issueToken(s, u, now), issueToken(s, u, now)
	logoutWith(s, a)
	if _, ok := s.validSession(a, u); ok {
		t.Fatal("logged-out session must be rejected")
	}
	if _, ok := s.validSession(b, u); !ok {
		t.Fatal("another login in the same second must stay valid")
	}
}

// A self-update restarts go-api. Revocations used to live in memory.
func TestLogoutSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.db")
	d1, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PULSENODE_SETUP_TOKEN", "test-setup-token-0123456789")
	mk := func(d *db.DB) *Server {
		return &Server{db: d, auth: auth.NewMiddleware(auth.Config{Secret: strings.Repeat("k", 32)})}
	}
	s1 := mk(d1)
	s1.initSetupToken(t.TempDir())
	postSetup(s1, `{"username":"admin","password":"password123","setup_token":"test-setup-token-0123456789"}`)
	u, _ := d1.GetUser()
	tok := issueToken(s1, u, time.Now().Unix())
	logoutWith(s1, tok)
	d1.Close()

	d2, err := db.Open(path) // "restart"
	if err != nil {
		t.Fatal(err)
	}
	defer d2.Close()
	u2, _ := d2.GetUser()
	if _, ok := mk(d2).validSession(tok, u2); ok {
		t.Fatal("a logged-out token must stay revoked after a restart")
	}
}

// Tokens issued before the jti claim existed fall back to their login time.
func TestLegacyTokenWithoutJTIStillRevocable(t *testing.T) {
	s := newAuthTestServer(t)
	postSetup(s, `{"username":"admin","password":"password123","setup_token":"test-setup-token-0123456789"}`)
	u, _ := s.db.GetUser()
	legacy := s.auth.MakeJWT(u.Username, sessionTTL, map[string]any{"ver": sessionVersion(u), "auth_time": time.Now().Unix() - 100})
	if _, ok := s.validSession(legacy, u); !ok {
		t.Fatal("legacy token should be valid before logout")
	}
	logoutWith(s, legacy)
	if _, ok := s.validSession(legacy, u); ok {
		t.Fatal("legacy token must be revoked by logout")
	}
}

func TestRefreshKeepsSessionID(t *testing.T) {
	s := newAuthTestServer(t)
	postSetup(s, `{"username":"admin","password":"password123","setup_token":"test-setup-token-0123456789"}`)
	u, _ := s.db.GetUser()
	tok := issueToken(s, u, time.Now().Unix())
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/host", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: tok})
	protectedOK(s).ServeHTTP(rr, req)
	cs := rr.Result().Cookies()
	if len(cs) == 0 {
		t.Fatal("expected a refreshed cookie")
	}
	before, _ := s.parseSession(tok, u)
	after, ok := s.parseSession(cs[0].Value, u)
	if !ok || after.sid == "" || after.sid != before.sid {
		t.Fatalf("refresh must keep the session id: before=%q after=%q", before.sid, after.sid)
	}
}
