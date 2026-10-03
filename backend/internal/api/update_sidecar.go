package api

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// The updater is a throwaway container (the OLD go-api image, started with the
// `updater` argument) that outlives the go-api it replaces. It swaps the stack,
// judges whether the new version is healthy, and if not puts the old one back.
// Everything it decides is in small pure functions so it is unit-tested; the
// docker calls go through the runFn seam.

type runFn func(extraEnv []string, name string, args ...string) (string, error)

func execRun(extraEnv []string, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), extraEnv...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

type updaterConfig struct {
	ID            string
	ResultFile    string
	EnvFile       string
	RepoDir       string
	PrevBoot      int64
	PrevCommit    string
	PostCommit    string
	PreDirty      bool
	PrevImages    []composeImage
	PrevTag       string
	Pinned        bool
	HealthTimeout time.Duration
}

func updaterConfigFromEnv(get func(string) string) updaterConfig {
	boot, _ := strconv.ParseInt(get("PN_PREV_BOOT"), 10, 64)
	secs, _ := strconv.Atoi(get("PN_HEALTH_TIMEOUT"))
	if secs <= 0 {
		secs = 120
	}
	return updaterConfig{
		ID: get("PN_UPDATE_ID"), ResultFile: get("PN_RESULT_FILE"), EnvFile: get("PN_ENV_FILE"),
		RepoDir: get("PN_REPO_DIR"), PrevBoot: boot, PrevCommit: get("PN_PREV_COMMIT"),
		PostCommit: get("PN_POST_COMMIT"), PreDirty: get("PN_PRE_DIRTY") == "1",
		PrevImages: parseImages(get("PN_PREV_IMAGES")), PrevTag: get("PN_PREV_TAG"),
		Pinned: get("PN_PINNED") == "1", HealthTimeout: time.Duration(secs) * time.Second,
	}
}

// RunUpdater is the entry point for `pulsenode updater`. Returns the exit code.
func RunUpdater() int {
	u := &updater{cfg: updaterConfigFromEnv(os.Getenv), run: execRun, sleep: time.Sleep, now: time.Now}
	if u.cfg.ID == "" || u.cfg.ResultFile == "" {
		fmt.Fprintln(os.Stderr, "updater: PN_UPDATE_ID / PN_RESULT_FILE missing")
		return 2
	}
	res := u.Run()
	if err := writeJSONFile(u.cfg.ResultFile, res, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "updater: cannot write result:", err)
	}
	if res.OK {
		return 0
	}
	return 1
}

type updater struct {
	cfg   updaterConfig
	run   runFn
	sleep func(time.Duration)
	now   func() time.Time
	log   []string
}

func (u *updater) logf(format string, a ...any) {
	line := fmt.Sprintf(format, a...)
	u.log = append(u.log, line)
	fmt.Println(line)
}

// healthSample is one observation of the stack.
type healthSample struct {
	GoAPIFound  bool
	GoAPIState  string // running | exited | restarting | …
	GoAPIHealth string // healthy | starting | unhealthy | none
	Boot        int64  // startedAt from /health; 0 = not answering
	WebFound    bool
	WebState    string
	WebHealth   string
}

// healthVerdict says whether a sample counts as a healthy new version. With
// requireNewBoot the old process (same boot id) does not count — that is how a
// build-while-serving window is told apart from a finished swap.
func healthVerdict(s healthSample, prevBoot int64, requireNewBoot bool) (bool, string) {
	switch {
	case !s.GoAPIFound:
		return false, "go-api container not found"
	case s.GoAPIState != "running":
		return false, "go-api is " + s.GoAPIState
	case s.GoAPIHealth == "unhealthy":
		return false, "go-api healthcheck reports unhealthy"
	case s.GoAPIHealth == "starting":
		return false, "go-api healthcheck still starting"
	case s.Boot == 0:
		return false, "go-api /health is not answering"
	case requireNewBoot && s.Boot == prevBoot:
		return false, "go-api has not restarted yet (still the previous process)"
	}
	if s.WebFound {
		switch {
		case s.WebState != "running":
			return false, "web is " + s.WebState
		case s.WebHealth == "unhealthy":
			return false, "web healthcheck reports unhealthy"
		case s.WebHealth == "starting":
			return false, "web healthcheck still starting"
		}
	}
	return true, ""
}

// waitHealthy polls probe until healthy or the timeout; returns the last reason on failure.
func waitHealthy(probe func() healthSample, prevBoot int64, requireNewBoot bool, timeout, interval time.Duration, sleep func(time.Duration), now func() time.Time) (bool, string) {
	deadline := now().Add(timeout)
	reason := "no health sample taken"
	for {
		ok, why := healthVerdict(probe(), prevBoot, requireNewBoot)
		if ok {
			return true, ""
		}
		reason = why
		if !now().Before(deadline) {
			return false, fmt.Sprintf("not healthy after %s: %s", timeout, reason)
		}
		sleep(interval)
	}
}

func (u *updater) serviceState(service string) (found bool, state, health string, id string) {
	idOut, err := u.run(nil, "docker", "compose", "ps", "-q", service)
	id = strings.TrimSpace(strings.SplitN(idOut, "\n", 2)[0])
	if err != nil || id == "" {
		return false, "", "", ""
	}
	out, err := u.run(nil, "docker", "inspect", "--format",
		"{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", id)
	if err != nil {
		return true, "unknown", "none", id
	}
	parts := strings.SplitN(strings.TrimSpace(out), "|", 2)
	if len(parts) != 2 {
		return true, "unknown", "none", id
	}
	return true, parts[0], parts[1], id
}

