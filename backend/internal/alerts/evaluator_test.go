package alerts

import (
	"context"
	"sync"
	"testing"
	"time"

	"pulsenode/backend/internal/db"
)

// memStore is an in-memory Store with a controllable clock.
type memStore struct {
	mu       sync.Mutex
	now      *time.Time
	rules    []db.AlertRuleFull
	events   []db.AlertEventFull
	channels []db.NotificationChannel
	settings map[string]string
	failed   []db.FailedDeployment
	nextID   int64
}

func (s *memStore) ListAlertRulesFull() ([]db.AlertRuleFull, error) { return s.rules, nil }
func (s *memStore) LatestAlertEvent(ruleID, target string) (*db.AlertEventFull, error) {
	for i := len(s.events) - 1; i >= 0; i-- {
		if s.events[i].RuleID == ruleID && s.events[i].Target == target {
			e := s.events[i]
			return &e, nil
		}
	}
	return nil, nil
}
func (s *memStore) InsertAlertEventFull(e *db.AlertEventFull) (int64, error) {
	s.nextID++
	c := *e
	c.ID, c.FiredAt = s.nextID, *s.now
	s.events = append(s.events, c)
	return c.ID, nil
}
func (s *memStore) GetAlertEventFull(id int64) (*db.AlertEventFull, error) {
	for _, e := range s.events {
		if e.ID == id {
			c := e
			return &c, nil
		}
	}
	return nil, nil
}
func (s *memStore) SetAlertEventState(id int64, state string) (*db.AlertEventFull, error) {
	for i := range s.events {
		if s.events[i].ID == id {
			s.events[i].State = state
			t := *s.now
			if state == "resolved" {
				s.events[i].ResolvedAt = &t
			}
			c := s.events[i]
			return &c, nil
		}
	}
	return nil, nil
}
func (s *memStore) OpenAlertEvents(ruleID string) ([]db.AlertEventFull, error) {
	var out []db.AlertEventFull
	for _, e := range s.events {
		if e.RuleID == ruleID && e.State != "resolved" {
			out = append(out, e)
		}
	}
	return out, nil
}
func (s *memStore) ListNotificationChannels() ([]db.NotificationChannel, error) {
	return s.channels, nil
}
func (s *memStore) GetSetting(k string) (string, error)                        { return s.settings[k], nil }
func (s *memStore) RecentFailedDeployments(int) ([]db.FailedDeployment, error) { return s.failed, nil }
func (s *memStore) PruneAlertHistory(time.Time) error                          { return nil }

type bus struct{ kinds []string }

func (b *bus) Broadcast(kind string, _ any) { b.kinds = append(b.kinds, kind) }

type harness struct {
	t     *testing.T
	store *memStore
	ev    *Evaluator
	hub   *bus
	now   time.Time
	host  HostSample
	cts   []ContainerState
	mu    sync.Mutex
	sent  []Message
	to    []string
}

func newHarness(t *testing.T, rules ...db.AlertRuleFull) *harness {
	t.Helper()
	h := &harness{t: t, hub: &bus{}, now: time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)}
	h.store = &memStore{now: &h.now, rules: rules, settings: map[string]string{}}
	h.ev = New(Deps{
		Store: h.store, Hub: h.hub,
		Host:       func() (HostSample, bool) { return h.host, true },
		Containers: func(context.Context) ([]ContainerState, error) { return h.cts, nil },
		Now:        func() time.Time { return h.now },
		Send: func(_ context.Context, ch Channel, m Message) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.sent = append(h.sent, m)
			h.to = append(h.to, ch.ID)
			return nil
		},
	})
	return h
}

func (h *harness) tick(advance time.Duration) {
	h.now = h.now.Add(advance)
	h.ev.Tick(context.Background())
	h.ev.Wait()
}

func (h *harness) states() []string {
	var out []string
	for _, e := range h.store.events {
		out = append(out, e.State)
	}
	return out
}

func cpuRule(duration, cooldown int) db.AlertRuleFull {
	return db.AlertRuleFull{ID: "r1", Name: "High CPU", Metric: MetricCPU, Operator: ">", Threshold: 90,
		Duration: duration, Severity: "critical", Cooldown: cooldown, Enabled: true}
}

func channel(id string, enabled bool) db.NotificationChannel {
	return db.NotificationChannel{ID: id, Name: id, Type: TypeWebhook, Config: `{"url":"https://example.com/h"}`, Enabled: enabled}
}

