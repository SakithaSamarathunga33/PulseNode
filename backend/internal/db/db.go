package db

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type DB struct{ *sql.DB }

func Open(path string) (*DB, error) {
	raw, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	// SQLite: one writer at a time. The _pragma options in the DSN are applied to
	// every new connection the pool opens, so they survive connection recycling.
	raw.SetMaxOpenConns(1)
	d := &DB{raw}
	if err := d.migrate(); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return d, nil
}

func (d *DB) migrate() error {
	_, err := d.Exec(`
CREATE TABLE IF NOT EXISTS github_accounts (
  id           INTEGER PRIMARY KEY,
  login        TEXT NOT NULL,
  avatar_url   TEXT NOT NULL,
  access_token TEXT NOT NULL,
  token_type   TEXT NOT NULL DEFAULT 'oauth',
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  repo_url      TEXT NOT NULL,
  branch        TEXT NOT NULL DEFAULT 'main',
  build_method  TEXT NOT NULL DEFAULT 'auto',
  build_command TEXT,
  port          INTEGER NOT NULL DEFAULT 3000,
  domain        TEXT NOT NULL,
  env_vars      TEXT NOT NULL DEFAULT '{}',
  container_id  TEXT,
  status        TEXT NOT NULL DEFAULT 'idle',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deployments (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  trigger     TEXT NOT NULL DEFAULT 'manual',
  commit_sha  TEXT,
  commit_msg  TEXT,
  started_at  DATETIME,
  finished_at DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deployment_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id TEXT NOT NULL,
  stream        TEXT NOT NULL DEFAULT 'stdout',
  line          TEXT NOT NULL,
  ts            DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS managed_databases (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  engine             TEXT NOT NULL,
  container_id       TEXT,
  volume_name        TEXT,
  host_port          INTEGER,
  username           TEXT NOT NULL,
  encrypted_password TEXT NOT NULL,
  db_name            TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'creating',
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS connected_databases (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  engine             TEXT NOT NULL,
  host               TEXT NOT NULL,
  port               INTEGER NOT NULL,
  username           TEXT NOT NULL,
  encrypted_password TEXT NOT NULL,
  db_name            TEXT NOT NULL,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  metric     TEXT NOT NULL,
  operator   TEXT NOT NULL,
  threshold  REAL NOT NULL,
  duration   INTEGER NOT NULL DEFAULT 0,
  severity   TEXT NOT NULL DEFAULT 'warning',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alert_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id    TEXT NOT NULL,
  rule_name  TEXT NOT NULL,
  metric     TEXT NOT NULL,
  value      REAL NOT NULL,
  severity   TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'firing',
  fired_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME
);

CREATE TABLE IF NOT EXISTS notification_channels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL DEFAULT 'system',
  action     TEXT NOT NULL,
  resource   TEXT,
  ip         TEXT,
  status     INTEGER NOT NULL DEFAULT 200,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS oauth_settings (
  id            INTEGER PRIMARY KEY,
  client_id     TEXT NOT NULL DEFAULT '',
  client_secret TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS github_app_installations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id INTEGER NOT NULL UNIQUE,
  account_login   TEXT NOT NULL,
  account_type    TEXT NOT NULL DEFAULT 'User',
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS domains (
  id              TEXT PRIMARY KEY,
  host            TEXT NOT NULL UNIQUE,
  is_primary      INTEGER NOT NULL DEFAULT 0,
  last_pointed    INTEGER,
  last_proxied    INTEGER NOT NULL DEFAULT 0,
  last_records    TEXT NOT NULL DEFAULT '[]',
  last_message    TEXT NOT NULL DEFAULT '',
  last_error      TEXT NOT NULL DEFAULT '',
  last_checked_at DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Keyed by container name rather than container ID: recreating a container
-- (redeploys, restarts via compose) assigns a new ID but keeps the same name,
-- so name is what stays continuous across the history a heartbeat graph needs.
CREATE TABLE IF NOT EXISTS container_heartbeats (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  container_name TEXT NOT NULL,
  up             INTEGER NOT NULL,
  checked_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_name_time ON container_heartbeats(container_name, checked_at);

-- Hot lookups: per-deployment log reads and "last line" lookups, project/status
-- filters, audit listing and alert counting. The DB has a single connection, so
-- a table scan on any of these stalls every API request.
CREATE INDEX IF NOT EXISTS idx_deployment_logs_dep ON deployment_logs(deployment_id, id);
CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id, status);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_alert_history_state ON alert_history(state, resolved_at);
`)
	if err != nil {
		return err
	}

	// Incremental column additions for existing databases (CREATE TABLE IF NOT
	// EXISTS won't add columns to a table that already exists).
	d.addColumn("projects", "auto_deploy", "INTEGER NOT NULL DEFAULT 1")
	d.addColumn("projects", "last_commit_sha", "TEXT")
	// image_tag records the Docker image a deployment produced, so a later
	// deployment can be rolled back to it without rebuilding.
	d.addColumn("deployments", "image_tag", "TEXT")
	// backend_env_vars holds the backend container's env for frontend/+backend
	// monorepos (kept separate from env_vars, which is the frontend/single env,
	// so backend secrets are never injected into the frontend container).
	d.addColumn("projects", "backend_env_vars", "TEXT")
	// base_dir identifies which subfolder of the repo this project builds from
	// ("" | "frontend" | "backend") — set at creation when a monorepo component
	// is deployed as its own independent project instead of the combined mode.
	d.addColumn("projects", "base_dir", "TEXT")
	return nil
}

