package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"pulsenode/backend/internal/backups"
	"pulsenode/backend/internal/db"
)

type backupTestEnv struct {
	s       *Server
	h       http.Handler
	dataDir string
}

func newBackupTestEnv(t *testing.T) *backupTestEnv {
	t.Helper()
	t.Setenv("AES_KEY", strings.Repeat("k", 40))
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	dataDir := t.TempDir()
	svc := backups.New(backups.Deps{DB: d, DataDir: dataDir, Workspace: t.TempDir(),
		PanelVersion: func() string { return "vtest" }})
	s := &Server{db: d, backupSvc: svc}
	r := chi.NewRouter()
	r.Get("/backups/status", s.backupsStatus)
	r.Get("/backups/destinations", s.listBackupDestinations)
	r.Post("/backups/destinations", s.createBackupDestination)
	r.Post("/backups/destinations/test", s.testDraftBackupDestination)
	r.Patch("/backups/destinations/{id}", s.updateBackupDestination)
	r.Delete("/backups/destinations/{id}", s.deleteBackupDestination)
	r.Post("/backups/destinations/{id}/test", s.testSavedBackupDestination)
	r.Get("/backups/schedules", s.listBackupSchedules)
	r.Post("/backups/schedules", s.createBackupSchedule)
	r.Patch("/backups/schedules/{id}", s.updateBackupSchedule)
	r.Delete("/backups/schedules/{id}", s.deleteBackupSchedule)
	r.Post("/backups/schedules/{id}/run", s.runBackupSchedule)
	r.Get("/backups/history", s.listBackupHistory)
	r.Get("/backups/history/{id}/download", s.downloadBackupHistory)
	r.Delete("/backups/history/{id}", s.deleteBackupHistory)
	r.Post("/backups/history/{id}/restore", s.restoreBackupHistory)
	r.Get("/backups/passphrase", s.getBackupPassphrase)
	r.Post("/backups/passphrase", s.setBackupPassphrase)
	return &backupTestEnv{s: s, h: r, dataDir: dataDir}
}

func (e *backupTestEnv) do(method, path, body string) *httptest.ResponseRecorder {
	return doJSON(e.h, method, path, body)
}

func (e *backupTestEnv) mustJSON(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int) map[string]any {
	t.Helper()
	if rec.Code != wantStatus {
		t.Fatalf("status %d (want %d): %s", rec.Code, wantStatus, rec.Body.String())
	}
	var v map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("not an object: %s", rec.Body.String())
	}
	return v
}

const s3Body = `{"name":"offsite","type":"s3","endpoint":"s3.eu-central-1.example.com","region":"eu-central-1","bucket":"my-backups","prefix":"pn","accessKey":"AKIAEXAMPLEWXYZ1","secretKey":"TOPSECRETVALUE"}`

func (e *backupTestEnv) createS3(t *testing.T) string {
	t.Helper()
	v := e.mustJSON(t, e.do(http.MethodPost, "/backups/destinations", s3Body), http.StatusCreated)
	return v["id"].(string)
}

func TestBackupListsAreNeverNull(t *testing.T) {
	e := newBackupTestEnv(t)
	for _, p := range []string{"/backups/destinations", "/backups/schedules", "/backups/history"} {
		rec := e.do(http.MethodGet, p, "")
		if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" {
			t.Errorf("%s = %d %q", p, rec.Code, rec.Body.String())
		}
	}
}

