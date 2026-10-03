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
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog/log"

	"pulsenode/backend/internal/alerts"
	"pulsenode/backend/internal/db"
)

var (
	// ErrBusy: a backup or restore is already running (global concurrency is 1).
	ErrBusy = errors.New("another backup or restore is already running")
	// ErrNoPassphrase: panel backups are always encrypted with a user passphrase.
	ErrNoPassphrase = errors.New("set a backup passphrase first (panel backups are always encrypted)")
	ErrNotFound     = errors.New("not found")
)

// Broadcaster is the slice of the event hub the service needs.
type Broadcaster interface {
	Broadcast(kind string, data any)
}

// DBOps performs the engine-specific dump and restore of managed databases (the
// API package implements it on top of the Docker client).
type DBOps interface {
	ResolveManaged(id string) (m *db.ManagedDatabase, container string, err error)
	Dump(ctx context.Context, m *db.ManagedDatabase, container string, w io.Writer) error
	Restore(ctx context.Context, m *db.ManagedDatabase, container, dumpPath string) (output string, err error)
}

// Sender delivers an alert message to a channel (alerts.Sender in production).
type Sender interface {
	Send(ctx context.Context, ch alerts.Channel, m alerts.Message) error
}

// Deps wires the service to the rest of the panel.
type Deps struct {
	DB           *db.DB
	Hub          Broadcaster
	Ops          DBOps
	DataDir      string // PULSENODE_DATA_DIR
	Workspace    string // directory holding .env.local (the bind-mounted /workspace)
	PanelVersion func() string
	Sender       Sender
	Audit        func(actor, action, resource string, status int)
	Now          func() time.Time
	// ExtraDirs are additional directories a local destination may use (besides
	// DataDir); the operator mounts them into the container.
	ExtraDirs []string
}

// Service runs schedules and restores.
type Service struct {
	d Deps

	mu      sync.Mutex
	busy    string // what is running right now ("" = idle)
	alive   bool   // scheduler loop is running
	runCtx  context.Context
	wg      sync.WaitGroup
	lastHyg time.Time
}

func New(d Deps) *Service {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Sender == nil {
		d.Sender = alerts.NewSender()
	}
	if d.Workspace == "" {
		d.Workspace = "/workspace"
	}
	if d.PanelVersion == nil {
		d.PanelVersion = func() string { return "" }
	}
	s := &Service{d: d, runCtx: context.Background()}
	d.DB.EnsureBackupSchema()
	return s
}

// SchedulerRunning reports whether the scheduler loop is alive.
func (s *Service) SchedulerRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.alive
}

func (s *Service) acquire(what string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.busy != "" {
		return false
	}
	s.busy = what
	return true
}

func (s *Service) release() {
	s.mu.Lock()
	s.busy = ""
	s.mu.Unlock()
}

// Start runs the scheduler until ctx is cancelled, then waits for in-flight runs.
func (s *Service) Start(ctx context.Context) {
	s.mu.Lock()
	s.alive, s.runCtx = true, ctx
	s.mu.Unlock()
	defer func() {
		s.wg.Wait()
		s.mu.Lock()
		s.alive = false
		s.mu.Unlock()
	}()

	// Nothing is running yet, so anything left in the temp area is from a crashed run.
	_ = os.RemoveAll(filepath.Join(s.d.DataDir, "backups", "tmp"))
	if n, err := s.d.DB.FailStaleBackupRuns(); err != nil {
		log.Warn().Err(err).Msg("backups: could not clean stale runs")
	} else if n > 0 {
		log.Warn().Int64("runs", n).Msg("backups: marked interrupted runs as failed")
	}
	s.Tick(ctx)
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Tick(ctx)
		}
	}
}