// addColumn runs an ALTER TABLE ADD COLUMN, ignoring the "duplicate column"
// error so migrations stay idempotent across restarts.
func (d *DB) addColumn(table, column, definition string) {
	_, err := d.Exec(fmt.Sprintf(`ALTER TABLE %s ADD COLUMN %s %s`, table, column, definition))
	if err != nil && !strings.Contains(err.Error(), "duplicate column") {
		fmt.Fprintf(os.Stderr, "[db] addColumn %s.%s: %v\n", table, column, err)
	}
}

// ── Encryption ────────────────────────────────────────────────────────────────

func aesKey() ([]byte, error) {
	k := os.Getenv("AES_KEY")
	if k == "" {
		k = os.Getenv("MASTER_ENCRYPTION_KEY")
	}
	if len(k) < 32 {
		return nil, errors.New("AES_KEY must be at least 32 chars")
	}
	return []byte(k[:32]), nil
}

func Encrypt(plaintext string) (string, error) {
	key, err := aesKey()
	if err != nil {
		// Never silently store secrets in plaintext. main() calls
		// EnsureEncryptionKey at startup, so this only fires on misconfiguration.
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return hex.EncodeToString(sealed), nil
}

func Decrypt(ciphertext string) (string, error) {
	key, err := aesKey()
	if err != nil {
		return ciphertext, nil
	}
	data, err := hex.DecodeString(ciphertext)
	if err != nil {
		return ciphertext, nil // not encrypted, return as-is
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(data) < gcm.NonceSize() {
		return ciphertext, nil
	}
	plain, err := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], nil)
	if err != nil {
		return ciphertext, nil
	}
	return string(plain), nil
}

// ── ID generation ─────────────────────────────────────────────────────────────

func NewID(prefix string) string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%s_%s", prefix, hex.EncodeToString(b))
}

// ── GitHub accounts ───────────────────────────────────────────────────────────

type GitHubAccount struct {
	ID          int64
	Login       string
	AvatarURL   string
	AccessToken string
	TokenType   string
	CreatedAt   time.Time
}

func (d *DB) UpsertGitHubAccount(login, avatarURL, token, tokenType string) error {
	enc, err := Encrypt(token)
	if err != nil {
		return err
	}
	_, err = d.Exec(`
INSERT INTO github_accounts (login, avatar_url, access_token, token_type)
VALUES (?, ?, ?, ?)
ON CONFLICT DO UPDATE SET login=excluded.login, avatar_url=excluded.avatar_url,
  access_token=excluded.access_token, token_type=excluded.token_type`,
		login, avatarURL, enc, tokenType)
	return err
}

