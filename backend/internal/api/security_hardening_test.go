package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLogoutRevokesEveryCopyOfTheSession(t *testing.T) {
	s := newAuthTestServer(t)
	postSetup(s, `{"username":"admin","password":"password123","setup_token":"test-setup-token-0123456789"}`)
	u, _ := s.db.GetUser()

	authTime := time.Now().Unix() - 5000 // unique per test: revocations are process-wide
	issue := func() string {
		rec := httptest.NewRecorder()
		s.issueSession(rec, httptest.NewRequest(http.MethodPost, "/", nil), u, authTime)
		return rec.Result().Cookies()[0].Value
	}
	stolen, current := issue(), issue() // a refreshed token and the copy an attacker kept
	if _, ok := s.validSession(stolen, u); !ok {
		t.Fatal("session should be valid before logout")
	}

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: current})
	s.authLogout(httptest.NewRecorder(), req)

	if _, ok := s.validSession(stolen, u); ok {
		t.Fatal("an older copy of the logged-out session must be rejected")
	}
	if _, ok := s.validSession(current, u); ok {
		t.Fatal("the logged-out session itself must be rejected")
	}
	// A different login is unaffected, and so is the middleware path.
	rec := httptest.NewRecorder()
	s.issueSession(rec, httptest.NewRequest(http.MethodPost, "/", nil), u, authTime+1)
	other := rec.Result().Cookies()[0].Value
	if _, ok := s.validSession(other, u); !ok {
		t.Fatal("other sessions must stay valid")
	}
	r2 := httptest.NewRequest(http.MethodGet, "/api/host", nil)
	r2.AddCookie(&http.Cookie{Name: sessionCookieName, Value: stolen})
	rr := httptest.NewRecorder()
	protectedOK(s).ServeHTTP(rr, r2)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("revoked cookie must be rejected by requireAuth, got %d", rr.Code)
	}
}

func TestUpsertEnvLocalRejectsInjection(t *testing.T) {
	ws := t.TempDir()
	t.Setenv("PULSENODE_WORKSPACE", ws)
	for _, bad := range []string{"a.com\nPULSENODE_COMPOSE_BIN=/tmp/x", "a.com\rX=1", "a\x00b"} {
		if err := upsertEnvLocal("PULSENODE_ROOT_DOMAIN", bad); err == nil {
			t.Errorf("value %q must be rejected", bad)
		}
	}
	if err := upsertEnvLocal("bad key", "v"); err == nil {
		t.Error("invalid key must be rejected")
	}
	if _, err := os.Stat(filepath.Join(ws, ".env.local")); err == nil {
		t.Error("nothing may be written when validation fails")
	}
	if err := upsertEnvLocal("PULSENODE_ROOT_DOMAIN", "ok.example.com"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(ws, ".env.local"))
	if strings.TrimSpace(string(data)) != "PULSENODE_ROOT_DOMAIN=ok.example.com" {
		t.Fatalf("unexpected file: %q", data)
	}
}

func TestSaveDomainRejectsInvalidHostname(t *testing.T) {
	s := newAuthTestServer(t)
	for _, host := range []string{"a.com\nPULSENODE_COMPOSE_BIN=/x", "not a host", "a..com", "-bad.com", "x"} {
		rec := httptest.NewRecorder()
		body := strings.NewReader(`{"host":` + jsonString(host) + `}`)
		s.saveDomain(rec, httptest.NewRequest(http.MethodPost, "/api/domains", body))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("host %q: got %d, want 400", host, rec.Code)
		}
	}
}

