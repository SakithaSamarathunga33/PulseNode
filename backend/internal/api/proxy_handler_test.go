package api

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"pulsenode/backend/internal/proxy"
)

// fakeProxyDocker answers the docker CLI calls the proxy manager makes.
type fakeProxyDocker struct {
	calls   []string
	handler func(args []string) (string, error)
}

func (f *fakeProxyDocker) Docker(_ context.Context, args ...string) (string, error) {
	f.calls = append(f.calls, strings.Join(args, " "))
	return f.handler(args)
}

func (f *fakeProxyDocker) called(prefix string) bool {
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

func proxyTestServer(t *testing.T, h func(args []string) (string, error)) (*Server, *fakeProxyDocker) {
	t.Helper()
	s := newAuthTestServer(t)
	f := &fakeProxyDocker{handler: h}
	s.proxySt.mgr = &proxy.Manager{R: f, Ready: func(context.Context) error { return nil }, Timeout: time.Second}
	return s, f
}

func proxyNoSuch(args []string) (string, error) { return "", errors.New("Error: No such object: x") }

func proxyCall(t *testing.T, h http.HandlerFunc, method, path, body string) (int, proxyStatusResponse, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
	var st proxyStatusResponse
	var raw map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &st)
	_ = json.Unmarshal(rec.Body.Bytes(), &raw)
	return rec.Code, st, raw
}

func TestProxyStatusNone(t *testing.T) {
	s, _ := proxyTestServer(t, proxyNoSuch)
	code, st, raw := proxyCall(t, s.proxyStatus, "GET", "/api/proxy/status", "")
	if code != 200 || st.Mode != "none" || st.Running || !st.Enabled || st.HTTPPort != 80 || st.HTTPSPort != 443 {
		t.Fatalf("%d %+v", code, st)
	}
	for _, k := range []string{"mode", "running", "container", "network", "httpPort", "httpsPort", "acmeEmail", "enabled", "error", "conflict"} {
		if _, ok := raw[k]; !ok {
			t.Errorf("contract field %q missing from %v", k, raw)
		}
	}
}

func TestProxyStatusExternal(t *testing.T) {
	s, _ := proxyTestServer(t, func(args []string) (string, error) {
		switch args[0] {
		case "ps":
			return "traefik\n", nil
		case "inspect":
			if args[1] == "traefik" {
				return "vps-monitor_proxy ", nil
			}
		}
		return "", errors.New("No such object")
	})
	_, st, _ := proxyCall(t, s.proxyStatus, "GET", "/api/proxy/status", "")
	if st.Mode != "external" || !st.Running || st.Network != "vps-monitor_proxy" {
		t.Fatalf("%+v", st)
	}
}

func TestProxyStatusManaged(t *testing.T) {
	s, _ := proxyTestServer(t, func(args []string) (string, error) {
		if args[0] == "inspect" {
			return "true|ops@example.com|abc", nil
		}
		return "", nil
	})
	_ = s.db.SetSetting(proxy.SettingACMEEmail, "ops@example.com")
	_, st, _ := proxyCall(t, s.proxyStatus, "GET", "/api/proxy/status", "")
	if st.Mode != "managed" || !st.Running || st.Container != "pulsenode-traefik" || st.Network != "pulsenode-proxy" || st.AcmeEmail != "ops@example.com" {
		t.Fatalf("%+v", st)
	}
}

func TestProxyEnableStartsAndPersists(t *testing.T) {
	running := false
	s, f := proxyTestServer(t, nil)
	f.handler = func(args []string) (string, error) {
		switch args[0] {
		case "ps":
			return "", nil
		case "network":
			return "", nil
		case "inspect":
			if !running {
				return "", errors.New("Error: No such object")
			}
			return "true|ops@example.com|x", nil
		case "run":
			running = true
		}
		return "id", nil
	}
	code, st, _ := proxyCall(t, s.proxyEnable, "POST", "/api/proxy/enable", `{"acmeEmail":"ops@example.com"}`)
	if code != 200 || st.Mode != "managed" || !st.Running || st.AcmeEmail != "ops@example.com" {
		t.Fatalf("%d %+v", code, st)
	}
	if v, _ := s.db.GetSetting(proxy.SettingManaged); v != "true" {
		t.Errorf("proxy_managed = %q", v)
	}
	var run string
	for _, c := range f.calls {
		if strings.HasPrefix(c, "run ") {
			run = c
		}
	}
	if !strings.Contains(run, "acme.email=ops@example.com") {
		t.Errorf("email not passed to Traefik: %s", run)
	}
}

