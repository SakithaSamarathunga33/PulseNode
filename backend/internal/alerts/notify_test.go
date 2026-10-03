package alerts

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pulsenode/backend/internal/db"
)

func TestIsBlockedIP(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "10.1.2.3", "172.16.0.5", "172.31.255.255", "192.168.1.1", "169.254.169.254",
		"100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
	}
	for _, s := range blocked {
		if !IsBlockedIP(net.ParseIP(s)) {
			t.Errorf("%s should be blocked", s)
		}
	}
	allowed := []string{"8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"}
	for _, s := range allowed {
		if IsBlockedIP(net.ParseIP(s)) {
			t.Errorf("%s should be allowed", s)
		}
	}
	if !IsBlockedIP(nil) {
		t.Error("nil IP must be blocked")
	}
}

func TestCheckURL(t *testing.T) {
	bad := []string{
		"", "ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "http://", "https://user:pw@example.com/",
		"http://127.0.0.1/hook", "http://localhost:8080/", "http://app.localhost/", "http://169.254.169.254/latest/meta-data",
		"http://[::1]/", "http://10.0.0.7/x", "http://metadata.google.internal/",
	}
	for _, u := range bad {
		if _, err := CheckURL(u); err == nil {
			t.Errorf("CheckURL(%q) should fail", u)
		}
	}
	for _, u := range []string{"https://hooks.slack.com/services/T/B/x", "http://example.com/h", "https://8.8.8.8/h"} {
		if _, err := CheckURL(u); err != nil {
			t.Errorf("CheckURL(%q) = %v", u, err)
		}
	}
	t.Setenv("PULSENODE_ALERTS_ALLOW_PRIVATE", "true")
	if _, err := CheckURL("http://10.0.0.7/x"); err != nil {
		t.Errorf("opt-out should allow private targets: %v", err)
	}
}

func TestDialGuardBlocksPrivateButOptOutWorks(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer srv.Close()

	s := NewSender()
	ch := Channel{Type: TypeWebhook, Config: map[string]string{"url": srv.URL}}
	// CheckURL already rejects the loopback literal, and so would the dialer.
	if err := s.Send(context.Background(), ch, Message{Title: "t"}); err == nil {
		t.Fatal("loopback webhook must be refused")
	}
	if hits != 0 {
		t.Fatal("request must never reach a loopback server")
	}

	// The dial-time guard must also stop a request that got past CheckURL.
	req, _ := http.NewRequest(http.MethodPost, srv.URL, nil)
	if _, err := s.HTTP.Do(req); err == nil || hits != 0 {
		t.Fatalf("dialer must refuse loopback even when called directly (err=%v hits=%d)", err, hits)
	}

	t.Setenv("PULSENODE_ALERTS_ALLOW_PRIVATE", "true")
	ch.Config["url"] = srv.URL
	if err := s.Send(context.Background(), ch, Message{Title: "t"}); err != nil || hits != 1 {
		t.Fatalf("opt-out should deliver: err=%v hits=%d", err, hits)
	}
}

func TestWebhookSignatureAndPayload(t *testing.T) {
	t.Setenv("PULSENODE_ALERTS_ALLOW_PRIVATE", "true")
	var gotSig, gotCT string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSig, gotCT = r.Header.Get("X-PulseNode-Signature"), r.Header.Get("Content-Type")
		gotBody, _ = io.ReadAll(r.Body)
	}))
	defer srv.Close()

	ch := Channel{Type: TypeWebhook, Config: map[string]string{"url": srv.URL, "secret": "s3cret"}}
	err := NewSender().Send(context.Background(), ch, Message{Title: "T", Body: "B", Severity: "critical", State: "firing", At: time.Unix(0, 0)})
	if err != nil {
		t.Fatal(err)
	}
	mac := hmac.New(sha256.New, []byte("s3cret"))
	mac.Write(gotBody)
	if want := "sha256=" + hex.EncodeToString(mac.Sum(nil)); gotSig != want {
		t.Fatalf("signature %q, want %q", gotSig, want)
	}
	if gotCT != "application/json" || !strings.Contains(string(gotBody), `"source":"pulsenode"`) {
		t.Fatalf("bad request: %s %s", gotCT, gotBody)
	}
}

