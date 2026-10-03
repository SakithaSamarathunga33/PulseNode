package db

import (
	"path/filepath"
	"testing"
)

func TestAlertEventLifecycle(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	rule := &AlertRuleFull{ID: "r1", Name: "CPU", Metric: "host.cpu", Operator: ">", Threshold: 90, Severity: "critical", ChannelIDs: []string{"c1"}, Cooldown: 60, Enabled: true}
	if err := d.CreateAlertRuleFull(rule); err != nil {
		t.Fatal(err)
	}
	got, err := d.GetAlertRuleFull("r1")
	if err != nil || got == nil || got.ChannelIDs[0] != "c1" || got.Cooldown != 60 {
		t.Fatalf("rule round trip: %+v %v", got, err)
	}
	if rs, _ := d.ListAlertRulesFull(); len(rs) != 1 {
		t.Fatalf("list rules: %v", rs)
	}
	if evs, _ := d.ListAlertEventsFull(10); evs == nil || len(evs) != 0 {
		t.Fatal("empty history must be a non-nil empty slice")
	}

	id, err := d.InsertAlertEventFull(&AlertEventFull{RuleID: "r1", RuleName: "CPU", Metric: "host.cpu", Value: 95, Severity: "critical", State: "firing", Target: "host", Message: "m"})
	if err != nil {
		t.Fatal(err)
	}
	if ev, _ := d.SetAlertEventState(id, "ack"); ev == nil || ev.State != "ack" || ev.AckedAt == nil {
		t.Fatalf("ack: %+v", ev)
	}
	if ev, _ := d.SetAlertEventState(id, "ack"); ev != nil {
		t.Fatal("acking an acked alert is a no-op")
	}
	if open, _ := d.OpenAlertEvents("r1"); len(open) != 1 {
		t.Fatalf("ack'd alert is still open: %v", open)
	}
	if ev, _ := d.SetAlertEventState(id, "resolved"); ev == nil || ev.ResolvedAt == nil {
		t.Fatalf("resolve: %+v", ev)
	}
	if ev, _ := d.SetAlertEventState(id, "ack"); ev != nil {
		t.Fatal("cannot ack a resolved alert")
	}
	if latest, _ := d.LatestAlertEvent("r1", "host"); latest == nil || latest.State != "resolved" {
		t.Fatalf("latest: %+v", latest)
	}
	d.InsertAlertEventFull(&AlertEventFull{RuleID: "r1", RuleName: "CPU", Metric: "host.cpu", Severity: "critical", State: "firing", Target: "host"})
	if n, _ := d.AckAllFiring(); n != 1 {
		t.Fatalf("ack all: %d", n)
	}
}
