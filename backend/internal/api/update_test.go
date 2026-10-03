package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"pulsenode/backend/internal/db"
)

// ---- pure decisions --------------------------------------------------------------

func TestMergeUpdateResultOnlyCountsMatchingID(t *testing.T) {
	rec := &updateRecord{ID: "u1", Phase: "switching"}
	if v := mergeUpdateResult(rec, &updateResult{ID: "OLD", OK: true}); v.Phase != "switching" {
		t.Fatalf("a result from another update must be ignored, got phase %q", v.Phase)
	}
	if v := mergeUpdateResult(rec, nil); v.Phase != "switching" {
		t.Fatalf("no result yet → still switching, got %q", v.Phase)
	}
	if v := mergeUpdateResult(rec, &updateResult{ID: "u1", OK: true}); v.Phase != "done" || v.Error != "" || v.RolledBack {
		t.Fatalf("ok result → done: %+v", v)
	}
	v := mergeUpdateResult(rec, &updateResult{ID: "u1", RolledBack: true, RollbackHealthy: true, Error: "boom"})
	if v.Phase != "rolled_back" || !v.RolledBack || !v.RollbackHealthy || v.Error != "boom" {
		t.Fatalf("rolled back result: %+v", v)
	}
	if v := mergeUpdateResult(rec, &updateResult{ID: "u1", Error: "x"}); v.Phase != "failed" || v.Error != "x" {
		t.Fatalf("failed result: %+v", v)
	}
	if v := mergeUpdateResult(nil, nil); v.Phase != "idle" {
		t.Fatalf("no update ever → idle, got %q", v.Phase)
	}
}

func TestGitRollbackNeverDiscardsLocalWork(t *testing.T) {
	cases := []struct {
		name             string
		preDirty         bool
		prev, post, head string
		cleanNow, want   bool
	}{
		{"normal ff update", false, "a", "b", "b", true, true},
		{"nothing was pulled", false, "a", "a", "a", true, false},
		{"tree was dirty before the update", true, "a", "b", "b", true, false},
		{"tree is dirty now", false, "a", "b", "b", false, false},
		{"HEAD moved since the pull", false, "a", "b", "c", true, false},
		{"unknown commits", false, "", "b", "b", true, false},
	}
	for _, c := range cases {
		if got := gitRollbackAllowed(c.preDirty, c.prev, c.post, c.head, c.cleanNow); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestHealthVerdict(t *testing.T) {
	good := healthSample{GoAPIFound: true, GoAPIState: "running", GoAPIHealth: "healthy", Boot: 200, WebFound: true, WebState: "running", WebHealth: "healthy"}
	if ok, why := healthVerdict(good, 100, true); !ok {
		t.Fatalf("healthy new boot should pass: %s", why)
	}
	bad := map[string]healthSample{}
	mod := func(name string, f func(*healthSample)) { s := good; f(&s); bad[name] = s }
	mod("missing", func(s *healthSample) { s.GoAPIFound = false })
	mod("exited", func(s *healthSample) { s.GoAPIState = "exited" })
	mod("unhealthy", func(s *healthSample) { s.GoAPIHealth = "unhealthy" })
	mod("starting", func(s *healthSample) { s.GoAPIHealth = "starting" })
	mod("no /health", func(s *healthSample) { s.Boot = 0 })
	mod("old process", func(s *healthSample) { s.Boot = 100 })
	mod("web down", func(s *healthSample) { s.WebState = "restarting" })
	mod("web unhealthy", func(s *healthSample) { s.WebHealth = "unhealthy" })
	for name, s := range bad {
		if ok, _ := healthVerdict(s, 100, true); ok {
			t.Errorf("%s must not count as healthy", name)
		}
	}
	// After a rollback the boot id is unknown, so only liveness is required.
	old := good
	old.Boot = 100
	if ok, why := healthVerdict(old, 0, false); !ok {
		t.Fatalf("rollback check must not require a new boot: %s", why)
	}
	// A container without a healthcheck ("none") is judged on state + /health.
	none := good
	none.GoAPIHealth, none.WebHealth = "none", "none"
	if ok, why := healthVerdict(none, 100, true); !ok {
		t.Fatalf("no healthcheck should still pass: %s", why)
	}
}

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time        { return c.t }
func (c *fakeClock) sleep(d time.Duration) { c.t = c.t.Add(d) }

func TestWaitHealthyTimesOutAfterTheBudget(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1000, 0)}
	calls := 0
	ok, why := waitHealthy(func() healthSample { calls++; return healthSample{} }, 1, true, 120*time.Second, 3*time.Second, clk.sleep, clk.now)
	if ok || !strings.Contains(why, "not healthy after 2m0s") || !strings.Contains(why, "go-api container not found") {
		t.Fatalf("ok=%v why=%q", ok, why)
	}
	if calls < 30 || calls > 50 {
		t.Fatalf("polled %d times; expected roughly one per interval across the budget", calls)
	}
}