func (d *DB) GetGitHubAccount() (*GitHubAccount, error) {
	row := d.QueryRow(`SELECT id, login, avatar_url, access_token, token_type, created_at FROM github_accounts LIMIT 1`)
	var a GitHubAccount
	var enc string
	if err := row.Scan(&a.ID, &a.Login, &a.AvatarURL, &enc, &a.TokenType, &a.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	token, err := Decrypt(enc)
	if err != nil {
		return nil, err
	}
	a.AccessToken = token
	return &a, nil
}

func (d *DB) DeleteGitHubAccount() error {
	_, err := d.Exec(`DELETE FROM github_accounts`)
	return err
}

// ── Projects ──────────────────────────────────────────────────────────────────

type Project struct {
	ID             string
	Name           string
	RepoURL        string
	Branch         string
	BuildMethod    string
	BuildCommand   string
	Port           int
	Domain         string
	EnvVars        string // JSON map, encrypted at rest (frontend/single-service env)
	BackendEnvVars string // JSON map, encrypted at rest (monorepo backend env; "" otherwise)
	BaseDir        string // "" | "frontend" | "backend" — subfolder to build from when deployed as a separate monorepo component
	ContainerID    string
	Status         string
	AutoDeploy     bool
	LastCommitSHA  string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

func (d *DB) CreateProject(p *Project) error {
	enc, err := Encrypt(p.EnvVars)
	if err != nil {
		return err
	}
	encBackend, err := Encrypt(p.BackendEnvVars)
	if err != nil {
		return err
	}
	_, err = d.Exec(`
INSERT INTO projects (id, name, repo_url, branch, build_method, build_command, port, domain, env_vars, backend_env_vars, base_dir, status, auto_deploy)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, p.Name, p.RepoURL, p.Branch, p.BuildMethod, p.BuildCommand, p.Port, p.Domain, enc, encBackend, p.BaseDir, p.Status, boolToInt(p.AutoDeploy))
	return err
}

func (d *DB) ListProjects() ([]Project, error) {
	rows, err := d.Query(`SELECT id, name, repo_url, branch, build_method, COALESCE(build_command,''), port, domain, env_vars, COALESCE(container_id,''), status, COALESCE(auto_deploy,1), COALESCE(last_commit_sha,''), COALESCE(base_dir,''), created_at, updated_at FROM projects ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Project{}
	for rows.Next() {
		var p Project
		var enc string
		var autoDeploy int
		if err := rows.Scan(&p.ID, &p.Name, &p.RepoURL, &p.Branch, &p.BuildMethod, &p.BuildCommand, &p.Port, &p.Domain, &enc, &p.ContainerID, &p.Status, &autoDeploy, &p.LastCommitSHA, &p.BaseDir, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		p.AutoDeploy = autoDeploy != 0
		p.EnvVars = "[]" // never expose values in list
		out = append(out, p)
	}
	return out, rows.Err()
}

func (d *DB) GetProject(id string) (*Project, error) {
	row := d.QueryRow(`SELECT id, name, repo_url, branch, build_method, COALESCE(build_command,''), port, domain, env_vars, COALESCE(backend_env_vars,''), COALESCE(container_id,''), status, COALESCE(auto_deploy,1), COALESCE(last_commit_sha,''), COALESCE(base_dir,''), created_at, updated_at FROM projects WHERE id=?`, id)
	var p Project
	var enc, encBackend string
	var autoDeploy int
	if err := row.Scan(&p.ID, &p.Name, &p.RepoURL, &p.Branch, &p.BuildMethod, &p.BuildCommand, &p.Port, &p.Domain, &enc, &encBackend, &p.ContainerID, &p.Status, &autoDeploy, &p.LastCommitSHA, &p.BaseDir, &p.CreatedAt, &p.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	p.AutoDeploy = autoDeploy != 0
	plain, err := Decrypt(enc)
	if err != nil {
		return nil, err
	}
	p.EnvVars = plain
	if p.BackendEnvVars, err = Decrypt(encBackend); err != nil {
		return nil, err
	}
	return &p, nil
}

func (d *DB) UpdateProjectStatus(id, status, containerID string) error {
	_, err := d.Exec(`UPDATE projects SET status=?, container_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, status, containerID, id)
	return err
}

// UpdateProjectStatusKeep changes only the status, leaving container_id alone —
// used when a deploy starts (the previous container is still serving) and when a
// deploy fails (the reference to that still-running container must survive).
func (d *DB) UpdateProjectStatusKeep(id, status string) error {
	_, err := d.Exec(`UPDATE projects SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, status, id)
	return err
}

// ClaimProjectForDeploy atomically moves a project to "building" unless a deploy
// is already queued/building. It returns the previous status so the caller can
// release the claim if enqueueing fails. container_id is left untouched.
func (d *DB) ClaimProjectForDeploy(id string) (prev string, claimed bool, err error) {
	tx, err := d.Begin()
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()
	if err := tx.QueryRow(`SELECT status FROM projects WHERE id=?`, id).Scan(&prev); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	if prev == "building" || prev == "queued" {
		return prev, false, nil
	}
	if _, err := tx.Exec(`UPDATE projects SET status='building', updated_at=CURRENT_TIMESTAMP WHERE id=?`, id); err != nil {
		return "", false, err
	}
	if err := tx.Commit(); err != nil {
		return prev, false, err // the claim was not persisted
	}
	return prev, true, nil
}

// ResetStuckProjects fixes projects left in building/queued by a crash when no
// deployment is actually queued or building for them any more. Projects with a
// live container go back to "running", others to "failed".
func (d *DB) ResetStuckProjects() (int64, error) {
	res, err := d.Exec(`
UPDATE projects
SET status = CASE WHEN COALESCE(container_id,'') <> '' THEN 'running' ELSE 'failed' END,
    updated_at = CURRENT_TIMESTAMP
WHERE status IN ('building','queued')
  AND id NOT IN (SELECT project_id FROM deployments WHERE status IN ('queued','building'))`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (d *DB) UpdateProject(id, name, branch, buildMethod, buildCommand string, port int, domain, envVars, backendEnvVars string, autoDeploy bool) error {
	enc, err := Encrypt(envVars)
	if err != nil {
		return err
	}
	encBackend, err := Encrypt(backendEnvVars)
	if err != nil {
		return err
	}
	_, err = d.Exec(`UPDATE projects SET name=?, branch=?, build_method=?, build_command=?, port=?, domain=?, env_vars=?, backend_env_vars=?, auto_deploy=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
		name, branch, buildMethod, buildCommand, port, domain, enc, encBackend, boolToInt(autoDeploy), id)
	return err
}

// UpdateProjectCommit records the last commit SHA that was deployed for a project.
func (d *DB) UpdateProjectCommit(id, sha string) error {
	_, err := d.Exec(`UPDATE projects SET last_commit_sha=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, sha, id)
	return err
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// nullable returns nil for an empty string so the column stores NULL instead of
// an empty string (keeps COALESCE/IS NULL checks meaningful).
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ── Settings (key/value) ──────────────────────────────────────────────────────

// GetSetting returns the value for key, or "" if unset.
func (d *DB) GetSetting(key string) (string, error) {
	var v string
	err := d.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

// SetSetting upserts a key/value pair.
func (d *DB) SetSetting(key, value string) error {
	_, err := d.Exec(`
INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`, key, value)
	return err
}

func (d *DB) DeleteProject(id string) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM deployment_logs WHERE deployment_id IN (SELECT id FROM deployments WHERE project_id=?)`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM deployments WHERE project_id=?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM projects WHERE id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// ── Deployments ───────────────────────────────────────────────────────────────

type Deployment struct {
	ID         string
	ProjectID  string
	Status     string
	Trigger    string
	CommitSHA  string
	CommitMsg  string
	ImageTag   string
	StartedAt  *time.Time
	FinishedAt *time.Time
	CreatedAt  time.Time
}

const deploymentCols = `id, project_id, status, trigger, COALESCE(commit_sha,''), COALESCE(commit_msg,''), COALESCE(image_tag,''), started_at, finished_at, created_at`

func scanDeployment(s interface{ Scan(...any) error }, dep *Deployment) error {
	return s.Scan(&dep.ID, &dep.ProjectID, &dep.Status, &dep.Trigger, &dep.CommitSHA, &dep.CommitMsg, &dep.ImageTag, &dep.StartedAt, &dep.FinishedAt, &dep.CreatedAt)
}

func (d *DB) CreateDeployment(dep *Deployment) error {
	_, err := d.Exec(`
INSERT INTO deployments (id, project_id, status, trigger, image_tag) VALUES (?, ?, ?, ?, ?)`,
		dep.ID, dep.ProjectID, dep.Status, dep.Trigger, nullable(dep.ImageTag))
	return err
}

func (d *DB) ListDeployments(projectID string) ([]Deployment, error) {
	rows, err := d.Query(`SELECT `+deploymentCols+` FROM deployments WHERE project_id=? ORDER BY created_at DESC LIMIT 20`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Deployment{}
	for rows.Next() {
		var dep Deployment
		if err := scanDeployment(rows, &dep); err != nil {
			return nil, err
		}
		out = append(out, dep)
	}
	return out, rows.Err()
}

func (d *DB) UpdateDeploymentStatus(id, status string, startedAt, finishedAt *time.Time) error {
	_, err := d.Exec(`UPDATE deployments SET status=?, started_at=?, finished_at=? WHERE id=?`, status, startedAt, finishedAt, id)
	return err
}

// CompleteDeployment records a successful deploy in one transaction: the project
// first points at the new container (and baseline commit), then the deployment is
// marked "success". Observers therefore never see a successful deployment on a
// project that is still "building", and a crash cannot split the two writes.
func (d *DB) CompleteDeployment(depID, projectID, containerID, commitSHA string, startedAt, finishedAt time.Time) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE projects SET status='running', container_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, containerID, projectID); err != nil {
		return err
	}
	if commitSHA != "" {
		if _, err := tx.Exec(`UPDATE projects SET last_commit_sha=? WHERE id=?`, commitSHA, projectID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE deployments SET status='success', started_at=?, finished_at=? WHERE id=?`, startedAt, finishedAt, depID); err != nil {
		return err
	}
	return tx.Commit()
}

// UpdateDeploymentCommit records the commit SHA and message a deployment built.
func (d *DB) UpdateDeploymentCommit(id, sha, msg string) error {
	_, err := d.Exec(`UPDATE deployments SET commit_sha=?, commit_msg=? WHERE id=?`, sha, msg, id)
	return err
}

// UpdateDeploymentImage records the Docker image tag a deployment produced.
func (d *DB) UpdateDeploymentImage(id, imageTag string) error {
	_, err := d.Exec(`UPDATE deployments SET image_tag=? WHERE id=?`, imageTag, id)
	return err
}

func (d *DB) GetDeploymentByID(id string) (*Deployment, error) {
	row := d.QueryRow(`SELECT `+deploymentCols+` FROM deployments WHERE id=?`, id)
	var dep Deployment
	if err := scanDeployment(row, &dep); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &dep, nil
}

func (d *DB) GetQueuedDeployments() ([]Deployment, error) {
	rows, err := d.Query(`SELECT ` + deploymentCols + ` FROM deployments WHERE status IN ('queued','building') ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Deployment{}
	for rows.Next() {
		var dep Deployment
		if err := scanDeployment(rows, &dep); err != nil {
			return nil, err
		}
		out = append(out, dep)
	}
	return out, rows.Err()
}

// ── Deployment logs ───────────────────────────────────────────────────────────

func (d *DB) AppendLog(deploymentID, stream, line string) error {
	_, err := d.Exec(`INSERT INTO deployment_logs (deployment_id, stream, line) VALUES (?, ?, ?)`, deploymentID, stream, line)
	return err
}

// LogWriter buffers a deployment's log lines and writes them in batches (every
// ~250ms or 100 lines) in one transaction, instead of one INSERT per line — the
// DB has a single connection, so per-line writes would starve API requests
// during chatty builds. Close flushes whatever is left.
type LogWriter struct {
	d   *DB
	dep string
	mu  sync.Mutex // guards buf
	// flushMu is held across "take the buffer" + "insert it", so two flushes can
	// never commit out of order and interleave lines.
	flushMu sync.Mutex
	buf     [][2]string
	stop    chan struct{}
	done    chan struct{}
	once    sync.Once
}

const (
	logFlushEvery = 250 * time.Millisecond
	logFlushLines = 100
	// logRetainMax bounds the lines kept for retry after a failed insert; beyond
	// it the oldest are dropped.
	logRetainMax = 5000
)

func (d *DB) NewLogWriter(deploymentID string) *LogWriter {
	w := &LogWriter{d: d, dep: deploymentID, stop: make(chan struct{}), done: make(chan struct{})}
	go w.loop()
	return w
}

func (w *LogWriter) loop() {
	defer close(w.done)
	t := time.NewTicker(logFlushEvery)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			w.Flush()
		case <-w.stop:
			return
		}
	}
}

// Add queues one line; safe for concurrent use.
func (w *LogWriter) Add(stream, line string) {
	w.mu.Lock()
	w.buf = append(w.buf, [2]string{stream, line})
	full := len(w.buf) >= logFlushLines
	w.mu.Unlock()
	if full {
		w.flush(false) // skip if a flush is already running; it (or the ticker) drains the rest
	}
}

// Flush writes everything buffered so far.
func (w *LogWriter) Flush() { w.flush(true) }

func (w *LogWriter) flush(wait bool) {
	if wait {
		w.flushMu.Lock()
	} else if !w.flushMu.TryLock() {
		return
	}
	defer w.flushMu.Unlock()

	w.mu.Lock()
	rows := w.buf
	w.buf = nil
	w.mu.Unlock()
	if len(rows) == 0 {
		return
	}
	if err := w.d.insertLogs(w.dep, rows); err != nil {
		// Keep the batch (ahead of anything added meanwhile) for the next flush.
		w.mu.Lock()
		w.buf = append(rows, w.buf...)
		dropped := 0
		if over := len(w.buf) - logRetainMax; over > 0 {
			w.buf = w.buf[over:]
			dropped = over
		}
		w.mu.Unlock()
		log.Printf("[db] deployment %s: log insert failed (%d lines kept for retry, %d dropped): %v", w.dep, len(rows)-dropped, dropped, err)
	}
}

// Close stops the background flusher and flushes the remainder. Idempotent.
func (w *LogWriter) Close() {
	w.once.Do(func() { close(w.stop) })
	<-w.done
	w.Flush()
}

func (d *DB) insertLogs(deploymentID string, rows [][2]string) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(`INSERT INTO deployment_logs (deployment_id, stream, line) VALUES (?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, r := range rows {
		if _, err := stmt.Exec(deploymentID, r[0], r[1]); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ── Retention ─────────────────────────────────────────────────────────────────

// PruneOld deletes deployment logs, audit entries and old alert history older
// than the given ages so those append-only tables stay bounded. Timestamps are
// compared with SQLite's own clock to match the CURRENT_TIMESTAMP defaults.
func (d *DB) PruneOld(logsAge, auditAge, alertsAge time.Duration) error {
	if logsAge <= 0 || auditAge <= 0 || alertsAge <= 0 {
		return errors.New("db: retention ages must be positive")
	}
	hours := func(a time.Duration) string { return fmt.Sprintf("-%d hours", int(a.Hours())+1) }
	var firstErr error
	for _, q := range []struct{ sql, age string }{
		{`DELETE FROM deployment_logs WHERE ts < datetime('now', ?)`, hours(logsAge)},
		{`DELETE FROM audit_log WHERE created_at < datetime('now', ?)`, hours(auditAge)},
		// Only closed alerts: a still-firing or acknowledged alert must outlive
		// retention, or it would fire (and notify) a second time.
		{`DELETE FROM alert_history WHERE state='resolved' AND COALESCE(resolved_at, fired_at) < datetime('now', ?)`, hours(alertsAge)},
	} {
		if _, err := d.Exec(q.sql, q.age); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (d *DB) GetLogs(deploymentID string) ([]map[string]string, error) {
	rows, err := d.Query(`SELECT stream, line, ts FROM deployment_logs WHERE deployment_id=? ORDER BY id ASC`, deploymentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]string{}
	for rows.Next() {
		var stream, line string
		var ts time.Time
		if err := rows.Scan(&stream, &line, &ts); err != nil {
			return nil, err
		}
		out = append(out, map[string]string{"stream": stream, "line": line, "ts": ts.Format(time.RFC3339)})
	}
	return out, rows.Err()
}

// ── Managed Databases ─────────────────────────────────────────────────────────

type ManagedDatabase struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Engine      string    `json:"engine"`
	ContainerID string    `json:"container_id"`
	VolumeName  string    `json:"volume_name"`
	HostPort    int       `json:"host_port"`
	Username    string    `json:"username"`
	Password    string    `json:"password"` // decrypted
	DBName      string    `json:"db_name"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
}

func (d *DB) CreateManagedDatabase(m *ManagedDatabase) error {
	enc, err := Encrypt(m.Password)
	if err != nil {
		return err
	}
	_, err = d.Exec(`INSERT INTO managed_databases (id,name,engine,container_id,volume_name,host_port,username,encrypted_password,db_name,status) VALUES (?,?,?,?,?,?,?,?,?,?)`,
		m.ID, m.Name, m.Engine, m.ContainerID, m.VolumeName, m.HostPort, m.Username, enc, m.DBName, m.Status)
	return err
}

func (d *DB) UpdateManagedDatabaseStatus(id, status, containerID string) error {
	_, err := d.Exec(`UPDATE managed_databases SET status=?, container_id=? WHERE id=?`, status, containerID, id)
	return err
}

func (d *DB) ListManagedDatabases() ([]ManagedDatabase, error) {
	rows, err := d.Query(`SELECT id,name,engine,COALESCE(container_id,''),COALESCE(volume_name,''),COALESCE(host_port,0),username,encrypted_password,db_name,status,created_at FROM managed_databases ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ManagedDatabase{}
	for rows.Next() {
		var m ManagedDatabase
		var enc string
		if err := rows.Scan(&m.ID, &m.Name, &m.Engine, &m.ContainerID, &m.VolumeName, &m.HostPort, &m.Username, &enc, &m.DBName, &m.Status, &m.CreatedAt); err != nil {
			return nil, err
		}
		// Don't expose password in list
		out = append(out, m)
	}
	return out, rows.Err()
}

func (d *DB) GetManagedDatabase(id string) (*ManagedDatabase, error) {
	row := d.QueryRow(`SELECT id,name,engine,COALESCE(container_id,''),COALESCE(volume_name,''),COALESCE(host_port,0),username,encrypted_password,db_name,status,created_at FROM managed_databases WHERE id=?`, id)
	var m ManagedDatabase
	var enc string
	if err := row.Scan(&m.ID, &m.Name, &m.Engine, &m.ContainerID, &m.VolumeName, &m.HostPort, &m.Username, &enc, &m.DBName, &m.Status, &m.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	plain, _ := Decrypt(enc)
	m.Password = plain
	return &m, nil
}

func (d *DB) GetManagedDatabaseByContainerName(engine, name string) (*ManagedDatabase, error) {
	row := d.QueryRow(`SELECT id,name,engine,COALESCE(container_id,''),COALESCE(volume_name,''),COALESCE(host_port,0),username,encrypted_password,db_name,status,created_at FROM managed_databases WHERE engine=? AND name=?`, engine, name)
	var m ManagedDatabase
	var enc string
	if err := row.Scan(&m.ID, &m.Name, &m.Engine, &m.ContainerID, &m.VolumeName, &m.HostPort, &m.Username, &enc, &m.DBName, &m.Status, &m.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	plain, _ := Decrypt(enc)
	m.Password = plain
	return &m, nil
}

func (d *DB) DeleteManagedDatabase(id string) error {
	_, err := d.Exec(`DELETE FROM managed_databases WHERE id=?`, id)
	return err
}

// ── Connected Databases ───────────────────────────────────────────────────────

type ConnectedDatabase struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Engine    string    `json:"engine"`
	Host      string    `json:"host"`
	Port      int       `json:"port"`
	Username  string    `json:"username"`
	Password  string    `json:"password"`
	DBName    string    `json:"db_name"`
	CreatedAt time.Time `json:"created_at"`
}

func (d *DB) CreateConnectedDatabase(c *ConnectedDatabase) error {
	enc, err := Encrypt(c.Password)
	if err != nil {
		return err
	}
	_, err = d.Exec(`INSERT INTO connected_databases (id,name,engine,host,port,username,encrypted_password,db_name) VALUES (?,?,?,?,?,?,?,?)`,
		c.ID, c.Name, c.Engine, c.Host, c.Port, c.Username, enc, c.DBName)
	return err
}

func (d *DB) ListConnectedDatabases() ([]ConnectedDatabase, error) {
	rows, err := d.Query(`SELECT id,name,engine,host,port,username,db_name,created_at FROM connected_databases ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ConnectedDatabase{}
	for rows.Next() {
		var c ConnectedDatabase
		if err := rows.Scan(&c.ID, &c.Name, &c.Engine, &c.Host, &c.Port, &c.Username, &c.DBName, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (d *DB) DeleteConnectedDatabase(id string) error {
	_, err := d.Exec(`DELETE FROM connected_databases WHERE id=?`, id)
	return err
}

// ── Alert Rules ───────────────────────────────────────────────────────────────

type AlertRule struct {
	ID        string
	Name      string
	Metric    string
	Operator  string
	Threshold float64
	Duration  int
	Severity  string
	Enabled   bool
	CreatedAt time.Time
}

func (d *DB) CreateAlertRule(r *AlertRule) error {
	_, err := d.Exec(`INSERT INTO alert_rules (id,name,metric,operator,threshold,duration,severity,enabled) VALUES (?,?,?,?,?,?,?,?)`,
		r.ID, r.Name, r.Metric, r.Operator, r.Threshold, r.Duration, r.Severity, r.Enabled)
	return err
}

func (d *DB) ListAlertRules() ([]AlertRule, error) {
	rows, err := d.Query(`SELECT id,name,metric,operator,threshold,duration,severity,enabled,created_at FROM alert_rules ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AlertRule{}
	for rows.Next() {
		var r AlertRule
		var enabled int
		if err := rows.Scan(&r.ID, &r.Name, &r.Metric, &r.Operator, &r.Threshold, &r.Duration, &r.Severity, &enabled, &r.CreatedAt); err != nil {
			return nil, err
		}
		r.Enabled = enabled == 1
		out = append(out, r)
	}
	return out, rows.Err()
}

func (d *DB) UpdateAlertRule(id string, enabled bool) error {
	v := 0
	if enabled {
		v = 1
	}
	_, err := d.Exec(`UPDATE alert_rules SET enabled=? WHERE id=?`, v, id)
	return err
}

func (d *DB) DeleteAlertRule(id string) error {
	_, err := d.Exec(`DELETE FROM alert_rules WHERE id=?`, id)
	return err
}

// ── Alert History ─────────────────────────────────────────────────────────────

type AlertEvent struct {
	ID         int64
	RuleID     string
	RuleName   string
	Metric     string
	Value      float64
	Severity   string
	State      string
	FiredAt    time.Time
	ResolvedAt *time.Time
}

func (d *DB) InsertAlertEvent(e *AlertEvent) error {
	_, err := d.Exec(`INSERT INTO alert_history (rule_id,rule_name,metric,value,severity,state) VALUES (?,?,?,?,?,?)`,
		e.RuleID, e.RuleName, e.Metric, e.Value, e.Severity, e.State)
	return err
}

func (d *DB) ListAlertHistory(limit int) ([]AlertEvent, error) {
	rows, err := d.Query(`SELECT id,rule_id,rule_name,metric,value,severity,state,fired_at,resolved_at FROM alert_history ORDER BY fired_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AlertEvent{}
	for rows.Next() {
		var e AlertEvent
		if err := rows.Scan(&e.ID, &e.RuleID, &e.RuleName, &e.Metric, &e.Value, &e.Severity, &e.State, &e.FiredAt, &e.ResolvedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ── Notification Channels ─────────────────────────────────────────────────────

type NotificationChannel struct {
	ID        string
	Name      string
	Type      string
	Config    string
	Enabled   bool
	CreatedAt time.Time
}

func (d *DB) CreateNotificationChannel(c *NotificationChannel) error {
	_, err := d.Exec(`INSERT INTO notification_channels (id,name,type,config,enabled) VALUES (?,?,?,?,?)`,
		c.ID, c.Name, c.Type, c.Config, c.Enabled)
	return err
}

func (d *DB) ListNotificationChannels() ([]NotificationChannel, error) {
	rows, err := d.Query(`SELECT id,name,type,config,enabled,created_at FROM notification_channels ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []NotificationChannel{}
	for rows.Next() {
		var c NotificationChannel
		var enabled int
		if err := rows.Scan(&c.ID, &c.Name, &c.Type, &c.Config, &enabled, &c.CreatedAt); err != nil {
			return nil, err
		}
		c.Enabled = enabled == 1
		out = append(out, c)
	}
	return out, rows.Err()
}

func (d *DB) DeleteNotificationChannel(id string) error {
	_, err := d.Exec(`DELETE FROM notification_channels WHERE id=?`, id)
	return err
}

// ── Audit Log ─────────────────────────────────────────────────────────────────

func (d *DB) InsertAuditLog(actor, action, resource, ip string, status int) {
	if _, err := d.Exec(`INSERT INTO audit_log (actor,action,resource,ip,status) VALUES (?,?,?,?,?)`,
		actor, action, resource, ip, status); err != nil {
		log.Printf("[db] audit log write failed (%s %s): %v", actor, action, err)
	}
}

// ── Users (auth) ──────────────────────────────────────────────────────────────

type User struct {
	ID           int64
	Username     string
	PasswordHash string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// GetUser returns the single admin user, or nil if none exists (auth disabled).
func (d *DB) GetUser() (*User, error) {
	row := d.QueryRow(`SELECT id, username, password_hash, created_at, updated_at FROM users LIMIT 1`)
	var u User
	if err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.CreatedAt, &u.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &u, nil
}

// UpsertUser creates or replaces the single admin user (id=1).
func (d *DB) UpsertUser(username, passwordHash string) error {
	_, err := d.Exec(`
INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  username=excluded.username,
  password_hash=excluded.password_hash,
  updated_at=CURRENT_TIMESTAMP`,
		username, passwordHash)
	return err
}

// DeleteUser removes the admin user, disabling login protection.
func (d *DB) DeleteUser() error {
	_, err := d.Exec(`DELETE FROM users`)
	return err
}

// ── Domains ───────────────────────────────────────────────────────────────────

type Domain struct {
	ID            string
	Host          string
	IsPrimary     bool
	LastPointed   *bool // nil = never checked
	LastProxied   bool
	LastRecords   string // JSON array of IPs
	LastMessage   string
	LastError     string
	LastCheckedAt *time.Time
	CreatedAt     time.Time
}

// UpsertDomain inserts the host if absent and returns its row id (existing or new).
func (d *DB) UpsertDomain(host string) (string, error) {
	id := NewID("dom")
	if _, err := d.Exec(`INSERT INTO domains (id, host) VALUES (?, ?) ON CONFLICT(host) DO NOTHING`, id, host); err != nil {
		return "", err
	}
	var got string
	if err := d.QueryRow(`SELECT id FROM domains WHERE host=?`, host).Scan(&got); err != nil {
		return "", err
	}
	return got, nil
}

func (d *DB) ListDomains() ([]Domain, error) {
	rows, err := d.Query(`SELECT id, host, is_primary, last_pointed, last_proxied, last_records, last_message, last_error, last_checked_at, created_at FROM domains ORDER BY is_primary DESC, created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Domain{}
	for rows.Next() {
		var dm Domain
		var isPrimary, lastProxied int
		var lastPointed sql.NullInt64
		var lastChecked sql.NullTime
		if err := rows.Scan(&dm.ID, &dm.Host, &isPrimary, &lastPointed, &lastProxied, &dm.LastRecords, &dm.LastMessage, &dm.LastError, &lastChecked, &dm.CreatedAt); err != nil {
			return nil, err
		}
		dm.IsPrimary = isPrimary == 1
		dm.LastProxied = lastProxied == 1
		if lastPointed.Valid {
			b := lastPointed.Int64 == 1
			dm.LastPointed = &b
		}
		if lastChecked.Valid {
			t := lastChecked.Time
			dm.LastCheckedAt = &t
		}
		out = append(out, dm)
	}
	return out, rows.Err()
}

// SetPrimaryDomain makes host the single primary domain.
func (d *DB) SetPrimaryDomain(host string) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE domains SET is_primary=0`); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE domains SET is_primary=1 WHERE host=?`, host); err != nil {
		return err
	}
	return tx.Commit()
}

// UpdateDomainCheck stores the latest DNS-check result for host.
func (d *DB) UpdateDomainCheck(host string, pointed, proxied bool, records []string, message, errStr string) error {
	recJSON, err := json.Marshal(records)
	if err != nil {
		return err
	}
	_, err = d.Exec(`UPDATE domains SET last_pointed=?, last_proxied=?, last_records=?, last_message=?, last_error=?, last_checked_at=CURRENT_TIMESTAMP WHERE host=?`,
		boolToInt(pointed), boolToInt(proxied), string(recJSON), message, errStr, host)
	return err
}

func (d *DB) DeleteDomain(host string) error {
	_, err := d.Exec(`DELETE FROM domains WHERE host=?`, host)
	return err
}

// ── GitHub App installations ───────────────────────────────────────────────────

// AppInstallation is a stored GitHub App installation record.
type AppInstallation struct {
	ID             int64  `json:"id"`
	InstallationID int64  `json:"installationId"`
	AccountLogin   string `json:"accountLogin"`
	AccountType    string `json:"accountType"`
	CreatedAt      string `json:"createdAt"`
}

func (d *DB) UpsertAppInstallation(installationID int64, login, typ string) error {
	_, err := d.Exec(`
INSERT INTO github_app_installations (installation_id, account_login, account_type)
VALUES (?, ?, ?)
ON CONFLICT(installation_id) DO UPDATE SET
    account_login = excluded.account_login,
    account_type  = excluded.account_type`,
		installationID, login, typ)
	return err
}

func (d *DB) ListAppInstallations() ([]AppInstallation, error) {
	rows, err := d.Query(`SELECT id, installation_id, account_login, account_type, created_at FROM github_app_installations ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AppInstallation{}
	for rows.Next() {
		var a AppInstallation
		if err := rows.Scan(&a.ID, &a.InstallationID, &a.AccountLogin, &a.AccountType, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (d *DB) DeleteAppInstallation(id int64) error {
	_, err := d.Exec(`DELETE FROM github_app_installations WHERE id=?`, id)
	return err
}

func (d *DB) DeleteAppInstallationByInstallID(installationID int64) error {
	_, err := d.Exec(`DELETE FROM github_app_installations WHERE installation_id=?`, installationID)
	return err
}

// PrimaryDomain returns the host of the primary domain, or "" if none.
func (d *DB) PrimaryDomain() (string, error) {
	var host string
	err := d.QueryRow(`SELECT host FROM domains WHERE is_primary=1 LIMIT 1`).Scan(&host)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return host, err
}

// ── Container Heartbeats ────────────────────────────────────────────────────────

// Heartbeat is one recorded up/down check for a container, identified by name.
type Heartbeat struct {
	ContainerName string    `json:"containerName"`
	Up            bool      `json:"up"`
	CheckedAt     time.Time `json:"checkedAt"`
}

// InsertHeartbeats records one row per container in a single transaction.
func (d *DB) InsertHeartbeats(beats []Heartbeat) error {
	if len(beats) == 0 {
		return nil
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(`INSERT INTO container_heartbeats (container_name, up) VALUES (?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, b := range beats {
		if _, err := stmt.Exec(b.ContainerName, b.Up); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ListHeartbeatsSince returns every recorded check at or after `since`, ordered
// by container name then time, for the caller to group per-container.
func (d *DB) ListHeartbeatsSince(since time.Time) ([]Heartbeat, error) {
	rows, err := d.Query(`SELECT container_name, up, checked_at FROM container_heartbeats WHERE checked_at >= ? ORDER BY container_name, checked_at`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Heartbeat{}
	for rows.Next() {
		var h Heartbeat
		var up int
		if err := rows.Scan(&h.ContainerName, &up, &h.CheckedAt); err != nil {
			return nil, err
		}
		h.Up = up == 1
		out = append(out, h)
	}
	return out, rows.Err()
}

// PruneHeartbeats deletes rows older than `before`, keeping the table bounded
// to the retention window.
func (d *DB) PruneHeartbeats(before time.Time) error {
	_, err := d.Exec(`DELETE FROM container_heartbeats WHERE checked_at < ?`, before)
	return err
}
