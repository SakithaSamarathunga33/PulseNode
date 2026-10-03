package api

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	dbpkg "pulsenode/backend/internal/db"
)

// ── Job types ─────────────────────────────────────────────────────────────────

type backupJob struct {
	ID      string
	Phase   string // starting | dumping | done | error
	Bytes   int64
	Err     string
	File    string
	Name    string
	Created time.Time
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func backupsDir() string {
	d := os.Getenv("PULSENODE_DATA_DIR")
	if d == "" {
		d = "/var/lib/pulsenode"
	}
	return filepath.Join(d, "backups")
}

// progressWriter wraps an *os.File, counting bytes and emitting SSE events
// every ~300 ms so the frontend can show live progress.
type progressWriter struct {
	f    *os.File
	job  *backupJob
	mu   *sync.Mutex
	hub  interface{ Broadcast(string, any) }
	last time.Time
}

func (pw *progressWriter) Write(p []byte) (int, error) {
	n, err := pw.f.Write(p)
	pw.mu.Lock()
	pw.job.Bytes += int64(n)
	bytes := pw.job.Bytes
	pw.mu.Unlock()
	if time.Since(pw.last) > 300*time.Millisecond {
		pw.last = time.Now()
		pw.hub.Broadcast("db:backup", map[string]any{
			"jobId": pw.job.ID,
			"phase": "dumping",
			"bytes": bytes,
		})
	}
	return n, err
}

// ── Start backup (async) ──────────────────────────────────────────────────────

func (s *Server) startBackup(w http.ResponseWriter, r *http.Request) {
	if !s.requireDocker(w) {
		return
	}
	containerName := chi.URLParam(r, "name")
	var body struct {
		Database string `json:"database"`
		Table    string `json:"table"` // table for pg/mysql, collection for mongo
	}
	_ = decodeJSON(r, &body)
	if (body.Database != "" && !dbIdentRe.MatchString(body.Database)) || (body.Table != "" && !dbIdentRe.MatchString(body.Table)) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid database or table name"})
		return
	}

	mdb, err := s.resolveAnyDB(r.Context(), containerName)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}

	ext := "sql"
	switch mdb.Engine {
	case "mongodb":
		ext = "archive"
	case "redis":
		ext = "rdb"
	}

	ts := time.Now().UTC().Format("20060102_150405")
	label := containerName
	if body.Table != "" {
		label = containerName + "_" + body.Table
	} else if body.Database != "" && body.Database != mdb.DBName {
		label = containerName + "_" + body.Database
	}
	filename := label + "_" + ts + "." + ext

	if err := os.MkdirAll(backupsDir(), 0o700); err != nil {
		writeError(w, err)
		return
	}

	jobID := dbpkg.NewID("bkp")
	job := &backupJob{
		ID:      jobID,
		Phase:   "starting",
		Name:    filename,
		File:    filepath.Join(backupsDir(), jobID+"."+ext),
		Created: time.Now(),
	}

	s.backupMu.Lock()
	s.backups[jobID] = job
	s.backupMu.Unlock()

	s.hub.Broadcast("db:backup", map[string]any{
		"jobId": jobID,
		"phase": "starting",
		"bytes": int64(0),
		"name":  filename,
	})

	go s.runBackup(job, containerName, mdb, body.Database, body.Table)

	writeJSON(w, http.StatusAccepted, map[string]any{
		"jobId": jobID,
		"name":  filename,
	})
}

func (s *Server) runBackup(job *backupJob, containerName string, mdb *dbpkg.ManagedDatabase, database, table string) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Hour)
	defer cancel()

	f, err := os.OpenFile(job.File, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600) // plaintext DB dump
	if err != nil {
		s.finishBackup(job, err)
		return
	}
	defer f.Close()

	s.backupMu.Lock()
	job.Phase = "dumping"
	s.backupMu.Unlock()
	s.hub.Broadcast("db:backup", map[string]any{"jobId": job.ID, "phase": "dumping", "bytes": int64(0)})

	pw := &progressWriter{f: f, job: job, mu: &s.backupMu, hub: s.hub, last: time.Now()}

	execErr := s.dumpEngine(ctx, containerName, mdb, database, table, pw)

	s.finishBackup(job, execErr)
}

