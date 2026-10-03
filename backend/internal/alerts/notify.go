package alerts

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"pulsenode/backend/internal/db"
)

const (
	TypeWebhook  = "webhook"
	TypeSlack    = "slack"
	TypeDiscord  = "discord"
	TypeTelegram = "telegram"
	TypeSMTP     = "smtp"
)

// Message is what a channel is asked to deliver.
type Message struct {
	Title    string    `json:"title"`
	Body     string    `json:"body"`
	Severity string    `json:"severity"` // critical | warning | info
	State    string    `json:"state"`    // firing | resolved | test
	Target   string    `json:"target"`
	Rule     string    `json:"rule"`
	Value    float64   `json:"value"`
	At       time.Time `json:"at"`
}

// Channel is a decoded (decrypted) notification channel.
type Channel struct {
	ID     string
	Name   string
	Type   string
	Config map[string]string
}

// secretKeys are never returned by the API and are kept on update when left blank.
var secretKeys = map[string][]string{
	TypeWebhook:  {"secret"},
	TypeSlack:    {"webhookUrl"},
	TypeDiscord:  {"webhookUrl"},
	TypeTelegram: {"botToken"},
	TypeSMTP:     {"password"},
}

var requiredKeys = map[string][]string{
	TypeWebhook:  {"url"},
	TypeSlack:    {"webhookUrl"},
	TypeDiscord:  {"webhookUrl"},
	TypeTelegram: {"botToken", "chatId"},
	TypeSMTP:     {"host", "port", "from", "to"},
}

var (
	telegramToken = regexp.MustCompile(`^[0-9]{3,20}:[A-Za-z0-9_-]{20,80}$`)
	telegramChat  = regexp.MustCompile(`^(-?[0-9]{1,20}|@[A-Za-z0-9_]{3,64})$`)
)

// ChannelTypes lists the supported channel types.
func ChannelTypes() []string {
	return []string{TypeWebhook, TypeSlack, TypeDiscord, TypeTelegram, TypeSMTP}
}

// NormalizeConfig turns JSON-decoded values (strings, numbers, bools) into strings.
func NormalizeConfig(in map[string]any) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		switch t := v.(type) {
		case nil:
		case string:
			out[k] = strings.TrimSpace(t)
		case float64:
			out[k] = strconv.FormatFloat(t, 'f', -1, 64)
		default:
			out[k] = fmt.Sprint(t)
		}
	}
	return out
}

// ValidateConfig checks required fields and URL/host sanity for a channel type.
func ValidateConfig(typ string, cfg map[string]string) error {
	req, ok := requiredKeys[typ]
	if !ok {
		return fmt.Errorf("unknown channel type %q", typ)
	}
	for _, k := range req {
		if cfg[k] == "" {
			return fmt.Errorf("%s is required", k)
		}
	}
	switch typ {
	case TypeWebhook:
		_, err := CheckURL(cfg["url"])
		return err
	case TypeSlack, TypeDiscord:
		u, err := CheckURL(cfg["webhookUrl"])
		if err != nil {
			return err
		}
		if u.Scheme != "https" {
			return errors.New("webhook URL must use https")
		}
	case TypeTelegram:
		if !telegramToken.MatchString(cfg["botToken"]) {
			return errors.New("bot token looks invalid (expected 123456:ABC…)")
		}
		if !telegramChat.MatchString(cfg["chatId"]) {
			return errors.New("chat ID must be a number or @channelname")
		}
	case TypeSMTP:
		if p, err := strconv.Atoi(cfg["port"]); err != nil || p < 1 || p > 65535 {
			return errors.New("port must be 1-65535")
		}
		if strings.ContainsAny(cfg["host"], " /\r\n") {
			return errors.New("invalid SMTP host")
		}
		if _, err := mail.ParseAddress(cfg["from"]); err != nil {
			return errors.New("from is not a valid email address")
		}
		if _, err := parseRecipients(cfg["to"]); err != nil {
			return err
		}
		switch cfg["security"] {
		case "", "starttls", "tls", "none":
		default:
			return errors.New("security must be starttls, tls or none")
		}
	}
	return nil
}

