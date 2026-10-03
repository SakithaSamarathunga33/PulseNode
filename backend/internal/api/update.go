package api

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type updateState struct {
	mu        sync.RWMutex
	running   bool
	log       []string
	err       *string
	startedAt *time.Time
}

var globalUpdate = &updateState{}

func (s *Server) updateStatus(w http.ResponseWriter, r *http.Request) {
	globalUpdate.mu.RLock()
	defer globalUpdate.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"running":   globalUpdate.running,
		"log":       globalUpdate.log,
		"error":     globalUpdate.err,
		"startedAt": globalUpdate.startedAt,
	})
}

func (s *Server) systemUpdate(w http.ResponseWriter, r *http.Request) {
	// The update recreates this very container; a deploy running now would be
	// killed mid-build and half-swapped. Make the operator wait for it.
	if s.queue != nil && s.queue.Busy() {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "a deployment is running — wait for it to finish before updating"})
		return
	}
	globalUpdate.mu.Lock()
	if globalUpdate.running {
		globalUpdate.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]string{"error": "update already in progress"})
		return
	}
	now := time.Now()
	globalUpdate.running = true
	globalUpdate.log = []string{}
	globalUpdate.err = nil
	globalUpdate.startedAt = &now
	globalUpdate.mu.Unlock()

	go func() {
		defer func() {
			if r := recover(); r != nil {
				updateFail(fmt.Sprintf("update crashed: %v", r))
			}
		}()
		runUpdate()
	}()

	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}

// maxUpdateLogLines bounds the in-memory log; the oldest lines are dropped.
const maxUpdateLogLines = 2000

func updateLog(line string) {
	globalUpdate.mu.Lock()
	globalUpdate.log = append(globalUpdate.log, line)
	if n := len(globalUpdate.log); n > maxUpdateLogLines {
		globalUpdate.log = append([]string(nil), globalUpdate.log[n-maxUpdateLogLines:]...)
	}
	globalUpdate.mu.Unlock()
}

func updateFail(msg string) {
	globalUpdate.mu.Lock()
	globalUpdate.err = &msg
	globalUpdate.running = false
	globalUpdate.mu.Unlock()
}

// loadDotEnv reads KEY=VALUE pairs from a file and returns them as a slice
// suitable for appending to exec.Cmd.Env. Comments and blank lines are ignored.
func loadDotEnv(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var vars []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.ContainsRune(line, '=') {
			vars = append(vars, line)
		}
	}
	return vars
}

// envVarVal finds the value of key in a slice of "KEY=VALUE" strings.
func envVarVal(vars []string, key string) string {
	prefix := key + "="
	for _, kv := range vars {
		if strings.HasPrefix(kv, prefix) {
			return strings.TrimPrefix(kv, prefix)
		}
	}
	return ""
}

func streamCmd(name string, args ...string) error {
	return streamCmdEnv(nil, name, args...)
}

// updateCmdTimeout bounds each update subprocess (git pull, compose pull/build).
const updateCmdTimeout = 15 * time.Minute

func streamCmdEnv(extra []string, name string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), updateCmdTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), extra...)
	cmd.WaitDelay = 10 * time.Second // same reason as builder.runEnv: never hang on a held pipe
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(stdout)
	// Compose progress output can contain very long lines; the default 64KB
	// token limit would end the scan and leave the child blocked on a full pipe.
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for scanner.Scan() {
		updateLog(scanner.Text())
	}
	// If the scan stopped early (oversized line), keep draining so the child can
	// finish, but without logging it.
	_, _ = io.Copy(io.Discard, stdout)
	err = cmd.Wait()
	if ctx.Err() == context.DeadlineExceeded {
		return fmt.Errorf("%s timed out after %s", name, updateCmdTimeout)
	}
	return err
}

// resolveCompose returns the binary and prefix args for running compose commands.
// It first checks PULSENODE_COMPOSE_BIN from the loaded env vars (set by install.sh
// to match the host's compose command), then falls back to auto-detection.
// "docker compose" → ("docker", ["compose"])
// "docker-compose"  → ("docker-compose", [])
func resolveCompose(envVars []string) (bin string, prefix []string) {
	for _, kv := range envVars {
		if strings.HasPrefix(kv, "PULSENODE_COMPOSE_BIN=") {
			val := strings.TrimPrefix(kv, "PULSENODE_COMPOSE_BIN=")
			parts := strings.Fields(val)
			if len(parts) >= 2 {
				return parts[0], parts[1:]
			}
			if len(parts) == 1 {
				return parts[0], nil
			}
		}
	}
	// Fallback: probe at runtime
	if err := exec.Command("docker", "compose", "version").Run(); err == nil {
		return "docker", []string{"compose"}
	}
	return "docker-compose", []string{}
}

