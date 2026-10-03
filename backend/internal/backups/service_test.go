package backups

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pulsenode/backend/internal/alerts"
	"pulsenode/backend/internal/db"
)

const (
	testAES  = "0123456789abcdef0123456789abcdef-test-aes-key"
	testDump = "--\n-- PostgreSQL database dump\n--\nCREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n"
)

type fakeOps struct {
	d        *db.DB
	mu       sync.Mutex
	dump     string
	dumpErr  error
	restored string
	restErr  error
	dumps    int
	started  chan struct{} // when set, Dump signals it and then blocks until ctx is cancelled
}

func (f *fakeOps) ResolveManaged(id string) (*db.ManagedDatabase, string, error) {
	m, err := f.d.GetManagedDatabase(id)
	if err != nil || m == nil {
		return nil, "", fmt.Errorf("managed database %q no longer exists", id)
	}
	return m, "pn-db-" + m.Engine + "-" + m.Name, nil
}

func (f *fakeOps) Dump(ctx context.Context, m *db.ManagedDatabase, container string, w io.Writer) error {
	f.mu.Lock()
	started := f.started
	f.dumps++
	f.mu.Unlock()
	if started != nil {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dumpErr != nil {
		return f.dumpErr
	}
	_, err := io.WriteString(w, f.dump)
	return err
}

func (f *fakeOps) Restore(ctx context.Context, m *db.ManagedDatabase, container, path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.restored = string(b)
	return "restored", f.restErr
}

type fakeSender struct {
	mu   sync.Mutex
	msgs []alerts.Message
}

func (s *fakeSender) Send(ctx context.Context, ch alerts.Channel, m alerts.Message) error {
	s.mu.Lock()
	s.msgs = append(s.msgs, m)
	s.mu.Unlock()
	return nil
}

func (s *fakeSender) titles() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, m := range s.msgs {
		out = append(out, m.Title)
	}
	return out
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type env struct {
	svc     *Service
	d       *db.DB
	ops     *fakeOps
	sender  *fakeSender
	clk     *clock
	dataDir string
	destDir string
	ws      string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	t.Setenv("AES_KEY", testAES)
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	e := &env{d: d, ops: &fakeOps{d: d, dump: testDump}, sender: &fakeSender{},
		clk: &clock{t: time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)}, dataDir: t.TempDir(), ws: t.TempDir()}
	e.destDir = filepath.Join(e.dataDir, "dest")
	e.svc = New(Deps{DB: d, Ops: e.ops, DataDir: e.dataDir, Workspace: e.ws, Now: e.clk.Now, Sender: e.sender,
		PanelVersion: func() string { return "v9.9.9" }})
	if err := d.SaveBackupDestination(&db.BackupDestination{ID: "d1", Name: "local", Type: "local", Enabled: true,
		Config: map[string]string{"dir": e.destDir}}, nil); err != nil {
		t.Fatal(err)
	}
	if err := d.CreateManagedDatabase(&db.ManagedDatabase{ID: "m1", Name: "app", Engine: "postgres", HostPort: 5432,
		Username: "u", Password: "p", DBName: "app", Status: "running"}); err != nil {
		t.Fatal(err)
	}
	// One notification channel so failures fan out to the fake sender.
	cfg, err := alerts.EncodeConfig(map[string]string{"url": "https://hooks.example.com/x"})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.CreateNotificationChannel(&db.NotificationChannel{ID: "c1", Name: "hook", Type: "webhook", Enabled: true, Config: cfg}); err != nil {
		t.Fatal(err)
	}
	return e
}

func (e *env) schedule(t *testing.T, id, target string, mod func(*db.BackupSchedule)) *db.BackupSchedule {
	t.Helper()
	past := e.clk.Now().Add(-time.Hour)
	s := &db.BackupSchedule{ID: id, Name: "sched " + id, Target: target, Frequency: FreqDaily, Hour: 2, Retention: 7,
		DestinationIDs: []string{"d1"}, Enabled: true, NextRunAt: &past}
	if mod != nil {
		mod(s)
	}
	if err := e.d.SaveBackupSchedule(s); err != nil {
		t.Fatal(err)
	}
	return s
}