func TestWaitHealthyReturnsAsSoonAsHealthy(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1000, 0)}
	n := 0
	ok, _ := waitHealthy(func() healthSample {
		n++
		s := healthSample{GoAPIFound: true, GoAPIState: "running", GoAPIHealth: "starting", Boot: 5}
		if n >= 3 {
			s.GoAPIHealth = "healthy"
		}
		return s
	}, 1, true, 120*time.Second, 3*time.Second, clk.sleep, clk.now)
	if !ok || n != 3 {
		t.Fatalf("ok=%v after %d polls", ok, n)
	}
}

func TestImageRecordRoundTrip(t *testing.T) {
	in := []composeImage{
		{"go-api", "ghcr.io/o/pulsenode-go-api:v1.2.3", "sha256:aaa"},
		{"caddy", "caddy:2-alpine", "sha256:bbb"},
		{"skipped", "", "sha256:ccc"},
	}
	out := parseImages(encodeImages(in))
	if len(out) != 2 || out[0] != in[0] || out[1] != in[1] {
		t.Fatalf("round trip: %+v", out)
	}
	if len(parseImages("")) != 0 || len(parseImages("garbage,@@@@")) != 0 {
		t.Fatal("garbage must parse to nothing")
	}
}

func TestSetEnvFileVar(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env.local")
	_ = os.WriteFile(path, []byte("A=1\nPULSENODE_IMAGE_TAG=v1\nB=2\n"), 0o600)
	if err := setEnvFileVar(path, "PULSENODE_IMAGE_TAG", "v2", false); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); string(got) != "A=1\nPULSENODE_IMAGE_TAG=v2\nB=2\n" {
		t.Fatalf("replace: %q", got)
	}
	if err := setEnvFileVar(path, "PULSENODE_IMAGE_TAG", "", true); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); string(got) != "A=1\nB=2\n" {
		t.Fatalf("remove: %q", got)
	}
	if err := setEnvFileVar(path, "NEW", "x", false); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); !strings.HasSuffix(string(got), "NEW=x\n") {
		t.Fatalf("append: %q", got)
	}
	if setEnvFileVar(path, "K", "bad\nPULSENODE_COMPOSE_BIN=/x", false) == nil {
		t.Fatal("newline injection must be rejected")
	}
	if setEnvFileVar(path, "bad key", "v", false) == nil {
		t.Fatal("invalid key must be rejected")
	}
}

// ---- pinning against a fake registry -------------------------------------------

func fakeRegistry(t *testing.T, published map[string]bool, latest string, tokenStatus int) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/"+releaseRepo+"/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tag_name":"` + latest + `"}`))
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if tokenStatus != 0 && tokenStatus != 200 {
			w.WriteHeader(tokenStatus)
			return
		}
		_, _ = w.Write([]byte(`{"token":"anon"}`))
	})
	mux.HandleFunc("/v2/", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer anon" {
			w.WriteHeader(401)
			return
		}
		// /v2/<owner>/<name>/manifests/<tag>
		p := strings.TrimPrefix(r.URL.Path, "/v2/")
		i := strings.Index(p, "/manifests/")
		if i < 0 || !published[p[:i]+":"+p[i+len("/manifests/"):]] {
			w.WriteHeader(404)
			return
		}
		w.WriteHeader(200)
	})
	srv := httptest.NewServer(mux)
	oldG, oldR := githubAPIBase, ghcrRegistryBase
	githubAPIBase, ghcrRegistryBase = srv.URL, srv.URL
	t.Cleanup(func() { srv.Close(); githubAPIBase, ghcrRegistryBase = oldG, oldR })
}