func TestRedirectsAreNotFollowedAndErrorsAreReported(t *testing.T) {
	t.Setenv("PULSENODE_ALERTS_ALLOW_PRIVATE", "true")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/", http.StatusFound)
	}))
	defer srv.Close()
	err := NewSender().Send(context.Background(), Channel{Type: TypeWebhook, Config: map[string]string{"url": srv.URL}}, Message{})
	if err == nil || !strings.Contains(err.Error(), "302") {
		t.Fatalf("a redirect must surface as a failure, got %v", err)
	}
}

func TestErrorsNeverLeakSecretsInURL(t *testing.T) {
	t.Setenv("PULSENODE_ALERTS_ALLOW_PRIVATE", "true")
	// A refused connection produces a *url.Error that embeds the full request URL.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	_ = ln.Close()
	target := "http://" + addr + "/bot123456:ABCDEFGHIJKLMNOPQRSTUVWX/sendMessage"
	err := NewSender().postRaw(context.Background(), target, []byte("{}"), nil)
	if err == nil {
		t.Fatal("expected a connection error")
	}
	if strings.Contains(err.Error(), "ABCDEFGHIJKLMNOPQRSTUVWX") {
		t.Fatalf("token leaked: %v", err)
	}
}

func TestSlackAndDiscordRequireHTTPS(t *testing.T) {
	for _, typ := range []string{TypeSlack, TypeDiscord} {
		if err := ValidateConfig(typ, map[string]string{"webhookUrl": "http://example.com/x"}); err == nil {
			t.Errorf("%s over http should be rejected", typ)
		}
		if err := ValidateConfig(typ, map[string]string{"webhookUrl": "https://example.com/x"}); err != nil {
			t.Errorf("%s over https: %v", typ, err)
		}
	}
}

func TestValidateConfig(t *testing.T) {
	good := map[string]map[string]string{
		TypeWebhook:  {"url": "https://example.com/h"},
		TypeTelegram: {"botToken": "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", "chatId": "-100123"},
		TypeSMTP:     {"host": "smtp.example.com", "port": "587", "from": "PulseNode <alerts@example.com>", "to": "a@example.com, b@example.com"},
	}
	for typ, cfg := range good {
		if err := ValidateConfig(typ, cfg); err != nil {
			t.Errorf("%s: %v", typ, err)
		}
	}
	bad := []struct {
		typ string
		cfg map[string]string
	}{
		{"nope", map[string]string{}},
		{TypeWebhook, map[string]string{}},
		{TypeTelegram, map[string]string{"botToken": "x", "chatId": "1"}},
		{TypeTelegram, map[string]string{"botToken": "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", "chatId": "not a chat"}},
		{TypeSMTP, map[string]string{"host": "h", "port": "99999", "from": "a@b.c", "to": "a@b.c"}},
		{TypeSMTP, map[string]string{"host": "h", "port": "25", "from": "nope", "to": "a@b.c"}},
		{TypeSMTP, map[string]string{"host": "h", "port": "25", "from": "a@b.c", "to": ""}},
		{TypeSMTP, map[string]string{"host": "h\r\nRCPT", "port": "25", "from": "a@b.c", "to": "a@b.c"}},
		{TypeSMTP, map[string]string{"host": "h", "port": "25", "from": "a@b.c", "to": "a@b.c", "security": "ssl3"}},
	}
	for i, c := range bad {
		if err := ValidateConfig(c.typ, c.cfg); err == nil {
			t.Errorf("bad case %d (%s) accepted", i, c.typ)
		}
	}
}

