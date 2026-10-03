package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"pulsenode/backend/internal/alerts"
	dbpkg "pulsenode/backend/internal/db"
)

func badRequest(w http.ResponseWriter, msg string) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
}

func notFound(w http.ResponseWriter, what string) {
	writeJSON(w, http.StatusNotFound, map[string]string{"error": what + " not found"})
}

// ── Alert rules ────────────────────────────────────────────────────────────────

type ruleBody struct {
	Name       string   `json:"name"`
	Metric     string   `json:"metric"`
	Operator   string   `json:"operator"`
	Threshold  float64  `json:"threshold"`
	Duration   int      `json:"duration"`
	Severity   string   `json:"severity"`
	Target     string   `json:"target"`
	ChannelIDs []string `json:"channelIds"`
	Cooldown   *int     `json:"cooldown"`
	Enabled    *bool    `json:"enabled"`
}

func (s *Server) listAlertRules(w http.ResponseWriter, r *http.Request) {
	rules, err := s.db.ListAlertRulesFull()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rules)
}

func (s *Server) createAlertRule(w http.ResponseWriter, r *http.Request) {
	var req ruleBody
	if err := decodeJSON(r, &req); err != nil {
		badRequest(w, "invalid body")
		return
	}
	rule := &dbpkg.AlertRuleFull{
		ID: dbpkg.NewID("rule"), Name: req.Name, Metric: req.Metric, Operator: req.Operator, Threshold: req.Threshold,
		Duration: req.Duration, Severity: req.Severity, Target: req.Target, ChannelIDs: req.ChannelIDs, Cooldown: 300, Enabled: true,
	}
	if req.Cooldown != nil {
		rule.Cooldown = *req.Cooldown
	}
	if req.Enabled != nil {
		rule.Enabled = *req.Enabled
	}
	if rule.ChannelIDs == nil {
		rule.ChannelIDs = []string{}
	}
	if err := alerts.ValidateRule(rule); err != nil {
		badRequest(w, err.Error())
		return
	}
	if err := s.db.CreateAlertRuleFull(rule); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, rule)
}

// updateAlertRule applies a partial update: any field omitted keeps its value, so
// the UI can PATCH just {"enabled": false}.
func (s *Server) updateAlertRule(w http.ResponseWriter, r *http.Request) {
	rule, err := s.db.GetAlertRuleFull(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, err)
		return
	}
	if rule == nil {
		notFound(w, "rule")
		return
	}
	var req map[string]json.RawMessage
	if err := decodeJSON(r, &req); err != nil {
		badRequest(w, "invalid body")
		return
	}
	set := func(key string, dst any) error {
		if raw, ok := req[key]; ok {
			return json.Unmarshal(raw, dst)
		}
		return nil
	}
	for key, dst := range map[string]any{
		"name": &rule.Name, "metric": &rule.Metric, "operator": &rule.Operator, "threshold": &rule.Threshold,
		"duration": &rule.Duration, "severity": &rule.Severity, "target": &rule.Target,
		"channelIds": &rule.ChannelIDs, "cooldown": &rule.Cooldown, "enabled": &rule.Enabled,
	} {
		if err := set(key, dst); err != nil {
			badRequest(w, "invalid value for "+key)
			return
		}
	}
	if rule.ChannelIDs == nil {
		rule.ChannelIDs = []string{}
	}
	if err := alerts.ValidateRule(rule); err != nil {
		badRequest(w, err.Error())
		return
	}
	if err := s.db.UpdateAlertRuleFull(rule); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rule)
}