func TestBackupDestinationContractAndSecretMasking(t *testing.T) {
	e := newBackupTestEnv(t)
	v := e.mustJSON(t, e.do(http.MethodPost, "/backups/destinations", s3Body), http.StatusCreated)
	for _, k := range []string{"id", "name", "type", "enabled", "endpoint", "region", "bucket", "prefix", "useSSL", "pathStyle", "accessKeyHint", "secretSet"} {
		if _, ok := v[k]; !ok {
			t.Errorf("response lacks contract field %q: %v", k, v)
		}
	}
	if v["secretSet"] != true {
		t.Errorf("secretSet = %v", v["secretSet"])
	}
	if v["accessKeyHint"] != "…XYZ1" {
		t.Errorf("accessKeyHint = %v, want the last 4 characters", v["accessKeyHint"])
	}
	if v["useSSL"] != true || v["pathStyle"] != false {
		t.Errorf("defaults: useSSL=%v pathStyle=%v", v["useSSL"], v["pathStyle"])
	}
	for _, path := range []string{"/backups/destinations"} {
		body := e.do(http.MethodGet, path, "").Body.String()
		for _, secret := range []string{"TOPSECRETVALUE", "AKIAEXAMPLEWXYZ1"} {
			if strings.Contains(body, secret) {
				t.Fatalf("list leaked %q: %s", secret, body)
			}
		}
	}
	// And the create response itself.
	if strings.Contains(e.do(http.MethodGet, "/backups/destinations", "").Body.String(), "secretKey") {
		t.Fatal("list exposes a secretKey field")
	}
}

func TestBackupDestinationSecretsNotReusedForNewDestination(t *testing.T) {
	e := newBackupTestEnv(t)
	id := e.createS3(t)
	orig, _ := e.s.db.BackupDestinationSecrets(id)

	// Same destination, blank secrets: allowed, stored credentials are kept.
	v := e.mustJSON(t, e.do(http.MethodPatch, "/backups/destinations/"+id, `{"name":"renamed","prefix":"other","enabled":false}`), http.StatusOK)
	if v["name"] != "renamed" || v["prefix"] != "other" || v["enabled"] != false || v["secretSet"] != true {
		t.Fatalf("patch: %v", v)
	}
	if got, _ := e.s.db.BackupDestinationSecrets(id); got != orig {
		t.Fatal("credentials changed by a same-destination edit")
	}

	// New bucket or endpoint without re-entering the keys: refused.
	for _, body := range []string{`{"bucket":"another-bucket"}`, `{"endpoint":"s3.evil.example.com"}`,
		`{"bucket":"another-bucket","secretKey":"only-secret"}`, `{"endpoint":"s3.evil.example.com","accessKey":"AKIAONLY"}`} {
		rec := e.do(http.MethodPatch, "/backups/destinations/"+id, body)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "entered again") {
			t.Errorf("%s -> %d %s", body, rec.Code, rec.Body.String())
		}
		if got, _ := e.s.db.BackupDestinationSecrets(id); got != orig {
			t.Fatalf("credentials changed by a refused edit (%s)", body)
		}
		if d, _ := e.s.db.GetBackupDestination(id); d.Config["bucket"] != "my-backups" || d.Config["endpoint"] != "s3.eu-central-1.example.com" {
			t.Fatalf("destination changed by a refused edit: %v", d.Config)
		}
	}
	// Re-entering both keys makes the change legitimate.
	e.mustJSON(t, e.do(http.MethodPatch, "/backups/destinations/"+id,
		`{"bucket":"another-bucket","accessKey":"AKIANEWKEY0001","secretKey":"NEWSECRET"}`), http.StatusOK)
	got, _ := e.s.db.BackupDestinationSecrets(id)
	if got.AccessKey != "AKIANEWKEY0001" || got.SecretKey != "NEWSECRET" {
		t.Fatalf("new credentials not stored: %+v", got)
	}
	// The draft test follows the same rule (it must not be a way to send stored secrets elsewhere).
	rec := e.do(http.MethodPost, "/backups/destinations/test", `{"id":"`+id+`","endpoint":"s3.attacker.example.com"}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "entered again") {
		t.Fatalf("draft test with new endpoint: %d %s", rec.Code, rec.Body.String())
	}
	// A type change is never allowed.
	if rec := e.do(http.MethodPatch, "/backups/destinations/"+id, `{"type":"local"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("type change: %d", rec.Code)
	}
}

