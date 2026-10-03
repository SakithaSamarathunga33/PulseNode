package alerts

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"pulsenode/backend/internal/db"
)

// countingStore adds CountFiringAlerts to the in-memory store, like *db.DB.
type countingStore struct{ *memStore }

func (s countingStore) CountFiringAlerts() (int, error) {
	n := 0
	for _, e := range s.events {
		if e.State == "firing" {
			n++
		}
	}
	return n, nil
}

type dataBus struct {
	mu     sync.Mutex
	counts []int
}

func (b *dataBus) Broadcast(kind string, data any) {
	if kind != "alert:count" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.counts = append(b.counts, data.(int))
}

func containerRule() db.AlertRuleFull {
	return db.AlertRuleFull{ID: "r2", Name: "Container down", Metric: MetricContainerDown, Operator: ">", Severity: "warning", Enabled: true}
}

// Finished jobs are not outages: exit code 0 and compose one-offs stay quiet,
// an abnormal exit alerts.
func TestExitedContainersOnlyAlertWhenAbnormal(t *testing.T) {
	h := newHarness(t, containerRule())
	h.cts = []ContainerState{
		{Name: "migrate", State: "exited", CleanExit: true},
		{Name: "run-once", State: "exited", OneOff: true},
		{Name: "crashed", State: "exited"},
		{Name: "looping", State: "restarting"},
	}
	h.tick(0)
	got := map[string]bool{}
	for _, e := range h.store.events {
		got[e.Target] = true
	}
	if len(got) != 2 || !got["crashed"] || !got["looping"] {
		t.Fatalf("only crashed + looping should alert, got %v", got)
	}
}

// deploy.failed is a one-shot fact: it notifies and shows in history but is
// stored already resolved, so it never inflates the open-alert count.
func TestDeployFailedEventsAreStoredResolvedAndDoNotCount(t *testing.T) {
	rule := db.AlertRuleFull{ID: "r3", Name: "Deploy failed", Metric: MetricDeployFailed, Operator: ">", Severity: "critical", Enabled: true}
	h := newHarness(t, rule)
	bus := &dataBus{}
	h.ev.d.Hub = bus
	h.ev.d.Store = countingStore{h.store}
	h.store.channels = []db.NotificationChannel{channel("c1", true)}

	h.tick(0) // prime
	h.store.failed = []db.FailedDeployment{{ID: "f1", Project: "shop", Reason: "boom"}}
	h.tick(15 * time.Second)

	if len(h.store.events) != 1 || h.store.events[0].State != "resolved" {
		t.Fatalf("event must be stored resolved: %v", h.states())
	}
	if len(h.sent) != 1 || h.sent[0].State != "firing" {
		t.Fatalf("it must still notify as an alert: %+v", h.sent)
	}
	if len(bus.counts) != 0 {
		t.Fatalf("informational events must not move the firing count: %v", bus.counts)
	}
}

// The firing count is broadcast (from the store, not invented) when alerts open
// and resolve.
func TestAlertCountBroadcastOnFireAndResolve(t *testing.T) {
	h := newHarness(t, cpuRule(0, 0))
	bus := &dataBus{}
	h.ev.d.Hub = bus
	h.ev.d.Store = countingStore{h.store}

	h.host.CPU = 95
	h.tick(0)
	h.host.CPU = 10
	h.tick(15 * time.Second)

	if fmt.Sprint(bus.counts) != "[1 0]" {
		t.Fatalf("alert:count broadcasts = %v, want [1 0]", bus.counts)
	}
}

// A breach timer for something that vanished (container removed, rule disabled)
// must not linger, or the target would fire instantly when it returns.
func TestPendingTimersPrunedWhenTargetDisappears(t *testing.T) {
	rule := containerRule()
	rule.Duration = 60
	h := newHarness(t, rule)
	h.cts = []ContainerState{{Name: "db", State: "exited"}}
	h.tick(0)
	if len(h.ev.pending) != 1 {
		t.Fatalf("breach timer expected, have %d", len(h.ev.pending))
	}
	h.cts = nil // container gone before the duration elapsed
	h.tick(15 * time.Second)
	if len(h.ev.pending) != 0 {
		t.Fatalf("stale pending timers leaked: %v", h.ev.pending)
	}

	// Disabling the rule also drops its timers.
	h.cts = []ContainerState{{Name: "db", State: "exited"}}
	h.tick(15 * time.Second)
	h.store.rules[0].Enabled = false
	h.tick(15 * time.Second)
	if len(h.ev.pending) != 0 {
		t.Fatalf("timers of a disabled rule leaked: %v", h.ev.pending)
	}
}

// With no enabled deploy.failed rule the evaluator must not query deployments.
type countingFailedStore struct {
	*memStore
	calls int
}

func (s *countingFailedStore) RecentFailedDeployments(limit int) ([]db.FailedDeployment, error) {
	s.calls++
	return s.memStore.RecentFailedDeployments(limit)
}

func TestNoDeployQueriesWithoutDeployFailedRule(t *testing.T) {
	h := newHarness(t, cpuRule(0, 0))
	cs := &countingFailedStore{memStore: h.store}
	h.ev.d.Store = cs
	h.host.CPU = 1
	h.tick(0)
	h.tick(15 * time.Second)
	if cs.calls != 0 {
		t.Fatalf("RecentFailedDeployments called %d times with no deploy.failed rule", cs.calls)
	}
}

// A burst of failures larger than one page between ticks must still be seen.
type pagedStore struct {
	*memStore
	all []db.FailedDeployment // newest first
}

func (s *pagedStore) RecentFailedDeployments(limit int) ([]db.FailedDeployment, error) {
	if limit > len(s.all) {
		limit = len(s.all)
	}
	return append([]db.FailedDeployment(nil), s.all[:limit]...), nil
}

func TestBurstOfFailuresBeyondOnePageIsNotLost(t *testing.T) {
	rule := db.AlertRuleFull{ID: "r3", Name: "Deploy failed", Metric: MetricDeployFailed, Operator: ">", Severity: "info", Enabled: true}
	h := newHarness(t, rule)
	ps := &pagedStore{memStore: h.store, all: []db.FailedDeployment{{ID: "old", Project: "p"}}}
	h.ev.d.Store = ps
	h.tick(0) // prime on "old"

	all := []db.FailedDeployment{}
	for i := 120; i > 0; i-- { // 120 new failures, newest first
		all = append(all, db.FailedDeployment{ID: fmt.Sprintf("n%d", i), Project: "p"})
	}
	ps.all = append(all, db.FailedDeployment{ID: "old", Project: "p"})
	h.tick(15 * time.Second)
	if len(h.store.events) != 120 {
		t.Fatalf("recorded %d of 120 failures", len(h.store.events))
	}
}
