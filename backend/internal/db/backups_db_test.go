package db

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBackupScheduleRoundTrip(t *testing.T) {
	d := newTestDB(t)
	defer d.Close()
	next := time.Now().Add(time.Hour).Truncate(time.Millisecond)
	s := &BackupSchedule{ID: "s1", Name: "nightly", Target: "panel", Frequency: "daily", Hour: 3, Retention: 7, Enabled: true, NextRunAt: &next}
	if err := d.SaveBackupSchedule(s); err != nil {
		t.Fatal(err)
	}
	got, err := d.GetBackupSchedule("s1")
	if err != nil || got == nil {
		t.Fatalf("get: %v %v", got, err)
	}
	if got.DestinationIDs == nil || len(got.DestinationIDs) != 0 {
		t.Fatalf("destination ids must be an empty slice, got %#v", got.DestinationIDs)
	}
	if got.NextRunAt == nil || !got.NextRunAt.Equal(next) || got.LastRunAt != nil {
		t.Fatalf("times: next=%v last=%v", got.NextRunAt, got.LastRunAt)
	}
	// A run records its outcome; a later edit must not wipe it.
	last := time.Now().Truncate(time.Millisecond)
	if err := d.RecordBackupRun("s1", last, "success", &next); err != nil {
		t.Fatal(err)
	}
	s.Name, s.DestinationIDs = "renamed", []string{"a", "b"}
	if err := d.SaveBackupSchedule(s); err != nil {
		t.Fatal(err)
	}
	got, _ = d.GetBackupSchedule("s1")
	if got.Name != "renamed" || len(got.DestinationIDs) != 2 || got.LastStatus != "success" || got.LastRunAt == nil || !got.LastRunAt.Equal(last) {
		t.Fatalf("after edit: %+v", got)
	}
	if missing, err := d.GetBackupSchedule("nope"); err != nil || missing != nil {
		t.Fatalf("missing schedule: %v %v", missing, err)
	}
	list, _ := d.ListBackupSchedules()
	if len(list) != 1 {
		t.Fatalf("list: %d", len(list))
	}
	if err := d.DeleteBackupSchedule("s1"); err != nil {
		t.Fatal(err)
	}
	if list, _ := d.ListBackupSchedules(); list == nil || len(list) != 0 {
		t.Fatalf("empty list must be non-nil: %#v", list)
	}
}

func TestBackupHistoryRoundTripAndQueries(t *testing.T) {
	d := newTestDB(t)
	defer d.Close()
	now := time.Now().Truncate(time.Millisecond)
	mk := func(id, sched, status string, age time.Duration, files []BackupFileResult) *BackupHistory {
		return &BackupHistory{ID: id, ScheduleID: sched, ScheduleName: sched, Target: "panel", StartedAt: now.Add(-age), Status: status, Files: files}
	}
	for _, h := range []*BackupHistory{
		mk("h1", "a", "success", 3*time.Hour, []BackupFileResult{{DestinationID: "d", DestinationName: "disk", Name: "a/x", OK: true}}),
		mk("h2", "a", "failed", 2*time.Hour, nil),
		mk("h3", "b", "failed", 30*time.Hour, nil),
		mk("h4", "b", "running", time.Hour, nil),
	} {
		if err := d.InsertBackupHistory(h); err != nil {
			t.Fatal(err)
		}
	}
	all, _ := d.ListBackupHistory(10, "")
	if len(all) != 4 || all[0].ID != "h4" || all[3].ID != "h3" {
		t.Fatalf("order (newest first): %+v", all)
	}
	if all[1].Files == nil || len(all[1].Files) != 0 {
		t.Fatalf("files must be an empty slice, got %#v", all[1].Files)
	}
	if onlyA, _ := d.ListBackupHistory(10, "a"); len(onlyA) != 2 {
		t.Fatalf("filter: %d", len(onlyA))
	}
	if lim, _ := d.ListBackupHistory(1, ""); len(lim) != 1 {
		t.Fatalf("limit: %d", len(lim))
	}
	h1, _ := d.GetBackupHistory("h1")
	if len(h1.Files) != 1 || !h1.Files[0].OK || h1.Files[0].DestinationName != "disk" {
		t.Fatalf("files roundtrip: %+v", h1.Files)
	}
	// A restart turns "running" rows into failures.
	n, err := d.FailStaleBackupRuns()
	if err != nil || n != 1 {
		t.Fatalf("stale: %d %v", n, err)
	}
	if h4, _ := d.GetBackupHistory("h4"); h4.Status != "failed" || h4.FinishedAt == nil || h4.Error == "" {
		t.Fatalf("h4: %+v", h4)
	}
	if c, _ := d.CountFailedBackupsSince(now.Add(-24 * time.Hour)); c != 2 {
		t.Fatalf("failed in 24h = %d, want 2 (h2, h4)", c)
	}
	// Update, then remove.
	fin := now
	h1.Status, h1.FinishedAt, h1.SizeBytes = "success", &fin, 1234
	if err := d.UpdateBackupHistory(h1); err != nil {
		t.Fatal(err)
	}
	if got, _ := d.GetBackupHistory("h1"); got.SizeBytes != 1234 || got.FinishedAt == nil {
		t.Fatalf("update: %+v", got)
	}
	if err := d.DeleteBackupHistory("h1"); err != nil {
		t.Fatal(err)
	}
	if got, _ := d.GetBackupHistory("h1"); got != nil {
		t.Fatal("row still present")
	}
}