// Tick runs every due schedule, one after the other. A schedule that was due while
// the panel was down runs once (its next time is then computed from "now"), so
// downtime never causes a burst of catch-up runs.
func (s *Service) Tick(ctx context.Context) {
	now := s.d.Now()
	s.hygiene(now)
	list, err := s.d.DB.ListBackupSchedules()
	if err != nil {
		log.Warn().Err(err).Msg("backups: could not list schedules")
		return
	}
	for i := range list {
		if ctx.Err() != nil {
			return
		}
		sch := list[i]
		if !sch.Enabled {
			continue
		}
		if sch.NextRunAt == nil {
			n := NextRun(sch.Frequency, sch.Hour, sch.Weekday, now)
			_ = s.d.DB.SetBackupNextRun(sch.ID, &n)
			continue
		}
		if sch.NextRunAt.After(now) {
			continue
		}
		if !s.acquire("schedule " + sch.ID) {
			continue // something is running; the next tick picks it up
		}
		h := s.begin(&sch)
		s.runLocked(ctx, &sch, h, "scheduler")
	}
}

// begin creates the history row for a run.
func (s *Service) begin(sch *db.BackupSchedule) *db.BackupHistory {
	h := &db.BackupHistory{
		ID: db.NewID("bkh"), ScheduleID: sch.ID, ScheduleName: sch.Name, Target: sch.Target,
		TargetName: s.targetName(sch.Target), StartedAt: s.d.Now(), Status: "running",
		Encrypted: sch.Encrypt || sch.Target == "panel", Files: []db.BackupFileResult{},
	}
	if err := s.d.DB.InsertBackupHistory(h); err != nil {
		log.Warn().Err(err).Msg("backups: could not record run")
	}
	s.broadcast("backup:run", map[string]any{"id": h.ID, "scheduleId": sch.ID, "status": "running"})
	return h
}

func (s *Service) targetName(target string) string {
	if target == "panel" {
		return "PulseNode panel"
	}
	if id, ok := strings.CutPrefix(target, "db:"); ok {
		if m, err := s.d.DB.GetManagedDatabase(id); err == nil && m != nil {
			return m.Name
		}
		return id
	}
	return target
}

func (s *Service) broadcast(kind string, data any) {
	if s.d.Hub != nil {
		s.d.Hub.Broadcast(kind, data)
	}
}

func (s *Service) audit(actor, action, resource string, status int) {
	if s.d.Audit != nil {
		s.d.Audit(actor, action, resource, status)
	}
}

// RunNow starts a schedule immediately in the background and returns the id of the
// history row it will fill in.
func (s *Service) RunNow(scheduleID, actor string) (string, error) {
	sch, err := s.d.DB.GetBackupSchedule(scheduleID)
	if err != nil {
		return "", err
	}
	if sch == nil {
		return "", ErrNotFound
	}
	if sch.Target == "panel" {
		if p, _ := s.passphrase(); p == "" {
			return "", ErrNoPassphrase
		}
	}
	if !s.acquire("schedule " + sch.ID) {
		return "", ErrBusy
	}
	h := s.begin(sch)
	s.mu.Lock()
	ctx := s.runCtx
	s.mu.Unlock()
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.runLocked(ctx, sch, h, actor)
	}()
	return h.ID, nil
}

func (s *Service) passphrase() (string, error) {
	p, err := s.d.DB.BackupPassphrase()
	if err != nil {
		return "", err
	}
	return p, nil
}