func (u *updater) probe() healthSample {
	var s healthSample
	var apiID string
	s.GoAPIFound, s.GoAPIState, s.GoAPIHealth, apiID = u.serviceState("go-api")
	if s.GoAPIFound && s.GoAPIState == "running" {
		if out, err := u.run(nil, "docker", "exec", apiID, "wget", "-q", "-O-", "http://127.0.0.1:4002/health"); err == nil {
			var h struct {
				StartedAt int64 `json:"startedAt"`
			}
			if json.Unmarshal([]byte(out), &h) == nil {
				s.Boot = h.StartedAt
			}
		}
	}
	s.WebFound, s.WebState, s.WebHealth, _ = u.serviceState("web")
	return s
}

// Run performs the swap and returns the outcome to persist.
func (u *updater) Run() updateResult {
	res := updateResult{ID: u.cfg.ID}
	finish := func() updateResult {
		res.FinishedAt = u.now().UTC()
		res.Log = u.log
		return res
	}

	// go-api answers the HTTP request that started us before we pull the rug.
	u.sleep(2 * time.Second)
	u.logf("Starting the new version…")
	reason := ""
	if out, err := u.run(nil, "docker", "compose", "up", "-d"); err != nil {
		reason = fmt.Sprintf("docker compose up failed: %v (%s)", err, tail(out, 300))
		u.logf("✗ %s", reason)
	} else {
		u.logf("Waiting up to %s for the new version to become healthy…", u.cfg.HealthTimeout)
		ok, why := waitHealthy(u.probe, u.cfg.PrevBoot, true, u.cfg.HealthTimeout, 3*time.Second, u.sleep, u.now)
		if ok {
			u.logf("✓ New version is healthy")
			res.OK = true
			return finish()
		}
		reason = why
		u.logf("✗ %s", reason)
	}

	// ---- roll back ------------------------------------------------------------
	res.RolledBack = true
	res.Error = reason
	u.logf("Rolling back to the previous version…")

	composeEnv := []string{}
	if u.cfg.Pinned {
		// Compose reads PULSENODE_IMAGE_TAG; empty means the overlay's :latest default.
		composeEnv = append(composeEnv, "PULSENODE_IMAGE_TAG="+u.cfg.PrevTag)
		if u.cfg.EnvFile != "" {
			if err := setEnvFileVar(u.cfg.EnvFile, "PULSENODE_IMAGE_TAG", u.cfg.PrevTag, u.cfg.PrevTag == ""); err != nil {
				u.logf("⚠ could not restore PULSENODE_IMAGE_TAG in .env.local: %v", err)
			}
		}
	}
	for _, img := range u.cfg.PrevImages {
		if out, err := u.run(nil, "docker", "tag", img.ID, img.Ref); err != nil {
			u.logf("⚠ could not point %s back at the old image: %v (%s)", img.Ref, err, tail(out, 200))
		} else {
			u.logf("✓ %s → previous image %s", img.Ref, shortID(img.ID))
		}
	}
	u.gitRollback()
	if out, err := u.run(composeEnv, "docker", "compose", "up", "-d", "--no-build"); err != nil {
		res.Error += fmt.Sprintf(" — rollback also failed to start: %v (%s)", err, tail(out, 300))
		u.logf("✗ rollback start failed: %v", err)
		return finish()
	}
	ok, why := waitHealthy(u.probe, 0, false, u.cfg.HealthTimeout, 3*time.Second, u.sleep, u.now)
	res.RollbackHealthy = ok
	if ok {
		u.logf("✓ Previous version is running again")
	} else {
		res.Error += " — and the previous version is not healthy either (" + why + "); manual intervention needed"
		u.logf("✗ previous version is not healthy: %s", why)
	}
	return finish()
}

func (u *updater) gitRollback() {
	if u.cfg.RepoDir == "" || u.cfg.PrevCommit == "" {
		return
	}
	git := func(args ...string) (string, error) {
		return u.run(nil, "git", append([]string{"-C", u.cfg.RepoDir, "-c", "safe.directory=" + u.cfg.RepoDir}, args...)...)
	}
	head, err := git("rev-parse", "HEAD")
	if err != nil {
		u.logf("⚠ git rollback skipped: cannot read HEAD: %v", err)
		return
	}
	status, err := git("status", "--porcelain", "--untracked-files=no")
	if err != nil {
		u.logf("⚠ git rollback skipped: cannot read status: %v", err)
		return
	}
	if !gitRollbackAllowed(u.cfg.PreDirty, u.cfg.PrevCommit, u.cfg.PostCommit, head, status == "") {
		u.logf("git rollback skipped (nothing pulled, or the working tree has local changes that must not be discarded) — restoring images only")
		return
	}
	if out, err := git("reset", "--hard", u.cfg.PrevCommit); err != nil {
		u.logf("⚠ git reset failed: %v (%s)", err, tail(out, 200))
		return
	}
	u.logf("✓ working tree restored to %s", shortID(u.cfg.PrevCommit))
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}

func shortID(s string) string {
	s = strings.TrimPrefix(s, "sha256:")
	if len(s) > 12 {
		return s[:12]
	}
	return s
}