func TestThresholdNeedsDurationThenFiresOnceAndResolves(t *testing.T) {
	h := newHarness(t, cpuRule(60, 0))
	h.store.channels = []db.NotificationChannel{channel("c1", true)}

	h.host.CPU = 95
	h.tick(0) // breach starts
	h.tick(30 * time.Second)
	if len(h.store.events) != 0 {
		t.Fatalf("must not fire before the duration elapsed: %v", h.states())
	}
	h.tick(31 * time.Second) // 61s of breach
	if got := h.states(); len(got) != 1 || got[0] != "firing" {
		t.Fatalf("want one firing event, got %v", got)
	}
	h.tick(15 * time.Second)
	h.tick(15 * time.Second)
	if len(h.store.events) != 1 {
		t.Fatalf("still breaching must dedupe, got %v", h.states())
	}
	if len(h.sent) != 1 || h.sent[0].State != "firing" {
		t.Fatalf("one firing notification expected, got %+v", h.sent)
	}

	h.host.CPU = 20
	h.tick(15 * time.Second)
	if got := h.store.events[0].State; got != "resolved" {
		t.Fatalf("auto-resolve expected, got %s", got)
	}
	if len(h.sent) != 2 || h.sent[1].State != "resolved" {
		t.Fatalf("resolved notification expected, got %+v", h.sent)
	}
	want := []string{"alert:new", "alert:update"}
	if len(h.hub.kinds) != 2 || h.hub.kinds[0] != want[0] || h.hub.kinds[1] != want[1] {
		t.Fatalf("broadcasts = %v, want %v", h.hub.kinds, want)
	}
}

func TestBriefSpikeShorterThanDurationNeverFires(t *testing.T) {
	h := newHarness(t, cpuRule(60, 0))
	h.host.CPU = 99
	h.tick(0)
	h.tick(20 * time.Second)
	h.host.CPU = 10 // spike ends, pending timer resets
	h.tick(15 * time.Second)
	h.host.CPU = 99
	h.tick(15 * time.Second)
	h.tick(40 * time.Second) // only 40s into the new breach
	if len(h.store.events) != 0 {
		t.Fatalf("spikes must not accumulate across gaps: %v", h.states())
	}
}

func TestCooldownBlocksRefireUntilElapsed(t *testing.T) {
	h := newHarness(t, cpuRule(0, 300))
	h.host.CPU = 95
	h.tick(0)
	h.host.CPU = 10
	h.tick(15 * time.Second) // resolves
	h.host.CPU = 95
	h.tick(15 * time.Second) // 15s after resolve: inside cooldown
	if len(h.store.events) != 1 {
		t.Fatalf("cooldown must suppress the refire: %v", h.states())
	}
	h.tick(301 * time.Second)
	if len(h.store.events) != 2 || h.store.events[1].State != "firing" {
		t.Fatalf("after cooldown it should fire again: %v", h.states())
	}
}

func TestDisabledRuleAndMissingSampleAreIgnored(t *testing.T) {
	r := cpuRule(0, 0)
	r.Enabled = false
	h := newHarness(t, r)
	h.host.CPU = 100
	h.tick(0)
	if len(h.store.events) != 0 {
		t.Fatal("disabled rule must not fire")
	}
	h.store.rules[0].Enabled = true
	h.ev.d.Host = func() (HostSample, bool) { return HostSample{CPU: 100}, false }
	h.tick(15 * time.Second)
	if len(h.store.events) != 0 {
		t.Fatal("no host sample yet must not fire")
	}
}

func TestOperatorsAndCompare(t *testing.T) {
	cases := []struct {
		v    float64
		op   string
		th   float64
		want bool
	}{
		{91, ">", 90, true}, {90, ">", 90, false}, {90, ">=", 90, true},
		{10, "<", 20, true}, {20, "<=", 20, true}, {21, "<=", 20, false}, {5, "?", 1, false},
	}
	for _, c := range cases {
		if got := Compare(c.v, c.op, c.th); got != c.want {
			t.Errorf("Compare(%v %s %v) = %v", c.v, c.op, c.th, got)
		}
	}
}

func TestMutedSuppressesNotificationsButRecordsEvent(t *testing.T) {
	h := newHarness(t, cpuRule(0, 0))
	h.store.channels = []db.NotificationChannel{channel("c1", true)}
	h.store.settings[SettingMutedUntil] = "4102444800" // year 2100
	h.host.CPU = 95
	h.tick(0)
	if len(h.store.events) != 1 {
		t.Fatalf("event must still be recorded while muted: %v", h.states())
	}
	if len(h.sent) != 0 {
		t.Fatalf("muted: nothing may be sent, got %+v", h.sent)
	}
}

func TestChannelRouting(t *testing.T) {
	r := cpuRule(0, 0)
	r.ChannelIDs = []string{"c2"}
	h := newHarness(t, r)
	h.store.channels = []db.NotificationChannel{channel("c1", true), channel("c2", true), channel("c3", false)}
	h.host.CPU = 95
	h.tick(0)
	if len(h.to) != 1 || h.to[0] != "c2" {
		t.Fatalf("only the rule's channel should receive it, got %v", h.to)
	}

	r2 := cpuRule(0, 0)
	r2.ID = "r2"
	h2 := newHarness(t, r2)
	h2.store.channels = []db.NotificationChannel{channel("c1", true), channel("c3", false)}
	h2.host.CPU = 95
	h2.tick(0)
	if len(h2.to) != 1 || h2.to[0] != "c1" {
		t.Fatalf("no explicit channels => all enabled ones, got %v", h2.to)
	}
}