func TestSecretsMergeAndRedaction(t *testing.T) {
	old := map[string]string{"host": "h", "password": "pw-old", "port": "25"}
	merged := MergeConfig(TypeSMTP, old, map[string]string{"host": "h2", "password": "", "port": "587"})
	if merged["password"] != "pw-old" || merged["host"] != "h2" {
		t.Fatalf("blank secret must keep the stored value: %v", merged)
	}
	merged = MergeConfig(TypeSMTP, old, map[string]string{"password": "new"})
	if merged["password"] != "new" {
		t.Fatal("a supplied secret must replace the stored one")
	}
	pub := PublicConfig(TypeSMTP, old)
	if _, leaked := pub["password"]; leaked || pub["passwordSet"] != "true" || pub["host"] != "h" {
		t.Fatalf("public view must hide secrets: %v", pub)
	}
	pub = PublicConfig(TypeSlack, map[string]string{"webhookUrl": "https://hooks.slack.com/services/SECRET"})
	if _, leaked := pub["webhookUrl"]; leaked {
		t.Fatal("slack webhook URL is a secret")
	}
	if s := Summary(TypeSlack, map[string]string{"webhookUrl": "https://hooks.slack.com/services/SECRET"}); strings.Contains(s, "SECRET") {
		t.Fatalf("summary leaked the secret path: %q", s)
	}
}

func TestEncodeDecodeRoundTripEncrypts(t *testing.T) {
	t.Setenv("AES_KEY", strings.Repeat("k", 32))
	enc, err := EncodeConfig(map[string]string{"url": "https://example.com/secret-path", "secret": "s"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(enc, "example.com") || strings.Contains(enc, "secret-path") {
		t.Fatal("stored config must be encrypted")
	}
	ch, err := DecodeChannel(db.NotificationChannel{ID: "c", Name: "n", Type: TypeWebhook, Config: enc})
	if err != nil || ch.Config["url"] != "https://example.com/secret-path" {
		t.Fatalf("round trip failed: %v %v", ch, err)
	}
	// Legacy rows stored plain JSON.
	ch, err = DecodeChannel(db.NotificationChannel{ID: "c", Type: TypeWebhook, Config: `{"url":"https://x.test/h","n":3}`})
	if err != nil || ch.Config["url"] != "https://x.test/h" || ch.Config["n"] != "3" {
		t.Fatalf("legacy config: %v %v", ch, err)
	}
}

func TestEmailHeadersCannotBeInjected(t *testing.T) {
	m := Message{Title: "Down\r\nBcc: evil@example.com", Body: "line1\nline2", At: time.Unix(0, 0)}
	out := string(buildEmail("PulseNode <a@b.c>", []string{"x@y.z"}, m))
	head := out[:strings.Index(out, "\r\n\r\n")]
	if strings.Contains(strings.ToLower(head), "\r\nbcc:") {
		t.Fatalf("header injection: %q", head)
	}
	if !strings.Contains(out, "line1\r\nline2") {
		t.Fatalf("body newlines must be CRLF: %q", out)
	}
}

func TestSMTPSendUsesGuardedDialer(t *testing.T) {
	s := NewSender()
	s.Dial = func(context.Context, string) (net.Conn, error) { return nil, errors.New("dial refused") }
	err := s.Send(context.Background(), Channel{Type: TypeSMTP, Config: map[string]string{
		"host": "smtp.example.com", "port": "587", "from": "a@b.c", "to": "d@e.f"}}, Message{Title: "t"})
	if err == nil || !strings.Contains(err.Error(), "dial refused") {
		t.Fatalf("got %v", err)
	}
	// The real dialer refuses loopback SMTP targets.
	real := NewSender()
	err = real.Send(context.Background(), Channel{Type: TypeSMTP, Config: map[string]string{
		"host": "127.0.0.1", "port": "25", "from": "a@b.c", "to": "d@e.f"}}, Message{Title: "t"})
	if err == nil || !strings.Contains(err.Error(), "private or reserved") {
		t.Fatalf("loopback SMTP must be blocked, got %v", err)
	}
}

func TestChatTextIsEscapedAndTruncated(t *testing.T) {
	if got := slackEscape("<!channel> a & b"); got != "&lt;!channel&gt; a &amp; b" {
		t.Fatalf("slack text must be escaped: %s", got)
	}
	if got := truncate(strings.Repeat("é", 2000), 1900); len([]rune(got)) != 1900 {
		t.Fatalf("truncate by runes failed: %d", len([]rune(got)))
	}
}