func (s *Server) deleteAlertRule(w http.ResponseWriter, r *http.Request) {
	if err := s.db.DeleteAlertRule(chi.URLParam(r, "id")); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── Alert history ─────────────────────────────────────────────────────────────

func (s *Server) listAlertHistory(w http.ResponseWriter, r *http.Request) {
	limit := 200
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 1000 {
		limit = l
	}
	events, err := s.db.ListAlertEventsFull(limit)
	if err != nil {
		writeError(w, err)
		return
	}
	out := make([]alerts.View, 0, len(events))
	for _, e := range events {
		out = append(out, alerts.ToView(e))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) setAlertState(state string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			badRequest(w, "invalid id")
			return
		}
		ev, err := s.db.SetAlertEventState(id, state)
		if err != nil {
			writeError(w, err)
			return
		}
		if ev == nil { // missing, or not in a state that allows this transition
			if cur, _ := s.db.GetAlertEventFull(id); cur != nil {
				writeJSON(w, http.StatusOK, alerts.ToView(*cur))
				return
			}
			notFound(w, "alert")
			return
		}
		s.hub.Broadcast("alert:update", alerts.ToView(*ev))
		writeJSON(w, http.StatusOK, alerts.ToView(*ev))
	}
}

func (s *Server) ackAllAlerts(w http.ResponseWriter, r *http.Request) {
	n, err := s.db.AckAllFiring()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "acknowledged": n})
}

// Mute: notifications are suppressed until the given time; events are still recorded.
func (s *Server) getAlertMute(w http.ResponseWriter, r *http.Request) {
	until := s.mutedUntil()
	writeJSON(w, http.StatusOK, map[string]any{"muted": until > time.Now().Unix(), "until": until})
}

func (s *Server) setAlertMute(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Minutes int `json:"minutes"` // 0 = unmute
	}
	if err := decodeJSON(r, &req); err != nil || req.Minutes < 0 || req.Minutes > 7*24*60 {
		badRequest(w, "minutes must be between 0 and 10080")
		return
	}
	until := int64(0)
	if req.Minutes > 0 {
		until = time.Now().Add(time.Duration(req.Minutes) * time.Minute).Unix()
	}
	if err := s.db.SetSetting(alerts.SettingMutedUntil, strconv.FormatInt(until, 10)); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"muted": until > 0, "until": until})
}

func (s *Server) mutedUntil() int64 {
	v, _ := s.db.GetSetting(alerts.SettingMutedUntil)
	n, _ := strconv.ParseInt(v, 10, 64)
	return n
}

// ── Notification channels ─────────────────────────────────────────────────────

type channelView struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Type    string            `json:"type"`
	Enabled bool              `json:"enabled"`
	Summary string            `json:"summary"`
	Config  map[string]string `json:"config"` // secrets omitted; "<key>Set":"true" marks stored ones
}

func toChannelView(c dbpkg.NotificationChannel) channelView {
	v := channelView{ID: c.ID, Name: c.Name, Type: c.Type, Enabled: c.Enabled, Config: map[string]string{}}
	if ch, err := alerts.DecodeChannel(c); err == nil {
		v.Config = alerts.PublicConfig(c.Type, ch.Config)
		v.Summary = alerts.Summary(c.Type, ch.Config)
	}
	return v
}

func (s *Server) listNotificationChannels(w http.ResponseWriter, r *http.Request) {
	channels, err := s.db.ListNotificationChannels()
	if err != nil {
		writeError(w, err)
		return
	}
	out := make([]channelView, 0, len(channels))
	for _, c := range channels {
		out = append(out, toChannelView(c))
	}
	writeJSON(w, http.StatusOK, out)
}

type channelBody struct {
	Name    string         `json:"name"`
	Type    string         `json:"type"`
	Config  map[string]any `json:"config"`
	Enabled *bool          `json:"enabled"`
}

func (s *Server) createNotificationChannel(w http.ResponseWriter, r *http.Request) {
	var req channelBody
	if err := decodeJSON(r, &req); err != nil {
		badRequest(w, "invalid body")
		return
	}
	cfg := alerts.NormalizeConfig(req.Config)
	if req.Name == "" || len(req.Name) > 100 {
		badRequest(w, "name is required (max 100 characters)")
		return
	}
	if err := alerts.ValidateConfig(req.Type, cfg); err != nil {
		badRequest(w, err.Error())
		return
	}
	enc, err := alerts.EncodeConfig(cfg)
	if err != nil {
		writeError(w, err)
		return
	}
	ch := &dbpkg.NotificationChannel{ID: dbpkg.NewID("ch"), Name: req.Name, Type: req.Type, Config: enc, Enabled: req.Enabled == nil || *req.Enabled}
	if err := s.db.CreateNotificationChannel(ch); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, toChannelView(*ch))
}

