package db

import (
	"database/sql"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// Alerting storage: the full rule/event/channel model used by internal/alerts.
// The original AlertRule/AlertEvent types in db.go are kept for compatibility;
// these *Full types carry the extra columns added by ensureAlertSchema.

var alertSchemaOnce sync.Map // *DB -> *sync.Once

// ensureAlertSchema adds the alerting columns/indexes once per DB handle. It is
// called lazily by every method below so no change to migrate() is needed.
func (d *DB) ensureAlertSchema() {
	v, _ := alertSchemaOnce.LoadOrStore(d, &sync.Once{})
	v.(*sync.Once).Do(func() {
		d.addColumn("alert_rules", "target", "TEXT NOT NULL DEFAULT ''")
		d.addColumn("alert_rules", "channel_ids", "TEXT NOT NULL DEFAULT '[]'")
		d.addColumn("alert_rules", "cooldown", "INTEGER NOT NULL DEFAULT 300")
		d.addColumn("alert_history", "target", "TEXT NOT NULL DEFAULT ''")
		d.addColumn("alert_history", "message", "TEXT NOT NULL DEFAULT ''")
		d.addColumn("alert_history", "acked_at", "DATETIME")
		_, _ = d.Exec(`CREATE INDEX IF NOT EXISTS idx_alert_history_rule ON alert_history(rule_id, target, id)`)
	})
}

// ── Rules ─────────────────────────────────────────────────────────────────────

type AlertRuleFull struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Metric     string    `json:"metric"`
	Operator   string    `json:"operator"`
	Threshold  float64   `json:"threshold"`
	Duration   int       `json:"duration"` // seconds the condition must hold
	Severity   string    `json:"severity"` // critical | warning | info
	Target     string    `json:"target"`   // "" / "*" = any; else container or project name
	ChannelIDs []string  `json:"channelIds"`
	Cooldown   int       `json:"cooldown"` // seconds after resolve before the rule may fire again
	Enabled    bool      `json:"enabled"`
	CreatedAt  time.Time `json:"createdAt"`
}

const ruleCols = `id,name,metric,operator,threshold,duration,severity,target,channel_ids,cooldown,enabled,created_at`

type rowScanner interface{ Scan(dest ...any) error }

