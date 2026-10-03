package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"pulsenode/backend/internal/backups"
	dbpkg "pulsenode/backend/internal/db"
)

// Scheduled backups API (see internal/backups). Lists are bare JSON arrays and are
// never null; destination credentials are write-only.

// RunBackups runs the backup scheduler until ctx is cancelled.
func (s *Server) RunBackups(ctx context.Context) { s.backupSvc.Start(ctx) }

func (s *Server) backupAudit(r *http.Request, action, resource string, status int) {
	s.db.InsertAuditLog(s.requestActor(r), action, resource, clientIP(r), status)
}

// ── Destinations ──────────────────────────────────────────────────────────────

type destView struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Type          string `json:"type"`
	Enabled       bool   `json:"enabled"`
	Dir           string `json:"dir,omitempty"`
	Endpoint      string `json:"endpoint,omitempty"`
	Region        string `json:"region,omitempty"`
	Bucket        string `json:"bucket,omitempty"`
	Prefix        string `json:"prefix,omitempty"`
	UseSSL        *bool  `json:"useSSL,omitempty"`
	PathStyle     *bool  `json:"pathStyle,omitempty"`
	AccessKeyHint string `json:"accessKeyHint,omitempty"`
	SecretSet     bool   `json:"secretSet"`
}

func (s *Server) toDestView(d dbpkg.BackupDestination) destView {
	v := destView{ID: d.ID, Name: d.Name, Type: d.Type, Enabled: d.Enabled, SecretSet: d.SecretSet}
	switch d.Type {
	case "local":
		v.Dir = d.Config["dir"]
		if v.Dir == "" {
			v.Dir = s.backupSvc.DefaultLocalDir()
		}
	case "s3":
		ssl, ps := d.Config["useSSL"] != "false", d.Config["pathStyle"] == "true"
		v.Endpoint, v.Region, v.Bucket, v.Prefix = d.Config["endpoint"], d.Config["region"], d.Config["bucket"], d.Config["prefix"]
		v.UseSSL, v.PathStyle = &ssl, &ps
		v.AccessKeyHint = d.Config["accessKeyHint"]
	}
	return v
}

type destBody struct {
	ID        string  `json:"id"`
	Name      *string `json:"name"`
	Type      *string `json:"type"`
	Enabled   *bool   `json:"enabled"`
	Dir       *string `json:"dir"`
	Endpoint  *string `json:"endpoint"`
	Region    *string `json:"region"`
	Bucket    *string `json:"bucket"`
	Prefix    *string `json:"prefix"`
	UseSSL    *bool   `json:"useSSL"`
	PathStyle *bool   `json:"pathStyle"`
	AccessKey *string `json:"accessKey"`
	SecretKey *string `json:"secretKey"`
}

var bucketRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$`)

func str(p *string, fallback string) string {
	if p == nil {
		return fallback
	}
	return strings.TrimSpace(*p)
}

func boolOr(p *bool, fallback bool) bool {
	if p == nil {
		return fallback
	}
	return *p
}

func last4(s string) string {
	if len(s) <= 4 {
		return s
	}
	return "…" + s[len(s)-4:]
}

// applyDestination merges a request onto an existing destination (nil = create)
// and validates it. secrets is non-nil only when credentials are being (re)written.
// Stored credentials are never reused for a different endpoint or bucket: changing
// either requires entering the keys again.
func (s *Server) applyDestination(existing *dbpkg.BackupDestination, b destBody, old dbpkg.BackupSecrets) (dbpkg.BackupDestination, *dbpkg.BackupSecrets, error) {
	var d dbpkg.BackupDestination
	if existing != nil {
		d = *existing
		d.Config = map[string]string{}
		for k, v := range existing.Config {
			d.Config[k] = v
		}
	} else {
		d = dbpkg.BackupDestination{ID: dbpkg.NewID("bkd"), Enabled: true, Config: map[string]string{}}
	}
	d.Name = str(b.Name, d.Name)
	if d.Name == "" || utf8.RuneCountInString(d.Name) > 80 {
		return d, nil, errors.New("name is required (max 80 characters)")
	}
	typ := str(b.Type, d.Type)
	if existing != nil && typ != existing.Type {
		return d, nil, errors.New("the type of a destination cannot be changed; create a new one")
	}
	if typ != "local" && typ != "s3" {
		return d, nil, errors.New(`type must be "local" or "s3"`)
	}
	d.Type = typ
	d.Enabled = boolOr(b.Enabled, d.Enabled)

	if typ == "local" {
		dir := str(b.Dir, d.Config["dir"])
		eff := dir
		if eff == "" {
			eff = s.backupSvc.DefaultLocalDir()
		}
		if err := s.backupSvc.LocalDirAllowed(eff); err != nil {
			return d, nil, err
		}
		d.Config = map[string]string{"dir": dir}
		return d, nil, nil
	}

	// s3
	endpointRaw := str(b.Endpoint, d.Config["endpoint"])
	endpoint, schemeSSL, err := backups.NormalizeEndpoint(endpointRaw)
	if err != nil {
		return d, nil, err
	}
	useSSL := d.Config["useSSL"] != "false"
	if existing == nil {
		useSSL = true
	}
	if schemeSSL != nil && b.UseSSL == nil {
		useSSL = *schemeSSL
	}
	useSSL = boolOr(b.UseSSL, useSSL)
	bucket := str(b.Bucket, d.Config["bucket"])
	if !bucketRe.MatchString(bucket) {
		return d, nil, errors.New("bucket must be 3–63 characters (letters, digits, dots, dashes)")
	}
	prefix := strings.Trim(str(b.Prefix, d.Config["prefix"]), "/")
	region := str(b.Region, d.Config["region"])
	pathStyle := boolOr(b.PathStyle, d.Config["pathStyle"] == "true")

	access, secret := str(b.AccessKey, ""), ""
	if b.SecretKey != nil {
		secret = *b.SecretKey
	}
	destinationChanged := existing != nil && (endpoint != existing.Config["endpoint"] || bucket != existing.Config["bucket"])
	if destinationChanged && (secret == "" || access == "") {
		return d, nil, errors.New("access key and secret key must be entered again because the endpoint or bucket changed (stored credentials are never reused for a different destination)")
	}
	var secrets *dbpkg.BackupSecrets
	switch {
	case existing == nil || access != "" || secret != "":
		ns := dbpkg.BackupSecrets{AccessKey: access, SecretKey: secret}
		if existing != nil && !destinationChanged {
			if ns.AccessKey == "" {
				ns.AccessKey = old.AccessKey
			}
			if ns.SecretKey == "" {
				ns.SecretKey = old.SecretKey
			}
		}
		if ns.AccessKey == "" || ns.SecretKey == "" {
			return d, nil, errors.New("access key and secret key are required")
		}
		secrets = &ns
	default:
		secrets = nil
	}
	effective := old
	if secrets != nil {
		effective = *secrets
	}
	d.Config = map[string]string{
		"endpoint": endpoint, "region": region, "bucket": bucket, "prefix": prefix,
		"useSSL": strconv.FormatBool(useSSL), "pathStyle": strconv.FormatBool(pathStyle),
		"accessKeyHint": last4(effective.AccessKey),
	}
	// Validate everything that does not need the network (blocked endpoints, prefix, …).
	if _, err := backups.NewS3(backups.ConfigFor(d, effective).S3); err != nil {
		return d, nil, err
	}
	return d, secrets, nil
}

func (s *Server) listBackupDestinations(w http.ResponseWriter, r *http.Request) {
	list, err := s.db.ListBackupDestinations()
	if err != nil {
		writeError(w, err)
		return
	}
	out := make([]destView, 0, len(list))
	for _, d := range list {
		out = append(out, s.toDestView(d))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) createBackupDestination(w http.ResponseWriter, r *http.Request) {
	var b destBody
	if err := decodeJSON(r, &b); err != nil {
		badRequest(w, "invalid body")
		return
	}
	d, secrets, err := s.applyDestination(nil, b, dbpkg.BackupSecrets{})
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	if err := s.db.SaveBackupDestination(&d, secrets); err != nil {
		writeError(w, err)
		return
	}
	saved, _ := s.db.GetBackupDestination(d.ID)
	s.backupAudit(r, "backup.destination.create", d.Name, http.StatusCreated)
	writeJSON(w, http.StatusCreated, s.toDestView(*saved))
}

func (s *Server) updateBackupDestination(w http.ResponseWriter, r *http.Request) {
	existing, err := s.db.GetBackupDestination(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, err)
		return
	}
	if existing == nil {
		notFound(w, "destination")
		return
	}
	var b destBody
	if err := decodeJSON(r, &b); err != nil {
		badRequest(w, "invalid body")
		return
	}
	old, err := s.db.BackupDestinationSecrets(existing.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	d, secrets, err := s.applyDestination(existing, b, old)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	if err := s.db.SaveBackupDestination(&d, secrets); err != nil {
		writeError(w, err)
		return
	}
	saved, _ := s.db.GetBackupDestination(d.ID)
	s.backupAudit(r, "backup.destination.update", d.Name, http.StatusOK)
	writeJSON(w, http.StatusOK, s.toDestView(*saved))
}

func (s *Server) deleteBackupDestination(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	d, err := s.db.GetBackupDestination(id)
	if err != nil {
		writeError(w, err)
		return
	}
	if d == nil {
		notFound(w, "destination")
		return
	}
	scheds, err := s.db.ListBackupSchedules()
	if err != nil {
		writeError(w, err)
		return
	}
	var users []string
	for _, sc := range scheds {
		for _, did := range sc.DestinationIDs {
			if did == id {
				users = append(users, sc.Name)
			}
		}
	}
	if len(users) > 0 {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "destination is used by schedule(s): " + strings.Join(users, ", ") + " — remove it from them first"})
		return
	}
	if err := s.db.DeleteBackupDestination(id); err != nil {
		writeError(w, err)
		return
	}
	s.backupAudit(r, "backup.destination.delete", d.Name, http.StatusOK)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) respondDestTest(w http.ResponseWriter, ctx context.Context, cfg backups.Config) {
	st, err := s.backupSvc.NewStore(cfg)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	tctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	start := time.Now()
	if err := st.Test(tctx); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "latencyMs": time.Since(start).Milliseconds()})
}

func (s *Server) testSavedBackupDestination(w http.ResponseWriter, r *http.Request) {
	d, err := s.db.GetBackupDestination(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, err)
		return
	}
	if d == nil {
		notFound(w, "destination")
		return
	}
	var sec dbpkg.BackupSecrets
	if d.Type == "s3" {
		if sec, err = s.db.BackupDestinationSecrets(d.ID); err != nil {
			writeError(w, err)
			return
		}
	}
	s.respondDestTest(w, r.Context(), backups.ConfigFor(*d, sec))
}

// testDraftBackupDestination tests a destination before it is saved. For an
// existing one pass "id" so blank credentials reuse the stored ones — unless the
// endpoint or bucket changed, which requires entering them again.
func (s *Server) testDraftBackupDestination(w http.ResponseWriter, r *http.Request) {
	var b destBody
	if err := decodeJSON(r, &b); err != nil {
		badRequest(w, "invalid body")
		return
	}
	var existing *dbpkg.BackupDestination
	var old dbpkg.BackupSecrets
	if b.ID != "" {
		var err error
		if existing, err = s.db.GetBackupDestination(b.ID); err != nil {
			writeError(w, err)
			return
		}
		if existing == nil {
			notFound(w, "destination")
			return
		}
		if old, err = s.db.BackupDestinationSecrets(b.ID); err != nil {
			writeError(w, err)
			return
		}
	}
	d, secrets, err := s.applyDestination(existing, b, old)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	eff := old
	if secrets != nil {
		eff = *secrets
	}
	s.respondDestTest(w, r.Context(), backups.ConfigFor(d, eff))
}

// ── Schedules ─────────────────────────────────────────────────────────────────

type scheduleView struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Target          string     `json:"target"`
	TargetName      string     `json:"targetName"`
	Frequency       string     `json:"frequency"`
	Hour            int        `json:"hour"`
	Weekday         int        `json:"weekday"`
	Retention       int        `json:"retention"`
	DestinationIDs  []string   `json:"destinationIds"`
	Encrypt         bool       `json:"encrypt"`
	NotifyOnSuccess bool       `json:"notifyOnSuccess"`
	Enabled         bool       `json:"enabled"`
	LastRunAt       *time.Time `json:"lastRunAt"`
	LastStatus      string     `json:"lastStatus"`
	NextRunAt       *time.Time `json:"nextRunAt"`
}

func (s *Server) targetName(target string) string {
	if target == "panel" {
		return "PulseNode panel"
	}
	if id, ok := strings.CutPrefix(target, "db:"); ok {
		if m, err := s.db.GetManagedDatabase(id); err == nil && m != nil {
			return m.Name
		}
		return id + " (deleted)"
	}
	return target
}

func (s *Server) toScheduleView(sc dbpkg.BackupSchedule) scheduleView {
	v := scheduleView{
		ID: sc.ID, Name: sc.Name, Target: sc.Target, TargetName: s.targetName(sc.Target), Frequency: sc.Frequency,
		Hour: sc.Hour, Weekday: sc.Weekday, Retention: sc.Retention, DestinationIDs: sc.DestinationIDs,
		Encrypt: sc.Encrypt || sc.Target == "panel", NotifyOnSuccess: sc.NotifyOnSuccess, Enabled: sc.Enabled,
		LastRunAt: sc.LastRunAt, LastStatus: sc.LastStatus,
	}
	if sc.Enabled {
		v.NextRunAt = sc.NextRunAt
	}
	if v.DestinationIDs == nil {
		v.DestinationIDs = []string{}
	}
	return v
}

type scheduleBody struct {
	Name            *string   `json:"name"`
	Target          *string   `json:"target"`
	Frequency       *string   `json:"frequency"`
	Hour            *int      `json:"hour"`
	Weekday         *int      `json:"weekday"`
	Retention       *int      `json:"retention"`
	DestinationIDs  *[]string `json:"destinationIds"`
	Encrypt         *bool     `json:"encrypt"`
	NotifyOnSuccess *bool     `json:"notifyOnSuccess"`
	Enabled         *bool     `json:"enabled"`
}

func intOr(p *int, fallback int) int {
	if p == nil {
		return fallback
	}
	return *p
}

// applySchedule merges a request onto a schedule (nil = create) and validates it.
func (s *Server) applySchedule(existing *dbpkg.BackupSchedule, b scheduleBody) (dbpkg.BackupSchedule, error) {
	var sc dbpkg.BackupSchedule
	if existing != nil {
		sc = *existing
	} else {
		sc = dbpkg.BackupSchedule{ID: dbpkg.NewID("bks"), Frequency: backups.FreqDaily, Hour: 2, Retention: backups.DefaultRetention, Encrypt: true, Enabled: true}
	}
	sc.Name = str(b.Name, sc.Name)
	if sc.Name == "" || utf8.RuneCountInString(sc.Name) > 80 {
		return sc, errors.New("name is required (max 80 characters)")
	}
	if b.Target != nil {
		t := strings.TrimSpace(*b.Target)
		if existing != nil && t != existing.Target {
			return sc, errors.New("the target of a schedule cannot be changed; create a new schedule")
		}
		sc.Target = t
	}
	if sc.Target == "panel" {
		sc.Encrypt = true // panel archives are always encrypted with the passphrase
	} else if id, ok := strings.CutPrefix(sc.Target, "db:"); ok && id != "" {
		m, err := s.db.GetManagedDatabase(id)
		if err != nil {
			return sc, err
		}
		if m == nil {
			return sc, errors.New("that managed database does not exist")
		}
		if b.Encrypt != nil {
			sc.Encrypt = *b.Encrypt
		}
	} else {
		return sc, errors.New(`target must be "panel" or "db:<managed database id>"`)
	}
	sc.Frequency = str(b.Frequency, sc.Frequency)
	sc.Hour = intOr(b.Hour, sc.Hour)
	sc.Weekday = intOr(b.Weekday, sc.Weekday)
	sc.Retention = intOr(b.Retention, sc.Retention)
	if err := backups.ValidateSchedule(sc.Frequency, sc.Hour, sc.Weekday, sc.Retention); err != nil {
		return sc, err
	}
	if b.DestinationIDs != nil {
		seen := map[string]bool{}
		ids := []string{}
		for _, id := range *b.DestinationIDs {
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			d, err := s.db.GetBackupDestination(id)
			if err != nil {
				return sc, err
			}
			if d == nil {
				return sc, fmt.Errorf("destination %q does not exist", id)
			}
			ids = append(ids, id)
		}
		sc.DestinationIDs = ids
	}
	if len(sc.DestinationIDs) == 0 {
		return sc, errors.New("choose at least one destination")
	}
	if b.NotifyOnSuccess != nil {
		sc.NotifyOnSuccess = *b.NotifyOnSuccess
	}
	if b.Enabled != nil {
		sc.Enabled = *b.Enabled
	}
	// Any timing change (or re-enabling) recomputes the next run from now.
	next := backups.NextRun(sc.Frequency, sc.Hour, sc.Weekday, time.Now())
	sc.NextRunAt = &next
	return sc, nil
}

func (s *Server) listBackupSchedules(w http.ResponseWriter, r *http.Request) {
	list, err := s.db.ListBackupSchedules()
	if err != nil {
		writeError(w, err)
		return
	}
	out := make([]scheduleView, 0, len(list))
	for _, sc := range list {
		out = append(out, s.toScheduleView(sc))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) createBackupSchedule(w http.ResponseWriter, r *http.Request) {
	var b scheduleBody
	if err := decodeJSON(r, &b); err != nil {
		badRequest(w, "invalid body")
		return
	}
	sc, err := s.applySchedule(nil, b)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	if err := s.db.SaveBackupSchedule(&sc); err != nil {
		writeError(w, err)
		return
	}
	s.backupAudit(r, "backup.schedule.create", sc.Name, http.StatusCreated)
	writeJSON(w, http.StatusCreated, s.toScheduleView(sc))
}

func (s *Server) updateBackupSchedule(w http.ResponseWriter, r *http.Request) {
	existing, err := s.db.GetBackupSchedule(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, err)
		return
	}
	if existing == nil {
		notFound(w, "schedule")
		return
	}
	var b scheduleBody
	if err := decodeJSON(r, &b); err != nil {
		badRequest(w, "invalid body")
		return
	}
	sc, err := s.applySchedule(existing, b)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	if err := s.db.SaveBackupSchedule(&sc); err != nil {
		writeError(w, err)
		return
	}
	s.backupAudit(r, "backup.schedule.update", sc.Name, http.StatusOK)
	writeJSON(w, http.StatusOK, s.toScheduleView(sc))
}

func (s *Server) deleteBackupSchedule(w http.ResponseWriter, r *http.Request) {
	sc, err := s.db.GetBackupSchedule(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, err)
		return
	}
	if sc == nil {
		notFound(w, "schedule")
		return
	}
	if err := s.db.DeleteBackupSchedule(sc.ID); err != nil {
		writeError(w, err)
		return
	}
	s.backupSvc.OnScheduleDeleted(sc)
	s.backupAudit(r, "backup.schedule.delete", sc.Name, http.StatusOK)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) runBackupSchedule(w http.ResponseWriter, r *http.Request) {
	id, err := s.backupSvc.RunNow(chi.URLParam(r, "id"), s.requestActor(r))
	switch {
	case errors.Is(err, backups.ErrNotFound):
		notFound(w, "schedule")
	case errors.Is(err, backups.ErrBusy):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, backups.ErrNoPassphrase):
		badRequest(w, err.Error())
	case err != nil:
		writeError(w, err)
	default:
		writeJSON(w, http.StatusAccepted, map[string]string{"historyId": id, "status": "running"})
	}
}

// ── History ───────────────────────────────────────────────────────────────────

type historyView struct {
	ID           string                   `json:"id"`
	ScheduleID   string                   `json:"scheduleId"`
	ScheduleName string                   `json:"scheduleName"`
	Target       string                   `json:"target"`
	TargetName   string                   `json:"targetName"`
	StartedAt    time.Time                `json:"startedAt"`
	FinishedAt   *time.Time               `json:"finishedAt"`
	Status       string                   `json:"status"`
	SizeBytes    int64                    `json:"sizeBytes"`
	Encrypted    bool                     `json:"encrypted"`
	Error        string                   `json:"error"`
	Files        []dbpkg.BackupFileResult `json:"files"`
}

func toHistoryView(h dbpkg.BackupHistory) historyView {
	files := h.Files
	if files == nil {
		files = []dbpkg.BackupFileResult{}
	}
	return historyView{
		ID: h.ID, ScheduleID: h.ScheduleID, ScheduleName: h.ScheduleName, Target: h.Target, TargetName: h.TargetName,
		StartedAt: h.StartedAt, FinishedAt: h.FinishedAt, Status: h.Status, SizeBytes: h.SizeBytes,
		Encrypted: h.Encrypted, Error: h.Error, Files: files,
	}
}

func (s *Server) listBackupHistory(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := s.db.ListBackupHistory(limit, r.URL.Query().Get("scheduleId"))
	if err != nil {
		writeError(w, err)
		return
	}
	out := make([]historyView, 0, len(rows))
	for _, h := range rows {
		out = append(out, toHistoryView(h))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) downloadBackupHistory(w http.ResponseWriter, r *http.Request) {
	h, err := s.db.GetBackupHistory(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, err)
		return
	}
	if h == nil {
		notFound(w, "backup")
		return
	}
	rc, name, err := s.backupSvc.OpenArtifact(r.Context(), h)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	defer rc.Close()
	s.backupAudit(r, "backup.download", h.ScheduleName+" / "+name, http.StatusOK)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+url.PathEscape(name)+`"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.Copy(w, rc)
}

