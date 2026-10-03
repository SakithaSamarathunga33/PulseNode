package db

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func openTestDB(t *testing.T) (*DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pulsenode.db")
	d, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d, path
}

func TestSnapshotCreatesValidOpenableCopy(t *testing.T) {
	d, _ := openTestDB(t)
	if err := d.SetSetting("marker", "before-snapshot"); err != nil {
		t.Fatal(err)
	}
	path, err := d.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifySnapshotFile(path); err != nil {
		t.Fatalf("snapshot should verify: %v", err)
	}
	// Writes after the snapshot must not appear in it.
	if err := d.SetSetting("marker", "after-snapshot"); err != nil {
		t.Fatal(err)
	}
	snap, err := Open(path)
	if err != nil {
		t.Fatalf("snapshot should open as a normal database: %v", err)
	}
	defer snap.Close()
	if v, _ := snap.GetSetting("marker"); v != "before-snapshot" {
		t.Fatalf("snapshot content = %q, want the value at snapshot time", v)
	}
	list := d.ListSnapshots()
	if len(list) != 1 || list[0].Name != filepath.Base(path) || list[0].Size == 0 {
		t.Fatalf("ListSnapshots = %+v", list)
	}
}

func TestSnapshotsPrunedToNewestFive(t *testing.T) {
	d, _ := openTestDB(t)
	dir := d.SnapshotsDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 8; i++ {
		name := fmt.Sprintf("pulsenode-%s.db", base.Add(time.Duration(i)*time.Hour).Format("20060102T150405Z"))
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// A real snapshot triggers pruning; it is the newest, so 4 old ones survive.
	if _, err := d.Snapshot(); err != nil {
		t.Fatal(err)
	}
	list := d.ListSnapshots()
	if len(list) != SnapshotsKept {
		t.Fatalf("kept %d snapshots, want %d: %+v", len(list), SnapshotsKept, list)
	}
	if list[len(list)-1].Name != "pulsenode-20260101T040000Z.db" {
		t.Fatalf("oldest kept = %s, want the 5th newest of the seeded set", list[len(list)-1].Name)
	}
}

func TestSnapshotsToPruneIgnoresForeignFiles(t *testing.T) {
	got := snapshotsToPrune([]string{"notes.txt", "pulsenode-20260101T000000Z.db", "pulsenode-20260102T000000Z.db", "prerestore-x.db"}, 1)
	if len(got) != 1 || got[0] != "pulsenode-20260101T000000Z.db" {
		t.Fatalf("snapshotsToPrune = %v", got)
	}
}

func TestSnapshotNameValidationRejectsTraversal(t *testing.T) {
	for _, bad := range []string{"../pulsenode.db", "pulsenode-20260101T000000Z.db/../x", "pulsenode.db", "", "pulsenode-2026.db"} {
		if ValidSnapshotName(bad) {
			t.Errorf("%q should be rejected", bad)
		}
	}
	if !ValidSnapshotName("pulsenode-20260101T000000Z.db") {
		t.Error("a real snapshot name should be accepted")
	}
}

func TestStageAndApplyRestoreSwapsDatabaseKeepingOldFiles(t *testing.T) {
	d, path := openTestDB(t)
	_ = d.SetSetting("marker", "old")
	snap, err := d.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	_ = d.SetSetting("marker", "newer")
	if err := d.StageRestore(filepath.Base(snap)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(pendingRestorePath(path)); err != nil {
		t.Fatalf("restore should be staged: %v", err)
	}
	_ = d.Close()

	d2, err := Open(path) // the restart: pending restore is applied before opening
	if err != nil {
		t.Fatal(err)
	}
	defer d2.Close()
	if v, _ := d2.GetSetting("marker"); v != "old" {
		t.Fatalf("marker after restore = %q, want old", v)
	}
	if _, err := os.Stat(pendingRestorePath(path)); !os.IsNotExist(err) {
		t.Fatal("pending file should be consumed")
	}
	moved, _ := filepath.Glob(filepath.Join(d2.SnapshotsDir(), "pre-restore-*", "pulsenode.db"))
	if len(moved) != 1 {
		t.Fatalf("previous database must be kept, found %v", moved)
	}
}

func TestBadStagedRestoreNeverBricksStartup(t *testing.T) {
	d, path := openTestDB(t)
	_ = d.SetSetting("marker", "live")
	_ = d.Close()
	if err := os.WriteFile(pendingRestorePath(path), []byte("not a database"), 0o600); err != nil {
		t.Fatal(err)
	}
	d2, err := Open(path)
	if err != nil {
		t.Fatalf("startup must survive a corrupt staged restore: %v", err)
	}
	defer d2.Close()
	if v, _ := d2.GetSetting("marker"); v != "live" {
		t.Fatalf("live data lost: %q", v)
	}
}

func TestStageRestoreRejectsUnknownSnapshot(t *testing.T) {
	d, _ := openTestDB(t)
	if err := d.StageRestore("../../etc/passwd"); err == nil {
		t.Fatal("path traversal must be rejected")
	}
	if err := d.StageRestore("pulsenode-20200101T000000Z.db"); err == nil {
		t.Fatal("a missing snapshot must be rejected")
	}
}

func TestSchemaFingerprintStableAndSensitive(t *testing.T) {
	d, _ := openTestDB(t)
	a, b := d.SchemaFingerprint(), d.SchemaFingerprint()
	if a == "" || a != b {
		t.Fatalf("fingerprint unstable: %q %q", a, b)
	}
	if _, err := d.Exec("CREATE TABLE zz_new (id INTEGER)"); err != nil {
		t.Fatal(err)
	}
	if d.SchemaFingerprint() == a {
		t.Fatal("fingerprint should change when the schema changes")
	}
}