// runLocked executes a run; the busy flag is already held and released here.
func (s *Service) runLocked(ctx context.Context, sch *db.BackupSchedule, h *db.BackupHistory, actor string) {
	defer s.release()
	timeout := 6 * time.Hour
	if sch.Target == "panel" {
		timeout = time.Hour
	}
	rctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	size, files, runErr := s.execute(rctx, sch, h)
	finished := s.d.Now()
	h.FinishedAt = &finished
	h.SizeBytes = size
	h.Files = files
	if runErr != nil && ctx.Err() != nil {
		// The panel is shutting down: this is not a backup failure worth an alert.
		// The schedule stays due, so it runs again after the restart.
		h.Status, h.Error = "failed", "interrupted by shutdown"
		if err := s.d.DB.UpdateBackupHistory(h); err != nil {
			log.Warn().Err(err).Msg("backups: could not save interrupted run")
		}
		return
	}
	if runErr != nil {
		h.Status, h.Error = "failed", runErr.Error()
	} else {
		h.Status = "success"
	}
	if err := s.d.DB.UpdateBackupHistory(h); err != nil {
		log.Warn().Err(err).Msg("backups: could not save run result")
	}
	next := NextRun(sch.Frequency, sch.Hour, sch.Weekday, finished)
	if err := s.d.DB.RecordBackupRun(sch.ID, finished, h.Status, &next); err != nil {
		log.Warn().Err(err).Msg("backups: could not update schedule")
	}
	status := 200
	if runErr != nil {
		status = 500
		log.Warn().Str("schedule", sch.Name).Err(runErr).Msg("backups: run failed")
	} else {
		log.Info().Str("schedule", sch.Name).Int64("bytes", size).Msg("backups: run finished")
	}
	s.audit(actor, "backup.run", sch.Name, status)
	s.broadcast("backup:run", map[string]any{"id": h.ID, "scheduleId": sch.ID, "status": h.Status})
	if runErr != nil {
		s.raiseFailure(ctx, sch, runErr.Error())
	} else {
		s.resolveFailure(ctx, sch)
		if sch.NotifyOnSuccess {
			s.notifySuccess(ctx, sch, h)
		}
	}
}

// execute builds the artifact, uploads it to every destination and applies retention.
func (s *Service) execute(ctx context.Context, sch *db.BackupSchedule, h *db.BackupHistory) (int64, []db.BackupFileResult, error) {
	tmpRoot := filepath.Join(s.d.DataDir, "backups", "tmp")
	if err := os.MkdirAll(tmpRoot, 0o700); err != nil {
		return 0, nil, fmt.Errorf("create temp dir: %w", err)
	}
	tmp, err := os.MkdirTemp(tmpRoot, "run-")
	if err != nil {
		return 0, nil, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmp)

	art, err := s.build(ctx, sch, tmp)
	if err != nil {
		return 0, nil, err
	}

	var dests []db.BackupDestination
	for _, id := range sch.DestinationIDs {
		d, err := s.d.DB.GetBackupDestination(id)
		if err != nil || d == nil {
			continue
		}
		dests = append(dests, *d)
	}
	if len(dests) == 0 {
		return art.size, nil, errors.New("the schedule has no destination (it may have been deleted)")
	}

	files := make([]db.BackupFileResult, 0, len(dests))
	var failed []string
	for _, d := range dests {
		res := db.BackupFileResult{DestinationID: d.ID, DestinationName: d.Name, Name: sch.ID + "/" + art.name}
		if !d.Enabled {
			res.Error = "destination is disabled"
		} else if st, err := s.StoreFor(d); err != nil {
			res.Error = err.Error()
		} else if err := putFile(ctx, st, res.Name, art.path); err != nil {
			res.Error = err.Error()
		} else {
			res.OK = true
		}
		if !res.OK {
			failed = append(failed, d.Name+": "+res.Error)
		}
		files = append(files, res)
	}
	h.Files = files
	for _, f := range files {
		if f.OK {
			s.applyRetention(ctx, sch, f.DestinationID, h)
		}
	}
	if len(failed) > 0 {
		return art.size, files, fmt.Errorf("upload failed — %s", strings.Join(failed, "; "))
	}
	return art.size, files, nil
}

func putFile(ctx context.Context, st Store, name, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	return st.Put(ctx, name, f, fi.Size())
}

type artifact struct {
	path string
	name string
	size int64
}

func (s *Service) build(ctx context.Context, sch *db.BackupSchedule, tmp string) (*artifact, error) {
	ts := s.d.Now().UTC().Format("20060102T150405Z")
	if sch.Target == "panel" {
		return s.buildPanel(tmp, ts)
	}
	id, ok := strings.CutPrefix(sch.Target, "db:")
	if !ok || id == "" {
		return nil, fmt.Errorf("unknown backup target %q", sch.Target)
	}
	return s.buildDB(ctx, id, sch.Encrypt, tmp, ts)
}

