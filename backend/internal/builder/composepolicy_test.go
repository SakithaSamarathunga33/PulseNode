package builder

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestComposeViolationsRejectsHostAccess(t *testing.T) {
	dir := t.TempDir()
	raw := `{
	  "services": {
	    "app": {
	      "privileged": true, "pid": "host", "network_mode": "host",
	      "cap_add": ["SYS_ADMIN"], "devices": [{"source": "/dev/sda", "target": "/dev/sda"}],
	      "security_opt": ["apparmor=unconfined"],
	      "labels": {"traefik.http.routers.x.rule": "Host(` + "`panel.example.com`" + `)"},
	      "volumes": [
	        {"type": "bind", "source": "/", "target": "/host"},
	        {"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock"}
	      ],
	      "env_file": [{"path": "/workspace/.env.local"}],
	      "build": {"context": "/workspace", "dockerfile": "Dockerfile"}
	    }
	  },
	  "volumes": {"named": {"driver_opts": {"type": "none", "o": "bind", "device": "/etc"}}},
	  "secrets": {"s": {"file": "/var/lib/pulsenode/aes-key"}}
	}`
	got := strings.Join(composeViolations([]byte(raw), dir), "\n")
	for _, want := range []string{
		"privileged", "pid: host", "network_mode: host", "cap_add", "devices", "security_opt",
		"label traefik.", "bind mount of host path /", "/var/run/docker.sock",
		"env_file outside", "build context outside", "volume named", "secret s",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing violation %q in:\n%s", want, got)
		}
	}
}

func TestComposeViolationsAllowsOrdinaryApps(t *testing.T) {
	dir := t.TempDir()
	raw := `{
	  "services": {
	    "web": {
	      "build": {"context": "` + dir + `", "dockerfile": "Dockerfile"},
	      "volumes": [{"type": "volume", "source": "data", "target": "/data"},
	                  {"type": "bind", "source": "` + filepath.Join(dir, "config") + `", "target": "/config"}],
	      "env_file": [{"path": "` + filepath.Join(dir, ".env") + `"}],
	      "labels": {"com.example.team": "web"}
	    },
	    "db": {"image": "postgres:16", "network_mode": "service:web"}
	  },
	  "volumes": {"data": {}}
	}`
	if v := composeViolations([]byte(raw), dir); len(v) > 0 {
		t.Fatalf("ordinary compose file rejected: %v", v)
	}
}

func TestResolvedWithinFollowsSymlinks(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.env")
	if err := os.WriteFile(outside, []byte("A=1"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "innocent.env")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if resolvedWithin(dir, link) {
		t.Fatal("symlink escaping the repo must not count as inside it")
	}
	if !resolvedWithin(dir, filepath.Join(dir, "missing.env")) {
		t.Fatal("non-existent path inside the repo should be allowed")
	}
	if resolvedWithin(dir, filepath.Join(dir, "..", "x")) {
		t.Fatal("../ path must be rejected")
	}
}

func TestBuildEnvExcludesPanelSecrets(t *testing.T) {
	t.Setenv("JWT_SECRET", "super-secret")
	t.Setenv("AES_KEY", "another-secret")
	t.Setenv("PATH", "/usr/bin")
	env := strings.Join(buildEnv([]string{"EXTRA=1"}), "\n")
	if strings.Contains(env, "super-secret") || strings.Contains(env, "another-secret") {
		t.Fatalf("panel secrets leaked into build env:\n%s", env)
	}
	if !strings.Contains(env, "PATH=/usr/bin") || !strings.Contains(env, "EXTRA=1") {
		t.Fatalf("expected PATH and extra vars:\n%s", env)
	}
}

func TestGitAuthEnvKeepsTokenOutOfURL(t *testing.T) {
	env := gitAuthEnv("https://github.com/o/r.git", "ghp_token123")
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "GIT_CONFIG_KEY_0=http.https://github.com/.extraheader") {
		t.Fatalf("header not scoped to repo host:\n%s", joined)
	}
	if strings.Contains(joined, "ghp_token123") {
		t.Fatal("token should be base64-encoded inside the Authorization header, not raw")
	}
	if gitAuthEnv("https://github.com/o/r.git", "") != nil {
		t.Fatal("no token → no auth env")
	}
}

func TestComposeViolationsRejectsPanelVolumesAndNamespaces(t *testing.T) {
	dir := t.TempDir()
	// Shape taken from real `docker compose config --format json` output.
	raw := `{
	  "name": "pn-build-1",
	  "services": {
	    "app": {
	      "pid": "container:vps-go-api-1", "ipc": "container:vps-go-api-1", "cgroup": "host",
	      "labels": {"traefik.enable": "false", "traefik.http.routers.x.rule": "Host(` + "`a`" + `)"},
	      "volumes": [{"type": "volume", "source": "stolen", "target": "/s"},
	                  {"type": "volume", "source": "named", "target": "/n"},
	                  {"type": "volume", "source": "plain", "target": "/p"}]
	    }
	  },
	  "volumes": {
	    "stolen": {"name": "vps_pn-go-data", "external": true},
	    "named": {"name": "vps_pn-sqlite-data"},
	    "plain": {"name": "pn-build-1_plain"}
	  }
	}`
	got := strings.Join(composeViolations([]byte(raw), dir), "\n")
	for _, want := range []string{"pid: container:", "ipc: container:", "cgroup: host", "volume stolen", "volume named", "traefik.http.routers.x.rule"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing violation %q in:\n%s", want, got)
		}
	}
	for _, unwanted := range []string{"volume plain", "traefik.enable"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("false positive %q in:\n%s", unwanted, got)
		}
	}
}
