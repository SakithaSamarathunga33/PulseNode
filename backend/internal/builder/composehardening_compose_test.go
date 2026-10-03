package builder

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Runs the generator against the real `docker compose` (skipped when it is not
// installed): the overlay must be accepted, must merge without "distinct values"
// conflicts, and must not override what the service set itself.
func TestHardeningOverlayAcceptedByRealCompose(t *testing.T) {
	if err := exec.Command("docker", "compose", "version").Run(); err != nil {
		t.Skip("docker compose not available")
	}
	clearAppLimitEnv(t)
	dir := t.TempDir()
	user := `
services:
  web:
    image: nginx:1.27
  api:
    image: node:20
    mem_limit: 256m
    cap_drop: [NET_RAW]
    logging:
      driver: local
  db:
    image: postgres:16
    deploy:
      resources:
        limits:
          memory: 512M
          pids: 200
`
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte(user), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	run := func(args ...string) []byte {
		cmd := exec.CommandContext(ctx, "docker", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("docker %v: %v\n%s", args, err, out)
		}
		return out
	}
	base := run("compose", "-p", "pn-test", "-f", "docker-compose.yml", "config", "--format", "json", "--no-env-resolution")
	overlay, err := composeHardeningOverlay(base)
	if err != nil || overlay == nil {
		t.Fatalf("overlay: %v %q", err, overlay)
	}
	if err := os.WriteFile(filepath.Join(dir, composeHardeningFile), overlay, 0o644); err != nil {
		t.Fatal(err)
	}
	merged := run("compose", "-p", "pn-test", "-f", "docker-compose.yml", "-f", composeHardeningFile,
		"config", "--format", "json", "--no-env-resolution")
	var cfg struct {
		Services map[string]struct {
			MemLimit    json.RawMessage `json:"mem_limit"`
			PidsLimit   json.RawMessage `json:"pids_limit"`
			CapDrop     []string        `json:"cap_drop"`
			CapAdd      []string        `json:"cap_add"`
			SecurityOpt []string        `json:"security_opt"`
			Logging     struct {
				Driver  string            `json:"driver"`
				Options map[string]string `json:"options"`
			} `json:"logging"`
		} `json:"services"`
	}
	if err := json.Unmarshal(merged, &cfg); err != nil {
		t.Fatal(err)
	}

	web := cfg.Services["web"]
	if len(web.CapDrop) != 1 || web.CapDrop[0] != "ALL" || len(web.CapAdd) != len(appCaps) {
		t.Errorf("web caps: drop=%v add=%v", web.CapDrop, web.CapAdd)
	}
	if unq(web.MemLimit) != "1073741824" || unq(web.PidsLimit) != "1024" {
		t.Errorf("web limits: mem=%s pids=%s", web.MemLimit, web.PidsLimit)
	}
	if web.Logging.Driver != "json-file" || web.Logging.Options["max-size"] != "10m" || web.Logging.Options["max-file"] != "3" {
		t.Errorf("web logging: %+v", web.Logging)
	}
	if len(web.SecurityOpt) != 1 || web.SecurityOpt[0] != "no-new-privileges:true" {
		t.Errorf("web security_opt: %v", web.SecurityOpt)
	}

	api := cfg.Services["api"]
	if unq(api.MemLimit) != "268435456" {
		t.Errorf("api mem_limit must stay the user's 256m, got %s", api.MemLimit)
	}
	if len(api.CapDrop) != 1 || api.CapDrop[0] != "NET_RAW" || len(api.CapAdd) != 0 {
		t.Errorf("api chose its own cap_drop; got drop=%v add=%v", api.CapDrop, api.CapAdd)
	}
	if api.Logging.Driver != "local" {
		t.Errorf("api logging must stay local, got %q", api.Logging.Driver)
	}
	if unq(api.PidsLimit) != "1024" {
		t.Errorf("api had no pids limit so it gets the default, got %s", api.PidsLimit)
	}

	db := cfg.Services["db"]
	if m := unq(db.MemLimit); m != "" && m != "0" && m != "null" {
		t.Errorf("db sets deploy.resources.limits.memory; mem_limit must not be added, got %s", db.MemLimit)
	}
}

// unq is a compose number as plain text (compose prints some as strings).
func unq(raw json.RawMessage) string { return strings.Trim(strings.TrimSpace(string(raw)), `"`) }