func (s *Server) updateNotificationChannel(w http.ResponseWriter, r *http.Request) {
	cur, err := s.db.GetNotificationChannel(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, err)
		return
	}
	if cur == nil {
		notFound(w, "channel")
		return
	}
	var req channelBody
	if err := decodeJSON(r, &req); err != nil {
		badRequest(w, "invalid body")
		return
	}
	old, err := alerts.DecodeChannel(*cur)
	if err != nil {
		writeError(w, err)
		return
	}
	if req.Name != "" {
		cur.Name = req.Name
	}
	if req.Enabled != nil {
		cur.Enabled = *req.Enabled
	}
	cfg := old.Config
	if req.Config != nil {
		cfg = alerts.MergeConfig(cur.Type, old.Config, alerts.NormalizeConfig(req.Config))
		if err := alerts.ValidateConfig(cur.Type, cfg); err != nil {
			badRequest(w, err.Error())
			return
		}
	}
	if cur.Config, err = alerts.EncodeConfig(cfg); err != nil {
		writeError(w, err)
		return
	}
	if err := s.db.UpdateNotificationChannel(cur); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toChannelView(*cur))
}

func (s *Server) deleteNotificationChannel(w http.ResponseWriter, r *http.Request) {
	if err := s.db.DeleteNotificationChannel(chi.URLParam(r, "id")); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func testMessage() alerts.Message {
	return alerts.Message{
		Title: "[TEST] PulseNode notification", Body: "If you can read this, this channel is working.",
		Severity: "info", State: "test", Rule: "Test notification", At: time.Now(),
	}
}

// testSavedChannel sends a test through a stored channel.
func (s *Server) testSavedChannel(w http.ResponseWriter, r *http.Request) {
	c, err := s.db.GetNotificationChannel(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, err)
		return
	}
	if c == nil {
		notFound(w, "channel")
		return
	}
	ch, err := alerts.DecodeChannel(*c)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	s.respondTest(w, r.Context(), ch)
}

// testDraftChannel tests a channel config before it is saved. For an existing
// channel, pass "id" so blank secret fields reuse the stored ones.
func (s *Server) testDraftChannel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		channelBody
		ID string `json:"id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		badRequest(w, "invalid body")
		return
	}
	cfg := alerts.NormalizeConfig(req.Config)
	if req.ID != "" {
		if c, _ := s.db.GetNotificationChannel(req.ID); c != nil && c.Type == req.Type {
			if old, err := alerts.DecodeChannel(*c); err == nil {
				cfg = alerts.MergeConfig(req.Type, old.Config, cfg)
			}
		}
	}
	s.respondTest(w, r.Context(), alerts.Channel{Name: req.Name, Type: req.Type, Config: cfg})
}

func (s *Server) respondTest(w http.ResponseWriter, ctx context.Context, ch alerts.Channel) {
	if err := alerts.ValidateConfig(ch.Type, ch.Config); err != nil {
		badRequest(w, err.Error())
		return
	}
	if err := alerts.DefaultSender.Send(ctx, ch, testMessage()); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── Audit log ─────────────────────────────────────────────────────────────────

func (s *Server) listAuditLog(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(`SELECT id,actor,action,resource,ip,status,created_at FROM audit_log ORDER BY created_at DESC LIMIT 200`)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var id int64
		var actor, action, resource, ip string
		var status int
		var createdAt string
		if err := rows.Scan(&id, &actor, &action, &resource, &ip, &status, &createdAt); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "actor": actor, "action": action,
			"resource": resource, "ip": ip, "status": status, "created_at": createdAt,
		})
	}
	if out == nil {
		out = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, out)
}