func parseRecipients(s string) ([]string, error) {
	var out []string
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		a, err := mail.ParseAddress(part)
		if err != nil {
			return nil, fmt.Errorf("%q is not a valid email address", part)
		}
		out = append(out, a.Address)
	}
	if len(out) == 0 {
		return nil, errors.New("at least one recipient is required")
	}
	if len(out) > 20 {
		return nil, errors.New("too many recipients (max 20)")
	}
	return out, nil
}

// MergeConfig applies an update on top of the stored config: blank secret fields
// keep their stored value so the UI never has to resend secrets.
func MergeConfig(typ string, old, update map[string]string) map[string]string {
	out := make(map[string]string, len(update))
	for k, v := range update {
		out[k] = v
	}
	for _, k := range secretKeys[typ] {
		if out[k] == "" {
			out[k] = old[k]
		}
	}
	return out
}

// PublicConfig is the config minus secrets, plus "<key>Set" flags for the UI.
func PublicConfig(typ string, cfg map[string]string) map[string]string {
	secret := map[string]bool{}
	for _, k := range secretKeys[typ] {
		secret[k] = true
	}
	out := map[string]string{}
	for k, v := range cfg {
		if secret[k] {
			if v != "" {
				out[k+"Set"] = "true"
			}
			continue
		}
		out[k] = v
	}
	return out
}

// Summary is a short non-secret description shown in channel lists.
func Summary(typ string, cfg map[string]string) string {
	switch typ {
	case TypeWebhook:
		return hostOf(cfg["url"])
	case TypeSlack, TypeDiscord:
		return hostOf(cfg["webhookUrl"])
	case TypeTelegram:
		return "chat " + cfg["chatId"]
	case TypeSMTP:
		return cfg["to"] + " via " + cfg["host"] + ":" + cfg["port"]
	}
	return ""
}

func hostOf(raw string) string {
	if u, err := url.Parse(raw); err == nil {
		return u.Host
	}
	return ""
}

// DecodeChannel decrypts a stored channel. Rows written before encryption was
// added hold plain JSON, which db.Decrypt passes through unchanged.
func DecodeChannel(c db.NotificationChannel) (Channel, error) {
	plain, err := db.Decrypt(c.Config)
	if err != nil {
		return Channel{}, err
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(plain), &raw); err != nil {
		return Channel{}, fmt.Errorf("channel %s has unreadable config", c.ID)
	}
	return Channel{ID: c.ID, Name: c.Name, Type: c.Type, Config: NormalizeConfig(raw)}, nil
}

// EncodeConfig serialises and encrypts a channel config for storage.
func EncodeConfig(cfg map[string]string) (string, error) {
	b, err := json.Marshal(cfg)
	if err != nil {
		return "", err
	}
	return db.Encrypt(string(b))
}

// Sender delivers messages.
type Sender struct {
	HTTP *http.Client
	// Dial opens the SMTP connection (SSRF-guarded by default).
	Dial func(ctx context.Context, addr string) (net.Conn, error)
}

func NewSender() *Sender {
	d := safeDialer()
	return &Sender{HTTP: NewHTTPClient(), Dial: func(ctx context.Context, addr string) (net.Conn, error) {
		return d.DialContext(ctx, "tcp", addr)
	}}
}

// DefaultSender is used by the evaluator and the API unless overridden.
var DefaultSender = NewSender()

// Send delivers m through ch.
func (s *Sender) Send(ctx context.Context, ch Channel, m Message) error {
	if err := ValidateConfig(ch.Type, ch.Config); err != nil {
		return err
	}
	if m.At.IsZero() {
		m.At = time.Now()
	}
	switch ch.Type {
	case TypeWebhook:
		return s.sendWebhook(ctx, ch.Config, m)
	case TypeSlack:
		return s.postJSON(ctx, ch.Config["webhookUrl"], map[string]any{"text": slackEscape(Text(m))}, nil)
	case TypeDiscord:
		return s.postJSON(ctx, ch.Config["webhookUrl"], map[string]any{
			"content":          truncate(Text(m), 1900),
			"allowed_mentions": map[string]any{"parse": []string{}}, // container names must not ping @everyone
		}, nil)
	case TypeTelegram:
		return s.postJSON(ctx, "https://api.telegram.org/bot"+ch.Config["botToken"]+"/sendMessage",
			map[string]any{"chat_id": ch.Config["chatId"], "text": truncate(Text(m), 4000), "disable_web_page_preview": true}, nil)
	case TypeSMTP:
		return s.sendSMTP(ctx, ch.Config, m)
	}
	return fmt.Errorf("unknown channel type %q", ch.Type)
}