func (s *Server) deleteBackupHistory(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	err := s.backupSvc.DeleteHistory(r.Context(), id)
	switch {
	case errors.Is(err, backups.ErrNotFound):
		notFound(w, "backup")
	case errors.Is(err, backups.ErrBusy):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "this backup is still running"})
	case err != nil:
		writeError(w, err)
	default:
		s.backupAudit(r, "backup.delete", id, http.StatusOK)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func (s *Server) restoreBackupHistory(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Confirm string `json:"confirm"`
	}
	_ = decodeJSON(r, &body)
	if body.Confirm != "restore" {
		badRequest(w, `send {"confirm":"restore"} to restore — this overwrites the database's current data`)
		return
	}
	h, err := s.db.GetBackupHistory(id)
	if err != nil {
		writeError(w, err)
		return
	}
	if h == nil {
		notFound(w, "backup")
		return
	}
	if !strings.HasPrefix(h.Target, "db:") {
		badRequest(w, "panel backups are restored offline: run `pulsenode restore-panel` (see docs/backups.md)")
		return
	}
	if h.Status != "success" {
		badRequest(w, "only successful backups can be restored")
		return
	}
	// A restore must not be cut off half way if the browser disconnects.
	out, err := s.backupSvc.RestoreFromHistory(context.WithoutCancel(r.Context()), id)
	switch {
	case errors.Is(err, backups.ErrBusy):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case err != nil:
		s.backupAudit(r, "backup.restore", h.TargetName, http.StatusInternalServerError)
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": err.Error(), "output": out})
	default:
		s.backupAudit(r, "backup.restore", h.TargetName, http.StatusOK)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
	}
}