func (s *Service) buildPanel(tmp, ts string) (*artifact, error) {
	pass, err := s.passphrase()
	if err != nil {
		return nil, fmt.Errorf("read backup passphrase: %w", err)
	}
	if pass == "" {
		return nil, ErrNoPassphrase
	}
	snap := filepath.Join(tmp, FileDB)
	if err := s.d.DB.SnapshotTo(snap); err != nil {
		return nil, err
	}
	var items []Item
	var notes []string
	items = append(items, Item{Name: FileDB, Path: snap})

	aes := os.Getenv("AES_KEY")
	if aes == "" {
		aes = os.Getenv("MASTER_ENCRYPTION_KEY")
	}
	if aes != "" {
		items = append(items, Item{Name: FileAESKey, Data: []byte(aes + "\n")})
	} else {
		notes = append(notes, "AES key was not available to the panel process")
	}
	if b, err := os.ReadFile(filepath.Join(s.d.DataDir, "jwt-secret")); err == nil && len(bytes.TrimSpace(b)) > 0 {
		items = append(items, Item{Name: FileJWT, Data: b})
	} else if j := firstNonEmpty(os.Getenv("JWT_SECRET"), os.Getenv("NODE_API_SECRET")); j != "" {
		items = append(items, Item{Name: FileJWT, Data: []byte(j + "\n")})
	} else {
		notes = append(notes, "no JWT secret found (sessions will simply be re-issued after a restore)")
	}
	if b, err := os.ReadFile(filepath.Join(s.d.Workspace, ".env.local")); err == nil {
		items = append(items, Item{Name: FileEnvLocal, Data: b})
	} else {
		notes = append(notes, ".env.local was not reachable from the panel container; keep your own copy of it")
	}
	for _, n := range []string{FileScans, FileSBOMs} {
		if _, err := os.Stat(filepath.Join(s.d.DataDir, n)); err == nil {
			items = append(items, Item{Name: n, Path: filepath.Join(s.d.DataDir, n)})
		}
	}

	name := "panel-" + ts + ".pnbak"
	out := filepath.Join(tmp, name)
	f, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	_, werr := WriteArchive(f, pass, items, s.d.PanelVersion(), notes, s.d.Now())
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		return nil, fmt.Errorf("build panel archive: %w", werr)
	}
	// Prove the archive can be read back with the passphrase before it is uploaded.
	vf, err := os.Open(out)
	if err != nil {
		return nil, err
	}
	_, verr := VerifyArchive(vf, pass)
	vf.Close()
	if verr != nil {
		return nil, fmt.Errorf("verify panel archive: %w", verr)
	}
	st, err := os.Stat(out)
	if err != nil {
		return nil, err
	}
	return &artifact{path: out, name: name, size: st.Size()}, nil
}

func engineExt(engine string) string {
	switch engine {
	case "mongodb":
		return "archive"
	case "redis":
		return "rdb"
	default:
		return "sql"
	}
}

func (s *Service) buildDB(ctx context.Context, id string, encrypt bool, tmp, ts string) (*artifact, error) {
	if s.d.Ops == nil {
		return nil, errors.New("database backups are unavailable (Docker is not connected)")
	}
	m, container, err := s.d.Ops.ResolveManaged(id)
	if err != nil {
		return nil, err
	}
	name := fmt.Sprintf("%s-%s.%s.gz", container, ts, engineExt(m.Engine))
	if encrypt {
		name += ".enc"
	}
	out := filepath.Join(tmp, name)
	f, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	var enc io.WriteCloser
	var w io.Writer = f
	if encrypt {
		key, kerr := db.BackupEncryptionKey()
		if kerr != nil {
			f.Close()
			return nil, kerr
		}
		if enc, err = EncryptWithKey(f, key); err != nil {
			f.Close()
			return nil, err
		}
		w = enc
	}
	gz := gzip.NewWriter(w)
	derr := s.d.Ops.Dump(ctx, m, container, gz)
	if cerr := gz.Close(); derr == nil {
		derr = cerr
	}
	if enc != nil {
		if cerr := enc.Close(); derr == nil {
			derr = cerr
		}
	}
	if cerr := f.Close(); derr == nil {
		derr = cerr
	}
	if derr != nil {
		return nil, fmt.Errorf("dump %s: %w", container, derr)
	}
	if err := sanityCheck(out, m.Engine, encrypt); err != nil {
		return nil, fmt.Errorf("backup of %s failed verification: %w", container, err)
	}
	st, err := os.Stat(out)
	if err != nil {
		return nil, err
	}
	return &artifact{path: out, name: name, size: st.Size()}, nil
}