const testOverlay = `services:
  web:
    image: ghcr.io/owner/pulsenode-web:${PULSENODE_IMAGE_TAG:-latest}
  go-api:
    image: ghcr.io/owner/pulsenode-go-api:${PULSENODE_IMAGE_TAG:-latest}
`

func TestGhcrReposParsesTheOverlay(t *testing.T) {
	got := ghcrRepos(testOverlay)
	if len(got) != 2 || got[0] != "owner/pulsenode-web" || got[1] != "owner/pulsenode-go-api" {
		t.Fatalf("repos = %v", got)
	}
	real, err := os.ReadFile("../../../docker-compose.ghcr.yml")
	if err != nil {
		t.Skip("overlay not found")
	}
	if len(ghcrRepos(string(real))) != 2 {
		t.Fatalf("the shipped overlay should name two images: %v", ghcrRepos(string(real)))
	}
}

func TestResolvePinPinsWhenBothImagesArePublished(t *testing.T) {
	fakeRegistry(t, map[string]bool{"owner/pulsenode-web:v1.5.0": true, "owner/pulsenode-go-api:v1.5.0": true}, "v1.5.0", 200)
	d := newReleaseResolver().resolvePin(context.Background(), testOverlay)
	if d.Action != "pin" || d.Tag != "v1.5.0" {
		t.Fatalf("%+v", d)
	}
}

func TestResolvePinRefusesWhileTheReleaseIsStillBuilding(t *testing.T) {
	// The web image is out, the go-api image is not: exactly the half-published window.
	fakeRegistry(t, map[string]bool{"owner/pulsenode-web:v1.5.0": true}, "v1.5.0", 200)
	d := newReleaseResolver().resolvePin(context.Background(), testOverlay)
	if d.Action != "refuse" || !strings.Contains(d.Message, "still building") || !strings.Contains(d.Message, "pulsenode-go-api") {
		t.Fatalf("%+v", d)
	}
}

func TestResolvePinFallsBackWhenTheRegistryCannotBeChecked(t *testing.T) {
	fakeRegistry(t, nil, "v1.5.0", 503)
	d := newReleaseResolver().resolvePin(context.Background(), testOverlay)
	if d.Action != "fallback" || !strings.Contains(d.Message, "could not verify") {
		t.Fatalf("%+v", d)
	}
}

func TestDecidePinWhenTheLatestReleaseIsUnknown(t *testing.T) {
	if d := decidePin("", errors.New("offline"), nil); d.Action != "fallback" {
		t.Fatalf("%+v", d)
	}
}

// ---- the detached updater, against a fake docker ---------------------------------

type fakeDocker struct {
	calls     []string
	envs      map[string][]string
	upFails   bool
	healthy   func(upCount int) bool // is the stack healthy after the n-th `compose up`
	ups       int
	headSHA   string
	statusOut string
	bootAfter int64
}

func (f *fakeDocker) run(extra []string, name string, args ...string) (string, error) {
	line := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, line)
	if f.envs == nil {
		f.envs = map[string][]string{}
	}
	f.envs[line] = extra
	switch {
	case name == "docker" && len(args) >= 2 && args[0] == "compose" && args[1] == "up":
		f.ups++
		if f.upFails && f.ups == 1 {
			return "no such image", errors.New("exit 1")
		}
		return "", nil
	case name == "docker" && len(args) >= 3 && args[0] == "compose" && args[1] == "ps":
		return "ctr-" + args[3], nil
	case name == "docker" && args[0] == "inspect":
		if f.healthy(f.ups) {
			return "running|healthy", nil
		}
		return "running|unhealthy", nil
	case name == "docker" && args[0] == "exec":
		boot := f.bootAfter
		if f.ups >= 2 { // after a rollback the old code answers with a new process
			boot = 777
		}
		return `{"ok":true,"startedAt":` + itoa(boot) + `}`, nil
	case name == "git" && contains(args, "rev-parse"):
		return f.headSHA, nil
	case name == "git" && contains(args, "status"):
		return f.statusOut, nil
	}
	return "", nil
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func newTestUpdater(t *testing.T, f *fakeDocker, cfg updaterConfig) *updater {
	clk := &fakeClock{t: time.Unix(5000, 0)}
	cfg.ID = "u1"
	if cfg.HealthTimeout == 0 {
		cfg.HealthTimeout = 30 * time.Second
	}
	return &updater{cfg: cfg, run: f.run, sleep: clk.sleep, now: clk.now}
}

