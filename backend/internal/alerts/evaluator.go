package alerts

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog/log"

	"pulsenode/backend/internal/db"
)

// Metrics a rule can watch.
const (
	MetricCPU           = "host.cpu"       // percent
	MetricMemory        = "host.memory"    // percent
	MetricDisk          = "host.disk"      // percent
	MetricContainerDown = "container.down" // event per container that is not running
	MetricDeployFailed  = "deploy.failed"  // event per failed deployment
)

// SettingMutedUntil holds a unix timestamp; while in the future, notifications are
// suppressed (events are still recorded).
const SettingMutedUntil = "alerts_muted_until"

const (
	defaultInterval = 15 * time.Second
	historyKeep     = 30 * 24 * time.Hour
	maxSeenDeploys  = 1000
)

// Store is the slice of *db.DB the evaluator needs.
type Store interface {
	ListAlertRulesFull() ([]db.AlertRuleFull, error)
	LatestAlertEvent(ruleID, target string) (*db.AlertEventFull, error)
	InsertAlertEventFull(e *db.AlertEventFull) (int64, error)
	GetAlertEventFull(id int64) (*db.AlertEventFull, error)
	SetAlertEventState(id int64, state string) (*db.AlertEventFull, error)
	OpenAlertEvents(ruleID string) ([]db.AlertEventFull, error)
	ListNotificationChannels() ([]db.NotificationChannel, error)
	GetSetting(key string) (string, error)
	RecentFailedDeployments(limit int) ([]db.FailedDeployment, error)
	PruneAlertHistory(before time.Time) error
}

var _ Store = (*db.DB)(nil)

type Broadcaster interface {
	Broadcast(kind string, data any)
}

// HostSample is the host's current usage, all in percent.
type HostSample struct{ CPU, Memory, Disk float64 }

// ContainerState is a container's name and Docker state ("running", "exited", …).
type ContainerState struct{ Name, State string }

// Deps wires the evaluator to the rest of the app.
type Deps struct {
	Store Store
	Hub   Broadcaster
	// Host returns the latest sample; ok=false while no sample exists yet.
	Host func() (HostSample, bool)
	// Containers lists containers; nil disables container.down rules.
	Containers func(ctx context.Context) ([]ContainerState, error)
	// Send delivers a message; defaults to DefaultSender.Send.
	Send     func(ctx context.Context, ch Channel, m Message) error
	Now      func() time.Time
	Interval time.Duration
}

type Evaluator struct {
	d  Deps
	mu sync.Mutex
	wg sync.WaitGroup // in-flight notifications

	pending     map[string]time.Time // rule|target -> breach start
	seenDeploys map[string]bool
	primed      bool
	lastPrune   time.Time
}

func New(d Deps) *Evaluator {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Send == nil {
		d.Send = DefaultSender.Send
	}
	if d.Interval <= 0 {
		d.Interval = defaultInterval
	}
	return &Evaluator{d: d, pending: map[string]time.Time{}, seenDeploys: map[string]bool{}}
}