// sanityCheck re-reads the finished file end to end (which also validates the gzip
// checksum and every encrypted chunk) and checks the dump is not empty and starts
// like a dump of that engine. A failed pg_dump/mysqldump writes its error to
// stderr, which the exec stream drops, so "empty output" is how failures show up.
func sanityCheck(path, engine string, encrypted bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var r io.Reader = f
	if encrypted {
		key, err := db.BackupEncryptionKey()
		if err != nil {
			return err
		}
		if r, err = NewDecryptReader(f, key, ""); err != nil {
			return err
		}
	}
	zr, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("compressed output is damaged: %w", err)
	}
	head := make([]byte, 512)
	n, err := io.ReadFull(zr, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return err
	}
	head = head[:n]
	if n == 0 {
		return errors.New("the dump is empty (the database tool produced no output)")
	}
	if _, err := io.Copy(io.Discard, zr); err != nil {
		return fmt.Errorf("compressed output is damaged: %w", err)
	}
	lower := bytes.ToLower(head)
	switch engine {
	case "postgres":
		if !bytes.Contains(lower, []byte("postgresql database dump")) {
			return errors.New("output does not look like a PostgreSQL dump")
		}
	case "mysql":
		if !bytes.Contains(lower, []byte("dump")) {
			return errors.New("output does not look like a MySQL/MariaDB dump")
		}
	case "mongodb":
		if n < 4 || !bytes.Equal(head[:4], []byte{0x6d, 0xe2, 0x99, 0x81}) {
			return errors.New("output does not look like a MongoDB archive")
		}
	case "redis":
		if !bytes.HasPrefix(head, []byte("REDIS")) {
			return errors.New("output does not look like a Redis RDB file")
		}
	}
	return nil
}

// applyRetention keeps the newest N successful uploads of a schedule on a
// destination and removes the older ones (objects and, in history, their marks).
func (s *Service) applyRetention(ctx context.Context, sch *db.BackupSchedule, destID string, current *db.BackupHistory) {
	rows, err := s.d.DB.ListBackupHistory(2000, sch.ID)
	if err != nil {
		return
	}
	keep := sch.Retention
	if keep < 1 {
		keep = DefaultRetention
	}
	d, err := s.d.DB.GetBackupDestination(destID)
	if err != nil || d == nil {
		return
	}
	st, err := s.StoreFor(*d)
	if err != nil {
		return
	}
	seen := 0
	for i := range rows {
		h := rows[i]
		if h.ID == current.ID {
			h = *current // not saved yet
		}
		idx := -1
		for j, f := range h.Files {
			if f.DestinationID == destID && f.OK {
				idx = j
			}
		}
		if idx < 0 {
			continue
		}
		seen++
		if seen <= keep {
			continue
		}
		name := h.Files[idx].Name
		if err := st.Delete(ctx, name); err != nil {
			log.Warn().Str("destination", d.Name).Err(err).Msg("backups: retention delete failed")
			continue
		}
		h.Files[idx].OK = false
		h.Files[idx].Error = "removed by retention"
		if h.ID == current.ID {
			current.Files = h.Files
			continue
		}
		_ = s.d.DB.UpdateBackupHistory(&h)
	}
}

// ── Destinations ──────────────────────────────────────────────────────────────

// DefaultLocalDir is where the built-in local destination keeps files.
func (s *Service) DefaultLocalDir() string { return filepath.Join(s.d.DataDir, "backups", "scheduled") }

