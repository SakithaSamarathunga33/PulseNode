package builder

import (
	"context"
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
	got := strings.Join(composeViolations([]byte(raw), dir, "pn-build-1"), "\n")
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
	  "volumes": {"data": {"name": "pn-build-1_data"}}
	}`
	if v := composeViolations([]byte(raw), dir, "pn-build-1"); len(v) > 0 {
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
	got := strings.Join(composeViolations([]byte(raw), dir, "pn-build-1"), "\n")
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

func TestEnvFileViolationsUninterpolated(t *testing.T) {
	dir := t.TempDir()
	raw := `{"services": {"app": {"env_file": [
	  {"path": "/workspace/.env.local"},
	  {"path": "${NOPE:-/workspace/.env.local}"},
	  {"path": "` + filepath.Join(dir, ".env") + `"}
	]}}}`
	got := strings.Join(envFileViolations([]byte(raw), dir), "\n")
	for _, want := range []string{"outside the repository: /workspace/.env.local", "literal path"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if strings.Contains(got, filepath.Join(dir, ".env")) {
		t.Errorf("in-repo env_file rejected:\n%s", got)
	}
}

func TestComposeViolationsRejectsTakeoverAndNetworkAbuse(t *testing.T) {
	dir := t.TempDir()
	raw := `{
	  "name": "pulsenode",
	  "services": {
	    "go-api": {
	      "ports": [{"mode": "ingress", "target": 80, "published": "80", "protocol": "tcp"}],
	      "sysctls": {"net.core.somaxconn": "1"},
	      "ulimits": {"nofile": {"soft": 1, "hard": 2}},
	      "extra_hosts": {"h": "host-gateway"},
	      "cgroup_parent": "/system.slice",
	      "build": {"context": "` + dir + `", "network": "host", "privileged": true, "extra_hosts": ["a:1.2.3.4"]}
	    }
	  },
	  "volumes": {
	    "stolen": {"name": "pulsenode_pn-go-data"},
	    "mine": {"name": "pn-build-1_mine"}
	  },
	  "networks": {
	    "ext": {"name": "vps-monitor_proxy", "external": true},
	    "named": {"name": "other_default"},
	    "weird": {"name": "pn-build-1_weird", "driver": "macvlan"},
	    "default": {"name": "pn-build-1_default"}
	  }
	}`
	got := strings.Join(composeViolations([]byte(raw), dir, "pn-build-1"), "\n")
	for _, want := range []string{
		"compose project name must be pn-build-1", "ports", "sysctls", "ulimits", "extra_hosts", "cgroup_parent",
		"build.network: host", "build.privileged", "build.extra_hosts",
		"volume stolen", "network ext", "network named", "network weird: driver macvlan",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing violation %q in:\n%s", want, got)
		}
	}
	for _, unwanted := range []string{"volume mine", "network default"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("false positive %q in:\n%s", unwanted, got)
		}
	}
}

func TestComposeViolationsAllowsEmptyOptionalFields(t *testing.T) {
	dir := t.TempDir()
	raw := `{"name": "pn-build-1", "services": {"web": {"image": "pn-build-1-web:latest", "ports": null, "sysctls": {}, "ulimits": null, "extra_hosts": [],
	  "build": {"context": "` + dir + `", "network": "default"}}},
	  "networks": {"default": {"name": "pn-build-1_default"}},
	  "volumes": {"data": {"name": "pn-build-1_data"}}}`
	if v := composeViolations([]byte(raw), dir, "pn-build-1"); len(v) > 0 {
		t.Fatalf("empty optional fields must not be flagged: %v", v)
	}
}

func TestComposeProjectIsFixedPerProject(t *testing.T) {
	if got := composeProject("A1b2-C3"); got != "pn-a1b2-c3" {
		t.Fatalf("composeProject = %q", got)
	}
	if got := composeProject("x y/../z"); strings.ContainsAny(got, " /.") {
		t.Fatalf("project name must be a safe compose identifier, got %q", got)
	}
}

func TestComposeFileNameIsSharedByPolicyAndUp(t *testing.T) {
	dir := t.TempDir()
	if composeFileName(dir) != "" || Detect(dir) == MethodCompose {
		t.Fatal("no compose file → not compose")
	}
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yaml"), []byte("services: {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if composeFileName(dir) != "docker-compose.yaml" || Detect(dir) != MethodCompose {
		t.Fatal(".yaml-only repo must resolve to that file")
	}
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("services: {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if composeFileName(dir) != "docker-compose.yml" {
		t.Fatal(".yml wins when both exist, deterministically")
	}
}

func TestGitAuthEnvOnlyForGitHubOverHTTPS(t *testing.T) {
	for _, u := range []string{
		"http://github.com/o/r.git",               // plaintext
		"https://evil.example/o/r.git",            // other host
		"https://github.com.evil.example/o/r.git", // look-alike
		"https://user:pw@github.com/o/r.git",      // embedded credentials
		"https://github.com:8443/o/r.git",         // other port
		"ssh://git@github.com/o/r.git",
	} {
		if env := gitAuthEnv(u, "ghp_secret"); env != nil {
			t.Errorf("token must not be sent for %s, got %v", u, env)
		}
	}
	env := strings.Join(gitAuthEnv("https://GitHub.com/o/r.git", "ghp_secret"), "\n")
	if !strings.Contains(env, "GIT_CONFIG_KEY_0=http.https://github.com/.extraheader") {
		t.Errorf("github.com over https must be authenticated:\n%s", env)
	}
}

func TestAppHardeningArgs(t *testing.T) {
	t.Setenv("PULSENODE_APP_MEMORY", "")
	t.Setenv("PULSENODE_APP_CPUS", "")
	t.Setenv("PULSENODE_APP_PIDS", "")
	joined := " " + strings.Join(appHardeningArgs(), " ") + " "
	for _, want := range []string{
		" --cap-drop ALL ", " --cap-add NET_BIND_SERVICE ", " --security-opt no-new-privileges ",
		" --memory 1g ", " --pids-limit 1024 ", " --log-opt max-size=10m ", " --log-opt max-file=3 ",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in%s", want, joined)
		}
	}
	if strings.Contains(joined, "--cpus") || strings.Contains(joined, "SYS_ADMIN") {
		t.Errorf("unexpected flags:%s", joined)
	}

	t.Setenv("PULSENODE_APP_MEMORY", "512m")
	t.Setenv("PULSENODE_APP_CPUS", "1.5")
	t.Setenv("PULSENODE_APP_PIDS", "unlimited")
	joined = " " + strings.Join(appHardeningArgs(), " ") + " "
	if !strings.Contains(joined, " --memory 512m ") || !strings.Contains(joined, " --cpus 1.5 ") || strings.Contains(joined, "--pids-limit") {
		t.Errorf("env overrides not applied:%s", joined)
	}
}

func TestRunEnvKeepsOutputTail(t *testing.T) {
	var got []string
	cfg := Config{Log: func(stream, line string) { got = append(got, stream+":"+line) }}
	// A long unterminated last line and a >64KB line: both used to be lost or to stall the scan.
	long := strings.Repeat("x", 100_000) // one arg must stay under the kernel's 128KB limit
	err := cfg.runEnv(context.Background(), "", nil, "sh", "-c", "echo first; echo "+long+"; printf tail-without-newline; echo err >&2; exit 3")
	if err == nil {
		t.Fatal("exit 3 must surface as an error")
	}
	joined := strings.Join(got, "\n")
	for _, want := range []string{"stdout:first", "stdout:" + long, "stdout:tail-without-newline", "stderr:err"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %.40q in output", want)
		}
	}
}

func TestComposeAllowListRejectsUnknownServiceOptions(t *testing.T) {
	dir := t.TempDir()
	raw := `{"services": {"app": {
	  "image": "alpine",
	  "use_api_socket": true,
	  "device_cgroup_rules": ["b *:* rwm"],
	  "runtime": "nvidia", "gpus": "all",
	  "provider": {"type": "evil"},
	  "post_start": [{"command": "id", "privileged": true}],
	  "container_name": "pulsenode-go-api-1",
	  "dns": ["10.0.0.1"], "external_links": ["panel_db_1"],
	  "network_mode": "pulsenode_default",
	  "logging": {"driver": "syslog"},
	  "shm_size": "4g",
	  "deploy": {"resources": {"reservations": {"devices": [{"capabilities": ["gpu"]}]}}, "placement": {"constraints": ["x"]}}
	}}, "include": ["../other.yml"]}`
	got := strings.Join(composeViolations([]byte(raw), dir, "pn-build-1"), "\n")
	for _, want := range []string{
		"app: use_api_socket is not allowed", "app: device_cgroup_rules is not allowed",
		"app: runtime is not allowed", "app: gpus is not allowed", "app: provider is not allowed",
		"app: post_start is not allowed", "app: container_name is not allowed",
		"app: dns is not allowed", "app: external_links is not allowed",
		"network_mode: pulsenode_default", "logging driver syslog", "shm_size above",
		"reservations.devices", "deploy.placement is not allowed", "top-level include is not allowed",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing violation %q in:\n%s", want, got)
		}
	}
}

func TestComposeRejectsForeignImagesAndBuildOptions(t *testing.T) {
	dir := t.TempDir()
	raw := `{"services": {
	  "a": {"image": "pulsenode-go-api:latest"},
	  "b": {"image": "docker.io/library/pn-other-app:3f9a2c1"},
	  "c": {"image": "pn-other-app:3f9a2c1"},
	  "d": {"image": "nginx", "build": {"context": "` + dir + `"}},
	  "e": {"build": {"context": "` + dir + `", "tags": ["pn-other-app:abc"], "entitlements": ["security.insecure"],
	        "ssh": ["default"], "cache_to": ["type=registry,ref=evil/x"], "cache_from": ["type=local,src=/workspace"],
	        "dockerfile": "/workspace/.env.local"}}
	}}`
	got := strings.Join(composeViolations([]byte(raw), dir, "pn-build-1"), "\n")
	for _, want := range []string{
		"a: image pulsenode-go-api", "b: image docker.io/library/pn-other-app", "c: image pn-other-app",
		"d: image nginx", "e: build tag pn-other-app", "e: build.entitlements is not allowed",
		"e: build.ssh is not allowed", "e: build.cache_to is not allowed", "e: build.cache_from",
		"e: build.dockerfile outside the repository",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing violation %q in:\n%s", want, got)
		}
	}
}

func TestComposeAllowsImagesOwnedByTheProject(t *testing.T) {
	dir := t.TempDir()
	raw := `{"services": {
	  "web": {"build": {"context": "` + dir + `", "tags": ["pn-build-1-web:v2"]}, "image": "pn-build-1-web:v2"},
	  "db": {"image": "postgres:16"},
	  "cache": {"image": "ghcr.io/acme/pn-tools:1"}
	}}`
	if v := composeViolations([]byte(raw), dir, "pn-build-1"); len(v) > 0 {
		t.Fatalf("own / public images rejected: %v", v)
	}
}

func TestComposeRejectsSecretsFromEnvironmentAndCustomDrivers(t *testing.T) {
	dir := t.TempDir()
	raw := `{"services": {"a": {"image": "alpine"}},
	  "secrets": {"jwt": {"environment": "JWT_SECRET"}},
	  "configs": {"c": {"environment": "AES_KEY"}},
	  "volumes": {"v": {"name": "pn-build-1_v", "driver": "rexray/s3fs"}}}`
	got := strings.Join(composeViolations([]byte(raw), dir, "pn-build-1"), "\n")
	for _, want := range []string{"secret jwt: environment source", "config c: environment source", "volume v: driver rexray/s3fs"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing violation %q in:\n%s", want, got)
		}
	}
}

// A realistic web + db + redis stack, as `docker compose config --format json`
// would print it, must keep working under the allow-list.
func TestComposeRealisticStackPasses(t *testing.T) {
	dir := t.TempDir()
	raw := `{
	  "name": "pn-build-1",
	  "services": {
	    "web": {
	      "build": {"context": "` + dir + `", "dockerfile": "Dockerfile", "target": "prod", "args": {"NODE_ENV": "production"}, "network": "default"},
	      "command": ["node", "server.js"],
	      "depends_on": {"db": {"condition": "service_healthy", "required": true}, "cache": {"condition": "service_started", "required": true}},
	      "env_file": [{"path": "` + filepath.Join(dir, ".env") + `", "required": true}],
	      "environment": {"DATABASE_URL": "postgres://app@db/app", "PORT": "3000"},
	      "expose": ["3000"],
	      "healthcheck": {"test": ["CMD", "wget", "-qO-", "http://localhost:3000/health"], "interval": "30s", "timeout": "5s", "retries": 3},
	      "networks": {"default": null},
	      "restart": "unless-stopped",
	      "labels": {"com.example.team": "web"},
	      "deploy": {"resources": {"limits": {"cpus": 0.5, "memory": "536870912"}}, "replicas": 1},
	      "init": true, "stop_grace_period": "30s", "user": "1000:1000", "working_dir": "/app",
	      "logging": {"driver": "json-file", "options": {"max-size": "10m"}},
	      "volumes": [{"type": "volume", "source": "uploads", "target": "/app/uploads", "volume": {}}],
	      "ports": null, "privileged": false, "cap_add": null, "devices": null, "sysctls": {}
	    },
	    "db": {
	      "image": "postgres:16-alpine",
	      "environment": {"POSTGRES_PASSWORD": "x"},
	      "healthcheck": {"test": ["CMD-SHELL", "pg_isready -U app"], "interval": "10s"},
	      "networks": {"default": null}, "restart": "unless-stopped", "shm_size": "134217728",
	      "volumes": [{"type": "volume", "source": "pgdata", "target": "/var/lib/postgresql/data", "volume": {}}]
	    },
	    "cache": {"image": "redis:7-alpine", "command": ["redis-server", "--appendonly", "yes"], "networks": {"default": null}, "tmpfs": ["/tmp"], "read_only": true}
	  },
	  "networks": {"default": {"name": "pn-build-1_default", "ipam": {}}},
	  "volumes": {"uploads": {"name": "pn-build-1_uploads"}, "pgdata": {"name": "pn-build-1_pgdata"}}
	}`
	if v := composeViolations([]byte(raw), dir, "pn-build-1"); len(v) > 0 {
		t.Fatalf("realistic compose stack rejected: %v", v)
	}
}

func TestDetectIgnoresSymlinkedComposeFileAndDirs(t *testing.T) {
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "docker-compose.yml"), []byte("services: {}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "Dockerfile"), []byte("FROM scratch"), 0o600); err != nil {
		t.Fatal(err)
	}

	repo := t.TempDir()
	if err := os.Symlink(filepath.Join(outside, "docker-compose.yml"), filepath.Join(repo, "docker-compose.yml")); err != nil {
		t.Fatal(err)
	}
	if got := composeFileName(repo); got != "" {
		t.Fatalf("compose file symlinked outside the repo must be ignored, got %q", got)
	}

	mono := t.TempDir()
	if err := os.Mkdir(filepath.Join(mono, "backend"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mono, "backend", "Dockerfile"), []byte("FROM scratch"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(mono, "frontend")); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := DetectMonorepo(mono); ok {
		t.Fatal("a frontend/ symlinked outside the repo must not make a monorepo")
	}

	// A symlink that stays inside the repo is still not followed as a build dir.
	inner := t.TempDir()
	for _, d := range []string{"real", "backend"} {
		if err := os.Mkdir(filepath.Join(inner, d), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(inner, d, "Dockerfile"), []byte("FROM scratch"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(inner, "real"), filepath.Join(inner, "frontend")); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := DetectMonorepo(inner); ok {
		t.Fatal("symlinked build directories must not be followed")
	}
}