func TestBackupDestinationValidation(t *testing.T) {
	e := newBackupTestEnv(t)
	bad := map[string]string{
		"no name":            `{"type":"s3","endpoint":"s3.example.com","bucket":"my-backups","accessKey":"a","secretKey":"b"}`,
		"bad type":           `{"name":"x","type":"ftp"}`,
		"missing keys":       `{"name":"x","type":"s3","endpoint":"s3.example.com","bucket":"my-backups"}`,
		"missing endpoint":   `{"name":"x","type":"s3","bucket":"my-backups","accessKey":"a","secretKey":"b"}`,
		"bad bucket":         `{"name":"x","type":"s3","endpoint":"s3.example.com","bucket":"A","accessKey":"a","secretKey":"b"}`,
		"endpoint with path": `{"name":"x","type":"s3","endpoint":"https://s3.example.com/bucket","bucket":"my-backups","accessKey":"a","secretKey":"b"}`,
		"private endpoint":   `{"name":"x","type":"s3","endpoint":"10.0.0.5:9000","bucket":"my-backups","accessKey":"a","secretKey":"b"}`,
		"localhost endpoint": `{"name":"x","type":"s3","endpoint":"localhost:9000","bucket":"my-backups","accessKey":"a","secretKey":"b"}`,
		"metadata endpoint":  `{"name":"x","type":"s3","endpoint":"169.254.169.254","bucket":"my-backups","accessKey":"a","secretKey":"b"}`,
		"local outside data": `{"name":"x","type":"local","dir":"/etc"}`,
		"local relative":     `{"name":"x","type":"local","dir":"backups"}`,
		"local traversal":    `{"name":"x","type":"local","dir":"` + "/tmp/../etc" + `"}`,
		"prefix traversal":   `{"name":"x","type":"s3","endpoint":"s3.example.com","bucket":"my-backups","prefix":"../x","accessKey":"a","secretKey":"b"}`,
		"name too long":      `{"name":"` + strings.Repeat("n", 81) + `","type":"local"}`,
		"invalid json":       `{"name":`,
	}
	for name, body := range bad {
		if rec := e.do(http.MethodPost, "/backups/destinations", body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d %s", name, rec.Code, rec.Body.String())
		}
	}
	if list := e.do(http.MethodGet, "/backups/destinations", "").Body.String(); strings.TrimSpace(list) != "[]" {
		t.Fatalf("rejected destinations were stored: %s", list)
	}

	// Local with no dir uses the default under the data directory.
	v := e.mustJSON(t, e.do(http.MethodPost, "/backups/destinations", `{"name":"disk","type":"local"}`), http.StatusCreated)
	if v["dir"] != filepath.Join(e.dataDir, "backups", "scheduled") || v["secretSet"] != false {
		t.Fatalf("local default: %v", v)
	}
	// A dir inside the data directory is fine.
	e.mustJSON(t, e.do(http.MethodPost, "/backups/destinations", `{"name":"disk2","type":"local","dir":"`+filepath.Join(e.dataDir, "mine")+`"}`), http.StatusCreated)

	// A private S3 endpoint works only with the operator override (MinIO on a LAN).
	t.Setenv("PULSENODE_BACKUPS_ALLOW_PRIVATE", "true")
	e.mustJSON(t, e.do(http.MethodPost, "/backups/destinations",
		`{"name":"minio","type":"s3","endpoint":"10.0.0.5:9000","bucket":"my-backups","useSSL":false,"pathStyle":true,"accessKey":"minio","secretKey":"minio-secret"}`), http.StatusCreated)
}