func (s *Server) finishBackup(job *backupJob, err error) {
	s.backupMu.Lock()
	if err != nil {
		job.Phase = "error"
		job.Err = err.Error()
	} else {
		job.Phase = "done"
	}
	bytes := job.Bytes
	s.backupMu.Unlock()

	event := map[string]any{"jobId": job.ID, "phase": job.Phase, "bytes": bytes, "name": job.Name}
	if err != nil {
		event["error"] = err.Error()
	}
	s.hub.Broadcast("db:backup", event)
}

// ── Job status ────────────────────────────────────────────────────────────────

func (s *Server) backupStatus(w http.ResponseWriter, r *http.Request) {
	jobID := chi.URLParam(r, "jobId")
	s.backupMu.Lock()
	job, ok := s.backups[jobID]
	var phase, name, errStr string
	var bytes int64
	if ok {
		phase, name, errStr, bytes = job.Phase, job.Name, job.Err, job.Bytes
	}
	s.backupMu.Unlock()
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "backup not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"jobId": jobID, "phase": phase, "name": name, "error": errStr, "bytes": bytes,
	})
}

// ── Download completed backup ─────────────────────────────────────────────────

func (s *Server) downloadBackup(w http.ResponseWriter, r *http.Request) {
	jobID := chi.URLParam(r, "jobId")
	s.backupMu.Lock()
	job, ok := s.backups[jobID]
	s.backupMu.Unlock()
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "backup not found"})
		return
	}
	if job.Phase == "error" {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": job.Err})
		return
	}
	if job.Phase != "done" {
		writeJSON(w, http.StatusAccepted, map[string]string{"phase": job.Phase})
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="`+job.Name+`"`)
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeFile(w, r, job.File)
}

// ── Restore from uploaded file ────────────────────────────────────────────────

func (s *Server) restoreDatabase(w http.ResponseWriter, r *http.Request) {
	if !s.requireDocker(w) {
		return
	}
	containerName := chi.URLParam(r, "name")
	mdb, err := s.resolveAnyDB(r.Context(), containerName)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}

	// Cap the upload, and keep at most 32 MB in memory (the rest spills to temp
	// files) — go-api runs with a 128 MB memory limit.
	r.Body = http.MaxBytesReader(w, r.Body, maxRestoreUpload)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid form or file larger than 2 GB"})
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file is required"})
		return
	}
	defer file.Close()

	database := r.FormValue("database")
	if database == "" {
		database = mdb.DBName
	}
	if database != "" && !dbIdentRe.MatchString(database) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid database name"})
		return
	}
	table := r.FormValue("table")

	// Save upload to disk (avoids memory pressure for large files)
	if err := os.MkdirAll(backupsDir(), 0o700); err != nil {
		writeError(w, err)
		return
	}
	// Name files only by a server-generated ID: the uploaded filename is
	// attacker-chosen and used to end up in a shell command.
	tmpID := dbpkg.NewID("rst")
	tmpPath := filepath.Join(backupsDir(), tmpID)
	tmpFile, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		writeError(w, err)
		return
	}
	if _, err := io.Copy(tmpFile, file); err != nil {
		tmpFile.Close()
		os.Remove(tmpPath)
		writeError(w, err)
		return
	}
	tmpFile.Close()
	defer os.Remove(tmpPath)

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()

	_ = table // psql restores the whole file; table-level is implicit in the dump
	output, status, rerr := s.restoreEngine(ctx, containerName, mdb, database, tmpPath)
	switch {
	case status == http.StatusUnprocessableEntity:
		writeJSON(w, status, map[string]any{"error": rerr.Error(), "output": output})
	case rerr != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": rerr.Error()})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": output})
	}
}

// maxRestoreUpload caps restore uploads.
const maxRestoreUpload = 2 << 30

// dbIdentRe matches database names safe to pass as a client argument (no
// leading "-" option, no "key=value" conninfo or URI).
var dbIdentRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,63}$`)

// ── Background cleanup of old backup files ────────────────────────────────────

func (s *Server) startBackupCleaner() {
	go func() {
		for range time.Tick(15 * time.Minute) {
			s.cleanOldBackups()
		}
	}()
}

func (s *Server) cleanOldBackups() {
	cutoff := time.Now().Add(-2 * time.Hour)
	s.backupMu.Lock()
	defer s.backupMu.Unlock()
	for id, job := range s.backups {
		if job.Created.Before(cutoff) {
			os.Remove(job.File)
			delete(s.backups, id)
		}
	}
}