func TestUpdaterSuccessLeavesTheNewVersionRunning(t *testing.T) {
	f := &fakeDocker{healthy: func(int) bool { return true }, bootAfter: 200}
	u := newTestUpdater(t, f, updaterConfig{PrevBoot: 100})
	res := u.Run()
	if !res.OK || res.RolledBack || res.ID != "u1" {
		t.Fatalf("%+v", res)
	}
	for _, c := range f.calls {
		if strings.HasPrefix(c, "docker tag") || strings.HasPrefix(c, "git") {
			t.Fatalf("a successful update must not retag or touch git: %s", c)
		}
	}
}

func TestUpdaterRollsBackWhenTheNewVersionIsUnhealthy(t *testing.T) {
	f := &fakeDocker{
		healthy:   func(ups int) bool { return ups >= 2 }, // only healthy again after the rollback `up`
		bootAfter: 200, headSHA: "post", statusOut: "",
	}
	u := newTestUpdater(t, f, updaterConfig{
		PrevBoot: 100, PrevCommit: "pre", PostCommit: "post", RepoDir: "/srv/pn", Pinned: true, PrevTag: "v1.0.0", EnvFile: filepath.Join(t.TempDir(), ".env.local"),
		PrevImages: []composeImage{{"go-api", "ghcr.io/o/pulsenode-go-api:v1.0.0", "sha256:old"}},
	})
	_ = os.WriteFile(u.cfg.EnvFile, []byte("PULSENODE_IMAGE_TAG=v1.1.0\n"), 0o600)
	res := u.Run()
	if res.OK || !res.RolledBack || !res.RollbackHealthy {
		t.Fatalf("%+v", res)
	}
	if !strings.Contains(res.Error, "not healthy after") {
		t.Fatalf("the reason must be reported: %q", res.Error)
	}
	joined := strings.Join(f.calls, "\n")
	for _, want := range []string{
		"docker tag sha256:old ghcr.io/o/pulsenode-go-api:v1.0.0",
		"git -C /srv/pn -c safe.directory=/srv/pn reset --hard pre",
		"docker compose up -d --no-build",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing call %q in:\n%s", want, joined)
		}
	}
	rollbackUp := f.envs["docker compose up -d --no-build"]
	if len(rollbackUp) != 1 || rollbackUp[0] != "PULSENODE_IMAGE_TAG=v1.0.0" {
		t.Fatalf("rollback compose must run with the previous tag, env=%v", rollbackUp)
	}
	if got, _ := os.ReadFile(u.cfg.EnvFile); string(got) != "PULSENODE_IMAGE_TAG=v1.0.0\n" {
		t.Fatalf(".env.local pin not restored: %q", got)
	}
}

func TestUpdaterRollbackRemovesThePinWhenThereWasNone(t *testing.T) {
	f := &fakeDocker{healthy: func(ups int) bool { return ups >= 2 }, bootAfter: 200}
	env := filepath.Join(t.TempDir(), ".env.local")
	_ = os.WriteFile(env, []byte("A=1\nPULSENODE_IMAGE_TAG=v1.1.0\n"), 0o600)
	u := newTestUpdater(t, f, updaterConfig{PrevBoot: 100, Pinned: true, PrevTag: "", EnvFile: env})
	res := u.Run()
	if !res.RolledBack {
		t.Fatalf("%+v", res)
	}
	if got, _ := os.ReadFile(env); string(got) != "A=1\n" {
		t.Fatalf("pin should be removed: %q", got)
	}
}