func TestBackupDestinationTestEndpoints(t *testing.T) {
	e := newBackupTestEnv(t)
	// Local destination: the round trip works.
	v := e.mustJSON(t, e.do(http.MethodPost, "/backups/destinations", `{"name":"disk","type":"local"}`), http.StatusCreated)
	rec := e.do(http.MethodPost, "/backups/destinations/"+v["id"].(string)+"/test", "")
	if out := e.mustJSON(t, rec, http.StatusOK); out["ok"] != true {
		t.Fatalf("saved test: %v", out)
	}
	if out := e.mustJSON(t, e.do(http.MethodPost, "/backups/destinations/test", `{"name":"d","type":"local"}`), http.StatusOK); out["ok"] != true {
		t.Fatalf("draft test: %v", out)
	}
	// Invalid draft -> 400, unknown id -> 404.
	if rec := e.do(http.MethodPost, "/backups/destinations/test", `{"name":"d","type":"local","dir":"/etc"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("draft outside data dir: %d", rec.Code)
	}
	if rec := e.do(http.MethodPost, "/backups/destinations/nope/test", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown destination: %d", rec.Code)
	}
}

func TestBackupDestinationDeleteBlockedWhileInUse(t *testing.T) {
	e := newBackupTestEnv(t)
	id := e.mustJSON(t, e.do(http.MethodPost, "/backups/destinations", `{"name":"disk","type":"local"}`), http.StatusCreated)["id"].(string)
	sched := e.mustJSON(t, e.do(http.MethodPost, "/backups/schedules",
		`{"name":"nightly","target":"panel","frequency":"daily","hour":3,"destinationIds":["`+id+`"]}`), http.StatusCreated)
	rec := e.do(http.MethodDelete, "/backups/destinations/"+id, "")
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "nightly") {
		t.Fatalf("delete in use: %d %s", rec.Code, rec.Body.String())
	}
	if rec := e.do(http.MethodDelete, "/backups/schedules/"+sched["id"].(string), ""); rec.Code != http.StatusOK {
		t.Fatalf("delete schedule: %d", rec.Code)
	}
	if rec := e.do(http.MethodDelete, "/backups/destinations/"+id, ""); rec.Code != http.StatusOK {
		t.Fatalf("delete unused destination: %d %s", rec.Code, rec.Body.String())
	}
	if rec := e.do(http.MethodDelete, "/backups/destinations/"+id, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("delete twice: %d", rec.Code)
	}
}

func TestBackupScheduleContractAndValidation(t *testing.T) {
	e := newBackupTestEnv(t)
	dest := e.mustJSON(t, e.do(http.MethodPost, "/backups/destinations", `{"name":"disk","type":"local"}`), http.StatusCreated)["id"].(string)
	if err := e.s.db.CreateManagedDatabase(&db.ManagedDatabase{ID: "m1", Name: "shop", Engine: "postgres", HostPort: 5432,
		Username: "u", Password: "p", DBName: "shop", Status: "running"}); err != nil {
		t.Fatal(err)
	}
	ids := `["` + dest + `"]`

	v := e.mustJSON(t, e.do(http.MethodPost, "/backups/schedules",
		`{"name":"db nightly","target":"db:m1","frequency":"daily","hour":3,"retention":5,"destinationIds":`+ids+`,"notifyOnSuccess":true}`), http.StatusCreated)
	for _, k := range []string{"id", "name", "target", "targetName", "frequency", "hour", "weekday", "retention", "destinationIds", "encrypt", "notifyOnSuccess", "enabled", "lastRunAt", "lastStatus", "nextRunAt"} {
		if _, ok := v[k]; !ok {
			t.Errorf("schedule lacks contract field %q: %v", k, v)
		}
	}
	if v["targetName"] != "shop" || v["encrypt"] != true || v["enabled"] != true || v["retention"] != float64(5) || v["notifyOnSuccess"] != true {
		t.Fatalf("schedule values: %v", v)
	}
	if v["nextRunAt"] == nil {
		t.Fatal("enabled schedule has no nextRunAt")
	}
	next, err := time.Parse(time.RFC3339, v["nextRunAt"].(string))
	if err != nil || !next.After(time.Now()) {
		t.Fatalf("nextRunAt %v %v", v["nextRunAt"], err)
	}

	// Panel schedules are always encrypted, whatever the client says.
	p := e.mustJSON(t, e.do(http.MethodPost, "/backups/schedules",
		`{"name":"panel weekly","target":"panel","frequency":"weekly","hour":4,"weekday":0,"encrypt":false,"destinationIds":`+ids+`}`), http.StatusCreated)
	if p["encrypt"] != true || p["targetName"] != "PulseNode panel" {
		t.Fatalf("panel schedule: %v", p)
	}

	bad := map[string]string{
		"no destination": `{"name":"x","target":"panel","frequency":"daily","hour":3,"destinationIds":[]}`,
		"unknown dest":   `{"name":"x","target":"panel","frequency":"daily","hour":3,"destinationIds":["nope"]}`,
		"bad frequency":  `{"name":"x","target":"panel","frequency":"monthly","hour":3,"destinationIds":` + ids + `}`,
		"bad hour":       `{"name":"x","target":"panel","frequency":"daily","hour":24,"destinationIds":` + ids + `}`,
		"bad weekday":    `{"name":"x","target":"panel","frequency":"weekly","hour":3,"weekday":9,"destinationIds":` + ids + `}`,
		"bad retention":  `{"name":"x","target":"panel","frequency":"daily","hour":3,"retention":0,"destinationIds":` + ids + `}`,
		"unknown db":     `{"name":"x","target":"db:ghost","frequency":"daily","hour":3,"destinationIds":` + ids + `}`,
		"bad target":     `{"name":"x","target":"everything","frequency":"daily","hour":3,"destinationIds":` + ids + `}`,
		"no name":        `{"target":"panel","frequency":"daily","hour":3,"destinationIds":` + ids + `}`,
		"missing target": `{"name":"x","frequency":"daily","hour":3,"destinationIds":` + ids + `}`,
	}
	for name, body := range bad {
		if rec := e.do(http.MethodPost, "/backups/schedules", body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, rec.Code, rec.Body.String())
		}
	}

	// PATCH: partial update, target is immutable, disabling clears nextRunAt in the view.
	id := v["id"].(string)
	u := e.mustJSON(t, e.do(http.MethodPatch, "/backups/schedules/"+id, `{"hour":5,"retention":9,"enabled":false}`), http.StatusOK)
	if u["hour"] != float64(5) || u["retention"] != float64(9) || u["enabled"] != false || u["nextRunAt"] != nil || u["name"] != "db nightly" {
		t.Fatalf("patch: %v", u)
	}
	if rec := e.do(http.MethodPatch, "/backups/schedules/"+id, `{"target":"panel"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("target change: %d", rec.Code)
	}
	if rec := e.do(http.MethodPatch, "/backups/schedules/nope", `{"hour":1}`); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown schedule: %d", rec.Code)
	}
	u = e.mustJSON(t, e.do(http.MethodPatch, "/backups/schedules/"+id, `{"enabled":true}`), http.StatusOK)
	if u["nextRunAt"] == nil {
		t.Fatal("re-enabling did not schedule a next run")
	}
	var list []map[string]any
	if err := json.Unmarshal(e.do(http.MethodGet, "/backups/schedules", "").Body.Bytes(), &list); err != nil || len(list) != 2 {
		t.Fatalf("list: %v (%d)", err, len(list))
	}
}