// LocalDirAllowed reports whether dir may be used by a local destination: an
// absolute path inside the data directory or one of the operator-allowed extra
// directories (PULSENODE_BACKUPS_EXTRA_DIRS, mounted into the container).
func (s *Service) LocalDirAllowed(dir string) error {
	if dir == "" || !filepath.IsAbs(dir) {
		return errors.New("directory must be an absolute path")
	}
	c := filepath.Clean(dir)
	roots := append([]string{s.d.DataDir}, s.d.ExtraDirs...)
	if extra := os.Getenv("PULSENODE_BACKUPS_EXTRA_DIRS"); extra != "" {
		roots = append(roots, strings.Split(extra, string(os.PathListSeparator))...)
	}
	for _, r := range roots {
		if r == "" {
			continue
		}
		rel, err := filepath.Rel(filepath.Clean(r), c)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil
		}
	}
	return fmt.Errorf("directory must be inside %s (mount another volume and list it in PULSENODE_BACKUPS_EXTRA_DIRS to use other locations)", s.d.DataDir)
}

// Config describes a destination before it is saved (used by the draft test).
type Config struct {
	Type string
	Dir  string
	S3   S3Config
}

// NewStore builds a Store from a config.
func (s *Service) NewStore(c Config) (Store, error) {
	switch c.Type {
	case "local":
		dir := c.Dir
		if dir == "" {
			dir = s.DefaultLocalDir()
		}
		if err := s.LocalDirAllowed(dir); err != nil {
			return nil, err
		}
		return &LocalStore{Dir: filepath.Clean(dir)}, nil
	case "s3":
		return NewS3(c.S3)
	}
	return nil, fmt.Errorf("unknown destination type %q", c.Type)
}

// ConfigFor turns a stored destination (plus its decrypted credentials) into a Config.
func ConfigFor(d db.BackupDestination, sec db.BackupSecrets) Config {
	c := Config{Type: d.Type, Dir: d.Config["dir"]}
	if d.Type == "s3" {
		c.S3 = S3Config{
			Endpoint: d.Config["endpoint"], Region: d.Config["region"], Bucket: d.Config["bucket"],
			Prefix: d.Config["prefix"], UseSSL: d.Config["useSSL"] != "false", PathStyle: d.Config["pathStyle"] == "true",
			AccessKey: sec.AccessKey, SecretKey: sec.SecretKey,
		}
	}
	return c
}

// StoreFor builds the Store of a saved destination (decrypting its credentials).
func (s *Service) StoreFor(d db.BackupDestination) (Store, error) {
	var sec db.BackupSecrets
	if d.Type == "s3" {
		var err error
		if sec, err = s.d.DB.BackupDestinationSecrets(d.ID); err != nil {
			return nil, err
		}
	}
	return s.NewStore(ConfigFor(d, sec))
}

// ── Restore, download, delete ────────────────────────────────────────────────

// firstFile returns the first successfully stored file of a history row.
func firstFile(h *db.BackupHistory) (db.BackupFileResult, bool) {
	for _, f := range h.Files {
		if f.OK {
			return f, true
		}
	}
	return db.BackupFileResult{}, false
}

// OpenArtifact opens the stored backup file of a history row (for download).
func (s *Service) OpenArtifact(ctx context.Context, h *db.BackupHistory) (io.ReadCloser, string, error) {
	f, ok := firstFile(h)
	if !ok {
		return nil, "", errors.New("no stored copy of this backup exists any more")
	}
	d, err := s.d.DB.GetBackupDestination(f.DestinationID)
	if err != nil || d == nil {
		return nil, "", errors.New("the destination holding this backup no longer exists")
	}
	st, err := s.StoreFor(*d)
	if err != nil {
		return nil, "", err
	}
	rc, err := st.Open(ctx, f.Name)
	if err != nil {
		return nil, "", err
	}
	return rc, filepath.Base(f.Name), nil
}