func TestProxyEnableRejectsBadEmail(t *testing.T) {
	s, f := proxyTestServer(t, proxyNoSuch)
	for _, e := range []string{"nope", "a b@c.com", "Bob <bob@x.com>", "a@b.com,c@d.com"} {
		code, _, raw := proxyCall(t, s.proxyEnable, "POST", "/api/proxy/enable", `{"acmeEmail":"`+e+`"}`)
		if code != 400 || raw["error"] == nil {
			t.Errorf("%q: %d %v", e, code, raw)
		}
	}
	if f.called("run ") {
		t.Error("must not start anything on invalid input")
	}
}

func TestProxyEnablePortConflict409(t *testing.T) {
	s, _ := proxyTestServer(t, func(args []string) (string, error) {
		switch args[0] {
		case "run":
			return "", errors.New("Bind for 0.0.0.0:80 failed: port is already allocated")
		case "inspect", "ps":
			return "", errors.New("No such object")
		}
		return "", nil
	})
	code, st, _ := proxyCall(t, s.proxyEnable, "POST", "/api/proxy/enable", "")
	if code != http.StatusConflict || !st.Conflict || !strings.Contains(st.Error, "ports 80/443 are in use") {
		t.Fatalf("%d %+v", code, st)
	}
	if v, _ := s.db.GetSetting(proxy.SettingManaged); v == "true" {
		t.Error("must not persist enabled after a failed start")
	}
	// The failure is remembered for the status endpoint.
	_, st, _ = proxyCall(t, s.proxyStatus, "GET", "/api/proxy/status", "")
	if !st.Conflict || st.Error == "" {
		t.Errorf("status should surface the last conflict: %+v", st)
	}
}

func TestProxyEnableRefusedWhenExternalTraefik(t *testing.T) {
	s, f := proxyTestServer(t, func(args []string) (string, error) {
		switch args[0] {
		case "ps":
			return "traefik\n", nil
		case "inspect":
			if args[1] == "traefik" {
				return "proxy_net ", nil
			}
		}
		return "", errors.New("No such object")
	})
	code, st, _ := proxyCall(t, s.proxyEnable, "POST", "/api/proxy/enable", "")
	if code != http.StatusConflict || !strings.Contains(st.Error, "existing Traefik") || st.Mode != "external" {
		t.Fatalf("%d %+v", code, st)
	}
	if f.called("run ") || f.called("network create") {
		t.Errorf("must not touch Docker: %v", f.calls)
	}
}

func TestProxyDisableRemovesAndPersists(t *testing.T) {
	s, f := proxyTestServer(t, func(args []string) (string, error) {
		if args[0] == "inspect" || args[0] == "ps" {
			return "", errors.New("No such object")
		}
		return "", nil
	})
	code, st, _ := proxyCall(t, s.proxyDisable, "POST", "/api/proxy/disable", "")
	if code != 200 || st.Enabled || st.Mode != "none" {
		t.Fatalf("%d %+v", code, st)
	}
	if !f.called("rm -f pulsenode-traefik") {
		t.Errorf("calls: %v", f.calls)
	}
	for _, c := range f.calls {
		if strings.Contains(c, "volume") {
			t.Errorf("the ACME volume must be kept: %s", c)
		}
	}
	if v, _ := s.db.GetSetting(proxy.SettingManaged); v != "false" {
		t.Errorf("proxy_managed = %q", v)
	}
}