func (e *env) runDue(t *testing.T, id string) {
	t.Helper()
	past := e.clk.Now().Add(-time.Minute)
	if err := e.d.SetBackupNextRun(id, &past); err != nil {
		t.Fatal(err)
	}
	e.svc.Tick(context.Background())
}

func (e *env) history(t *testing.T, scheduleID string) []db.BackupHistory {
	t.Helper()
	h, err := e.d.ListBackupHistory(100, scheduleID)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func readStored(t *testing.T, e *env, h db.BackupHistory) []byte {
	t.Helper()
	rc, _, err := e.svc.OpenArtifact(context.Background(), &h)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	b, _ := io.ReadAll(rc)
	return b
}

func gunzipString(t *testing.T, b []byte) string {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func firstFileOK(h db.BackupHistory) bool {
	for _, f := range h.Files {
		if f.OK {
			return true
		}
	}
	return false
}

func TestTickRunsDueScheduleOnce(t *testing.T) {
	e := newEnv(t)
	e.schedule(t, "s1", "db:m1", func(s *db.BackupSchedule) { s.Encrypt = false })
	e.svc.Tick(context.Background())

	h := e.history(t, "s1")
	if len(h) != 1 || h[0].Status != "success" || h[0].SizeBytes == 0 || h[0].FinishedAt == nil {
		t.Fatalf("history: %+v", h)
	}
	if len(h[0].Files) != 1 || !h[0].Files[0].OK || h[0].Files[0].DestinationName != "local" {
		t.Fatalf("files: %+v", h[0].Files)
	}
	if got := gunzipString(t, readStored(t, e, h[0])); got != testDump {
		t.Fatalf("stored dump = %q", got)
	}
	sch, _ := e.d.GetBackupSchedule("s1")
	if sch.LastStatus != "success" || sch.LastRunAt == nil || sch.NextRunAt == nil || !sch.NextRunAt.After(e.clk.Now()) {
		t.Fatalf("schedule after run: %+v", sch)
	}
	// Not due any more: a second tick does nothing.
	e.svc.Tick(context.Background())
	if n := len(e.history(t, "s1")); n != 1 {
		t.Fatalf("second tick ran again: %d rows", n)
	}
	// Temp files never linger.
	if ents, _ := os.ReadDir(filepath.Join(e.dataDir, "backups", "tmp")); len(ents) != 0 {
		t.Fatalf("temp dir not cleaned: %v", ents)
	}
}

func TestMissedRunsCatchUpAtMostOnce(t *testing.T) {
	e := newEnv(t)
	e.schedule(t, "s1", "db:m1", func(s *db.BackupSchedule) {
		old := e.clk.Now().Add(-72 * time.Hour) // three days of downtime
		s.NextRunAt = &old
		s.Encrypt = false
	})
	e.svc.Tick(context.Background())
	e.svc.Tick(context.Background())
	e.svc.Tick(context.Background())
	if n := len(e.history(t, "s1")); n != 1 {
		t.Fatalf("expected a single catch-up run, got %d", n)
	}
	if e.ops.dumps != 1 {
		t.Fatalf("dump ran %d times", e.ops.dumps)
	}
}

func TestDisabledScheduleDoesNotRun(t *testing.T) {
	e := newEnv(t)
	e.schedule(t, "s1", "db:m1", func(s *db.BackupSchedule) { s.Enabled = false })
	e.svc.Tick(context.Background())
	if n := len(e.history(t, "s1")); n != 0 {
		t.Fatalf("disabled schedule ran: %d", n)
	}
}

func TestRetentionKeepsNewestN(t *testing.T) {
	e := newEnv(t)
	e.schedule(t, "s1", "db:m1", func(s *db.BackupSchedule) { s.Retention = 2; s.Encrypt = false })
	for i := 0; i < 4; i++ {
		e.clk.Add(time.Hour)
		e.runDue(t, "s1")
	}
	files, _ := filepath.Glob(filepath.Join(e.destDir, "s1", "*"))
	if len(files) != 2 {
		t.Fatalf("expected 2 files after retention, got %d: %v", len(files), files)
	}
	h := e.history(t, "s1") // newest first
	if len(h) != 4 {
		t.Fatalf("history rows = %d", len(h))
	}
	for i, row := range h {
		live := firstFileOK(row)
		if want := i < 2; live != want {
			t.Errorf("row %d (newest=0): stored=%v want %v (%+v)", i, live, want, row.Files)
		}
		if !live && row.Files[0].Error != "removed by retention" {
			t.Errorf("row %d error = %q", i, row.Files[0].Error)
		}
		if row.Status != "success" {
			t.Errorf("row %d status %s", i, row.Status)
		}
	}
	for _, row := range h[:2] {
		if _, err := os.Stat(filepath.Join(e.destDir, row.Files[0].Name)); err != nil {
			t.Errorf("newest file missing: %v", err)
		}
	}
}

func TestEncryptedDBBackupAndRestore(t *testing.T) {
	e := newEnv(t)
	e.schedule(t, "s1", "db:m1", func(s *db.BackupSchedule) { s.Encrypt = true })
	e.svc.Tick(context.Background())
	h := e.history(t, "s1")
	if len(h) != 1 || h[0].Status != "success" || !h[0].Encrypted {
		t.Fatalf("history: %+v", h)
	}
	stored := readStored(t, e, h[0])
	if !bytes.HasPrefix(stored, []byte(magic)) || !strings.HasSuffix(h[0].Files[0].Name, ".enc") {
		t.Fatalf("stored file is not encrypted: %q", h[0].Files[0].Name)
	}
	if bytes.Contains(stored, []byte("PostgreSQL")) {
		t.Fatal("plaintext visible in encrypted backup")
	}
	out, err := e.svc.RestoreFromHistory(context.Background(), h[0].ID)
	if err != nil || out != "restored" {
		t.Fatalf("restore: %q %v", out, err)
	}
	if e.ops.restored != testDump {
		t.Fatalf("restored %q", e.ops.restored)
	}

	// Without the panel keys the file cannot be read.
	t.Setenv("AES_KEY", strings.Repeat("z", 40))
	if _, err := e.svc.RestoreFromHistory(context.Background(), h[0].ID); err == nil {
		t.Fatal("restore succeeded with a different AES key")
	}
}

func TestRestoreRefusals(t *testing.T) {
	e := newEnv(t)
	e.schedule(t, "s1", "db:m1", func(s *db.BackupSchedule) { s.Encrypt = false })
	e.svc.Tick(context.Background())
	h := e.history(t, "s1")[0]

	e.svc.acquire("something else")
	if _, err := e.svc.RestoreFromHistory(context.Background(), h.ID); !errors.Is(err, ErrBusy) {
		t.Fatalf("restore while busy: %v", err)
	}
	e.svc.release()

	if _, err := e.svc.RestoreFromHistory(context.Background(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown id: %v", err)
	}
	_ = e.d.SetBackupPassphrase("a long enough passphrase")
	e.schedule(t, "p1", "panel", nil)
	e.svc.Tick(context.Background())
	for _, row := range e.history(t, "p1") {
		if _, err := e.svc.RestoreFromHistory(context.Background(), row.ID); err == nil || !strings.Contains(err.Error(), "restore-panel") {
			t.Fatalf("panel backup restore via API: %v", err)
		}
	}
	// A database that no longer exists cannot be restored into.
	_, _ = e.d.Exec(`DELETE FROM managed_databases WHERE id='m1'`)
	if _, err := e.svc.RestoreFromHistory(context.Background(), h.ID); err == nil {
		t.Fatal("restore into a removed database")
	}
}

func TestFailureRaisesOneAlertAndSuccessResolvesIt(t *testing.T) {
	e := newEnv(t)
	e.schedule(t, "s1", "db:m1", func(s *db.BackupSchedule) { s.Encrypt = false })
	e.ops.dump = "" // a failing pg_dump yields no stdout

	e.clk.Add(time.Hour)
	e.runDue(t, "s1")
	h := e.history(t, "s1")
	if len(h) != 1 || h[0].Status != "failed" || !strings.Contains(h[0].Error, "empty") {
		t.Fatalf("history: %+v", h)
	}
	ev, err := e.d.LatestAlertEvent("backup:s1", "")
	if err != nil || ev == nil || ev.State != "firing" || ev.Metric != "backup.failed" || ev.Severity != "critical" {
		t.Fatalf("alert event: %+v %v", ev, err)
	}
	if n, _ := e.d.CountFiringAlerts(); n != 1 {
		t.Fatalf("firing alerts = %d", n)
	}
	e.svc.wg.Wait()
	if got := e.sender.titles(); len(got) != 1 || !strings.Contains(got[0], "Backup failed: sched s1") {
		t.Fatalf("notifications: %v", got)
	}

	// A second failure does not open a second alert.
	e.clk.Add(time.Hour)
	e.runDue(t, "s1")
	if n, _ := e.d.CountFiringAlerts(); n != 1 {
		t.Fatalf("duplicate alert: %d firing", n)
	}
	sch, _ := e.d.GetBackupSchedule("s1")
	if sch.LastStatus != "failed" {
		t.Fatalf("last status %q", sch.LastStatus)
	}

	// Next success resolves it and notifies.
	e.ops.dump = testDump
	e.clk.Add(time.Hour)
	e.runDue(t, "s1")
	e.svc.wg.Wait()
	ev, _ = e.d.LatestAlertEvent("backup:s1", "")
	if ev.State != "resolved" {
		t.Fatalf("alert not resolved: %+v", ev)
	}
	if n, _ := e.d.CountFiringAlerts(); n != 0 {
		t.Fatalf("firing after success = %d", n)
	}
	titles := e.sender.titles()
	if got := titles[len(titles)-1]; !strings.HasPrefix(got, "[RESOLVED]") {
		t.Fatalf("last notification %q (all %v)", got, titles)
	}
}

func TestDumpErrorsAndBadDumpHeaders(t *testing.T) {
	e := newEnv(t)
	e.schedule(t, "s1", "db:m1", func(s *db.BackupSchedule) { s.Encrypt = false })
	e.ops.dumpErr = errors.New("exec: container not running")
	e.runDue(t, "s1")
	h := e.history(t, "s1")
	if len(h) != 1 || h[0].Status != "failed" || !strings.Contains(h[0].Error, "container not running") {
		t.Fatalf("dump error: %+v", h)
	}
	e.ops.dumpErr = nil
	e.ops.dump = "this is not a database dump at all"
	e.clk.Add(time.Hour)
	e.runDue(t, "s1")
	if h = e.history(t, "s1"); h[0].Status != "failed" || !strings.Contains(h[0].Error, "PostgreSQL") {
		t.Fatalf("bad header accepted: %+v", h[0])
	}
	// Nothing was uploaded for failed runs.
	if files, _ := filepath.Glob(filepath.Join(e.destDir, "s1", "*")); len(files) != 0 {
		t.Fatalf("files uploaded for failed runs: %v", files)
	}
}

func TestSanityCheckPerEngine(t *testing.T) {
	t.Setenv("AES_KEY", testAES)
	write := func(content []byte) string {
		p := filepath.Join(t.TempDir(), "x.gz")
		f, _ := os.Create(p)
		zw := gzip.NewWriter(f)
		_, _ = zw.Write(content)
		_ = zw.Close()
		_ = f.Close()
		return p
	}
	ok := map[string][]byte{
		"postgres": []byte("--\n-- PostgreSQL database dump\n"),
		"mysql":    []byte("-- MySQL dump 10.13\n"),
		"mongodb":  {0x6d, 0xe2, 0x99, 0x81, 1, 2, 3},
		"redis":    []byte("REDIS0011xxxx"),
	}
	for eng, c := range ok {
		if err := sanityCheck(write(c), eng, false); err != nil {
			t.Errorf("%s: valid dump rejected: %v", eng, err)
		}
		if err := sanityCheck(write([]byte("garbage")), eng, false); err == nil {
			t.Errorf("%s: garbage accepted", eng)
		}
		if err := sanityCheck(write(nil), eng, false); err == nil {
			t.Errorf("%s: empty accepted", eng)
		}
	}
	// A damaged gzip stream is caught even when the head looks right.
	p := write(bytes.Repeat([]byte("-- PostgreSQL database dump\n"), 5000))
	b, _ := os.ReadFile(p)
	b[len(b)-10] ^= 0xff
	_ = os.WriteFile(p, b, 0o600)
	if err := sanityCheck(p, "postgres", false); err == nil {
		t.Error("corrupt gzip accepted")
	}
}

func TestBusySkipsTickAndRunNowRejects(t *testing.T) {
	e := newEnv(t)
	e.schedule(t, "s1", "db:m1", func(s *db.BackupSchedule) { s.Encrypt = false })
	if !e.svc.acquire("manual") {
		t.Fatal("acquire failed on an idle service")
	}
	if e.svc.acquire("second") {
		t.Fatal("two runs may not hold the service at once")
	}
	e.svc.Tick(context.Background())
	if n := len(e.history(t, "s1")); n != 0 {
		t.Fatalf("tick ran while busy: %d", n)
	}
	if _, err := e.svc.RunNow("s1", "tester"); !errors.Is(err, ErrBusy) {
		t.Fatalf("RunNow while busy: %v", err)
	}
	e.svc.release()

	id, err := e.svc.RunNow("s1", "tester")
	if err != nil || id == "" {
		t.Fatalf("RunNow: %q %v", id, err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		h, _ := e.d.GetBackupHistory(id)
		if h != nil && h.Status != "running" {
			if h.Status != "success" {
				t.Fatalf("run failed: %+v", h)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("RunNow never finished")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := e.svc.RunNow("nope", "t"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown schedule: %v", err)
	}
}

func TestPanelBackupEndToEnd(t *testing.T) {
	e := newEnv(t)
	t.Setenv("JWT_SECRET", "")
	if err := os.WriteFile(filepath.Join(e.dataDir, "jwt-secret"), []byte("jwt-secret-value\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.ws, ".env.local"), []byte("AES_KEY="+testAES+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.dataDir, "scans.json"), []byte(`[{"image":"x"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	e.schedule(t, "p1", "panel", nil)

	// Without a passphrase the scheduled run fails, records it and raises an alert.
	e.svc.Tick(context.Background())
	h := e.history(t, "p1")
	if len(h) != 1 || h[0].Status != "failed" || !strings.Contains(h[0].Error, "passphrase") {
		t.Fatalf("no-passphrase run: %+v", h)
	}
	if ev, _ := e.d.LatestAlertEvent("backup:p1", ""); ev == nil || ev.State != "firing" {
		t.Fatalf("no alert for refused panel backup: %+v", ev)
	}
	if _, err := e.svc.RunNow("p1", "t"); !errors.Is(err, ErrNoPassphrase) {
		t.Fatalf("RunNow without passphrase: %v", err)
	}

	pass := "correct horse battery staple"
	if err := e.d.SetBackupPassphrase(pass); err != nil {
		t.Fatal(err)
	}
	e.clk.Add(time.Hour)
	e.runDue(t, "p1")
	h = e.history(t, "p1")
	if h[0].Status != "success" || !h[0].Encrypted || !strings.HasSuffix(h[0].Files[0].Name, ".pnbak") {
		t.Fatalf("panel run: %+v", h[0])
	}
	arc := readStored(t, e, h[0])
	if bytes.Contains(arc, []byte("SQLite format")) || bytes.Contains(arc, []byte(testAES)) {
		t.Fatal("panel archive leaks plaintext")
	}
	m, err := VerifyArchive(bytes.NewReader(arc), pass)
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	for _, f := range m.Files {
		have[f.Name] = true
	}
	for _, n := range []string{FileDB, FileAESKey, FileJWT, FileEnvLocal, FileScans} {
		if !have[n] {
			t.Errorf("archive lacks %s (has %v)", n, have)
		}
	}
	if m.PanelVersion != "v9.9.9" {
		t.Errorf("panel version %q", m.PanelVersion)
	}
	if _, err := VerifyArchive(bytes.NewReader(arc), "wrong passphrase here"); err == nil {
		t.Fatal("wrong passphrase verified")
	}
	out := filepath.Join(t.TempDir(), "restore")
	if _, err := RestoreArchive(bytes.NewReader(arc), pass, out, false); err != nil {
		t.Fatal(err)
	}
	if err := db.VerifySnapshotFile(filepath.Join(out, FileDB)); err != nil {
		t.Fatalf("restored database is not valid: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(out, FileAESKey)); strings.TrimSpace(string(b)) != testAES {
		t.Fatalf("aes-key = %q", b)
	}
	// The failure alert from the refused run resolved after this success.
	if ev, _ := e.d.LatestAlertEvent("backup:p1", ""); ev.State != "resolved" {
		t.Fatalf("alert not resolved: %+v", ev)
	}
	// The pre-update snapshots directory is untouched by scheduled snapshots.
	if ents, _ := os.ReadDir(e.d.SnapshotsDir()); len(ents) != 0 {
		t.Fatalf("scheduled backup wrote into the update snapshots dir: %v", ents)
	}
}

func TestPartialFailureAcrossDestinations(t *testing.T) {
	e := newEnv(t)
	if err := e.d.SaveBackupDestination(&db.BackupDestination{ID: "d2", Name: "bad", Type: "local", Enabled: true,
		Config: map[string]string{"dir": "/etc/not-allowed"}}, nil); err != nil {
		t.Fatal(err)
	}
	if err := e.d.SaveBackupDestination(&db.BackupDestination{ID: "d3", Name: "off", Type: "local", Enabled: false,
		Config: map[string]string{"dir": filepath.Join(e.dataDir, "off")}}, nil); err != nil {
		t.Fatal(err)
	}
	e.schedule(t, "s1", "db:m1", func(s *db.BackupSchedule) { s.DestinationIDs = []string{"d1", "d2", "d3"}; s.Encrypt = false })
	e.svc.Tick(context.Background())
	h := e.history(t, "s1")[0]
	if h.Status != "failed" || len(h.Files) != 3 {
		t.Fatalf("history: %+v", h)
	}
	byName := map[string]db.BackupFileResult{}
	for _, f := range h.Files {
		byName[f.DestinationName] = f
	}
	if !byName["local"].OK || byName["bad"].OK || byName["off"].OK {
		t.Fatalf("per-destination results: %+v", byName)
	}
	if !strings.Contains(byName["bad"].Error, "inside") || byName["off"].Error != "destination is disabled" {
		t.Fatalf("errors: %+v", byName)
	}
	if _, err := os.Stat(filepath.Join(e.dataDir, "off")); err == nil {
		t.Fatal("disabled destination was written to")
	}
}

func TestDeleteHistoryRemovesStoredFile(t *testing.T) {
	e := newEnv(t)
	e.schedule(t, "s1", "db:m1", func(s *db.BackupSchedule) { s.Encrypt = false })
	e.svc.Tick(context.Background())
	h := e.history(t, "s1")[0]
	path := filepath.Join(e.destDir, h.Files[0].Name)
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.DeleteHistory(context.Background(), h.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("stored file survived deletion")
	}
	if got, _ := e.d.GetBackupHistory(h.ID); got != nil {
		t.Fatal("history row survived deletion")
	}
	if err := e.svc.DeleteHistory(context.Background(), h.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
	running := &db.BackupHistory{ID: "r1", ScheduleID: "s1", Target: "panel", StartedAt: e.clk.Now(), Status: "running"}
	_ = e.d.InsertBackupHistory(running)
	if err := e.svc.DeleteHistory(context.Background(), "r1"); !errors.Is(err, ErrBusy) {
		t.Fatalf("deleting a running row: %v", err)
	}
}

func TestHistoryHygiene(t *testing.T) {
	e := newEnv(t)
	now := e.clk.Now()
	for i := 0; i < 230; i++ {
		_ = e.d.InsertBackupHistory(&db.BackupHistory{ID: fmt.Sprintf("f%03d", i), ScheduleID: "s1", Target: "panel",
			StartedAt: now.Add(-time.Duration(i) * time.Minute), Status: "failed", Error: "x"})
	}
	// A successful row with a live file survives even when it is very old.
	_ = e.d.InsertBackupHistory(&db.BackupHistory{ID: "keep", ScheduleID: "s1", Target: "panel", StartedAt: now.Add(-400 * 24 * time.Hour),
		Status: "success", Files: []db.BackupFileResult{{DestinationID: "d1", Name: "s1/x", OK: true}}})
	// An old failed row goes.
	_ = e.d.InsertBackupHistory(&db.BackupHistory{ID: "old", ScheduleID: "s1", Target: "panel", StartedAt: now.Add(-200 * 24 * time.Hour), Status: "failed"})
	e.svc.hygiene(now)
	rows, _ := e.d.ListBackupHistory(5000, "")
	ids := map[string]bool{}
	for _, r := range rows {
		ids[r.ID] = true
	}
	if !ids["keep"] || ids["old"] {
		t.Fatalf("keep=%v old=%v", ids["keep"], ids["old"])
	}
	if len(rows) > historyKeepRows+1 {
		t.Fatalf("history not trimmed: %d rows", len(rows))
	}
}

func TestStartMarksStaleRunsAndStops(t *testing.T) {
	e := newEnv(t)
	_ = e.d.InsertBackupHistory(&db.BackupHistory{ID: "stale", ScheduleID: "s1", Target: "panel", StartedAt: e.clk.Now(), Status: "running"})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { e.svc.Start(ctx); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for !e.svc.SchedulerRunning() {
		if time.Now().After(deadline) {
			t.Fatal("scheduler never reported running")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Start did not return after cancel")
	}
	if e.svc.SchedulerRunning() {
		t.Fatal("still running after stop")
	}
	if h, _ := e.d.GetBackupHistory("stale"); h.Status != "failed" || !strings.Contains(h.Error, "restart") {
		t.Fatalf("stale row: %+v", h)
	}
}

func TestLocalDirAllowed(t *testing.T) {
	e := newEnv(t)
	for _, ok := range []string{e.dataDir, filepath.Join(e.dataDir, "backups", "x")} {
		if err := e.svc.LocalDirAllowed(ok); err != nil {
			t.Errorf("%s rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "relative/dir", "/etc", "/", e.dataDir + "-evil", filepath.Join(e.dataDir, "..", "x")} {
		if err := e.svc.LocalDirAllowed(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	extra := t.TempDir()
	t.Setenv("PULSENODE_BACKUPS_EXTRA_DIRS", extra)
	if err := e.svc.LocalDirAllowed(filepath.Join(extra, "mnt")); err != nil {
		t.Errorf("extra dir rejected: %v", err)
	}
}

func TestDestinationCredentialsStayEncrypted(t *testing.T) {
	e := newEnv(t)
	sec := db.BackupSecrets{AccessKey: "AKIAEXAMPLE1234", SecretKey: "super-secret-value"}
	d := &db.BackupDestination{ID: "s3a", Name: "b2", Type: "s3", Enabled: true,
		Config: map[string]string{"endpoint": "s3.example.com", "bucket": "backups", "accessKeyHint": "…1234"}}
	if err := e.d.SaveBackupDestination(d, &sec); err != nil {
		t.Fatal(err)
	}
	got, _ := e.d.GetBackupDestination("s3a")
	if !got.SecretSet {
		t.Fatal("secretSet false")
	}
	for k, v := range got.Config {
		if strings.Contains(v, "super-secret") || strings.Contains(v, "AKIAEXAMPLE") {
			t.Fatalf("config %s leaks a credential", k)
		}
	}
	raw := ""
	_ = e.d.QueryRow(`SELECT secret_enc FROM backup_destinations WHERE id='s3a'`).Scan(&raw)
	if raw == "" || strings.Contains(raw, "super-secret") || strings.Contains(raw, "AKIA") {
		t.Fatalf("credentials stored in plaintext: %q", raw)
	}
	back, err := e.d.BackupDestinationSecrets("s3a")
	if err != nil || back != sec {
		t.Fatalf("decrypt: %+v %v", back, err)
	}
	// Updating without secrets keeps them.
	d.Name = "renamed"
	if err := e.d.SaveBackupDestination(d, nil); err != nil {
		t.Fatal(err)
	}
	if back, _ := e.d.BackupDestinationSecrets("s3a"); back != sec {
		t.Fatal("secrets lost on update")
	}
}

func TestShutdownMidRunIsNotAFailureAlert(t *testing.T) {
	e := newEnv(t)
	e.ops.started = make(chan struct{})
	e.schedule(t, "s1", "db:m1", func(s *db.BackupSchedule) { s.Encrypt = false })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { e.svc.Tick(ctx); close(done) }()
	<-e.ops.started
	cancel() // the panel is shutting down while the dump is running
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Tick did not return after cancel")
	}
	h := e.history(t, "s1")
	if len(h) != 1 || h[0].Status != "failed" || h[0].Error != "interrupted by shutdown" {
		t.Fatalf("history: %+v", h)
	}
	if ev, _ := e.d.LatestAlertEvent("backup:s1", ""); ev != nil {
		t.Fatalf("a shutdown raised an alert: %+v", ev)
	}
	e.svc.wg.Wait()
	if got := e.sender.titles(); len(got) != 0 {
		t.Fatalf("a shutdown sent notifications: %v", got)
	}
	// The schedule is still due, so it runs again after the restart.
	sch, _ := e.d.GetBackupSchedule("s1")
	if sch.LastStatus != "" || sch.NextRunAt == nil || sch.NextRunAt.After(e.clk.Now()) {
		t.Fatalf("schedule was advanced by an interrupted run: %+v", sch)
	}
	if e.svc.busy != "" {
		t.Fatalf("service still marked busy: %q", e.svc.busy)
	}
}

func TestStartCleansLeftoverTempFiles(t *testing.T) {
	e := newEnv(t)
	leftover := filepath.Join(e.dataDir, "backups", "tmp", "run-crashed")
	if err := os.MkdirAll(leftover, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(leftover, "pulsenode.db"), []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { e.svc.Start(ctx); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for e.svc.SchedulerRunning() == false {
		if time.Now().After(deadline) {
			t.Fatal("scheduler never started")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	if _, err := os.Stat(leftover); err == nil {
		t.Fatal("leftover temp directory from a crashed run was not removed")
	}
}
