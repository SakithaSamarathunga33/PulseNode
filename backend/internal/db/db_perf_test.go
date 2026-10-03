package db

import (
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func seedProject(t *testing.T, d *DB, id string) {
	t.Helper()
	p := &Project{ID: id, Name: id, RepoURL: "https://github.com/a/b", Branch: "main", BuildMethod: "auto", Port: 3000, Domain: id + ".example", Status: "running", EnvVars: "{}"}
	if err := d.CreateProject(p); err != nil {
		t.Fatal(err)
	}
}

// Without these indexes every "last log line" / count lookup is a table scan on
// the single DB connection and stalls the API.
func TestHotPathIndexesExist(t *testing.T) {
	d := newTestDB(t)
	defer d.Close()
	for _, idx := range []string{
		"idx_deployment_logs_dep", "idx_deployments_project", "idx_deployments_status",
		"idx_audit_log_created", "idx_alert_history_state",
	} {
		var name string
		if err := d.QueryRow(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`, idx).Scan(&name); err != nil {
			t.Errorf("index %s missing: %v", idx, err)
		}
	}
	// The failure-reason lookup must use the deployment_logs index.
	rows, err := d.Query(`EXPLAIN QUERY PLAN SELECT line FROM deployment_logs WHERE deployment_id='x' ORDER BY id DESC LIMIT 1`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	plan := ""
	for rows.Next() {
		var a, b, c int
		var detail string
		_ = rows.Scan(&a, &b, &c, &detail)
		plan += detail + "\n"
	}
	if !strings.Contains(plan, "idx_deployment_logs_dep") {
		t.Fatalf("last-line lookup does not use the index:\n%s", plan)
	}
}

// Opening a database twice (every restart) must be idempotent.
func TestMigrateIsIdempotentWithIndexes(t *testing.T) {
	d := newTestDB(t)
	defer d.Close()
	if err := d.migrate(); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
}

func TestRecentFailedDeploymentsOneQueryWithReason(t *testing.T) {
	d := newTestDB(t)
	defer d.Close()
	seedProject(t, d, "p1")
	for _, id := range []string{"d1", "d2", "d3"} {
		status := "failed"
		if id == "d2" {
			status = "success"
		}
		if err := d.CreateDeployment(&Deployment{ID: id, ProjectID: "p1", Status: status, Trigger: "manual"}); err != nil {
			t.Fatal(err)
		}
	}
	_ = d.AppendLog("d1", "system", "first")
	_ = d.AppendLog("d1", "system", "✕ boom d1")
	_ = d.AppendLog("d3", "system", "✕ boom d3")

	got, err := d.RecentFailedDeployments(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != "d3" || got[0].Reason != "✕ boom d3" || got[1].ID != "d1" || got[1].Reason != "✕ boom d1" || got[0].Project != "p1" {
		t.Fatalf("failed deployments = %+v", got)
	}
	if got, _ := d.RecentFailedDeployments(1); len(got) != 1 || got[0].ID != "d3" {
		t.Fatalf("limit not applied: %+v", got)
	}
	// No logs at all → empty reason, still returned.
	_ = d.CreateDeployment(&Deployment{ID: "d4", ProjectID: "p1", Status: "failed", Trigger: "manual"})
	got, _ = d.RecentFailedDeployments(1)
	if len(got) != 1 || got[0].ID != "d4" || got[0].Reason != "" {
		t.Fatalf("deployment without logs: %+v", got)
	}
}

func TestCountFiringAlertsAndResolvedInsert(t *testing.T) {
	d := newTestDB(t)
	defer d.Close()
	if n, err := d.CountFiringAlerts(); err != nil || n != 0 {
		t.Fatalf("empty count = %d, %v", n, err)
	}
	fire := &AlertEventFull{RuleID: "r", RuleName: "R", Metric: "host.cpu", Severity: "critical", State: "firing", Target: "host"}
	id1, _ := d.InsertAlertEventFull(fire)
	_, _ = d.InsertAlertEventFull(fire)
	// An informational event is stored closed: it has resolved_at and is not counted.
	infoID, err := d.InsertAlertEventFull(&AlertEventFull{RuleID: "r2", RuleName: "D", Metric: "deploy.failed", Severity: "info", State: "resolved", Target: "shop"})
	if err != nil {
		t.Fatal(err)
	}
	if ev, _ := d.GetAlertEventFull(infoID); ev == nil || ev.State != "resolved" || ev.ResolvedAt == nil {
		t.Fatalf("resolved insert must set resolved_at: %+v", ev)
	}
	if n, _ := d.CountFiringAlerts(); n != 2 {
		t.Fatalf("firing count = %d, want 2", n)
	}
	_, _ = d.SetAlertEventState(id1, "ack")
	if n, _ := d.CountFiringAlerts(); n != 1 {
		t.Fatalf("acked alerts are not firing: %d", n)
	}
}

func TestPruneOldKeepsOpenAlertsAndRejectsBadAges(t *testing.T) {
	d := newTestDB(t)
	defer d.Close()
	_, _ = d.Exec(`INSERT INTO alert_history (rule_id,rule_name,metric,value,severity,state,fired_at) VALUES
		('r','r','cpu',1,'warning','firing', datetime('now','-400 days')),
		('r','r','cpu',1,'warning','ack',    datetime('now','-400 days')),
		('r','r','cpu',1,'warning','resolved', datetime('now','-400 days'))`)
	if err := d.PruneOld(time.Hour, time.Hour, 24*time.Hour); err != nil {
		t.Fatal(err)
	}
	var open, resolved int
	_ = d.QueryRow(`SELECT COUNT(*) FROM alert_history WHERE state IN ('firing','ack')`).Scan(&open)
	_ = d.QueryRow(`SELECT COUNT(*) FROM alert_history WHERE state='resolved'`).Scan(&resolved)
	if open != 2 || resolved != 0 {
		t.Fatalf("open=%d resolved=%d: old firing/ack alerts must survive, resolved ones must go", open, resolved)
	}

	// Sub-day ages used to become "-0 days" and wipe every row.
	_, _ = d.Exec(`INSERT INTO deployment_logs (deployment_id, stream, line) VALUES ('d','stdout','fresh')`)
	if err := d.PruneOld(0, time.Hour, time.Hour); err == nil {
		t.Fatal("age <= 0 must be rejected")
	}
	if err := d.PruneOld(6*time.Hour, 6*time.Hour, 6*time.Hour); err != nil {
		t.Fatal(err)
	}
	var logs int
	_ = d.QueryRow(`SELECT COUNT(*) FROM deployment_logs`).Scan(&logs)
	if logs != 1 {
		t.Fatalf("a sub-day retention deleted fresh rows: %d left", logs)
	}
}

func TestCompleteDeploymentUpdatesProjectAndDeploymentTogether(t *testing.T) {
	d := newTestDB(t)
	defer d.Close()
	seedProject(t, d, "p1")
	_ = d.UpdateProjectStatus("p1", "building", "old")
	_ = d.CreateDeployment(&Deployment{ID: "d1", ProjectID: "p1", Status: "building", Trigger: "manual"})
	start := time.Now().Add(-time.Minute)
	if err := d.CompleteDeployment("d1", "p1", "new", "abc", start, time.Now()); err != nil {
		t.Fatal(err)
	}
	p, _ := d.GetProject("p1")
	dep, _ := d.GetDeploymentByID("d1")
	if p.Status != "running" || p.ContainerID != "new" || p.LastCommitSHA != "abc" || dep.Status != "success" {
		t.Fatalf("project %+v deployment %+v", p, dep)
	}
	// No commit SHA: the baseline must be left alone.
	if err := d.CompleteDeployment("d1", "p1", "newer", "", start, time.Now()); err != nil {
		t.Fatal(err)
	}
	if p, _ := d.GetProject("p1"); p.LastCommitSHA != "abc" || p.ContainerID != "newer" {
		t.Fatalf("baseline commit clobbered: %+v", p)
	}
}

func TestClaimProjectForDeployIsExclusive(t *testing.T) {
	d := newTestDB(t)
	defer d.Close()
	seedProject(t, d, "p1")
	var wg sync.WaitGroup
	var mu sync.Mutex
	claims := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, ok, err := d.ClaimProjectForDeploy("p1"); err == nil && ok {
				mu.Lock()
				claims++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if claims != 1 {
		t.Fatalf("%d concurrent claims succeeded, want exactly 1", claims)
	}
	if _, ok, _ := d.ClaimProjectForDeploy("missing"); ok {
		t.Fatal("unknown project must not be claimable")
	}
}

// Lines must land in order, none lost, even when many goroutines Add while the
// ticker and size-based flushes run.
func TestLogWriterKeepsOrderAndLosesNothing(t *testing.T) {
	d := newTestDB(t)
	defer d.Close()
	w := d.NewLogWriter("dep")
	const n = 1000
	for i := 0; i < n; i++ {
		w.Add("stdout", strings.Repeat("x", i%7)+"|"+strconv.Itoa(i))
	}
	w.Close()
	logs, err := d.GetLogs("dep")
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != n {
		t.Fatalf("got %d lines, want %d", len(logs), n)
	}
	for i, l := range logs {
		if !strings.HasSuffix(l["line"], "|"+strconv.Itoa(i)) {
			t.Fatalf("line %d out of order: %q", i, l["line"])
		}
	}
}

// A failed insert keeps the batch (in order, ahead of newer lines) for retry.
func TestLogWriterRetriesAfterInsertFailure(t *testing.T) {
	d := newTestDB(t)
	w := &LogWriter{d: d, dep: "dep", stop: make(chan struct{}), done: make(chan struct{})}
	close(w.done) // no background loop in this test

	w.Add("stdout", "a")
	w.Add("stdout", "b")
	_, _ = d.Exec(`ALTER TABLE deployment_logs RENAME TO deployment_logs_off`) // make the insert fail
	w.Flush()
	if len(w.buf) != 2 {
		t.Fatalf("failed batch must be kept for retry, have %d", len(w.buf))
	}
	w.Add("stdout", "c")
	_, _ = d.Exec(`ALTER TABLE deployment_logs_off RENAME TO deployment_logs`)
	w.Flush()
	logs, _ := d.GetLogs("dep")
	if len(logs) != 3 || logs[0]["line"] != "a" || logs[1]["line"] != "b" || logs[2]["line"] != "c" {
		t.Fatalf("retry lost or reordered lines: %v", logs)
	}
	d.Close()
}
