package db

import (
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
)

// Scheduled backups: destinations (where files go), schedules (what/when) and a
// history of runs. Destination credentials are stored encrypted; the list APIs
// only ever see a hint (last 4 characters of the access key) and a "secret set"
// flag.

var backupSchemaOnce sync.Map // *DB -> *sync.Once

// EnsureBackupSchema creates the backup tables (idempotent, once per DB).
func (d *DB) EnsureBackupSchema() {
	v, _ := backupSchemaOnce.LoadOrStore(d, &sync.Once{})
	v.(*sync.Once).Do(func() {
		for _, q := range []string{
			`CREATE TABLE IF NOT EXISTS backup_destinations (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				type TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 1,
				config TEXT NOT NULL DEFAULT '{}',
				secret_enc TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS backup_schedules (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				target TEXT NOT NULL,
				frequency TEXT NOT NULL,
				hour INTEGER NOT NULL DEFAULT 2,
				weekday INTEGER NOT NULL DEFAULT 0,
				retention INTEGER NOT NULL DEFAULT 7,
				destination_ids TEXT NOT NULL DEFAULT '[]',
				encrypt INTEGER NOT NULL DEFAULT 0,
				notify_on_success INTEGER NOT NULL DEFAULT 0,
				enabled INTEGER NOT NULL DEFAULT 1,
				last_run_at INTEGER,
				last_status TEXT NOT NULL DEFAULT '',
				next_run_at INTEGER,
				created_at INTEGER NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS backup_history (
				id TEXT PRIMARY KEY,
				schedule_id TEXT NOT NULL DEFAULT '',
				schedule_name TEXT NOT NULL DEFAULT '',
				target TEXT NOT NULL,
				target_name TEXT NOT NULL DEFAULT '',
				started_at INTEGER NOT NULL,
				finished_at INTEGER,
				status TEXT NOT NULL,
				size_bytes INTEGER NOT NULL DEFAULT 0,
				encrypted INTEGER NOT NULL DEFAULT 0,
				error TEXT NOT NULL DEFAULT '',
				files TEXT NOT NULL DEFAULT '[]'
			)`,
			`CREATE INDEX IF NOT EXISTS idx_backup_history_started ON backup_history(started_at)`,
			`CREATE INDEX IF NOT EXISTS idx_backup_history_schedule ON backup_history(schedule_id, started_at)`,
		} {
			if _, err := d.Exec(q); err != nil {
				fmt.Fprintf(os.Stderr, "[db] backup schema: %v\n", err)
			}
		}
	})
}

// BackupEncryptionKey derives the 32-byte key used to encrypt scheduled database
// backups from the panel's AES key. Restoring such a backup therefore needs the
// same panel keys — which the encrypted panel backup carries.
func BackupEncryptionKey() ([]byte, error) {
	k, err := aesKey()
	if err != nil {
		return nil, err
	}
	h := sha256.Sum256(append([]byte("pulsenode/backups/v1\x00"), k...))
	return h[:], nil
}

// SnapshotTo writes a consistent copy of the live database to dest (VACUUM INTO,
// safe while the app keeps running) and verifies it. Unlike Snapshot() it never
// prunes the pre-update snapshots. dest must not exist.
func (d *DB) SnapshotTo(dest string) error {
	if _, err := os.Stat(dest); err == nil {
		return fmt.Errorf("snapshot target %s already exists", dest)
	}
	if _, err := d.Exec("VACUUM INTO ?", dest); err != nil {
		_ = os.Remove(dest)
		return fmt.Errorf("snapshot database: %w", err)
	}
	if err := VerifySnapshotFile(dest); err != nil {
		_ = os.Remove(dest)
		return err
	}
	return nil
}

func msOrNil(t *time.Time) any {
	if t == nil || t.IsZero() {
		return nil
	}
	return t.UnixMilli()
}

func timeFromMs(v sql.NullInt64) *time.Time {
	if !v.Valid {
		return nil
	}
	t := time.UnixMilli(v.Int64)
	return &t
}

// ── Destinations ──────────────────────────────────────────────────────────────

// BackupDestination is where backup files are stored. Config holds the
// non-secret settings (dir, endpoint, region, bucket, prefix, useSSL, pathStyle,
// accessKeyHint); credentials live encrypted in a separate column.
type BackupDestination struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Type      string            `json:"type"` // local | s3
	Enabled   bool              `json:"enabled"`
	Config    map[string]string `json:"config"`
	SecretSet bool              `json:"secretSet"`
	CreatedAt time.Time         `json:"createdAt"`
}

// BackupSecrets are a destination's decrypted credentials.
type BackupSecrets struct {
	AccessKey string `json:"accessKey"`
	SecretKey string `json:"secretKey"`
}