func TestUpdaterRollbackSkipsGitWhenTheTreeWasDirty(t *testing.T) {
	f := &fakeDocker{healthy: func(ups int) bool { return ups >= 2 }, bootAfter: 200, headSHA: "post"}
	u := newTestUpdater(t, f, updaterConfig{PrevBoot: 100, PrevCommit: "pre", PostCommit: "post", RepoDir: "/srv/pn", PreDirty: true})
	res := u.Run()
	if !res.RolledBack || !res.RollbackHealthy {
		t.Fatalf("%+v", res)
	}
	for _, c := range f.calls {
		if strings.Contains(c, "reset --hard") {
			t.Fatalf("must never reset a tree that had local changes: %s", c)
		}
	}
}

func TestUpdaterRollbackSkipsGitWhenTheTreeIsDirtyNow(t *testing.T) {
	f := &fakeDocker{healthy: func(ups int) bool { return ups >= 2 }, bootAfter: 200, headSHA: "post", statusOut: " M Caddyfile"}
	u := newTestUpdater(t, f, updaterConfig{PrevBoot: 100, PrevCommit: "pre", PostCommit: "post", RepoDir: "/srv/pn"})
	u.Run()
	for _, c := range f.calls {
		if strings.Contains(c, "reset --hard") {
			t.Fatalf("must not reset a tree with local changes: %s", c)
		}
	}
}

func TestUpdaterComposeUpFailureRollsBackToo(t *testing.T) {
	f := &fakeDocker{upFails: true, healthy: func(ups int) bool { return ups >= 2 }, bootAfter: 200}
	u := newTestUpdater(t, f, updaterConfig{PrevBoot: 100})
	res := u.Run()
	if !res.RolledBack || !res.RollbackHealthy || !strings.Contains(res.Error, "docker compose up failed") {
		t.Fatalf("%+v", res)
	}
}

func TestUpdaterReportsWhenTheRollbackIsUnhealthyToo(t *testing.T) {
	f := &fakeDocker{healthy: func(int) bool { return false }, bootAfter: 200}
	u := newTestUpdater(t, f, updaterConfig{PrevBoot: 100})
	res := u.Run()
	if res.OK || !res.RolledBack || res.RollbackHealthy || !strings.Contains(res.Error, "manual intervention needed") {
		t.Fatalf("%+v", res)
	}
}

func TestUpdaterConfigFromEnv(t *testing.T) {
	env := map[string]string{
		"PN_UPDATE_ID": "x", "PN_RESULT_FILE": "/r", "PN_PREV_BOOT": "123", "PN_PRE_DIRTY": "1", "PN_PINNED": "1",
		"PN_PREV_IMAGES": "go-api@@ref@@sha256:1", "PN_HEALTH_TIMEOUT": "45", "PN_PREV_TAG": "v1",
	}
	c := updaterConfigFromEnv(func(k string) string { return env[k] })
	if c.ID != "x" || c.PrevBoot != 123 || !c.PreDirty || !c.Pinned || c.HealthTimeout != 45*time.Second || len(c.PrevImages) != 1 || c.PrevTag != "v1" {
		t.Fatalf("%+v", c)
	}
	if updaterConfigFromEnv(func(string) string { return "" }).HealthTimeout != 120*time.Second {
		t.Fatal("default health timeout should be 120s")
	}
}

// ---- status survives the restart; restore needs explicit confirmation ------------

