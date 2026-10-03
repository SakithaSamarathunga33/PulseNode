package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"pulsenode/backend/internal/db"
)

type updateState struct {
	mu        sync.RWMutex
	running   bool
	log       []string
	err       *string
	startedAt *time.Time
	rec       *updateRecord // the update this process started; nil in a fresh process
}

var globalUpdate = &updateState{}

// setUpdatePhase records progress both in memory and on disk (the in-memory
// state is lost when the container is swapped).
func setUpdatePhase(phase string, mutate func(*updateRecord)) {
	globalUpdate.mu.Lock()
	defer globalUpdate.mu.Unlock()
	if globalUpdate.rec == nil {
		return
	}
	globalUpdate.rec.Phase = phase
	if mutate != nil {
		mutate(globalUpdate.rec)
	}
	_ = writeJSONFile(updateRecordPath(), globalUpdate.rec, 0o600)
}

func (s *Server) updateStatus(w http.ResponseWriter, r *http.Request) {
	globalUpdate.mu.RLock()
	running := globalUpdate.running
	logLines := append([]string{}, globalUpdate.log...)
	errMsg := globalUpdate.err
	startedAt := globalUpdate.startedAt
	var rec *updateRecord
	if globalUpdate.rec != nil {
		c := *globalUpdate.rec
		rec = &c
	}
	globalUpdate.mu.RUnlock()

	// A fresh process (after the swap) has no memory of the update: read the
	// persisted record and the updater's verdict.
	if rec == nil {
		var persisted updateRecord
		if readJSONFile(updateRecordPath(), &persisted) {
			rec = &persisted
		}
	}
	var res *updateResult
	if rec != nil {
		var rr updateResult
		if readJSONFile(updateResultPath(), &rr) {
			res = &rr
		}
	}
	view := mergeUpdateResult(rec, res)
	if len(logLines) == 0 && len(view.Log) > 0 {
		logLines = view.Log
	}
	if errMsg == nil && view.Error != "" {
		e := view.Error
		errMsg = &e
	}
	if startedAt == nil && rec != nil {
		t := rec.StartedAt
		startedAt = &t
	}

	out := map[string]any{
		"running":         running,
		"log":             logLines,
		"error":           errMsg,
		"startedAt":       startedAt,
		"phase":           view.Phase,
		"rolledBack":      view.RolledBack,
		"rollbackHealthy": view.RollbackHealthy,
		"finishedAt":      view.FinishedAt,
		"snapshots":       []db.SnapshotInfo{},
	}
	if rec != nil {
		out["fromVersion"], out["toVersion"], out["imageTag"] = rec.FromVersion, rec.ToVersion, rec.ImageTag
		out["snapshotPath"] = rec.SnapshotPath
	}
	if s.db != nil {
		out["snapshots"] = s.db.ListSnapshots()
		if rec != nil && rec.SchemaBefore != "" && (view.Phase == "done" || view.Phase == "rolled_back") {
			out["schemaChanged"] = s.db.SchemaFingerprint() != rec.SchemaBefore
		}
	}
	writeJSON(w, http.StatusOK, out)
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
	globalUpdate.rec = &updateRecord{ID: newUpdateID(), StartedAt: now, Phase: "preflight"}
	globalUpdate.mu.Unlock()

	go func() {
		defer func() {
			if r := recover(); r != nil {
				updateFail(fmt.Sprintf("update crashed: %v", r))
			}
		}()
		s.runUpdate()
	}()

	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}

// restartSelf restarts this container shortly after the HTTP response is sent.
// A variable so tests do not touch docker.
var restartSelf = func() bool {
	host, err := os.Hostname()
	if err != nil || host == "" {
		return false
	}
	go func() {
		time.Sleep(1500 * time.Millisecond)
		_ = exec.Command("docker", "restart", host).Run()
	}()
	return true
}

