package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

type auditRow struct {
	actor, action, resource string
	status                  int
}

func auditRows(t *testing.T, s *Server) []auditRow {
	t.Helper()
	rows, err := s.db.Query(`SELECT actor, action, resource, status FROM audit_log ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []auditRow
	for rows.Next() {
		var a auditRow
		if err := rows.Scan(&a.actor, &a.action, &a.resource, &a.status); err != nil {
			t.Fatal(err)
		}
		out = append(out, a)
	}
	return out
}

func auditRouter(s *Server) http.Handler {
	r := chi.NewRouter()
	r.Use(s.AuditLog)
	ok := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }
	r.Route("/api", func(r chi.Router) {
		r.Get("/projects/{id}", ok)
		r.Get("/projects/{id}/deployments", ok)
		r.Get("/databases/managed/{id}/credentials", ok)
		r.Post("/projects/{id}/deploy", ok)
	})
	return r
}

func TestAuditLogsBearerActorAndSensitiveReads(t *testing.T) {
	s := newAuthTestServer(t)
	postSetup(s, `{"username":"admin","password":"password123","setup_token":"test-setup-token-0123456789"}`)
	u, _ := s.db.GetUser()
	token := issueToken(s, u, time.Now().Unix())
	h := auditRouter(s)

	do := func(method, path, bearer string) {
		req := httptest.NewRequest(method, path, nil)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
	do(http.MethodGet, "/api/projects/p1?secret=1", token)              // reads env → audited
	do(http.MethodGet, "/api/databases/managed/db1/credentials", token) // credentials → audited
	do(http.MethodGet, "/api/projects/p1/deployments", token)           // ordinary read → not audited
	do(http.MethodPost, "/api/projects/p1/deploy", token)               // write by Bearer caller
	do(http.MethodPost, "/api/projects/p1/deploy", "")                  // unauthenticated stays anonymous

	got := auditRows(t, s)
	want := []auditRow{
		{"admin", "GET /api/projects/p1", "/api/projects/p1", 200},
		{"admin", "GET /api/databases/managed/db1/credentials", "/api/databases/managed/db1/credentials", 200},
		{"admin", "POST /api/projects/p1/deploy", "/api/projects/p1/deploy", 200},
		{"anonymous", "POST /api/projects/p1/deploy", "/api/projects/p1/deploy", 200},
	}
	if len(got) != len(want) {
		t.Fatalf("audit rows = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("row %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	for _, g := range got {
		if strings.Contains(g.action+g.resource, "secret=1") {
			t.Fatal("the query string must never be stored")
		}
	}
}

func TestLoginOutcomesAreAuditedWithoutTheAttemptedUsername(t *testing.T) {
	s := newAuthTestServer(t)
	postSetup(s, `{"username":"admin","password":"password123","setup_token":"test-setup-token-0123456789"}`)
	login := func(user, pass string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"`+user+`","password":"`+pass+`"}`))
		req.Header.Set("X-Real-IP", "198.51.100.77")
		rec := httptest.NewRecorder()
		s.authLogin(rec, req)
		return rec.Code
	}
	if login("admin", "wrong-password") != http.StatusUnauthorized {
		t.Fatal("bad password must be 401")
	}
	// Someone typed their password into the username box.
	if login("hunter2-my-real-password", "x") != http.StatusUnauthorized {
		t.Fatal("unknown user must be 401")
	}
	if login("admin", "password123") != http.StatusOK {
		t.Fatal("good login must be 200")
	}
	rows := auditRows(t, s)
	var failed, unknown, ok int
	for _, r := range rows {
		if strings.Contains(r.actor+r.action+r.resource, "hunter2") || strings.Contains(r.actor+r.action+r.resource, "wrong-password") {
			t.Fatalf("attempted username/password leaked into the audit log: %+v", r)
		}
		switch {
		case r.action == "auth.login.failed" && r.resource == "account" && r.status == 401:
			failed++
		case r.action == "auth.login.failed" && r.resource == "unknown-user":
			unknown++
		case r.action == "auth.login" && r.actor == "admin" && r.status == 200:
			ok++
		}
	}
	if failed != 1 || unknown != 1 || ok != 1 {
		t.Fatalf("want 1 failed(account), 1 failed(unknown-user), 1 success; got %d/%d/%d in %+v", failed, unknown, ok, rows)
	}
}