func TestUpdateStatusAfterRestartShowsTheRolledBackVerdict(t *testing.T) {
	data, ws := t.TempDir(), t.TempDir()
	t.Setenv("PULSENODE_DATA_DIR", data)
	t.Setenv("PULSENODE_WORKSPACE", ws)
	globalUpdate.mu.Lock()
	sRec, sRunning, sLog, sErr, sStarted := globalUpdate.rec, globalUpdate.running, globalUpdate.log, globalUpdate.err, globalUpdate.startedAt
	globalUpdate.rec, globalUpdate.running, globalUpdate.log, globalUpdate.err, globalUpdate.startedAt = nil, false, nil, nil, nil
	globalUpdate.mu.Unlock()
	t.Cleanup(func() {
		globalUpdate.mu.Lock()
		globalUpdate.rec, globalUpdate.running, globalUpdate.log, globalUpdate.err, globalUpdate.startedAt = sRec, sRunning, sLog, sErr, sStarted
		globalUpdate.mu.Unlock()
	})
	rec := &updateRecord{ID: "u9", StartedAt: time.Now(), Phase: "switching", FromVersion: "1.0.0", ToVersion: "1.1.0", SnapshotPath: "/data/snapshots/s.db", ImageTag: "v1.1.0"}
	if err := writeJSONFile(updateRecordPath(), rec, 0o600); err != nil {
		t.Fatal(err)
	}
	res := &updateResult{ID: "u9", RolledBack: true, RollbackHealthy: true, Error: "go-api healthcheck reports unhealthy", FinishedAt: time.Now(), Log: []string{"Rolling back…"}}
	if err := writeJSONFile(updateResultPath(), res, 0o644); err != nil {
		t.Fatal(err)
	}

	rr := httptest.NewRecorder()
	(&Server{}).updateStatus(rr, httptest.NewRequest(http.MethodGet, "/api/system/update/status", nil))
	var got map[string]any
	mustUnmarshal(t, rr.Body.Bytes(), &got)
	if got["phase"] != "rolled_back" || got["rolledBack"] != true || got["rollbackHealthy"] != true ||
		got["fromVersion"] != "1.0.0" || got["toVersion"] != "1.1.0" || got["error"] != "go-api healthcheck reports unhealthy" ||
		got["snapshotPath"] != "/data/snapshots/s.db" || got["running"] != false {
		t.Fatalf("%v", got)
	}
	if logs, _ := got["log"].([]any); len(logs) != 1 {
		t.Fatalf("the updater's log should surface after a restart: %v", got["log"])
	}
}

func TestRestoreSnapshotRequiresExplicitConfirmation(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "pulsenode.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	snap, err := d.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	restarted := 0
	old := restartSelf
	restartSelf = func() bool { restarted++; return true }
	defer func() { restartSelf = old }()
	s := &Server{db: d}

	post := func(body string) *httptest.ResponseRecorder {
		rr := httptest.NewRecorder()
		s.restoreSnapshot(rr, httptest.NewRequest(http.MethodPost, "/api/system/update/restore-snapshot", bytes.NewBufferString(body)))
		return rr
	}
	name := filepath.Base(snap)
	if rr := post(`{"snapshot":"` + name + `"}`); rr.Code != http.StatusBadRequest || restarted != 0 {
		t.Fatalf("no confirm → 400, got %d", rr.Code)
	}
	if rr := post(`{"snapshot":"` + name + `","confirm":"yes"}`); rr.Code != http.StatusBadRequest {
		t.Fatalf("wrong confirm → 400, got %d", rr.Code)
	}
	if rr := post(`{"snapshot":"../../etc/passwd","confirm":"restore"}`); rr.Code != http.StatusBadRequest || restarted != 0 {
		t.Fatalf("traversal → 400, got %d", rr.Code)
	}
	if rr := post(`{"snapshot":"pulsenode-20200101T000000Z.db","confirm":"restore"}`); rr.Code != http.StatusBadRequest {
		t.Fatalf("unknown snapshot → 400, got %d", rr.Code)
	}
	rr := post(`{"snapshot":"` + name + `","confirm":"restore"}`)
	if rr.Code != http.StatusAccepted || restarted != 1 {
		t.Fatalf("confirmed restore → 202 + restart, got %d restarted=%d body=%s", rr.Code, restarted, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(snap), "..", "restore-pending.db")); err != nil {
		t.Fatalf("the restore must be staged for the next start: %v", err)
	}
}

func mustUnmarshal(t *testing.T, data []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("bad json %q: %v", data, err)
	}
}