// restoreSnapshot stages a database restore from a pre-update snapshot and
// restarts go-api to apply it. It is deliberately manual: the update never
// restores data on its own (a rollback keeps the live database, because
// restoring would lose everything written since the snapshot).
func (s *Server) restoreSnapshot(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Snapshot string `json:"snapshot"`
		Confirm  string `json:"confirm"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.Confirm != "restore" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `confirmation required: send {"confirm":"restore"}`})
		return
	}
	if s.db == nil || !db.ValidSnapshotName(body.Snapshot) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown snapshot"})
		return
	}
	globalUpdate.mu.RLock()
	updating := globalUpdate.running
	globalUpdate.mu.RUnlock()
	if updating || (s.queue != nil && s.queue.Busy()) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "an update or deployment is running — try again when it finishes"})
		return
	}
	if err := s.db.StageRestore(body.Snapshot); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	// The swap happens at startup, so restart this container (docker restarts it
	// under `restart: unless-stopped`). If that fails the operator restarts it.
	restarting := restartSelf()
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "restartRequired": true, "restarting": restarting})
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
	if globalUpdate.rec != nil {
		globalUpdate.rec.Phase, globalUpdate.rec.Error = "failed", msg
		_ = writeJSONFile(updateRecordPath(), globalUpdate.rec, 0o600)
	}
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

func gitOut(workspace string, args ...string) (string, error) {
	out, err := exec.Command("git", append([]string{"-C", workspace, "-c", "safe.directory=" + workspace}, args...)...).Output()
	return strings.TrimSpace(string(out)), err
}

// collectComposeImages records, per compose service of this project, which image
// reference it runs and that image's immutable id.
func collectComposeImages(projectName string) []composeImage {
	ids, err := exec.Command("docker", "ps", "-a", "--filter", "label=com.docker.compose.project="+projectName, "--format", "{{.ID}}").Output()
	if err != nil {
		return nil
	}
	var imgs []composeImage
	seen := map[string]bool{}
	for _, id := range strings.Fields(string(ids)) {
		out, err := exec.Command("docker", "inspect", "--format",
			`{{index .Config.Labels "com.docker.compose.service"}}|{{.Config.Image}}|{{.Image}}`, id).Output()
		if err != nil {
			continue
		}
		f := strings.SplitN(strings.TrimSpace(string(out)), "|", 3)
		if len(f) != 3 || f[0] == "" || seen[f[0]] {
			continue
		}
		seen[f[0]] = true
		imgs = append(imgs, composeImage{Service: f[0], Ref: f[1], ID: f[2]})
	}
	return imgs
}

// protectImages tags the images being replaced so a later `docker image prune`
// (or the tag moving to the new image) cannot delete what a rollback needs.
func protectImages(imgs []composeImage) {
	for _, img := range imgs {
		if img.ID == "" {
			continue
		}
		if out, err := exec.Command("docker", "tag", img.ID, "pulsenode-rollback:"+img.Service).CombinedOutput(); err != nil {
			updateLog(fmt.Sprintf("⚠ could not protect the current %s image for rollback: %v (%s)", img.Service, err, strings.TrimSpace(string(out))))
		}
	}
}

func (s *Server) runUpdate() {
	workspace := workspaceDir() // /workspace inside the container

	// Check git is available and project is a git repo
	if _, err := os.Stat(workspace + "/.git"); err != nil {
		updateFail(fmt.Sprintf("Project directory not found at %s — was PulseNode installed via install.sh?", workspace))
		return
	}

	// ---- Preflight: record where we are, before touching anything -------------
	setUpdatePhase("preflight", nil)
	updateLog(":: phase :: Checking the current installation…")
	_ = os.Remove(updateResultPath()) // a previous update's verdict must not be mistaken for this one

	envVars := loadDotEnv(workspace + "/.env.local")
	fromVersion := installedVersion()
	prevCommit, _ := gitOut(workspace, "rev-parse", "HEAD")
	dirtyOut, _ := gitOut(workspace, "status", "--porcelain", "--untracked-files=no")
	preDirty := dirtyOut != ""
	prevTag := envVarVal(envVars, "PULSENODE_IMAGE_TAG")
	prevBoot := processStart.UnixMilli()
	updateLog(fmt.Sprintf("Running v%s (%s)", fromVersion, shortID(prevCommit)))
	if preDirty {
		updateLog("⚠ The install directory has local changes to tracked files; they will never be discarded, so a failed update can only roll back the images.")
	}

	installDir := envVarVal(envVars, "PULSENODE_INSTALL_DIR")
	if installDir == "" {
		installDir = workspace
	}
	projectName := filepath.Base(installDir)
	prevImages := collectComposeImages(projectName)

	// ---- Pin: only update to a release whose images exist ----------------------
	ghcrFile := workspace + "/docker-compose.ghcr.yml"
	ghcrData, ghcrErr := os.ReadFile(ghcrFile)
	pinTag := ""
	if ghcrErr == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		d := newReleaseResolver().resolvePin(ctx, string(ghcrData))
		cancel()
		switch d.Action {
		case "refuse":
			updateFail(d.Message)
			return
		case "fallback":
			updateLog("⚠ " + d.Message + " — falling back to the :latest images (not pinned to a release).")
		default:
			pinTag = d.Tag
			updateLog("✓ Release " + pinTag + " is published — the update will be pinned to it")
		}
	}

	// ---- Snapshot: a restorable copy of the database ----------------------------
	setUpdatePhase("snapshot", nil)
	updateLog(":: phase :: Saving a database snapshot…")
	if s.db == nil {
		updateFail("no database handle — update aborted before changing anything")
		return
	}
	snapPath, err := s.db.Snapshot()
	if err != nil {
		updateFail("could not snapshot the database, so the update was aborted before changing anything: " + err.Error())
		return
	}
	updateLog("✓ Snapshot saved: " + filepath.Base(snapPath))
	protectImages(prevImages)
	setUpdatePhase("pulling", func(r *updateRecord) {
		r.FromVersion, r.PrevCommit, r.PrevBoot = fromVersion, prevCommit, prevBoot
		r.SnapshotPath, r.SchemaBefore = snapPath, s.db.SchemaFingerprint()
	})

	// Step 1: git pull
	// -c safe.directory bypasses ownership mismatch when the container user differs from the host file owner.
	updateLog(":: phase :: Pulling latest code from GitHub…")
	if err := streamCmd("git", "-C", workspace, "-c", "safe.directory="+workspace, "pull", "--ff-only"); err != nil {
		updateFail("git pull failed: " + err.Error())
		return
	}
	postCommit, _ := gitOut(workspace, "rev-parse", "HEAD")
	toVersion := installedVersion()
	if pinTag != "" {
		toVersion = strings.TrimPrefix(pinTag, "v")
	}
	setUpdatePhase("pulling", func(r *updateRecord) { r.PostCommit, r.ToVersion = postCommit, toVersion })
	updateLog("✓ Code updated")

	// Step 2: restart containers — prefer pre-built GHCR images, fall back to source build
	updateLog(":: phase :: Updating containers…")
	updateLog("⚠ The dashboard will go offline for ~30-90s during the restart.")

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

	// COMPOSE_FILE uses container-readable paths (/workspace/...) so compose
	// can parse the files, while COMPOSE_PROJECT_DIR uses the host path so that
	// relative volume binds resolve correctly on the host. COMPOSE_PROJECT_NAME
	// ensures we update the existing containers instead of creating a parallel project.
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

	if ghcrErr == nil {
		ghcrFiles := append(append([]string{}, baseFiles...), ghcrFile)
		ghcrEnv := append(append([]string{}, envVars...),
			"COMPOSE_FILE="+strings.Join(ghcrFiles, ":"),
			"COMPOSE_PROJECT_DIR="+installDir,
			"COMPOSE_PROJECT_NAME="+projectName,
		)
		if pinTag != "" {
			ghcrEnv = append(ghcrEnv, "PULSENODE_IMAGE_TAG="+pinTag) // later entry wins
		} else {
			updateLog("⚠ Not pinned to a release: pulling :latest")
		}
		pullArgs := append(append([]string{}, composePrefix...), "pull")
		updateLog("Pulling pre-built images from GitHub Container Registry…")
		if err := streamCmdEnv(ghcrEnv, composeBin, pullArgs...); err == nil {
			updateLog("✓ Images pulled — handing off to background updater…")
			pinned := false
			if pinTag != "" {
				// Persist the pin only now that the pinned images are really here.
				if err := setEnvFileVar(workspace+"/.env.local", "PULSENODE_IMAGE_TAG", pinTag, false); err != nil {
					updateLog("⚠ could not record the pinned tag in .env.local: " + err.Error())
				} else {
					pinned = true
				}
				envVars = loadDotEnv(workspace + "/.env.local")
			}
			hostFiles := toHostPaths(ghcrFiles, workspace, installDir)
			s.handOff(envVars, hostFiles, installDir, projectName, handoff{
				prevBoot: prevBoot, prevCommit: prevCommit, postCommit: postCommit, preDirty: preDirty,
				prevImages: prevImages, prevTag: prevTag, pinned: pinned, pinTag: pinTag,
			})
			return
		}
		updateLog("Pre-built images unavailable — building from source instead…")
	}

	updateLog("Building from source (this takes ~2-3 min)…")
	setUpdatePhase("building", nil)
	// Build is safe to stream in-process — it doesn't recreate containers.
	buildArgs := append(append([]string{}, composePrefix...), "build")
	if err := streamCmdEnv(baseEnv, composeBin, buildArgs...); err != nil {
		updateFail("docker compose build failed: " + err.Error())
		return
	}
	updateLog("✓ Built — handing off to background updater…")
	hostFiles := toHostPaths(baseFiles, workspace, installDir)
	s.handOff(envVars, hostFiles, installDir, projectName, handoff{
		prevBoot: prevBoot, prevCommit: prevCommit, postCommit: postCommit, preDirty: preDirty,
		prevImages: prevImages, prevTag: prevTag,
	})
}

type handoff struct {
	prevBoot               int64
	prevCommit, postCommit string
	preDirty               bool
	prevImages             []composeImage
	prevTag, pinTag        string
	pinned                 bool
}

func (s *Server) handOff(envVars, hostFiles []string, installDir, projectName string, h handoff) {
	setUpdatePhase("switching", func(r *updateRecord) {
		r.Pinned, r.ImageTag = h.pinned, h.pinTag
	})
	globalUpdate.mu.RLock()
	id := globalUpdate.rec.ID
	globalUpdate.mu.RUnlock()
	b := func(v bool) string {
		if v {
			return "1"
		}
		return "0"
	}
	extra := []string{
		"PN_UPDATE_ID=" + id,
		"PN_RESULT_FILE=" + installDir + "/.pulsenode/update-result.json",
		"PN_ENV_FILE=" + installDir + "/.env.local",
		"PN_REPO_DIR=" + installDir,
		"PN_PREV_BOOT=" + strconv.FormatInt(h.prevBoot, 10),
		"PN_PREV_COMMIT=" + h.prevCommit,
		"PN_POST_COMMIT=" + h.postCommit,
		"PN_PRE_DIRTY=" + b(h.preDirty),
		"PN_PREV_IMAGES=" + encodeImages(h.prevImages),
		"PN_PREV_TAG=" + h.prevTag,
		"PN_PINNED=" + b(h.pinned),
	}
	if err := runDetachedComposeUp(envVars, hostFiles, installDir, projectName, extra); err != nil {
		updateFail("failed to start background updater: " + err.Error())
		return
	}
	updateLog("✓ Updater started — it will verify the new version and roll back automatically if it is not healthy.")
	globalUpdate.mu.Lock()
	globalUpdate.running = false
	globalUpdate.mu.Unlock()
}

// runDetachedComposeUp spawns a sidecar container that performs the swap on our
// behalf (see update_sidecar.go). We can't run the swap in-process: compose
// recreates the go-api container, which kills the compose subprocess mid-flight
// and leaves the stack half-swapped. `docker run -d` hands the sidecar to the
// host daemon, so it survives us dying — and it stays alive afterwards to
// verify the new version and roll back if needed.
//
// The sidecar runs OUR image by immutable id (not by tag: `compose pull` has
// already moved the tag to the new image, whose code we have not vetted) with
// the `updater` argument.
//
// hostComposeFiles must be HOST-absolute paths — the sidecar talks to the host
// daemon via the mounted socket, so /workspace/... paths from our PoV are
// meaningless to it.
func runDetachedComposeUp(envVars []string, hostComposeFiles []string, installDir, projectName string, extra []string) error {
	image, err := selfImageID()
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
	for _, kv := range extra {
		args = append(args, "-e", kv)
	}
	args = append(args, image, "pulsenode", "updater")

	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker run: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// selfImageID returns the immutable image id of the currently-running container
// (read via docker inspect on $HOSTNAME, which docker sets to the container ID).
func selfImageID() (string, error) {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		return "", fmt.Errorf("read hostname: %w", err)
	}
	out, err := exec.Command("docker", "inspect", hostname, "--format", "{{.Image}}").CombinedOutput()
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