func waitHistory(t *testing.T, e *backupTestEnv, id string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		rows := []map[string]any{}
		_ = json.Unmarshal(e.do(http.MethodGet, "/backups/history", "").Body.Bytes(), &rows)
		for _, r := range rows {
			if r["id"] == id && r["status"] != "running" {
				return r
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("run %s never finished: %v", id, rows)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func TestBackupRunHistoryDownloadAndDelete(t *testing.T) {
	e := newBackupTestEnv(t)
	dest := e.mustJSON(t, e.do(http.MethodPost, "/backups/destinations", `{"name":"disk","type":"local"}`), http.StatusCreated)["id"].(string)
	sched := e.mustJSON(t, e.do(http.MethodPost, "/backups/schedules",
		`{"name":"panel nightly","target":"panel","frequency":"daily","hour":3,"destinationIds":["`+dest+`"]}`), http.StatusCreated)["id"].(string)

	// Panel backups need the passphrase first.
	if rec := e.do(http.MethodPost, "/backups/schedules/"+sched+"/run", ""); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "passphrase") {
		t.Fatalf("run without passphrase: %d %s", rec.Code, rec.Body.String())
	}
	e.mustJSON(t, e.do(http.MethodPost, "/backups/passphrase", `{"passphrase":"a sufficiently long passphrase"}`), http.StatusOK)
	if rec := e.do(http.MethodPost, "/backups/schedules/nope/run", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("run unknown: %d", rec.Code)
	}
	run := e.mustJSON(t, e.do(http.MethodPost, "/backups/schedules/"+sched+"/run", ""), http.StatusAccepted)
	hid, _ := run["historyId"].(string)
	if hid == "" || run["status"] != "running" {
		t.Fatalf("run response: %v", run)
	}
	h := waitHistory(t, e, hid)
	for _, k := range []string{"id", "scheduleId", "scheduleName", "target", "targetName", "startedAt", "finishedAt", "status", "sizeBytes", "encrypted", "error", "files"} {
		if _, ok := h[k]; !ok {
			t.Errorf("history lacks contract field %q: %v", k, h)
		}
	}
	if h["status"] != "success" || h["encrypted"] != true || h["sizeBytes"].(float64) <= 0 || h["scheduleName"] != "panel nightly" {
		t.Fatalf("history row: %v", h)
	}
	files := h["files"].([]any)
	f0 := files[0].(map[string]any)
	if len(files) != 1 || f0["ok"] != true || f0["destinationName"] != "disk" || !strings.HasSuffix(f0["name"].(string), ".pnbak") {
		t.Fatalf("files: %v", files)
	}
	for _, k := range []string{"destinationId", "destinationName", "name", "ok", "error"} {
		if _, ok := f0[k]; !ok {
			t.Errorf("file result lacks %q", k)
		}
	}

	// schedule filter + limit
	var rows []map[string]any
	_ = json.Unmarshal(e.do(http.MethodGet, "/backups/history?scheduleId="+sched+"&limit=1", "").Body.Bytes(), &rows)
	if len(rows) != 1 {
		t.Fatalf("filtered history: %v", rows)
	}
	_ = json.Unmarshal(e.do(http.MethodGet, "/backups/history?scheduleId=other", "").Body.Bytes(), &rows)
	if len(rows) != 0 {
		t.Fatalf("filter ignored: %v", rows)
	}

	// Download: the stored (encrypted) archive, with a safe filename.
	dl := e.do(http.MethodGet, "/backups/history/"+hid+"/download", "")
	if dl.Code != http.StatusOK || !strings.HasPrefix(dl.Body.String(), "PNBAK1") ||
		!strings.Contains(dl.Header().Get("Content-Disposition"), ".pnbak") || dl.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("download: %d %q %v", dl.Code, dl.Body.String()[:6], dl.Header())
	}
	if _, err := backups.VerifyArchive(strings.NewReader(dl.Body.String()), "a sufficiently long passphrase"); err != nil {
		t.Fatalf("downloaded archive does not verify: %v", err)
	}

	// Restore endpoint rules.
	if rec := e.do(http.MethodPost, "/backups/history/"+hid+"/restore", `{}`); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "confirm") {
		t.Fatalf("restore without confirm: %d %s", rec.Code, rec.Body.String())
	}
	if rec := e.do(http.MethodPost, "/backups/history/"+hid+"/restore", `{"confirm":"restore"}`); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "restore-panel") {
		t.Fatalf("panel restore via API: %d %s", rec.Code, rec.Body.String())
	}
	if rec := e.do(http.MethodPost, "/backups/history/nope/restore", `{"confirm":"restore"}`); rec.Code != http.StatusNotFound {
		t.Fatalf("restore unknown: %d", rec.Code)
	}

	// Status reflects it.
	st := e.mustJSON(t, e.do(http.MethodGet, "/backups/status", ""), http.StatusOK)
	for _, k := range []string{"schedulerRunning", "lastRunAt", "nextRunAt", "failedLast24h", "destinations", "schedules", "passphraseSet"} {
		if _, ok := st[k]; !ok {
			t.Errorf("status lacks %q: %v", k, st)
		}
	}
	if st["passphraseSet"] != true || st["destinations"] != float64(1) || st["schedules"] != float64(1) || st["failedLast24h"] != float64(0) ||
		st["lastRunAt"] == nil || st["nextRunAt"] == nil || st["schedulerRunning"] != false {
		t.Fatalf("status: %v", st)
	}

	// Delete removes the row and the stored file.
	stored := filepath.Join(e.dataDir, "backups", "scheduled", f0["name"].(string))
	if _, err := os.Stat(stored); err != nil {
		t.Fatalf("stored file missing: %v", err)
	}
	if rec := e.do(http.MethodDelete, "/backups/history/"+hid, ""); rec.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(stored); err == nil {
		t.Fatal("stored file survived history deletion")
	}
	if rec := e.do(http.MethodGet, "/backups/history/"+hid+"/download", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("download after delete: %d", rec.Code)
	}
	if rec := e.do(http.MethodDelete, "/backups/history/"+hid, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("delete twice: %d", rec.Code)
	}
}