func runUpdate() {
	workspace := os.Getenv("PULSENODE_WORKSPACE") // /workspace inside container
	if workspace == "" {
		workspace = "/workspace"
	}

	// Check git is available and project is a git repo
	if _, err := os.Stat(workspace + "/.git"); err != nil {
		updateFail(fmt.Sprintf("Project directory not found at %s — was PulseNode installed via install.sh?", workspace))
		return
	}

	// Step 1: git pull
	// -c safe.directory bypasses ownership mismatch when the container user differs from the host file owner.
	updateLog(":: phase :: Pulling latest code from GitHub…")
	if err := streamCmd("git", "-C", workspace, "-c", "safe.directory="+workspace, "pull", "--ff-only"); err != nil {
		updateFail("git pull failed: " + err.Error())
		return
	}
	updateLog("✓ Code updated")

	// Step 2: restart containers — prefer pre-built GHCR images, fall back to source build
	updateLog(":: phase :: Updating containers…")
	updateLog("⚠ The dashboard will go offline for ~30-90s during the restart.")

	// Load .env.local and inject as env vars — avoids relying on --env-file
	// which is not available in older Docker CLI versions.
	envVars := loadDotEnv(workspace + "/.env.local")

	// Prefer .env.local over the container's frozen env: the container's
	// PULSENODE_OVERLAY is baked at first `docker compose up` time and can
	// drift from .env.local, which silently breaks port bindings on update.
	overlay := envVarVal(envVars, "PULSENODE_OVERLAY")
	if overlay == "" {
		overlay = os.Getenv("PULSENODE_OVERLAY")
	}
	if overlay == "" {
		overlay = "docker-compose.standalone.yml"
	}

	composeBin, composePrefix := resolveCompose(envVars)
	updateLog("Using compose: " + composeBin)

	// HOST install directory — used so that relative bind-mount paths in the
	// compose files (e.g. ./Caddyfile) resolve to real host paths rather than
	// container-internal /workspace/... paths. COMPOSE_PROJECT_NAME ensures we
	// update the existing containers instead of creating a parallel project.
	installDir := envVarVal(envVars, "PULSENODE_INSTALL_DIR")
	if installDir == "" {
		installDir = workspace
	}
	projectName := filepath.Base(installDir)

	// COMPOSE_FILE uses container-readable paths (/workspace/...) so compose
	// can parse the files, while COMPOSE_PROJECT_DIR uses the host path so that
	// relative volume binds resolve correctly on the host.
	var baseFiles []string
	for _, f := range []string{workspace + "/docker-compose.yml", workspace + "/" + overlay} {
		if _, err := os.Stat(f); err == nil {
			baseFiles = append(baseFiles, f)
		}
	}

	baseEnv := append(append([]string{}, envVars...),
		"COMPOSE_FILE="+strings.Join(baseFiles, ":"),
		"COMPOSE_PROJECT_DIR="+installDir,
		"COMPOSE_PROJECT_NAME="+projectName,
	)

	ghcrFile := workspace + "/docker-compose.ghcr.yml"
	if _, err := os.Stat(ghcrFile); err == nil {
		ghcrFiles := append(append([]string{}, baseFiles...), ghcrFile)
		ghcrEnv := append(append([]string{}, envVars...),
			"COMPOSE_FILE="+strings.Join(ghcrFiles, ":"),
			"COMPOSE_PROJECT_DIR="+installDir,
			"COMPOSE_PROJECT_NAME="+projectName,
		)
		pullArgs := append(append([]string{}, composePrefix...), "pull")
		updateLog("Pulling pre-built images from GitHub Container Registry…")
		if err := streamCmdEnv(ghcrEnv, composeBin, pullArgs...); err == nil {
			updateLog("✓ Images pulled — handing off to background updater…")
			hostFiles := toHostPaths(ghcrFiles, workspace, installDir)
			if err := runDetachedComposeUp(envVars, hostFiles, installDir, projectName); err != nil {
				updateFail("failed to start background updater: " + err.Error())
				return
			}
			updateLog("✓ Updater started — dashboard will restart in a few seconds…")
			globalUpdate.mu.Lock()
			globalUpdate.running = false
			globalUpdate.mu.Unlock()
			return
		}
		updateLog("Pre-built images unavailable — building from source instead…")
	}

	updateLog("Building from source (this takes ~2-3 min)…")
	// Build is safe to stream in-process — it doesn't recreate containers.
	buildArgs := append(append([]string{}, composePrefix...), "build")
	if err := streamCmdEnv(baseEnv, composeBin, buildArgs...); err != nil {
		updateFail("docker compose build failed: " + err.Error())
		return
	}
	updateLog("✓ Built — handing off to background updater…")
	hostFiles := toHostPaths(baseFiles, workspace, installDir)
	if err := runDetachedComposeUp(envVars, hostFiles, installDir, projectName); err != nil {
		updateFail("failed to start background updater: " + err.Error())
		return
	}
	updateLog("✓ Updater started — dashboard will restart in a few seconds…")

	globalUpdate.mu.Lock()
	globalUpdate.running = false
	globalUpdate.mu.Unlock()
}