func scanDestination(row rowScanner) (*BackupDestination, error) {
	var (
		dst     BackupDestination
		cfg     string
		secret  string
		enabled int
		created int64
	)
	if err := row.Scan(&dst.ID, &dst.Name, &dst.Type, &enabled, &cfg, &secret, &created); err != nil {
		return nil, err
	}
	dst.Enabled = enabled != 0
	dst.SecretSet = secret != ""
	dst.CreatedAt = time.UnixMilli(created)
	dst.Config = map[string]string{}
	_ = json.Unmarshal([]byte(cfg), &dst.Config)
	if dst.Config == nil {
		dst.Config = map[string]string{}
	}
	return &dst, nil
}

const destCols = `id,name,type,enabled,config,secret_enc,created_at`

func (d *DB) ListBackupDestinations() ([]BackupDestination, error) {
	d.EnsureBackupSchema()
	rows, err := d.Query(`SELECT ` + destCols + ` FROM backup_destinations ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BackupDestination{}
	for rows.Next() {
		dst, err := scanDestination(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *dst)
	}
	return out, rows.Err()
}

// GetBackupDestination returns nil (no error) when the id is unknown.
func (d *DB) GetBackupDestination(id string) (*BackupDestination, error) {
	d.EnsureBackupSchema()
	dst, err := scanDestination(d.QueryRow(`SELECT `+destCols+` FROM backup_destinations WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return dst, err
}

// BackupDestinationSecrets decrypts the stored credentials ("" values when none).
func (d *DB) BackupDestinationSecrets(id string) (BackupSecrets, error) {
	d.EnsureBackupSchema()
	var enc string
	err := d.QueryRow(`SELECT secret_enc FROM backup_destinations WHERE id=?`, id).Scan(&enc)
	if errors.Is(err, sql.ErrNoRows) {
		return BackupSecrets{}, nil
	}
	if err != nil || enc == "" {
		return BackupSecrets{}, err
	}
	plain, err := Decrypt(enc)
	if err != nil {
		return BackupSecrets{}, err
	}
	var s BackupSecrets
	if err := json.Unmarshal([]byte(plain), &s); err != nil {
		return BackupSecrets{}, fmt.Errorf("corrupt destination credentials: %w", err)
	}
	return s, nil
}

// SaveBackupDestination inserts or updates a destination. secrets == nil keeps
// the stored credentials; otherwise they replace them (encrypted).
func (d *DB) SaveBackupDestination(dst *BackupDestination, secrets *BackupSecrets) error {
	d.EnsureBackupSchema()
	cfg, err := json.Marshal(dst.Config)
	if err != nil {
		return err
	}
	var enc *string
	if secrets != nil {
		raw, err := json.Marshal(secrets)
		if err != nil {
			return err
		}
		e, err := Encrypt(string(raw))
		if err != nil {
			return err
		}
		enc = &e
	}
	existing, err := d.GetBackupDestination(dst.ID)
	if err != nil {
		return err
	}
	if existing == nil {
		if dst.CreatedAt.IsZero() {
			dst.CreatedAt = time.Now()
		}
		e := ""
		if enc != nil {
			e = *enc
		}
		_, err = d.Exec(`INSERT INTO backup_destinations (`+destCols+`) VALUES (?,?,?,?,?,?,?)`,
			dst.ID, dst.Name, dst.Type, boolInt(dst.Enabled), string(cfg), e, dst.CreatedAt.UnixMilli())
		return err
	}
	if enc != nil {
		_, err = d.Exec(`UPDATE backup_destinations SET name=?,type=?,enabled=?,config=?,secret_enc=? WHERE id=?`,
			dst.Name, dst.Type, boolInt(dst.Enabled), string(cfg), *enc, dst.ID)
	} else {
		_, err = d.Exec(`UPDATE backup_destinations SET name=?,type=?,enabled=?,config=? WHERE id=?`,
			dst.Name, dst.Type, boolInt(dst.Enabled), string(cfg), dst.ID)
	}
	return err
}

func (d *DB) DeleteBackupDestination(id string) error {
	d.EnsureBackupSchema()
	_, err := d.Exec(`DELETE FROM backup_destinations WHERE id=?`, id)
	return err
}

// ── Schedules ─────────────────────────────────────────────────────────────────

type BackupSchedule struct {
	ID              string
	Name            string
	Target          string // "panel" | "db:<managedDatabaseId>"
	Frequency       string // hourly | daily | weekly
	Hour            int
	Weekday         int
	Retention       int
	DestinationIDs  []string
	Encrypt         bool
	NotifyOnSuccess bool
	Enabled         bool
	LastRunAt       *time.Time
	LastStatus      string
	NextRunAt       *time.Time
	CreatedAt       time.Time
}

const schedCols = `id,name,target,frequency,hour,weekday,retention,destination_ids,encrypt,notify_on_success,enabled,last_run_at,last_status,next_run_at,created_at`

func scanSchedule(row rowScanner) (*BackupSchedule, error) {
	var (
		s                    BackupSchedule
		ids                  string
		enc, notify, enabled int
		last, next           sql.NullInt64
		created              int64
	)
	if err := row.Scan(&s.ID, &s.Name, &s.Target, &s.Frequency, &s.Hour, &s.Weekday, &s.Retention, &ids,
		&enc, &notify, &enabled, &last, &s.LastStatus, &next, &created); err != nil {
		return nil, err
	}
	s.Encrypt, s.NotifyOnSuccess, s.Enabled = enc != 0, notify != 0, enabled != 0
	s.LastRunAt, s.NextRunAt = timeFromMs(last), timeFromMs(next)
	s.CreatedAt = time.UnixMilli(created)
	s.DestinationIDs = []string{}
	_ = json.Unmarshal([]byte(ids), &s.DestinationIDs)
	if s.DestinationIDs == nil {
		s.DestinationIDs = []string{}
	}
	return &s, nil
}

func (d *DB) ListBackupSchedules() ([]BackupSchedule, error) {
	d.EnsureBackupSchema()
	rows, err := d.Query(`SELECT ` + schedCols + ` FROM backup_schedules ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BackupSchedule{}
	for rows.Next() {
		s, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

func (d *DB) GetBackupSchedule(id string) (*BackupSchedule, error) {
	d.EnsureBackupSchema()
	s, err := scanSchedule(d.QueryRow(`SELECT `+schedCols+` FROM backup_schedules WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return s, err
}

// SaveBackupSchedule inserts or fully updates a schedule.
func (d *DB) SaveBackupSchedule(s *BackupSchedule) error {
	d.EnsureBackupSchema()
	ids, err := json.Marshal(append([]string{}, s.DestinationIDs...))
	if err != nil {
		return err
	}
	if s.CreatedAt.IsZero() {
		s.CreatedAt = time.Now()
	}
	_, err = d.Exec(`INSERT INTO backup_schedules (`+schedCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET name=excluded.name,target=excluded.target,frequency=excluded.frequency,hour=excluded.hour,
weekday=excluded.weekday,retention=excluded.retention,destination_ids=excluded.destination_ids,encrypt=excluded.encrypt,
notify_on_success=excluded.notify_on_success,enabled=excluded.enabled,next_run_at=excluded.next_run_at`,
		s.ID, s.Name, s.Target, s.Frequency, s.Hour, s.Weekday, s.Retention, string(ids), boolInt(s.Encrypt),
		boolInt(s.NotifyOnSuccess), boolInt(s.Enabled), msOrNil(s.LastRunAt), s.LastStatus, msOrNil(s.NextRunAt), s.CreatedAt.UnixMilli())
	return err
}

// RecordBackupRun stores the outcome of a run and the schedule's next due time.
func (d *DB) RecordBackupRun(id string, last time.Time, status string, next *time.Time) error {
	d.EnsureBackupSchema()
	_, err := d.Exec(`UPDATE backup_schedules SET last_run_at=?,last_status=?,next_run_at=? WHERE id=?`,
		last.UnixMilli(), status, msOrNil(next), id)
	return err
}

func (d *DB) SetBackupNextRun(id string, next *time.Time) error {
	d.EnsureBackupSchema()
	_, err := d.Exec(`UPDATE backup_schedules SET next_run_at=? WHERE id=?`, msOrNil(next), id)
	return err
}

func (d *DB) DeleteBackupSchedule(id string) error {
	d.EnsureBackupSchema()
	_, err := d.Exec(`DELETE FROM backup_schedules WHERE id=?`, id)
	return err
}

// ── History ───────────────────────────────────────────────────────────────────

// BackupFileResult is one destination's outcome for a run.
type BackupFileResult struct {
	DestinationID   string `json:"destinationId"`
	DestinationName string `json:"destinationName"`
	Name            string `json:"name"`
	OK              bool   `json:"ok"`
	Error           string `json:"error"`
}

type BackupHistory struct {
	ID           string
	ScheduleID   string
	ScheduleName string
	Target       string
	TargetName   string
	StartedAt    time.Time
	FinishedAt   *time.Time
	Status       string // running | success | failed
	SizeBytes    int64
	Encrypted    bool
	Error        string
	Files        []BackupFileResult
}

const histCols = `id,schedule_id,schedule_name,target,target_name,started_at,finished_at,status,size_bytes,encrypted,error,files`

func scanHistory(row rowScanner) (*BackupHistory, error) {
	var (
		h        BackupHistory
		started  int64
		finished sql.NullInt64
		enc      int
		files    string
	)
	if err := row.Scan(&h.ID, &h.ScheduleID, &h.ScheduleName, &h.Target, &h.TargetName, &started, &finished,
		&h.Status, &h.SizeBytes, &enc, &h.Error, &files); err != nil {
		return nil, err
	}
	h.StartedAt = time.UnixMilli(started)
	h.FinishedAt = timeFromMs(finished)
	h.Encrypted = enc != 0
	h.Files = []BackupFileResult{}
	_ = json.Unmarshal([]byte(files), &h.Files)
	if h.Files == nil {
		h.Files = []BackupFileResult{}
	}
	return &h, nil
}

func (d *DB) InsertBackupHistory(h *BackupHistory) error {
	d.EnsureBackupSchema()
	files, err := json.Marshal(append([]BackupFileResult{}, h.Files...))
	if err != nil {
		return err
	}
	_, err = d.Exec(`INSERT INTO backup_history (`+histCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		h.ID, h.ScheduleID, h.ScheduleName, h.Target, h.TargetName, h.StartedAt.UnixMilli(), msOrNil(h.FinishedAt),
		h.Status, h.SizeBytes, boolInt(h.Encrypted), h.Error, string(files))
	return err
}

// UpdateBackupHistory rewrites the mutable parts of a history row.
func (d *DB) UpdateBackupHistory(h *BackupHistory) error {
	d.EnsureBackupSchema()
	files, err := json.Marshal(append([]BackupFileResult{}, h.Files...))
	if err != nil {
		return err
	}
	_, err = d.Exec(`UPDATE backup_history SET finished_at=?,status=?,size_bytes=?,encrypted=?,error=?,files=? WHERE id=?`,
		msOrNil(h.FinishedAt), h.Status, h.SizeBytes, boolInt(h.Encrypted), h.Error, string(files), h.ID)
	return err
}

func (d *DB) GetBackupHistory(id string) (*BackupHistory, error) {
	d.EnsureBackupSchema()
	h, err := scanHistory(d.QueryRow(`SELECT `+histCols+` FROM backup_history WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return h, err
}

// ListBackupHistory returns newest first, optionally for one schedule.
func (d *DB) ListBackupHistory(limit int, scheduleID string) ([]BackupHistory, error) {
	d.EnsureBackupSchema()
	if limit <= 0 {
		limit = 50
	}
	q, args := `SELECT `+histCols+` FROM backup_history`, []any{}
	if scheduleID != "" {
		q += ` WHERE schedule_id=?`
		args = append(args, scheduleID)
	}
	q += ` ORDER BY started_at DESC, id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := d.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BackupHistory{}
	for rows.Next() {
		h, err := scanHistory(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *h)
	}
	return out, rows.Err()
}

func (d *DB) DeleteBackupHistory(id string) error {
	d.EnsureBackupSchema()
	_, err := d.Exec(`DELETE FROM backup_history WHERE id=?`, id)
	return err
}

// FailStaleBackupRuns marks rows left "running" by a crash or restart as failed.
func (d *DB) FailStaleBackupRuns() (int64, error) {
	d.EnsureBackupSchema()
	res, err := d.Exec(`UPDATE backup_history SET status='failed', finished_at=?, error='interrupted by a restart' WHERE status='running'`,
		time.Now().UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// CountFailedBackupsSince counts failed runs that started at or after t.
func (d *DB) CountFailedBackupsSince(t time.Time) (int, error) {
	d.EnsureBackupSchema()
	var n int
	err := d.QueryRow(`SELECT COUNT(*) FROM backup_history WHERE status='failed' AND started_at>=?`, t.UnixMilli()).Scan(&n)
	return n, err
}

// BackupSettingPassphrase is the settings key holding the encrypted panel-backup passphrase.
const BackupSettingPassphrase = "backup_passphrase"

// BackupPassphrase returns the decrypted panel-backup passphrase ("" when unset).
func (d *DB) BackupPassphrase() (string, error) {
	v, err := d.GetSetting(BackupSettingPassphrase)
	if err != nil || v == "" {
		return "", err
	}
	return Decrypt(v)
}

// SetBackupPassphrase stores the passphrase encrypted with the panel key.
func (d *DB) SetBackupPassphrase(p string) error {
	enc, err := Encrypt(p)
	if err != nil {
		return err
	}
	return d.SetSetting(BackupSettingPassphrase, enc)
}