func jsonString(s string) string {
	b := strings.Builder{}
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\n':
			b.WriteString(`\n`)
		case '"':
			b.WriteString(`\"`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func TestTrustedOriginRebindingInNoAuthMode(t *testing.T) {
	s := &Server{origins: []string{"http://panel.example.com:8080"}, insecureNoAuth: true}
	if !s.trustedOrigin("http://panel.example.com:8080/x", "panel.example.com:8080") {
		t.Error("configured host must be trusted")
	}
	// DNS rebinding: attacker's name resolves to this server, so Origin == Host.
	if s.trustedOrigin("http://evil.example:8080", "evil.example:8080") {
		t.Error("an unconfigured Host must not be trusted just because Origin matches it")
	}
	// With login on, the host-only cookie already protects against rebinding.
	s.insecureNoAuth = false
	if !s.trustedOrigin("http://other.example", "other.example") {
		t.Error("login mode keeps the same-host rule")
	}
}

func TestOAuthStateCookieUsesHostPrefixOverHTTPS(t *testing.T) {
	plain := httptest.NewRequest(http.MethodGet, "http://panel/x", nil)
	if got := oauthStateName(plain); got != "pn_oauth_state" {
		t.Errorf("http: %q", got)
	}
	tls := httptest.NewRequest(http.MethodGet, "http://panel/x", nil)
	tls.Header.Set("X-Forwarded-Proto", "https")
	if got := oauthStateName(tls); got != "__Host-pn_oauth_state" {
		t.Errorf("https: %q", got)
	}
}

func TestDBCredentialsStayOffArgv(t *testing.T) {
	const pw = "p@ss'w\"ord $(x)"
	if env := mysqlAuthEnv(pw); len(env) != 1 || env[0] != "MYSQL_PWD="+pw {
		t.Errorf("mysql env: %v", env)
	}
	if env := redisAuthEnv(pw); len(env) != 1 || env[0] != "REDISCLI_AUTH="+pw {
		t.Errorf("redis env: %v", env)
	}
	if mysqlAuthEnv("") != nil || redisAuthEnv("") != nil {
		t.Error("no password → no env")
	}

	cmd, env := mongoToolCmd("mongodump", []string{"--archive", "--db", "app"}, "root", pw)
	if strings.Contains(strings.Join(cmd, "\x00"), pw) {
		t.Fatalf("password must not be in argv: %q", cmd)
	}
	if len(env) != 1 || env[0] != "PN_MONGO_PWD='p@ss''w\"ord $(x)'" {
		t.Fatalf("env = %q", env)
	}
	if cmd, env := mongoToolCmd("mongodump", []string{"--archive"}, "", ""); env != nil || cmd[0] != "mongodump" {
		t.Errorf("no user → plain command, got %v %v", cmd, env)
	}
}

// Runs the real sh wrapper against a fake mongodump: the password must reach the
// tool only through a 0600 --config file (valid YAML), argv must stay clean, the
// file must be gone afterwards, and the tool's exit status must propagate.
func TestMongoWrapperWritesConfigFileAndCleansUp(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	dir := t.TempDir()
	rec := filepath.Join(dir, "record")
	fake := filepath.Join(dir, "mongodump")
	script := "#!/bin/sh\n" +
		"echo \"ARGV: $*\" > " + rec + "\n" +
		"while [ $# -gt 0 ]; do if [ \"$1\" = --config ]; then cfg=$2; fi; shift; done\n" +
		"echo \"MODE: $(stat -c %a \"$cfg\")\" >> " + rec + "\n" +
		"cat \"$cfg\" >> " + rec + "\n" +
		"echo \"CFG: $cfg\" >> " + rec + "\n" +
		"exit 7\n"
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	const pw = "it's a \"secret\""
	cmd, env := mongoToolCmd("mongodump", []string{"--archive", "--db", "app"}, "root", pw)
	c := exec.Command(cmd[0], cmd[1:]...)
	c.Env = append([]string{"PATH=" + dir + ":/usr/bin:/bin", "TMPDIR=" + dir}, env...)
	err := c.Run()
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 7 {
		t.Fatalf("tool exit status must propagate, got %v", err)
	}
	out, _ := os.ReadFile(rec)
	got := string(out)
	if strings.Contains(strings.SplitN(got, "\n", 2)[0], "secret") {
		t.Fatalf("password leaked into argv: %s", got)
	}
	for _, want := range []string{"--username root", "--authenticationDatabase admin", "MODE: 600", "password: 'it''s a \"secret\"'"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	for _, line := range strings.Split(got, "\n") {
		if strings.HasPrefix(line, "CFG: ") {
			if _, err := os.Stat(strings.TrimPrefix(line, "CFG: ")); err == nil {
				t.Error("config file with the password must be removed after the run")
			}
		}
	}
}