func TestProxySettingsValidatesAndRecreatesWhenRunning(t *testing.T) {
	s, f := proxyTestServer(t, nil)
	f.handler = func(args []string) (string, error) {
		switch args[0] {
		case "inspect":
			return "true|old@example.com|oldspec", nil
		case "network":
			return "", nil
		}
		return "id", nil
	}
	if code, _, _ := proxyCall(t, s.proxySettings, "PATCH", "/api/proxy/settings", `{"acmeEmail":"bad"}`); code != 400 {
		t.Fatalf("bad email: %d", code)
	}
	code, st, _ := proxyCall(t, s.proxySettings, "PATCH", "/api/proxy/settings", `{"acmeEmail":"new@example.com"}`)
	if code != 200 || st.AcmeEmail != "new@example.com" {
		t.Fatalf("%d %+v", code, st)
	}
	if !f.called("rm -f pulsenode-traefik") || !f.called("run ") {
		t.Errorf("running proxy should be recreated: %v", f.calls)
	}
}

func TestProxySettingsNotRunningOnlyPersists(t *testing.T) {
	s, f := proxyTestServer(t, proxyNoSuch)
	code, st, _ := proxyCall(t, s.proxySettings, "PATCH", "/api/proxy/settings", `{"acmeEmail":""}`)
	if code != 200 || st.AcmeEmail != "" || f.called("run ") {
		t.Fatalf("%d %+v %v", code, st, f.calls)
	}
}

func TestReconcileProxy(t *testing.T) {
	newSrv := func(setting string) (*Server, *fakeProxyDocker) {
		s, f := proxyTestServer(t, func(args []string) (string, error) {
			if args[0] == "ps" || args[0] == "inspect" {
				return "", errors.New("No such object")
			}
			return "id", nil
		})
		if setting != "" {
			_ = s.db.SetSetting(proxy.SettingManaged, setting)
		}
		return s, f
	}
	s, f := newSrv("true")
	s.ReconcileProxy(context.Background())
	if !f.called("run ") {
		t.Errorf("enabled but missing proxy should be started: %v", f.calls)
	}
	for _, v := range []string{"false", ""} {
		s, f := newSrv(v)
		s.ReconcileProxy(context.Background())
		if f.called("run ") || f.called("network") {
			t.Errorf("setting %q must not start the proxy at boot: %v", v, f.calls)
		}
	}
	t.Setenv(proxy.EnvManaged, "false")
	s, f = newSrv("true")
	s.ReconcileProxy(context.Background())
	if f.called("run ") {
		t.Errorf("env override must win: %v", f.calls)
	}
}

func TestProxyRoutesRequireAuthAndAreAudited(t *testing.T) {
	s, _ := proxyTestServer(t, proxyNoSuch)
	postSetup(s, `{"username":"admin","password":"password123","setup_token":"test-setup-token-0123456789"}`)
	h := s.Routes()
	for _, rt := range [][2]string{
		{"GET", "/api/proxy/status"}, {"POST", "/api/proxy/enable"}, {"POST", "/api/proxy/disable"},
		{"PATCH", "/api/proxy/settings"}, {"GET", "/api/domains/wildcard?domain=a.example.com"},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(rt[0], rt[1], nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without login = %d, want 401", rt[0], rt[1], rec.Code)
		}
	}
	// State changes land in the audit log through the shared middleware.
	var found bool
	for _, a := range auditRows(t, s) {
		if a.action == "POST /api/proxy/enable" {
			found = true
		}
	}
	if !found {
		t.Error("POST /api/proxy/enable was not audited")
	}
}

// ── wildcard ──────────────────────────────────────────────────────────────────

type fakeResolver struct {
	answers map[string][]string // host → IPs; absent → NXDOMAIN
	err     error
	asked   []string
}

func (f *fakeResolver) LookupIPAddr(_ context.Context, host string) ([]net.IPAddr, error) {
	f.asked = append(f.asked, host)
	if f.err != nil {
		return nil, f.err
	}
	var out []net.IPAddr
	for suffix, ips := range f.answers {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			for _, ip := range ips {
				out = append(out, net.IPAddr{IP: net.ParseIP(ip)})
			}
			return out, nil
		}
	}
	return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
}