// Text renders a message as plain text for chat channels.
func Text(m Message) string {
	var b strings.Builder
	b.WriteString(m.Title)
	if m.Body != "" {
		b.WriteString("\n")
		b.WriteString(m.Body)
	}
	return b.String()
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

func slackEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

func (s *Sender) sendWebhook(ctx context.Context, cfg map[string]string, m Message) error {
	payload := map[string]any{
		"source": "pulsenode", "title": m.Title, "body": m.Body, "severity": m.Severity,
		"state": m.State, "target": m.Target, "rule": m.Rule, "value": m.Value, "at": m.At.UTC().Format(time.RFC3339),
	}
	var hdr map[string]string
	body, _ := json.Marshal(payload)
	if sec := cfg["secret"]; sec != "" {
		mac := hmac.New(sha256.New, []byte(sec))
		mac.Write(body)
		hdr = map[string]string{"X-PulseNode-Signature": "sha256=" + hex.EncodeToString(mac.Sum(nil))}
	}
	return s.postRaw(ctx, cfg["url"], body, hdr)
}

func (s *Sender) postJSON(ctx context.Context, target string, payload any, hdr map[string]string) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return s.postRaw(ctx, target, body, hdr)
}

func (s *Sender) postRaw(ctx context.Context, target string, body []byte, hdr map[string]string) error {
	if _, err := CheckURL(target); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "PulseNode-Alerts")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return redactURLErr(err, target)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("endpoint answered HTTP %d", resp.StatusCode)
	}
	return nil
}

// redactURLErr strips the request URL (which can embed a bot token or webhook
// secret) from net/http errors before they are logged or shown in the UI.
func redactURLErr(err error, target string) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return errors.New(strings.ReplaceAll(err.Error(), target, "<url>"))
}

func (s *Sender) sendSMTP(ctx context.Context, cfg map[string]string, m Message) error {
	to, err := parseRecipients(cfg["to"])
	if err != nil {
		return err
	}
	from, _ := mail.ParseAddress(cfg["from"])
	addr := net.JoinHostPort(cfg["host"], cfg["port"])
	sec := cfg["security"]
	if sec == "" {
		sec = "starttls"
	}

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	conn, err := s.Dial(ctx, addr)
	if err != nil {
		return fmt.Errorf("smtp connect: %w", err)
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	tlsCfg := &tls.Config{ServerName: cfg["host"], MinVersion: tls.VersionTLS12}
	if sec == "tls" {
		conn = tls.Client(conn, tlsCfg)
	}
	c, err := smtp.NewClient(conn, cfg["host"])
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("smtp handshake: %w", err)
	}
	defer c.Close()
	if sec == "starttls" {
		if err := c.StartTLS(tlsCfg); err != nil {
			return fmt.Errorf("smtp starttls: %w", err)
		}
	}
	if cfg["username"] != "" {
		if err := c.Auth(smtp.PlainAuth("", cfg["username"], cfg["password"], cfg["host"])); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := c.Mail(from.Address); err != nil {
		return err
	}
	for _, r := range to {
		if err := c.Rcpt(r); err != nil {
			return err
		}
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(buildEmail(from.String(), to, m)); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

// buildEmail assembles a plain-text message; headers are sanitised so a container
// name or rule title can never inject extra headers.
func buildEmail(from string, to []string, m Message) []byte {
	clean := func(s string) string { return strings.NewReplacer("\r", " ", "\n", " ").Replace(s) }
	var b bytes.Buffer
	fmt.Fprintf(&b, "From: %s\r\n", clean(from))
	fmt.Fprintf(&b, "To: %s\r\n", clean(strings.Join(to, ", ")))
	fmt.Fprintf(&b, "Subject: %s\r\n", mime.QEncoding.Encode("utf-8", clean(m.Title)))
	fmt.Fprintf(&b, "Date: %s\r\n", m.At.Format(time.RFC1123Z))
	b.WriteString("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n")
	body := strings.ReplaceAll(strings.ReplaceAll(m.Body, "\r\n", "\n"), "\n", "\r\n")
	b.WriteString(body)
	b.WriteString("\r\n")
	return b.Bytes()
}