// RestoreFromHistory restores a managed-database backup into its database. It
// refuses to run while another backup or restore is running.
func (s *Service) RestoreFromHistory(ctx context.Context, historyID string) (string, error) {
	h, err := s.d.DB.GetBackupHistory(historyID)
	if err != nil {
		return "", err
	}
	if h == nil {
		return "", ErrNotFound
	}
	id, ok := strings.CutPrefix(h.Target, "db:")
	if !ok {
		return "", errors.New("panel backups are restored offline: run `pulsenode restore-panel` (see docs/backups.md)")
	}
	if h.Status != "success" {
		return "", errors.New("only successful backups can be restored")
	}
	if s.d.Ops == nil {
		return "", errors.New("Docker is not connected")
	}
	m, container, err := s.d.Ops.ResolveManaged(id)
	if err != nil {
		return "", fmt.Errorf("the database this backup belongs to no longer exists: %w", err)
	}
	if !s.acquire("restore " + historyID) {
		return "", ErrBusy
	}
	defer s.release()

	rc, _, err := s.OpenArtifact(ctx, h)
	if err != nil {
		return "", err
	}
	defer rc.Close()
	var r io.Reader = rc
	if h.Encrypted {
		key, err := db.BackupEncryptionKey()
		if err != nil {
			return "", err
		}
		if r, err = NewDecryptReader(rc, key, ""); err != nil {
			return "", fmt.Errorf("%w (this backup needs the panel keys it was made with)", err)
		}
	}
	zr, err := gzip.NewReader(r)
	if err != nil {
		return "", fmt.Errorf("backup file is damaged: %w", err)
	}
	tmpRoot := filepath.Join(s.d.DataDir, "backups", "tmp")
	if err := os.MkdirAll(tmpRoot, 0o700); err != nil {
		return "", err
	}
	tmp, err := os.MkdirTemp(tmpRoot, "restore-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	dump := filepath.Join(tmp, "dump")
	f, err := os.OpenFile(dump, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	_, cerr := io.Copy(f, zr)
	if e := f.Close(); cerr == nil {
		cerr = e
	}
	if cerr != nil {
		return "", fmt.Errorf("could not read the stored backup: %w", cerr)
	}
	rctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	return s.d.Ops.Restore(rctx, m, container, dump)
}

// DeleteHistory removes a run and, best effort, the files it stored.
func (s *Service) DeleteHistory(ctx context.Context, id string) error {
	h, err := s.d.DB.GetBackupHistory(id)
	if err != nil {
		return err
	}
	if h == nil {
		return ErrNotFound
	}
	if h.Status == "running" {
		return ErrBusy
	}
	for _, f := range h.Files {
		if !f.OK {
			continue
		}
		d, err := s.d.DB.GetBackupDestination(f.DestinationID)
		if err != nil || d == nil {
			continue
		}
		if st, err := s.StoreFor(*d); err == nil {
			if err := st.Delete(ctx, f.Name); err != nil {
				log.Warn().Str("destination", d.Name).Err(err).Msg("backups: could not delete stored file")
			}
		}
	}
	return s.d.DB.DeleteBackupHistory(id)
}

// ── History hygiene ──────────────────────────────────────────────────────────

const (
	historyKeepRows = 200
	historyKeepAge  = 180 * 24 * time.Hour
)

// hygiene trims history, at most every few hours. Rows that still point at a
// stored file are never dropped (retention owns those); only failed or fully
// pruned rows beyond 200 rows / 180 days go.
func (s *Service) hygiene(now time.Time) {
	s.mu.Lock()
	if now.Sub(s.lastHyg) < 6*time.Hour {
		s.mu.Unlock()
		return
	}
	s.lastHyg = now
	s.mu.Unlock()
	rows, err := s.d.DB.ListBackupHistory(5000, "")
	if err != nil {
		return
	}
	for i, h := range rows { // newest first
		if h.Status == "running" {
			continue
		}
		if _, hasFile := firstFile(&h); hasFile {
			continue
		}
		if i >= historyKeepRows || now.Sub(h.StartedAt) > historyKeepAge {
			_ = s.d.DB.DeleteBackupHistory(h.ID)
		}
	}
}

// ── Alerts ───────────────────────────────────────────────────────────────────

func ruleID(sch *db.BackupSchedule) string { return "backup:" + sch.ID }

func (s *Service) muted() bool {
	v, err := s.d.DB.GetSetting(alerts.SettingMutedUntil)
	if err != nil || v == "" {
		return false
	}
	until, err := strconv.ParseInt(v, 10, 64)
	return err == nil && until > s.d.Now().Unix()
}

func (s *Service) broadcastCount() {
	if n, err := s.d.DB.CountFiringAlerts(); err == nil {
		s.broadcast("alert:count", n)
	}
}

// raiseFailure opens a critical "backup.failed" alert (once per schedule until a
// run succeeds) and sends it through the configured notification channels.
func (s *Service) raiseFailure(ctx context.Context, sch *db.BackupSchedule, msg string) {
	rid := ruleID(sch)
	if latest, err := s.d.DB.LatestAlertEvent(rid, ""); err == nil && latest != nil && latest.State != "resolved" {
		return // already firing; one alert per outage
	}
	ev := db.AlertEventFull{
		RuleID: rid, RuleName: "Backup failed: " + sch.Name, Metric: "backup.failed", Value: 1,
		Severity: "critical", State: "firing", Message: msg,
	}
	id, err := s.d.DB.InsertAlertEventFull(&ev)
	if err != nil {
		log.Warn().Err(err).Msg("backups: could not record alert")
		return
	}
	if stored, err := s.d.DB.GetAlertEventFull(id); err == nil && stored != nil {
		ev = *stored
	}
	s.broadcast("alert:new", alerts.ToView(ev))
	s.broadcastCount()
	s.notify(ctx, alerts.MessageFor(ev, "firing"))
}

// resolveFailure closes the open alert of a schedule after a successful run.
func (s *Service) resolveFailure(ctx context.Context, sch *db.BackupSchedule) {
	latest, err := s.d.DB.LatestAlertEvent(ruleID(sch), "")
	if err != nil || latest == nil || latest.State == "resolved" {
		return
	}
	ev, err := s.d.DB.SetAlertEventState(latest.ID, "resolved")
	if err != nil || ev == nil {
		return
	}
	s.broadcast("alert:update", alerts.ToView(*ev))
	s.broadcastCount()
	s.notify(ctx, alerts.MessageFor(*ev, "resolved"))
}

// notifySuccess sends an informational message (not stored as an open alert).
func (s *Service) notifySuccess(ctx context.Context, sch *db.BackupSchedule, h *db.BackupHistory) {
	ev := db.AlertEventFull{
		RuleName: "Backup succeeded: " + sch.Name, Metric: "backup.succeeded", Severity: "info", State: "resolved",
		Message: fmt.Sprintf("%s backed up (%s).", h.TargetName, humanBytes(h.SizeBytes)), FiredAt: s.d.Now(),
	}
	s.notify(ctx, alerts.MessageFor(ev, "firing"))
}

// OnScheduleDeleted resolves the schedule's open failure alert so it does not
// linger in the alert badge forever.
func (s *Service) OnScheduleDeleted(sch *db.BackupSchedule) {
	s.resolveFailure(context.Background(), sch)
}

func (s *Service) notify(ctx context.Context, msg alerts.Message) {
	if s.muted() {
		return
	}
	all, err := s.d.DB.ListNotificationChannels()
	if err != nil {
		return
	}
	for _, c := range all {
		if !c.Enabled {
			continue
		}
		ch, err := alerts.DecodeChannel(c)
		if err != nil {
			continue
		}
		s.wg.Add(1)
		go func(ch alerts.Channel) {
			defer s.wg.Done()
			c, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer cancel()
			if err := s.d.Sender.Send(c, ch, msg); err != nil {
				log.Warn().Str("channel", ch.Name).Err(err).Msg("backups: notification failed")
			}
		}(ch)
	}
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
