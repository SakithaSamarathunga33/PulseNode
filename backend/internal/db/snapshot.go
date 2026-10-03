package db

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

// SnapshotsKept is how many pre-update snapshots are retained.
const SnapshotsKept = 5

var snapshotNameRe = regexp.MustCompile(`^pulsenode-\d{8}T\d{6}Z\.db$`)

// SnapshotInfo describes one stored snapshot.
type SnapshotInfo struct {
	Name      string    `json:"name"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"createdAt"`
}

// ValidSnapshotName reports whether name is one of our snapshot file names
// (never a path), so it is safe to join onto the snapshots directory.
func ValidSnapshotName(name string) bool { return snapshotNameRe.MatchString(name) }

// SnapshotsDir is where snapshots live: next to the database, on the same volume.
func (d *DB) SnapshotsDir() string { return filepath.Join(filepath.Dir(d.path), "snapshots") }

// Snapshot writes a consistent copy of the live database (VACUUM INTO — safe
// while the app keeps running) into the snapshots directory, verifies it can be
// opened and passes SQLite's quick_check, then prunes old snapshots down to
// SnapshotsKept. It returns the new snapshot's path.
func (d *DB) Snapshot() (string, error) {
	return d.snapshotAs(fmt.Sprintf("pulsenode-%s.db", time.Now().UTC().Format("20060102T150405Z")), true)
}

func (d *DB) snapshotAs(name string, prune bool) (string, error) {
	dir := d.SnapshotsDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create snapshots dir: %w", err)
	}
	dest := filepath.Join(dir, name)
	if _, err := os.Stat(dest); err == nil {
		return "", fmt.Errorf("snapshot %s already exists", name)
	}
	if _, err := d.Exec("VACUUM INTO ?", dest); err != nil {
		_ = os.Remove(dest)
		return "", fmt.Errorf("snapshot database: %w", err)
	}
	if err := VerifySnapshotFile(dest); err != nil {
		_ = os.Remove(dest)
		return "", err
	}
	if prune {
		PruneSnapshots(dir, SnapshotsKept)
	}
	return dest, nil
}

// VerifySnapshotFile opens the file read-only and runs PRAGMA quick_check.
func VerifySnapshotFile(path string) error {
	raw, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return fmt.Errorf("open snapshot: %w", err)
	}
	defer raw.Close()
	var res string
	if err := raw.QueryRow("PRAGMA quick_check").Scan(&res); err != nil {
		return fmt.Errorf("check snapshot: %w", err)
	}
	if res != "ok" {
		return fmt.Errorf("snapshot failed integrity check: %s", res)
	}
	return nil
}

// snapshotsToPrune returns the names to delete so only the newest keep remain.
// Names embed a UTC timestamp, so lexical order is chronological. Pure.
func snapshotsToPrune(names []string, keep int) []string {
	var snaps []string
	for _, n := range names {
		if ValidSnapshotName(n) {
			snaps = append(snaps, n)
		}
	}
	sort.Strings(snaps)
	if len(snaps) <= keep {
		return nil
	}
	return snaps[:len(snaps)-keep]
}

// PruneSnapshots deletes all but the newest keep snapshots in dir.
func PruneSnapshots(dir string, keep int) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	for _, n := range snapshotsToPrune(names, keep) {
		_ = os.Remove(filepath.Join(dir, n))
	}
}

// ListSnapshots returns the stored snapshots, newest first (never nil).
func (d *DB) ListSnapshots() []SnapshotInfo {
	out := []SnapshotInfo{}
	entries, err := os.ReadDir(d.SnapshotsDir())
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !ValidSnapshotName(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		created := info.ModTime()
		if t, err := time.Parse("20060102T150405Z", e.Name()[len("pulsenode-"):len(e.Name())-len(".db")]); err == nil {
			created = t
		}
		out = append(out, SnapshotInfo{Name: e.Name(), Size: info.Size(), CreatedAt: created})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name > out[j].Name })
	return out
}

func pendingRestorePath(dbPath string) string {
	return filepath.Join(filepath.Dir(dbPath), "restore-pending.db")
}

// StageRestore prepares a restore of the named snapshot. The live database
// cannot be swapped under an open connection, so this: verifies the snapshot,
// takes a safety snapshot of the CURRENT database (so the restore is itself
// reversible), and copies the snapshot to restore-pending.db. The swap happens
// at the next start (applyPendingRestore in Open); the caller restarts go-api.
func (d *DB) StageRestore(name string) error {
	if !ValidSnapshotName(name) {
		return fmt.Errorf("invalid snapshot name")
	}
	src := filepath.Join(d.SnapshotsDir(), name)
	if err := VerifySnapshotFile(src); err != nil {
		return err
	}
	if _, err := d.snapshotAs(fmt.Sprintf("pulsenode-%s.db", time.Now().UTC().Add(time.Second).Format("20060102T150405Z")), false); err != nil {
		return fmt.Errorf("could not snapshot the current database first: %w", err)
	}
	tmp := pendingRestorePath(d.path) + ".tmp"
	if err := copyFile(src, tmp); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, pendingRestorePath(d.path))
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// applyPendingRestore swaps a staged restore into place before the database is
// opened. The previous live files (db, -wal, -shm) are MOVED, never deleted, into
// snapshots/pre-restore-<ts>/. A bad staged file is discarded and the live
// database is opened as normal, so a failed restore can never brick startup.
func applyPendingRestore(dbPath string) {
	pending := pendingRestorePath(dbPath)
	if _, err := os.Stat(pending); err != nil {
		return
	}
	if err := VerifySnapshotFile(pending); err != nil {
		log.Printf("[restore] staged snapshot rejected, keeping the live database: %v", err)
		_ = os.Remove(pending)
		return
	}
	keep := filepath.Join(filepath.Dir(dbPath), "snapshots", "pre-restore-"+time.Now().UTC().Format("20060102T150405Z"))
	if err := os.MkdirAll(keep, 0o700); err != nil {
		log.Printf("[restore] cannot create %s, keeping the live database: %v", keep, err)
		_ = os.Remove(pending)
		return
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Rename(dbPath+suffix, filepath.Join(keep, filepath.Base(dbPath)+suffix)); err != nil && !os.IsNotExist(err) {
			log.Printf("[restore] could not move %s aside: %v", dbPath+suffix, err)
		}
	}
	if err := os.Rename(pending, dbPath); err != nil {
		log.Printf("[restore] could not put the snapshot in place: %v — the previous database is in %s", err, keep)
		return
	}
	log.Printf("[restore] database restored from snapshot; previous files kept in %s", keep)
}

// SchemaFingerprint hashes the table/index definitions. The update records it
// before the swap so the UI can say whether the new version changed the schema
// (relevant when deciding whether restoring a snapshot is safe).
func (d *DB) SchemaFingerprint() string {
	rows, err := d.Query("SELECT type, name, COALESCE(sql,'') FROM sqlite_master ORDER BY type, name")
	if err != nil {
		return ""
	}
	defer rows.Close()
	h := sha256.New()
	for rows.Next() {
		var t, n, s string
		if rows.Scan(&t, &n, &s) == nil {
			fmt.Fprintf(h, "%s|%s|%s\n", t, n, s)
		}
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}