// Start runs the evaluator until ctx is cancelled. Call it in its own goroutine.
func Start(ctx context.Context, d Deps) {
	e := New(d)
	t := time.NewTicker(e.d.Interval)
	defer t.Stop()
	for {
		e.Tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Wait blocks until in-flight notifications have finished (used by tests).
func (e *Evaluator) Wait() { e.wg.Wait() }

type observation struct {
	Target string
	Value  float64
	Breach bool
	Detail string
}

// Tick runs one evaluation pass over every enabled rule.
func (e *Evaluator) Tick(ctx context.Context) {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.d.Now()

	rules, err := e.d.Store.ListAlertRulesFull()
	if err != nil {
		log.Warn().Err(err).Msg("alerts: could not load rules")
		return
	}

	var host *HostSample
	if e.d.Host != nil {
		if h, ok := e.d.Host(); ok {
			host = &h
		}
	}
	var containers []ContainerState
	containersOK := false
	if e.d.Containers != nil {
		needs := false
		for _, r := range rules {
			if r.Enabled && r.Metric == MetricContainerDown {
				needs = true
			}
		}
		if needs {
			cs, err := e.d.Containers(ctx)
			if err != nil {
				log.Warn().Err(err).Msg("alerts: could not list containers")
			} else {
				containers, containersOK = cs, true
			}
		}
	}

	for _, r := range rules {
		if !r.Enabled {
			continue
		}
		switch r.Metric {
		case MetricCPU, MetricMemory, MetricDisk:
			if host == nil {
				continue
			}
			v := host.CPU
			if r.Metric == MetricMemory {
				v = host.Memory
			} else if r.Metric == MetricDisk {
				v = host.Disk
			}
			e.process(ctx, r, observation{Target: "host", Value: v, Breach: Compare(v, r.Operator, r.Threshold)}, now)
		case MetricContainerDown:
			if !containersOK {
				continue
			}
			seen := map[string]bool{}
			for _, c := range containers {
				if !TargetMatches(r.Target, c.Name) {
					continue
				}
				seen[c.Name] = true
				down := isDown(c.State)
				v := 0.0
				if down {
					v = 1
				}
				e.process(ctx, r, observation{Target: c.Name, Value: v, Breach: down, Detail: c.State}, now)
			}
			// Containers that were removed entirely are no longer "down".
			open, err := e.d.Store.OpenAlertEvents(r.ID)
			if err == nil {
				for _, ev := range open {
					if !seen[ev.Target] {
						delete(e.pending, r.ID+"|"+ev.Target)
						e.resolve(ctx, r, ev.Target)
					}
				}
			}
		}
	}

	e.checkDeploys(ctx, rules, now)

	if now.Sub(e.lastPrune) > time.Hour {
		e.lastPrune = now
		if err := e.d.Store.PruneAlertHistory(now.Add(-historyKeep)); err != nil {
			log.Warn().Err(err).Msg("alerts: prune history failed")
		}
	}
}

func isDown(state string) bool {
	switch state {
	case "exited", "dead", "restarting":
		return true
	}
	return false
}

// TargetMatches reports whether a rule target ("" / "*" = anything) covers name.
func TargetMatches(ruleTarget, name string) bool {
	return ruleTarget == "" || ruleTarget == "*" || ruleTarget == name
}

// Compare applies a rule operator.
func Compare(v float64, op string, threshold float64) bool {
	switch op {
	case ">":
		return v > threshold
	case ">=":
		return v >= threshold
	case "<":
		return v < threshold
	case "<=":
		return v <= threshold
	}
	return false
}

// process applies the duration / dedupe / cooldown / auto-resolve state machine
// to one observation.
func (e *Evaluator) process(ctx context.Context, r db.AlertRuleFull, o observation, now time.Time) {
	key := r.ID + "|" + o.Target
	if !o.Breach {
		delete(e.pending, key)
		e.resolve(ctx, r, o.Target)
		return
	}
	since, ok := e.pending[key]
	if !ok {
		e.pending[key] = now
		since = now
	}
	if now.Sub(since) < time.Duration(r.Duration)*time.Second {
		return
	}
	e.fire(ctx, r, o, now)
}

func (e *Evaluator) fire(ctx context.Context, r db.AlertRuleFull, o observation, now time.Time) {
	latest, err := e.d.Store.LatestAlertEvent(r.ID, o.Target)
	if err != nil {
		log.Warn().Err(err).Msg("alerts: lookup failed")
		return
	}
	if latest != nil {
		if latest.State != "resolved" {
			return // already firing or acknowledged: dedupe
		}
		ref := latest.FiredAt
		if latest.ResolvedAt != nil {
			ref = *latest.ResolvedAt
		}
		if now.Sub(ref) < time.Duration(r.Cooldown)*time.Second {
			return // flap protection
		}
	}
	e.record(ctx, r, db.AlertEventFull{
		RuleID: r.ID, RuleName: r.Name, Metric: r.Metric, Value: o.Value, Severity: r.Severity,
		State: "firing", Target: o.Target, Message: describe(r, o),
	})
}

// record stores a new firing event, broadcasts it and notifies the channels.
func (e *Evaluator) record(ctx context.Context, r db.AlertRuleFull, ev db.AlertEventFull) {
	id, err := e.d.Store.InsertAlertEventFull(&ev)
	if err != nil {
		log.Warn().Err(err).Msg("alerts: could not record event")
		return
	}
	ev.ID = id
	if stored, err := e.d.Store.GetAlertEventFull(id); err == nil && stored != nil {
		ev = *stored
	} else {
		ev.FiredAt = e.d.Now()
	}
	if e.d.Hub != nil {
		e.d.Hub.Broadcast("alert:new", ToView(ev))
	}
	e.notify(ctx, r, ev, "firing")
}

func (e *Evaluator) resolve(ctx context.Context, r db.AlertRuleFull, target string) {
	latest, err := e.d.Store.LatestAlertEvent(r.ID, target)
	if err != nil || latest == nil || latest.State == "resolved" {
		return
	}
	ev, err := e.d.Store.SetAlertEventState(latest.ID, "resolved")
	if err != nil || ev == nil {
		return
	}
	if e.d.Hub != nil {
		e.d.Hub.Broadcast("alert:update", ToView(*ev))
	}
	e.notify(ctx, r, *ev, "resolved")
}

func (e *Evaluator) muted() bool {
	v, err := e.d.Store.GetSetting(SettingMutedUntil)
	if err != nil || v == "" {
		return false
	}
	until, err := strconv.ParseInt(v, 10, 64)
	return err == nil && until > e.d.Now().Unix()
}

// channelsFor returns the enabled, decodable channels a rule routes to (all
// enabled channels when the rule names none).
func (e *Evaluator) channelsFor(r db.AlertRuleFull) []Channel {
	all, err := e.d.Store.ListNotificationChannels()
	if err != nil {
		log.Warn().Err(err).Msg("alerts: could not load channels")
		return nil
	}
	want := map[string]bool{}
	for _, id := range r.ChannelIDs {
		want[id] = true
	}
	var out []Channel
	for _, c := range all {
		if !c.Enabled || (len(want) > 0 && !want[c.ID]) {
			continue
		}
		ch, err := DecodeChannel(c)
		if err != nil {
			log.Warn().Str("channel", c.Name).Err(err).Msg("alerts: skipping unreadable channel")
			continue
		}
		out = append(out, ch)
	}
	return out
}

func (e *Evaluator) notify(ctx context.Context, r db.AlertRuleFull, ev db.AlertEventFull, state string) {
	if e.muted() {
		return
	}
	msg := MessageFor(ev, state)
	for _, ch := range e.channelsFor(r) {
		e.wg.Add(1)
		go func(ch Channel) {
			defer e.wg.Done()
			c, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			if err := e.d.Send(c, ch, msg); err != nil {
				log.Warn().Str("channel", ch.Name).Str("type", ch.Type).Err(err).Msg("alerts: notification failed")
			}
		}(ch)
	}
}

// checkDeploys raises one event per newly failed deployment for deploy.failed
// rules. The first pass only records what already failed so a restart does not
// replay old failures.
func (e *Evaluator) checkDeploys(ctx context.Context, rules []db.AlertRuleFull, now time.Time) {
	failed, err := e.d.Store.RecentFailedDeployments(50)
	if err != nil {
		log.Warn().Err(err).Msg("alerts: could not read failed deployments")
		return
	}
	if !e.primed {
		for _, f := range failed {
			e.seenDeploys[f.ID] = true
		}
		e.primed = true
		return
	}
	if len(e.seenDeploys) > maxSeenDeploys {
		e.seenDeploys = map[string]bool{}
		for _, f := range failed {
			e.seenDeploys[f.ID] = true
		}
	}
	for _, f := range failed {
		if e.seenDeploys[f.ID] {
			continue
		}
		e.seenDeploys[f.ID] = true
		for _, r := range rules {
			if !r.Enabled || r.Metric != MetricDeployFailed || !TargetMatches(r.Target, f.Project) {
				continue
			}
			e.record(ctx, r, db.AlertEventFull{
				RuleID: r.ID, RuleName: r.Name, Metric: r.Metric, Value: 1, Severity: r.Severity,
				State: "firing", Target: f.Project,
				Message: describe(r, observation{Target: f.Project, Detail: f.Reason}),
			})
		}
	}
}

// describe is the human-readable reason stored on an event.
func describe(r db.AlertRuleFull, o observation) string {
	var s string
	switch r.Metric {
	case MetricCPU, MetricMemory, MetricDisk:
		name := map[string]string{MetricCPU: "CPU", MetricMemory: "Memory", MetricDisk: "Disk"}[r.Metric]
		s = fmt.Sprintf("%s usage is %.1f%% (alert when %s %g%%)", name, o.Value, r.Operator, r.Threshold)
		if r.Duration > 0 {
			s += fmt.Sprintf(" for %s", (time.Duration(r.Duration) * time.Second).String())
		}
	case MetricContainerDown:
		s = fmt.Sprintf("Container %s is not running (state: %s)", o.Target, o.Detail)
	case MetricDeployFailed:
		s = fmt.Sprintf("A deployment of %s failed", o.Target)
		if d := strings.TrimSpace(o.Detail); d != "" {
			if len(d) > 300 {
				d = d[:300] + "…"
			}
			s += ": " + d
		}
	}
	return s
}

// MessageFor builds the notification for an event in the given state.
func MessageFor(ev db.AlertEventFull, state string) Message {
	tag := strings.ToUpper(ev.Severity)
	if state == "resolved" {
		tag = "RESOLVED"
	}
	title := fmt.Sprintf("[%s] %s", tag, ev.RuleName)
	if ev.Target != "" && ev.Target != "host" {
		title += " — " + ev.Target
	}
	body := ev.Message
	if state == "resolved" {
		body = "Back to normal. " + ev.Message
	}
	return Message{Title: title, Body: body, Severity: ev.Severity, State: state, Target: ev.Target, Rule: ev.RuleName, Value: ev.Value, At: ev.FiredAt}
}

// View is the JSON shape the UI consumes for an alert event.
type View struct {
	ID         int64   `json:"id"`
	RuleID     string  `json:"ruleId"`
	Rule       string  `json:"rule"`
	Metric     string  `json:"metric"`
	Severity   string  `json:"severity"`
	Sev        string  `json:"sev"` // bad | warn | info, matches the UI's severity tones
	Title      string  `json:"title"`
	Target     string  `json:"target"`
	State      string  `json:"state"`
	Message    string  `json:"message"`
	Value      float64 `json:"value"`
	FiredAt    string  `json:"firedAt"`
	AckedAt    *string `json:"ackedAt"`
	ResolvedAt *string `json:"resolvedAt"`
}

func ToView(e db.AlertEventFull) View {
	sev := "info"
	switch e.Severity {
	case "critical":
		sev = "bad"
	case "warning":
		sev = "warn"
	}
	f := func(t *time.Time) *string {
		if t == nil {
			return nil
		}
		s := t.UTC().Format(time.RFC3339)
		return &s
	}
	return View{
		ID: e.ID, RuleID: e.RuleID, Rule: e.RuleName, Metric: e.Metric, Severity: e.Severity, Sev: sev,
		Title: e.RuleName, Target: e.Target, State: e.State, Message: e.Message, Value: e.Value,
		FiredAt: e.FiredAt.UTC().Format(time.RFC3339), AckedAt: f(e.AckedAt), ResolvedAt: f(e.ResolvedAt),
	}
}

// ValidateRule normalises and checks a rule submitted through the API.
func ValidateRule(r *db.AlertRuleFull) error {
	r.Name = strings.TrimSpace(r.Name)
	r.Target = strings.TrimSpace(r.Target)
	if r.Name == "" || len(r.Name) > 100 {
		return errors.New("name is required (max 100 characters)")
	}
	if len(r.Target) > 200 || strings.ContainsAny(r.Target, "\r\n\x00") {
		return errors.New("invalid target")
	}
	switch r.Severity {
	case "critical", "warning", "info":
	default:
		return errors.New("severity must be critical, warning or info")
	}
	if r.Duration < 0 || r.Duration > 86400 {
		return errors.New("duration must be between 0 and 86400 seconds")
	}
	if r.Cooldown < 0 || r.Cooldown > 7*86400 {
		return errors.New("cooldown must be between 0 and 7 days")
	}
	if len(r.ChannelIDs) > 50 {
		return errors.New("too many channels")
	}
	switch r.Metric {
	case MetricCPU, MetricMemory, MetricDisk:
		switch r.Operator {
		case ">", ">=", "<", "<=":
		default:
			return errors.New("operator must be >, >=, < or <=")
		}
		if r.Threshold < 0 || r.Threshold > 100 {
			return errors.New("threshold must be a percentage between 0 and 100")
		}
	case MetricContainerDown, MetricDeployFailed:
		r.Operator, r.Threshold = ">", 0 // event rules have no threshold
	default:
		return errors.New("unknown metric")
	}
	return nil
}