func scanRule(row rowScanner) (*AlertRuleFull, error) {
	var r AlertRuleFull
	var ids string
	var enabled int
	if err := row.Scan(&r.ID, &r.Name, &r.Metric, &r.Operator, &r.Threshold, &r.Duration, &r.Severity, &r.Target, &ids, &r.Cooldown, &enabled, &r.CreatedAt); err != nil {
		return nil, err
	}
	r.Enabled = enabled == 1
	r.ChannelIDs = []string{}
	_ = json.Unmarshal([]byte(ids), &r.ChannelIDs)
	if r.ChannelIDs == nil {
		r.ChannelIDs = []string{}
	}
	return &r, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (d *DB) ListAlertRulesFull() ([]AlertRuleFull, error) {
	d.ensureAlertSchema()
	rows, err := d.Query(`SELECT ` + ruleCols + ` FROM alert_rules ORDER BY created_at DESC, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AlertRuleFull{}
	for rows.Next() {
		r, err := scanRule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// GetAlertRuleFull returns nil, nil when the rule does not exist.
func (d *DB) GetAlertRuleFull(id string) (*AlertRuleFull, error) {
	d.ensureAlertSchema()
	r, err := scanRule(d.QueryRow(`SELECT `+ruleCols+` FROM alert_rules WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return r, err
}

func (d *DB) CreateAlertRuleFull(r *AlertRuleFull) error {
	d.ensureAlertSchema()
	ids, _ := json.Marshal(r.ChannelIDs)
	_, err := d.Exec(`INSERT INTO alert_rules (id,name,metric,operator,threshold,duration,severity,target,channel_ids,cooldown,enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		r.ID, r.Name, r.Metric, r.Operator, r.Threshold, r.Duration, r.Severity, r.Target, string(ids), r.Cooldown, boolInt(r.Enabled))
	return err
}

func (d *DB) UpdateAlertRuleFull(r *AlertRuleFull) error {
	d.ensureAlertSchema()
	ids, _ := json.Marshal(r.ChannelIDs)
	_, err := d.Exec(`UPDATE alert_rules SET name=?,metric=?,operator=?,threshold=?,duration=?,severity=?,target=?,channel_ids=?,cooldown=?,enabled=? WHERE id=?`,
		r.Name, r.Metric, r.Operator, r.Threshold, r.Duration, r.Severity, r.Target, string(ids), r.Cooldown, boolInt(r.Enabled), r.ID)
	return err
}

// ── Events ────────────────────────────────────────────────────────────────────

type AlertEventFull struct {
	ID         int64      `json:"id"`
	RuleID     string     `json:"ruleId"`
	RuleName   string     `json:"ruleName"`
	Metric     string     `json:"metric"`
	Value      float64    `json:"value"`
	Severity   string     `json:"severity"`
	State      string     `json:"state"` // firing | ack | resolved
	Target     string     `json:"target"`
	Message    string     `json:"message"`
	FiredAt    time.Time  `json:"firedAt"`
	AckedAt    *time.Time `json:"ackedAt"`
	ResolvedAt *time.Time `json:"resolvedAt"`
}

const eventCols = `id,rule_id,rule_name,metric,value,severity,state,target,message,fired_at,acked_at,resolved_at`

func scanEvent(row rowScanner) (*AlertEventFull, error) {
	var e AlertEventFull
	if err := row.Scan(&e.ID, &e.RuleID, &e.RuleName, &e.Metric, &e.Value, &e.Severity, &e.State, &e.Target, &e.Message, &e.FiredAt, &e.AckedAt, &e.ResolvedAt); err != nil {
		return nil, err
	}
	return &e, nil
}

func (d *DB) InsertAlertEventFull(e *AlertEventFull) (int64, error) {
	d.ensureAlertSchema()
	q := `INSERT INTO alert_history (rule_id,rule_name,metric,value,severity,state,target,message) VALUES (?,?,?,?,?,?,?,?)`
	if e.State == "resolved" { // informational event: closed on arrival, so it ages out normally
		q = `INSERT INTO alert_history (rule_id,rule_name,metric,value,severity,state,target,message,resolved_at) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
	}
	res, err := d.Exec(q, e.RuleID, e.RuleName, e.Metric, e.Value, e.Severity, e.State, e.Target, e.Message)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (d *DB) ListAlertEventsFull(limit int) ([]AlertEventFull, error) {
	d.ensureAlertSchema()
	rows, err := d.Query(`SELECT `+eventCols+` FROM alert_history ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AlertEventFull{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

// GetAlertEventFull returns nil, nil when the event does not exist.
func (d *DB) GetAlertEventFull(id int64) (*AlertEventFull, error) {
	d.ensureAlertSchema()
	e, err := scanEvent(d.QueryRow(`SELECT `+eventCols+` FROM alert_history WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return e, err
}

// LatestAlertEvent is the most recent event (any state) for a rule+target, or nil.
func (d *DB) LatestAlertEvent(ruleID, target string) (*AlertEventFull, error) {
	d.ensureAlertSchema()
	e, err := scanEvent(d.QueryRow(`SELECT `+eventCols+` FROM alert_history WHERE rule_id=? AND target=? ORDER BY id DESC LIMIT 1`, ruleID, target))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return e, err
}

// OpenAlertEvents lists events still firing or acknowledged for a rule.
func (d *DB) OpenAlertEvents(ruleID string) ([]AlertEventFull, error) {
	d.ensureAlertSchema()
	rows, err := d.Query(`SELECT `+eventCols+` FROM alert_history WHERE rule_id=? AND state IN ('firing','ack')`, ruleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AlertEventFull{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

// SetAlertEventState moves an event to "ack" (from firing) or "resolved" (from
// firing/ack). It returns the updated event, or nil when nothing changed.
func (d *DB) SetAlertEventState(id int64, state string) (*AlertEventFull, error) {
	d.ensureAlertSchema()
	var res sql.Result
	var err error
	switch state {
	case "ack":
		res, err = d.Exec(`UPDATE alert_history SET state='ack', acked_at=CURRENT_TIMESTAMP WHERE id=? AND state='firing'`, id)
	case "resolved":
		res, err = d.Exec(`UPDATE alert_history SET state='resolved', resolved_at=CURRENT_TIMESTAMP WHERE id=? AND state IN ('firing','ack')`, id)
	default:
		return nil, errors.New("invalid state")
	}
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, nil
	}
	return d.GetAlertEventFull(id)
}

// AckAllFiring acknowledges every firing alert and returns how many changed.
func (d *DB) AckAllFiring() (int64, error) {
	d.ensureAlertSchema()
	res, err := d.Exec(`UPDATE alert_history SET state='ack', acked_at=CURRENT_TIMESTAMP WHERE state='firing'`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// PruneAlertHistory deletes resolved events older than before.
func (d *DB) PruneAlertHistory(before time.Time) error {
	d.ensureAlertSchema()
	_, err := d.Exec(`DELETE FROM alert_history WHERE state='resolved' AND resolved_at < ?`, before)
	return err
}

// ── Failed deployments (for the deploy.failed metric) ─────────────────────────

type FailedDeployment struct {
	ID      string
	Project string
	Reason  string
}

// CountFiringAlerts is the number of alerts still firing (not acknowledged or
// resolved); it backs the sidebar badge.
func (d *DB) CountFiringAlerts() (int, error) {
	d.ensureAlertSchema()
	var n int
	err := d.QueryRow(`SELECT COUNT(*) FROM alert_history WHERE state='firing'`).Scan(&n)
	return n, err
}

// RecentFailedDeployments returns the newest failed deployments with the last log
// line as the reason, in one query (the reason is an index lookup on
// deployment_logs(deployment_id,id)). The caller dedupes by ID.
func (d *DB) RecentFailedDeployments(limit int) ([]FailedDeployment, error) {
	rows, err := d.Query(`
SELECT d.id, p.name,
       COALESCE((SELECT l.line FROM deployment_logs l WHERE l.deployment_id = d.id ORDER BY l.id DESC LIMIT 1), '')
FROM deployments d JOIN projects p ON p.id = d.project_id
WHERE d.status = 'failed'
ORDER BY d.rowid DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FailedDeployment{}
	for rows.Next() {
		var f FailedDeployment
		if err := rows.Scan(&f.ID, &f.Project, &f.Reason); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// ── Notification channels (extras) ────────────────────────────────────────────

// GetNotificationChannel returns nil, nil when the channel does not exist.
func (d *DB) GetNotificationChannel(id string) (*NotificationChannel, error) {
	var c NotificationChannel
	var enabled int
	err := d.QueryRow(`SELECT id,name,type,config,enabled,created_at FROM notification_channels WHERE id=?`, id).
		Scan(&c.ID, &c.Name, &c.Type, &c.Config, &enabled, &c.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	c.Enabled = enabled == 1
	return &c, err
}

func (d *DB) UpdateNotificationChannel(c *NotificationChannel) error {
	_, err := d.Exec(`UPDATE notification_channels SET name=?, config=?, enabled=? WHERE id=?`, c.Name, c.Config, boolInt(c.Enabled), c.ID)
	return err
}