// runDetachedComposeUp spawns a sidecar container that runs `docker compose
// up -d` on our behalf. We can't run the swap in-process: compose recreates
// the go-api container, which kills the compose subprocess mid-flight and
// leaves the stack half-swapped (new container stuck in "Created", old one
// stuck in "Exited"). `docker run -d` hands the sidecar to the host daemon,
// so it survives us dying.
//
// The sidecar reuses our own image (which already ships docker-cli + compose),
// so no external image pull is needed.
//
// hostComposeFiles must be HOST-absolute paths — the sidecar talks to the host
// daemon via the mounted socket, so /workspace/... paths from our PoV are
// meaningless to it.
func runDetachedComposeUp(envVars []string, hostComposeFiles []string, installDir, projectName string) error {
	image, err := selfImage()
	if err != nil {
		return fmt.Errorf("resolve self image: %w", err)
	}

	sidecarName := projectName + "-updater"
	// Best-effort cleanup of a stale updater from a previous failed run.
	_ = exec.Command("docker", "rm", "-f", sidecarName).Run()

	args := []string{
		"run", "--rm", "-d",
		"--name", sidecarName,
		"-v", "/var/run/docker.sock:/var/run/docker.sock",
		"-v", installDir + ":" + installDir,
		"-w", installDir,
		"-e", "COMPOSE_FILE=" + strings.Join(hostComposeFiles, ":"),
		"-e", "COMPOSE_PROJECT_DIR=" + installDir,
		"-e", "COMPOSE_PROJECT_NAME=" + projectName,
	}
	for _, kv := range envVars {
		// Skip COMPOSE_* — we set explicit host-path versions above.
		if strings.HasPrefix(kv, "COMPOSE_") {
			continue
		}
		args = append(args, "-e", kv)
	}
	// The sleep gives go-api a moment to finish its in-flight HTTP response
	// before the swap begins; without it the client sees a torn connection
	// instead of the "updater started" acknowledgement.
	args = append(args, image, "sh", "-c", "sleep 2; exec docker compose up -d")

	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker run: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// selfImage returns the image of the currently-running container (read via
// docker inspect on $HOSTNAME, which docker sets to the container ID).
func selfImage() (string, error) {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		return "", fmt.Errorf("read hostname: %w", err)
	}
	out, err := exec.Command("docker", "inspect", hostname, "--format", "{{.Config.Image}}").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("inspect %s: %w (%s)", hostname, err, strings.TrimSpace(string(out)))
	}
	img := strings.TrimSpace(string(out))
	if img == "" {
		return "", fmt.Errorf("empty image for %s", hostname)
	}
	return img, nil
}

// toHostPaths rewrites container-side compose file paths (/workspace/...) to
// the equivalent host paths, so the sidecar (which talks to the host daemon)
// can resolve them.
func toHostPaths(containerFiles []string, workspace, installDir string) []string {
	out := make([]string, 0, len(containerFiles))
	for _, f := range containerFiles {
		rel := strings.TrimPrefix(f, workspace+"/")
		out = append(out, installDir+"/"+rel)
	}
	return out
}