// ── Status and passphrase ─────────────────────────────────────────────────────

func (s *Server) backupsStatus(w http.ResponseWriter, r *http.Request) {
	dests, err := s.db.ListBackupDestinations()
	if err != nil {
		writeError(w, err)
		return
	}
	scheds, err := s.db.ListBackupSchedules()
	if err != nil {
		writeError(w, err)
		return
	}
	var last, next *time.Time
	for i := range scheds {
		sc := scheds[i]
		if sc.LastRunAt != nil && (last == nil || sc.LastRunAt.After(*last)) {
			last = sc.LastRunAt
		}
		if sc.Enabled && sc.NextRunAt != nil && (next == nil || sc.NextRunAt.Before(*next)) {
			next = sc.NextRunAt
		}
	}
	failed, _ := s.db.CountFailedBackupsSince(time.Now().Add(-24 * time.Hour))
	pass, _ := s.db.GetSetting(dbpkg.BackupSettingPassphrase)
	writeJSON(w, http.StatusOK, map[string]any{
		"schedulerRunning": s.backupSvc.SchedulerRunning(),
		"lastRunAt":        last,
		"nextRunAt":        next,
		"failedLast24h":    failed,
		"destinations":     len(dests),
		"schedules":        len(scheds),
		"passphraseSet":    pass != "",
	})
}

func (s *Server) getBackupPassphrase(w http.ResponseWriter, r *http.Request) {
	v, err := s.db.GetSetting(dbpkg.BackupSettingPassphrase)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"set": v != ""})
}

func (s *Server) setBackupPassphrase(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Passphrase string `json:"passphrase"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "invalid body")
		return
	}
	p := body.Passphrase
	if utf8.RuneCountInString(p) < 12 || utf8.RuneCountInString(p) > 256 {
		badRequest(w, "passphrase must be 12–256 characters")
		return
	}
	if strings.ContainsAny(p, "\r\n") {
		badRequest(w, "passphrase must be a single line")
		return
	}
	had, _ := s.db.GetSetting(dbpkg.BackupSettingPassphrase)
	if err := s.db.SetBackupPassphrase(p); err != nil {
		writeError(w, err)
		return
	}
	s.backupAudit(r, "backup.passphrase", "set", http.StatusOK)
	resp := map[string]any{"set": true}
	if had != "" {
		resp["warning"] = "Panel backups made before this change still need the OLD passphrase to be restored."
	}
	writeJSON(w, http.StatusOK, resp)
}