func TestContainerDownFiresAndResolvesWhenBackOrRemoved(t *testing.T) {
	rule := db.AlertRuleFull{ID: "r2", Name: "Container down", Metric: MetricContainerDown, Operator: ">", Severity: "warning", Enabled: true}
	h := newHarness(t, rule)
	h.cts = []ContainerState{{Name: "web", State: "running"}, {Name: "db", State: "exited"}, {Name: "cache", State: "running"}}
	h.tick(0)
	if len(h.store.events) != 1 || h.store.events[0].Target != "db" {
		t.Fatalf("only the exited container should alert: %+v", h.store.events)
	}
	h.cts = []ContainerState{{Name: "web", State: "running"}, {Name: "db", State: "running"}}
	h.tick(15 * time.Second)
	if h.store.events[0].State != "resolved" {
		t.Fatalf("container back up should resolve: %v", h.states())
	}

	h.cts = []ContainerState{{Name: "web", State: "running"}, {Name: "db", State: "dead"}}
	h.tick(15 * time.Second)
	if len(h.store.events) != 2 {
		t.Fatalf("second incident expected: %v", h.states())
	}
	h.cts = []ContainerState{{Name: "web", State: "running"}} // db removed entirely
	h.tick(15 * time.Second)
	if h.store.events[1].State != "resolved" {
		t.Fatalf("removed container must auto-resolve: %v", h.states())
	}

	rule.Target = "web"
	h.store.rules[0] = rule
	h.cts = []ContainerState{{Name: "web", State: "exited"}, {Name: "db", State: "exited"}}
	h.tick(15 * time.Second)
	last := h.store.events[len(h.store.events)-1]
	if last.Target != "web" || len(h.store.events) != 3 {
		t.Fatalf("target filter should limit to web: %+v", h.store.events)
	}
}

func TestDeployFailedIgnoresHistoryThenFiresOncePerFailure(t *testing.T) {
	rule := db.AlertRuleFull{ID: "r3", Name: "Deploy failed", Metric: MetricDeployFailed, Operator: ">", Severity: "critical", Enabled: true}
	h := newHarness(t, rule)
	h.store.failed = []db.FailedDeployment{{ID: "old", Project: "shop", Reason: "boom"}}
	h.tick(0)
	if len(h.store.events) != 0 {
		t.Fatal("pre-existing failures must not alert after a restart")
	}
	h.store.failed = []db.FailedDeployment{{ID: "new", Project: "shop", Reason: "exit status 1"}, {ID: "old", Project: "shop"}}
	h.tick(15 * time.Second)
	h.tick(15 * time.Second)
	if len(h.store.events) != 1 || h.store.events[0].Target != "shop" {
		t.Fatalf("exactly one event for the new failure: %+v", h.store.events)
	}
	if got := h.store.events[0].Message; got != "A deployment of shop failed: exit status 1" {
		t.Fatalf("message = %q", got)
	}

	rule.Target = "blog"
	h.store.rules[0] = rule
	h.store.failed = append([]db.FailedDeployment{{ID: "new2", Project: "shop"}}, h.store.failed...)
	h.tick(15 * time.Second)
	if len(h.store.events) != 1 {
		t.Fatal("rule scoped to another project must not fire")
	}
}

func TestValidateRule(t *testing.T) {
	ok := db.AlertRuleFull{Name: "x", Metric: MetricCPU, Operator: ">", Threshold: 80, Severity: "warning"}
	if err := ValidateRule(&ok); err != nil {
		t.Fatalf("valid rule rejected: %v", err)
	}
	bad := []db.AlertRuleFull{
		{Name: "", Metric: MetricCPU, Operator: ">", Severity: "warning"},
		{Name: "x", Metric: "bogus", Operator: ">", Severity: "warning"},
		{Name: "x", Metric: MetricCPU, Operator: "==", Severity: "warning"},
		{Name: "x", Metric: MetricCPU, Operator: ">", Threshold: 140, Severity: "warning"},
		{Name: "x", Metric: MetricCPU, Operator: ">", Severity: "severe"},
		{Name: "x", Metric: MetricCPU, Operator: ">", Severity: "info", Duration: -1},
		{Name: "x", Metric: MetricContainerDown, Severity: "info", Target: "a\nb"},
	}
	for i, r := range bad {
		if err := ValidateRule(&r); err == nil {
			t.Errorf("case %d should be rejected", i)
		}
	}
	ev := db.AlertRuleFull{Name: "d", Metric: MetricDeployFailed, Operator: "<", Threshold: 5, Severity: "info"}
	if err := ValidateRule(&ev); err != nil || ev.Operator != ">" || ev.Threshold != 0 {
		t.Fatalf("event rules should drop operator/threshold: %v %+v", err, ev)
	}
}