func TestBackupPassphraseEndpoints(t *testing.T) {
	e := newBackupTestEnv(t)
	if v := e.mustJSON(t, e.do(http.MethodGet, "/backups/passphrase", ""), http.StatusOK); v["set"] != false {
		t.Fatalf("initially set: %v", v)
	}
	for name, body := range map[string]string{
		"too short":  `{"passphrase":"short"}`,
		"multi line": `{"passphrase":"a long passphrase\nwith a newline"}`,
		"empty":      `{"passphrase":""}`,
		"too long":   `{"passphrase":"` + strings.Repeat("x", 257) + `"}`,
		"not json":   `nope`,
	} {
		if rec := e.do(http.MethodPost, "/backups/passphrase", body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", name, rec.Code)
		}
	}
	v := e.mustJSON(t, e.do(http.MethodPost, "/backups/passphrase", `{"passphrase":"correct horse battery"}`), http.StatusOK)
	if v["set"] != true || v["warning"] != nil {
		t.Fatalf("first set: %v", v)
	}
	if body := e.do(http.MethodGet, "/backups/passphrase", "").Body.String(); strings.Contains(body, "correct horse") || !strings.Contains(body, `"set":true`) {
		t.Fatalf("get: %s", body)
	}
	stored, _ := e.s.db.GetSetting(db.BackupSettingPassphrase)
	if stored == "" || strings.Contains(stored, "correct horse") {
		t.Fatalf("passphrase stored in plaintext: %q", stored)
	}
	if got, err := e.s.db.BackupPassphrase(); err != nil || got != "correct horse battery" {
		t.Fatalf("round trip: %q %v", got, err)
	}
	// Replacing it warns that older backups need the old one.
	v = e.mustJSON(t, e.do(http.MethodPost, "/backups/passphrase", `{"passphrase":"another long passphrase"}`), http.StatusOK)
	if w, _ := v["warning"].(string); !strings.Contains(w, "OLD passphrase") {
		t.Fatalf("no warning on replace: %v", v)
	}
}

func TestBackupActionsAreAudited(t *testing.T) {
	e := newBackupTestEnv(t)
	id := e.mustJSON(t, e.do(http.MethodPost, "/backups/destinations", `{"name":"disk","type":"local"}`), http.StatusCreated)["id"].(string)
	e.mustJSON(t, e.do(http.MethodPatch, "/backups/destinations/"+id, `{"name":"disk2"}`), http.StatusOK)
	e.mustJSON(t, e.do(http.MethodPost, "/backups/passphrase", `{"passphrase":"correct horse battery"}`), http.StatusOK)
	e.mustJSON(t, e.do(http.MethodDelete, "/backups/destinations/"+id, ""), http.StatusOK)

	rows, err := e.s.db.Query(`SELECT action, resource FROM audit_log WHERE action LIKE 'backup.%' ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var a, r string
		_ = rows.Scan(&a, &r)
		got = append(got, a)
		if strings.Contains(r, "correct horse") {
			t.Fatalf("audit row leaks the passphrase: %q", r)
		}
	}
	want := []string{"backup.destination.create", "backup.destination.update", "backup.passphrase", "backup.destination.delete"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("audit actions = %v, want %v", got, want)
	}
}
