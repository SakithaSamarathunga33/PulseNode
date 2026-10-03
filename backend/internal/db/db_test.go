package db

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func newTestDB(t *testing.T) *DB {
	t.Helper()
	d, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return d
}

func TestUpsertDomainIdempotent(t *testing.T) {
	d := newTestDB(t)
	id1, err := d.UpsertDomain("example.com")
	if err != nil {
		t.Fatalf("upsert1: %v", err)
	}
	id2, err := d.UpsertDomain("example.com")
	if err != nil {
		t.Fatalf("upsert2: %v", err)
	}
	if id1 != id2 {
		t.Fatalf("expected same id on re-upsert, got %q then %q", id1, id2)
	}
	list, err := d.ListDomains()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 domain, got %d", len(list))
	}
	if list[0].LastPointed != nil {
		t.Fatalf("expected LastPointed nil before any check")
	}
}

func TestSetPrimaryDomainSingleWinner(t *testing.T) {
	d := newTestDB(t)
	_, _ = d.UpsertDomain("a.com")
	_, _ = d.UpsertDomain("b.com")
	if err := d.SetPrimaryDomain("a.com"); err != nil {
		t.Fatal(err)
	}
	if err := d.SetPrimaryDomain("b.com"); err != nil {
		t.Fatal(err)
	}
	primary, err := d.PrimaryDomain()
	if err != nil {
		t.Fatal(err)
	}
	if primary != "b.com" {
		t.Fatalf("expected primary b.com, got %q", primary)
	}
	list, _ := d.ListDomains()
	count := 0
	for _, dm := range list {
		if dm.IsPrimary {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected exactly 1 primary, got %d", count)
	}
}

func TestPrimaryDomainEmpty(t *testing.T) {
	d := newTestDB(t)
	primary, err := d.PrimaryDomain()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if primary != "" {
		t.Fatalf("expected empty primary on empty table, got %q", primary)
	}
}

func TestUpdateDomainCheckRoundTrip(t *testing.T) {
	d := newTestDB(t)
	_, _ = d.UpsertDomain("a.com")
	if err := d.UpdateDomainCheck("a.com", true, false, []string{"1.2.3.4"}, "ok", ""); err != nil {
		t.Fatal(err)
	}
	list, _ := d.ListDomains()
	if list[0].LastPointed == nil || !*list[0].LastPointed {
		t.Fatalf("expected LastPointed true")
	}
	if list[0].LastRecords != `["1.2.3.4"]` {
		t.Fatalf("expected records JSON, got %q", list[0].LastRecords)
	}
}

func TestSettingsRoundTrip(t *testing.T) {
	d := newTestDB(t)
	if v, err := d.GetSetting("missing"); err != nil || v != "" {
		t.Fatalf("GetSetting(missing) = %q, %v; want empty", v, err)
	}
	if err := d.SetSetting("k", "v1"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	if v, _ := d.GetSetting("k"); v != "v1" {
		t.Fatalf("GetSetting = %q, want v1", v)
	}
	// upsert overwrites
	if err := d.SetSetting("k", "v2"); err != nil {
		t.Fatalf("SetSetting upsert: %v", err)
	}
	if v, _ := d.GetSetting("k"); v != "v2" {
		t.Fatalf("GetSetting after upsert = %q, want v2", v)
	}
}

func TestDeploymentImageTagRoundTrip(t *testing.T) {
	d := newTestDB(t)
	if err := d.CreateProject(&Project{ID: "proj_1", Name: "app", RepoURL: "u", Branch: "main", Domain: "x", Status: "idle"}); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	// Created without an image tag → empty.
	dep := &Deployment{ID: "dep_1", ProjectID: "proj_1", Status: "queued", Trigger: "manual"}
	if err := d.CreateDeployment(dep); err != nil {
		t.Fatalf("CreateDeployment: %v", err)
	}
	got, _ := d.GetDeploymentByID("dep_1")
	if got == nil || got.ImageTag != "" {
		t.Fatalf("fresh deployment ImageTag = %q, want empty", got.ImageTag)
	}
	// After a build records its image.
	if err := d.UpdateDeploymentImage("dep_1", "pn-app:abc1234"); err != nil {
		t.Fatalf("UpdateDeploymentImage: %v", err)
	}
	got, _ = d.GetDeploymentByID("dep_1")
	if got.ImageTag != "pn-app:abc1234" {
		t.Fatalf("ImageTag = %q, want pn-app:abc1234", got.ImageTag)
	}
	// A rollback deployment carries the image tag from creation.
	rb := &Deployment{ID: "dep_2", ProjectID: "proj_1", Status: "queued", Trigger: "rollback", ImageTag: "pn-app:abc1234"}
	if err := d.CreateDeployment(rb); err != nil {
		t.Fatalf("CreateDeployment rollback: %v", err)
	}
	got, _ = d.GetDeploymentByID("dep_2")
	if got.ImageTag != "pn-app:abc1234" || got.Trigger != "rollback" {
		t.Fatalf("rollback deployment = %+v", got)
	}
}

func TestPragmasApplied(t *testing.T) {
	d := newTestDB(t)
	var mode string
	if err := d.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal_mode = %q, %v; want wal", mode, err)
	}
	var fk int
	if err := d.QueryRow(`PRAGMA foreign_keys`).Scan(&fk); err != nil || fk != 1 {
		t.Fatalf("foreign_keys = %d, %v; want 1", fk, err)
	}
	var busy int
	if err := d.QueryRow(`PRAGMA busy_timeout`).Scan(&busy); err != nil || busy != 5000 {
		t.Fatalf("busy_timeout = %d, %v; want 5000", busy, err)
	}
}

// Every list function must serialise to [] (never null) when empty, because the
// React client calls .length/.map on the result.
func TestEmptyListsMarshalAsArray(t *testing.T) {
	d := newTestDB(t)
	cases := map[string]func() (any, error){
		"projects":     func() (any, error) { return d.ListProjects() },
		"deployments":  func() (any, error) { return d.ListDeployments("x") },
		"queued":       func() (any, error) { return d.GetQueuedDeployments() },
		"logs":         func() (any, error) { return d.GetLogs("x") },
		"managed":      func() (any, error) { return d.ListManagedDatabases() },
		"connected":    func() (any, error) { return d.ListConnectedDatabases() },
		"alertRules":   func() (any, error) { return d.ListAlertRules() },
		"alertHistory": func() (any, error) { return d.ListAlertHistory(10) },
		"channels":     func() (any, error) { return d.ListNotificationChannels() },
		"domains":      func() (any, error) { return d.ListDomains() },
		"installs":     func() (any, error) { return d.ListAppInstallations() },
		"heartbeats":   func() (any, error) { return d.ListHeartbeatsSince(time.Now().Add(-time.Hour)) },
	}
	for name, fn := range cases {
		v, err := fn()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		b, _ := json.Marshal(v)
		if string(b) != "[]" {
			t.Errorf("%s marshals to %s, want []", name, b)
		}
	}
}

func TestClaimProjectForDeploy(t *testing.T) {
	d := newTestDB(t)
	p := &Project{ID: "p1", Name: "n", RepoURL: "https://github.com/a/b", Branch: "main", BuildMethod: "auto", Port: 3000, Domain: "a.example", Status: "running", EnvVars: "{}"}
	if err := d.CreateProject(p); err != nil {
		t.Fatal(err)
	}
	if err := d.UpdateProjectStatus("p1", "running", "cont1"); err != nil {
		t.Fatal(err)
	}
	prev, ok, err := d.ClaimProjectForDeploy("p1")
	if err != nil || !ok || prev != "running" {
		t.Fatalf("first claim: prev=%q ok=%v err=%v", prev, ok, err)
	}
	if _, ok, _ := d.ClaimProjectForDeploy("p1"); ok {
		t.Fatal("second claim must fail while building")
	}
	got, _ := d.GetProject("p1")
	if got.Status != "building" || got.ContainerID != "cont1" {
		t.Fatalf("claim must keep container_id: %+v", got)
	}
	if _, ok, _ := d.ClaimProjectForDeploy("missing"); ok {
		t.Fatal("claiming a missing project must not succeed")
	}
}

func TestResetStuckProjects(t *testing.T) {
	d := newTestDB(t)
	mk := func(id, status, cid string) {
		p := &Project{ID: id, Name: id, RepoURL: "https://github.com/a/b", Branch: "main", BuildMethod: "auto", Port: 3000, Domain: id + ".example", Status: status, EnvVars: "{}"}
		if err := d.CreateProject(p); err != nil {
			t.Fatal(err)
		}
		if cid != "" {
			_ = d.UpdateProjectStatus(id, status, cid)
		}
	}
	mk("live", "building", "c1")
	mk("dead", "building", "")
	mk("busy", "building", "c2")
	_ = d.CreateDeployment(&Deployment{ID: "d1", ProjectID: "busy", Status: "queued", Trigger: "manual"})
	n, err := d.ResetStuckProjects()
	if err != nil || n != 2 {
		t.Fatalf("reset = %d, %v; want 2", n, err)
	}
	for id, want := range map[string]string{"live": "running", "dead": "failed", "busy": "building"} {
		p, _ := d.GetProject(id)
		if p.Status != want {
			t.Errorf("%s status = %s, want %s", id, p.Status, want)
		}
	}
}

func TestLogWriterBatchesAndFlushesOnClose(t *testing.T) {
	d := newTestDB(t)
	w := d.NewLogWriter("dep1")
	for i := 0; i < 250; i++ { // crosses the 100-line threshold twice
		w.Add("stdout", fmt.Sprintf("line %d", i))
	}
	w.Close()
	logs, err := d.GetLogs("dep1")
	if err != nil || len(logs) != 250 {
		t.Fatalf("got %d lines, err %v; want 250", len(logs), err)
	}
	if logs[0]["line"] != "line 0" || logs[249]["line"] != "line 249" {
		t.Fatalf("order not preserved: %q … %q", logs[0]["line"], logs[249]["line"])
	}
	w.Close() // idempotent
}

func TestDeleteProjectRemovesDeploymentsAndLogs(t *testing.T) {
	d := newTestDB(t)
	p := &Project{ID: "p1", Name: "n", RepoURL: "https://github.com/a/b", Branch: "main", BuildMethod: "auto", Port: 3000, Domain: "a.example", Status: "idle", EnvVars: "{}"}
	_ = d.CreateProject(p)
	_ = d.CreateDeployment(&Deployment{ID: "d1", ProjectID: "p1", Status: "success", Trigger: "manual"})
	_ = d.AppendLog("d1", "stdout", "hi")
	if err := d.DeleteProject("p1"); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = d.QueryRow(`SELECT (SELECT COUNT(*) FROM deployments) + (SELECT COUNT(*) FROM deployment_logs) + (SELECT COUNT(*) FROM projects)`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d rows left after delete", n)
	}
}

func TestPruneOld(t *testing.T) {
	d := newTestDB(t)
	_, _ = d.Exec(`INSERT INTO deployment_logs (deployment_id, stream, line, ts) VALUES ('d','stdout','old', datetime('now','-40 days')), ('d','stdout','new', datetime('now'))`)
	_, _ = d.Exec(`INSERT INTO audit_log (action, created_at) VALUES ('old', datetime('now','-100 days')), ('new', datetime('now'))`)
	_, _ = d.Exec(`INSERT INTO alert_history (rule_id,rule_name,metric,value,severity,fired_at) VALUES ('r','r','cpu',1,'warning', datetime('now','-100 days')), ('r','r','cpu',1,'warning', datetime('now'))`)
	if err := d.PruneOld(30*24*time.Hour, 90*24*time.Hour, 90*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	for _, tbl := range []string{"deployment_logs", "audit_log", "alert_history"} {
		var n int
		_ = d.QueryRow(`SELECT COUNT(*) FROM ` + tbl).Scan(&n)
		if n != 1 {
			t.Errorf("%s has %d rows after prune, want 1", tbl, n)
		}
	}
}