func TestCheckWildcardClassification(t *testing.T) {
	const server = "203.0.113.7"
	cases := []struct {
		name    string
		r       *fakeResolver
		expect  string
		status  string
		resolve bool
		proxied bool
	}{
		{"points at server", &fakeResolver{answers: map[string][]string{"example.com": {server}}}, server, "ok", true, false},
		{"one of several matches", &fakeResolver{answers: map[string][]string{"example.com": {"198.51.100.1", server}}}, server, "ok", true, false},
		{"cloudflare proxied", &fakeResolver{answers: map[string][]string{"example.com": {"104.21.5.9", "172.67.1.2"}}}, server, "proxied", true, true},
		{"somewhere else", &fakeResolver{answers: map[string][]string{"example.com": {"198.51.100.1"}}}, server, "wrong", true, false},
		{"nxdomain", &fakeResolver{}, server, "missing", false, false},
		{"servfail", &fakeResolver{err: &net.DNSError{Err: "server misbehaving", IsTemporary: true}}, server, "error", false, false},
		{"unknown server ip, resolves", &fakeResolver{answers: map[string][]string{"example.com": {"198.51.100.1"}}}, "", "error", true, false},
		{"unknown server ip, cloudflare", &fakeResolver{answers: map[string][]string{"example.com": {"104.21.5.9"}}}, "", "proxied", true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			old := dnsResolver
			dnsResolver = tc.r
			t.Cleanup(func() { dnsResolver = old })
			got := checkWildcard(context.Background(), "example.com", "pn-probe-abc.example.com", tc.expect)
			if got.Status != tc.status || got.Resolves != tc.resolve || got.Proxied != tc.proxied {
				t.Fatalf("%+v", got)
			}
			if got.IPs == nil {
				t.Error("ips must be an empty array, never null")
			}
			if got.Message == "" || got.Root != "example.com" || got.ProbeHost != "pn-probe-abc.example.com" || got.ExpectedIP != tc.expect {
				t.Errorf("incomplete: %+v", got)
			}
		})
	}
}

func TestWildcardEndpoint(t *testing.T) {
	s := newAuthTestServer(t)
	t.Setenv("VPS_IP", "203.0.113.7")
	r := &fakeResolver{answers: map[string][]string{"luxe.sakitha.com": {"203.0.113.7"}}} // only the host itself, no wildcard
	old := dnsResolver
	dnsResolver = r
	t.Cleanup(func() { dnsResolver = old })

	do := func(q string) (int, map[string]any) {
		rec := httptest.NewRecorder()
		s.wildcardCheck(rec, httptest.NewRequest("GET", "/api/domains/wildcard?domain="+url.QueryEscape(q), nil))
		var m map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &m)
		return rec.Code, m
	}

	code, m := do("luxe.sakitha.com")
	if code != 200 || m["status"] != "missing" || m["root"] != "sakitha.com" || m["domain"] != "luxe.sakitha.com" || m["expectedIp"] != "203.0.113.7" {
		t.Fatalf("%d %v", code, m)
	}
	probe, _ := m["probeHost"].(string)
	if !strings.HasPrefix(probe, "pn-probe-") || !strings.HasSuffix(probe, ".sakitha.com") {
		t.Errorf("probeHost = %q", probe)
	}
	dc, _ := m["domainCheck"].(map[string]any)
	if dc == nil || dc["pointed"] != true {
		t.Errorf("domain's own resolution missing: %v", m["domainCheck"])
	}
	if !strings.Contains(m["message"].(string), "luxe.sakitha.com itself resolves") {
		t.Errorf("message: %v", m["message"])
	}
	if ips, ok := m["ips"].([]any); !ok || len(ips) != 0 {
		t.Errorf("ips = %v", m["ips"])
	}

	// Two calls probe two different random labels.
	_, m2 := do("luxe.sakitha.com")
	if m2["probeHost"] == m["probeHost"] {
		t.Error("probe label must be random per call")
	}

	// Apex input is its own root; multi-part TLD roots are respected.
	if _, m := do("sakitha.com"); m["root"] != "sakitha.com" {
		t.Errorf("apex: %v", m)
	}
	if _, m := do("shop.example.co.uk"); m["root"] != "example.co.uk" {
		t.Errorf("co.uk: %v", m)
	}

	for _, bad := range []string{"bad%60host.com", "no_dot", "a b.com"} {
		if code, _ := do(bad); code != 400 {
			t.Errorf("%q: %d, want 400", bad, code)
		}
	}
}