func TestSnapshotToLeavesUpdateSnapshotsAlone(t *testing.T) {
	d := newTestDB(t)
	defer d.Close()
	if err := d.SetSetting("marker", "before-snapshot"); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "copy.db")
	if err := d.SnapshotTo(dest); err != nil {
		t.Fatal(err)
	}
	if err := VerifySnapshotFile(dest); err != nil {
		t.Fatal(err)
	}
	if ents, _ := os.ReadDir(d.SnapshotsDir()); len(ents) != 0 {
		t.Fatalf("SnapshotTo touched the update snapshots dir: %v", ents)
	}
	if err := d.SnapshotTo(dest); err == nil {
		t.Fatal("an existing target must not be overwritten")
	}
	// The copy holds the data as of the snapshot, not later writes.
	_ = d.SetSetting("marker", "after-snapshot")
	b, _ := os.ReadFile(dest)
	if !bytes.Contains(b, []byte("before-snapshot")) || bytes.Contains(b, []byte("after-snapshot")) {
		t.Fatal("snapshot content is not a point-in-time copy")
	}
}

func TestBackupEncryptionKey(t *testing.T) {
	t.Setenv("AES_KEY", "0123456789abcdef0123456789abcdef")
	k1, err := BackupEncryptionKey()
	if err != nil || len(k1) != 32 {
		t.Fatalf("key: %d %v", len(k1), err)
	}
	if k2, _ := BackupEncryptionKey(); !bytes.Equal(k1, k2) {
		t.Fatal("key is not deterministic")
	}
	if bytes.Equal(k1, []byte("0123456789abcdef0123456789abcdef")) {
		t.Fatal("backup key must be derived, not the raw AES key")
	}
	t.Setenv("AES_KEY", "ffffffffffffffffffffffffffffffff")
	if k3, _ := BackupEncryptionKey(); bytes.Equal(k1, k3) {
		t.Fatal("different AES keys must give different backup keys")
	}
	t.Setenv("AES_KEY", "")
	t.Setenv("MASTER_ENCRYPTION_KEY", "")
	if _, err := BackupEncryptionKey(); err == nil {
		t.Fatal("no key must be an error")
	}
}

func TestBackupPassphraseStoredEncrypted(t *testing.T) {
	d := newTestDB(t)
	defer d.Close()
	if p, err := d.BackupPassphrase(); err != nil || p != "" {
		t.Fatalf("unset: %q %v", p, err)
	}
	if err := d.SetBackupPassphrase("  spaces are kept  "); err != nil {
		t.Fatal(err)
	}
	raw, _ := d.GetSetting(BackupSettingPassphrase)
	if raw == "" || bytes.Contains([]byte(raw), []byte("spaces")) {
		t.Fatalf("stored in plaintext: %q", raw)
	}
	if p, _ := d.BackupPassphrase(); p != "  spaces are kept  " {
		t.Fatalf("passphrase must round-trip exactly, got %q", p)
	}
}
