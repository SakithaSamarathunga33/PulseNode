package builder

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"pulsenode/backend/internal/proxy"
)

// stubProxy swaps the Docker-facing seams and returns call counters.
func stubProxy(t *testing.T, external string, managedRunning bool, ensureErr error) (ensured *int) {
	t.Helper()
	t.Setenv("PULSENODE_WORKSPACE", t.TempDir()) // no .env.local
	oldD, oldR, oldE := detectExternalTraefik, managedProxyRunning, ensureManagedProxy
	t.Cleanup(func() { detectExternalTraefik, managedProxyRunning, ensureManagedProxy = oldD, oldR, oldE })
	n := 0
	detectExternalTraefik = func(context.Context) string { return external }
	managedProxyRunning = func(context.Context) bool { return managedRunning }
	ensureManagedProxy = func(context.Context, string) error { n++; return ensureErr }
	return &n
}

func logLines(cfg *Config) *[]string {
	var lines []string
	cfg.Log = func(_, l string) { lines = append(lines, l) }
	return &lines
}

func TestResolveNetworkExplicitWins(t *testing.T) {
	ensured := stubProxy(t, "ext", false, nil)
	cfg := Config{TraefikNet: "my-net"}
	got, err := cfg.resolveTraefikNetwork(context.Background())
	if err != nil || got != "my-net" || *ensured != 0 {
		t.Fatalf("got %q %v ensured=%d", got, err, *ensured)
	}
}

func TestResolveNetworkExternalUntouched(t *testing.T) {
	ensured := stubProxy(t, "vps-monitor_proxy", false, nil)
	cfg := Config{}
	got, err := cfg.resolveTraefikNetwork(context.Background())
	if err != nil || got != "vps-monitor_proxy" || *ensured != 0 {
		t.Fatalf("external Traefik must be used without starting ours: %q %v ensured=%d", got, err, *ensured)
	}
}

func TestResolveNetworkRunningManagedReused(t *testing.T) {
	ensured := stubProxy(t, "", true, nil)
	cfg := Config{}
	got, err := cfg.resolveTraefikNetwork(context.Background())
	if err != nil || got != proxy.Network || *ensured != 0 {
		t.Fatalf("got %q %v ensured=%d", got, err, *ensured)
	}
}

func TestResolveNetworkStartsManagedWhenNoneFound(t *testing.T) {
	ensured := stubProxy(t, "", false, nil)
	cfg := Config{}
	lines := logLines(&cfg)
	got, err := cfg.resolveTraefikNetwork(context.Background())
	if err != nil || got != proxy.Network || *ensured != 1 {
		t.Fatalf("got %q %v ensured=%d", got, err, *ensured)
	}
	all := strings.Join(*lines, "\n")
	if !strings.Contains(all, "No Traefik found — starting PulseNode's built-in proxy") || !strings.Contains(all, "✓ Built-in proxy is running") {
		t.Errorf("deployment log missing proxy lines:\n%s", all)
	}
}

func TestResolveNetworkDisabledKeepsOldError(t *testing.T) {
	ensured := stubProxy(t, "", false, nil)
	cfg := Config{ManagedProxyOff: true}
	_, err := cfg.resolveTraefikNetwork(context.Background())
	if err == nil || !strings.Contains(err.Error(), "TRAEFIK_NETWORK is not configured") || *ensured != 0 {
		t.Fatalf("err=%v ensured=%d", err, *ensured)
	}
}

func TestResolveNetworkPortConflictIsActionable(t *testing.T) {
	stubProxy(t, "", false, &proxy.PortConflictError{Detail: "Bind for 0.0.0.0:80 failed"})
	cfg := Config{}
	lines := logLines(&cfg)
	_, err := cfg.resolveTraefikNetwork(context.Background())
	if !proxy.IsPortConflict(err) || !strings.Contains(err.Error(), "ports 80/443 are in use") {
		t.Fatalf("err=%v", err)
	}
	if !strings.Contains(strings.Join(*lines, "\n"), "✕ Could not start the built-in proxy: ports 80/443 are in use") {
		t.Errorf("log lines: %v", *lines)
	}
}

func TestResolveNetworkOtherEnsureError(t *testing.T) {
	stubProxy(t, "", false, errors.New("boom"))
	cfg := Config{}
	if _, err := cfg.resolveTraefikNetwork(context.Background()); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err=%v", err)
	}
}

// The managed proxy is configured to match the labels the builder emits. This
// guards against the two drifting apart.
func TestBuilderLabelsMatchProxyConfig(t *testing.T) {
	src, err := os.ReadFile("builder.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`.entrypoints=` + proxy.EntryPointSecure,
		`.tls.certresolver=` + proxy.CertResolver,
		`entrypoints: "` + proxy.EntryPointSecure + `"`,
		`certresolver: "` + proxy.CertResolver + `"`,
	} {
		if !strings.Contains(string(src), want) {
			t.Errorf("builder.go no longer emits %q; update internal/proxy to match", want)
		}
	}
	overlay := Config{ProjectID: "p1", Domain: "a.example.com", Port: 3000}.composeOverlay(proxy.Network)
	if !strings.Contains(overlay, proxy.EntryPointSecure) || !strings.Contains(overlay, proxy.CertResolver) {
		t.Errorf("overlay does not use the proxy's names:\n%s", overlay)
	}
}

func TestLogDNSNote(t *testing.T) {
	old := lookupHost
	t.Cleanup(func() { lookupHost = old })
	t.Setenv("VPS_IP", "203.0.113.7")

	var lines []string
	cfg := Config{Domain: "luxe.sakitha.com", Log: func(_, l string) { lines = append(lines, l) }}

	lookupHost = func(context.Context, string) ([]string, error) { return []string{"203.0.113.7"}, nil }
	cfg.logDNSNote(context.Background())
	if len(lines) != 1 || lines[0] != "DNS: luxe.sakitha.com resolves to 203.0.113.7 ✓" {
		t.Fatalf("resolved: %v", lines)
	}

	lines = nil
	lookupHost = func(context.Context, string) ([]string, error) { return nil, errors.New("no such host") }
	cfg.logDNSNote(context.Background())
	want := "⚠ luxe.sakitha.com does not resolve yet — add a wildcard record *.sakitha.com → 203.0.113.7 at your DNS provider (proxied through Cloudflare is fine)"
	if len(lines) != 1 || lines[0] != want {
		t.Fatalf("unresolved: %v", lines)
	}

	lines = nil
	cfg.Domain = ""
	cfg.logDNSNote(context.Background())
	if len(lines) != 0 {
		t.Fatalf("no domain should log nothing: %v", lines)
	}
}
