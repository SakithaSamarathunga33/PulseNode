package alerts

import (
	"net"
	"strings"
	"testing"
)

func TestIsBlockedIPTransitionAndSpecialRanges(t *testing.T) {
	blocked := []string{
		// IPv4 specials
		"0.1.2.3", "100.127.255.254", "192.0.0.8", "198.18.0.1", "198.19.255.255", "240.0.0.1", "255.255.255.254",
		// NAT64 well-known and local-use prefixes (can embed any IPv4, including private)
		"64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b::808:808", "64:ff9b:1::1",
		// 6to4, Teredo, site-local, discard-only, documentation
		"2002:7f00:1::", "2002:a00:1::1", "2002:808:808::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "fec0::1", "100::1", "2001:db8::1",
		// IPv4-mapped normalisation still applies
		"::ffff:169.254.169.254", "::ffff:100.64.0.1",
	}
	for _, s := range blocked {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("bad test address %q", s)
		}
		if !IsBlockedIP(ip) {
			t.Errorf("%s should be blocked", s)
		}
	}
	allowed := []string{"8.8.8.8", "1.1.1.1", "93.184.216.34", "100.128.0.1", "198.20.0.1", "223.255.255.254", "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001::1"}
	for _, s := range allowed {
		if IsBlockedIP(net.ParseIP(s)) {
			t.Errorf("%s should be allowed", s)
		}
	}
}

func TestMaskURLHidesPathAndQuery(t *testing.T) {
	cases := map[string]string{
		"https://ntfy.example.com/topic-secret?auth=tok": "https://ntfy.example.com/…",
		"https://hooks.slack.com/services/T/B/SECRET":    "https://hooks.slack.com/…",
		"https://example.com:8443/h":                     "https://example.com:8443/…",
		"https://example.com/":                           "https://example.com",
		"https://example.com":                            "https://example.com",
		"not a url":                                      "•••",
	}
	for in, want := range cases {
		if got := MaskURL(in); got != want {
			t.Errorf("MaskURL(%q) = %q, want %q", in, got, want)
		}
		if strings.Contains(MaskURL(in), "SECRET") || strings.Contains(MaskURL(in), "tok") {
			t.Errorf("MaskURL(%q) leaked a secret: %q", in, MaskURL(in))
		}
	}
}

func TestPublicConfigHidesWebhookURL(t *testing.T) {
	cfg := map[string]string{"url": "https://ntfy.example.com/topic-SECRET?auth=tok", "secret": "hmac"}
	pub := PublicConfig(TypeWebhook, cfg)
	if _, leaked := pub["url"]; leaked {
		t.Fatalf("webhook url must not be returned: %v", pub)
	}
	if _, leaked := pub["secret"]; leaked {
		t.Fatalf("signing secret must not be returned: %v", pub)
	}
	if pub["urlSet"] != "true" || pub["urlHint"] != "https://ntfy.example.com/…" || pub["secretSet"] != "true" {
		t.Fatalf("expected urlSet/urlHint/secretSet flags: %v", pub)
	}
	for k, v := range pub {
		if strings.Contains(v, "SECRET") || strings.Contains(v, "tok") && k != "urlHint" {
			t.Errorf("%s leaks: %q", k, v)
		}
	}
	// Chat tokens and the Telegram bot token stay hidden too.
	pub = PublicConfig(TypeSlack, map[string]string{"webhookUrl": "https://hooks.slack.com/services/T/B/SECRET"})
	if _, ok := pub["webhookUrl"]; ok || pub["webhookUrlHint"] != "https://hooks.slack.com/…" || pub["webhookUrlSet"] != "true" {
		t.Fatalf("slack view: %v", pub)
	}
	pub = PublicConfig(TypeTelegram, map[string]string{"botToken": "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", "chatId": "-100"})
	if _, ok := pub["botToken"]; ok || pub["botTokenSet"] != "true" || pub["chatId"] != "-100" {
		t.Fatalf("telegram view: %v", pub)
	}
}

func TestMergeConfigSecretsStayWithTheirDestination(t *testing.T) {
	smtpOld := map[string]string{"host": "smtp.example.com", "port": "587", "username": "u", "password": "pw", "security": "starttls", "from": "a@b.c", "to": "d@e.f"}
	smtpSame := func(mut func(m map[string]string)) map[string]string {
		m := map[string]string{"host": "smtp.example.com", "port": "587", "username": "u", "password": "", "security": "starttls", "from": "a@b.c", "to": "d@e.f"}
		if mut != nil {
			mut(m)
		}
		return m
	}

	// Same destination: stored password is kept (also when only from/to change, and host case differs).
	for name, upd := range map[string]map[string]string{
		"unchanged":   smtpSame(nil),
		"recipients":  smtpSame(func(m map[string]string) { m["to"] = "x@y.z" }),
		"host case":   smtpSame(func(m map[string]string) { m["host"] = "SMTP.Example.com" }),
		"default sec": smtpSame(func(m map[string]string) { m["security"] = "" }),
	} {
		got, err := MergeConfig(TypeSMTP, smtpOld, upd)
		if err != nil || got["password"] != "pw" {
			t.Errorf("%s: want kept password, got %v %v", name, got, err)
		}
	}

	// Moved destination + blank password: rejected, naming the field.
	for field, mut := range map[string]func(m map[string]string){
		"host":     func(m map[string]string) { m["host"] = "evil.example.net" },
		"port":     func(m map[string]string) { m["port"] = "25" },
		"username": func(m map[string]string) { m["username"] = "someone-else" },
		"security": func(m map[string]string) { m["security"] = "none" },
	} {
		got, err := MergeConfig(TypeSMTP, smtpOld, smtpSame(mut))
		if err == nil {
			t.Errorf("%s change with blank password must be rejected, got %v", field, got)
			continue
		}
		if !strings.Contains(err.Error(), "password") || !strings.Contains(err.Error(), field) {
			t.Errorf("error should name password and %s: %v", field, err)
		}
	}
	// Moved destination + a freshly typed password is fine.
	if got, err := MergeConfig(TypeSMTP, smtpOld, smtpSame(func(m map[string]string) { m["host"] = "new.example.org"; m["password"] = "typed" })); err != nil || got["password"] != "typed" {
		t.Errorf("re-entered password must be accepted: %v %v", got, err)
	}
	// Nothing stored, nothing to protect.
	if _, err := MergeConfig(TypeSMTP, map[string]string{"host": "a", "port": "25"}, smtpSame(nil)); err != nil {
		t.Errorf("no stored password: %v", err)
	}

	// Webhook: blank URL keeps stored URL + secret; same host, new path keeps the signing secret;
	// a different host with a blank signing secret is rejected.
	whOld := map[string]string{"url": "https://hooks.example.com/a?t=1", "secret": "hmac"}
	got, err := MergeConfig(TypeWebhook, whOld, map[string]string{"url": "", "secret": ""})
	if err != nil || got["url"] != whOld["url"] || got["secret"] != "hmac" {
		t.Errorf("blank url+secret must keep both: %v %v", got, err)
	}
	got, err = MergeConfig(TypeWebhook, whOld, map[string]string{"url": "https://hooks.example.com/b", "secret": ""})
	if err != nil || got["secret"] != "hmac" || got["url"] != "https://hooks.example.com/b" {
		t.Errorf("same host: %v %v", got, err)
	}
	if got, err = MergeConfig(TypeWebhook, whOld, map[string]string{"url": "https://attacker.example.net/x", "secret": ""}); err == nil {
		t.Errorf("new host with blank signing secret must be rejected: %v", got)
	} else if !strings.Contains(err.Error(), "secret") || !strings.Contains(err.Error(), "url") {
		t.Errorf("error should name secret and url: %v", err)
	}
	if got, err = MergeConfig(TypeWebhook, whOld, map[string]string{"url": "https://other.example.net/x", "secret": "new"}); err != nil || got["secret"] != "new" {
		t.Errorf("new host + new secret: %v %v", got, err)
	}
	// No signing secret stored: moving the URL is allowed (nothing to leak).
	if _, err = MergeConfig(TypeWebhook, map[string]string{"url": "https://a.example.com/x"}, map[string]string{"url": "https://b.example.com/x"}); err != nil {
		t.Errorf("no stored secret: %v", err)
	}
}

func TestChatWebhookHostsArePinned(t *testing.T) {
	ok := map[string]string{
		TypeSlack:   "https://hooks.slack.com/services/T000/B000/XXXX",
		TypeDiscord: "https://discord.com/api/webhooks/123/abc",
	}
	for typ, u := range ok {
		if err := ValidateConfig(typ, map[string]string{"webhookUrl": u}); err != nil {
			t.Errorf("%s %s: %v", typ, u, err)
		}
	}
	for _, u := range []string{"https://discordapp.com/api/webhooks/1/a", "https://ptb.discord.com/api/webhooks/1/a", "https://canary.discord.com/api/webhooks/1/a"} {
		if err := ValidateConfig(TypeDiscord, map[string]string{"webhookUrl": u}); err != nil {
			t.Errorf("discord %s: %v", u, err)
		}
	}
	bad := map[string][]string{
		TypeSlack: {
			"https://example.com/services/T/B/x",              // wrong host
			"https://hooks.slack.com.evil.net/services/T/B/x", // look-alike suffix
			"https://evilhooks.slack.com/services/T/B/x",      // look-alike prefix
			"https://hooks.slack.com/other/path",              // wrong path
			"https://hooks.slack.com:8443/services/T/B/x",     // odd port
			"https://8.8.8.8/services/T/B/x",                  // IP literal
		},
		TypeDiscord: {
			"https://example.com/api/webhooks/1/a",
			"https://discord.com.evil.net/api/webhooks/1/a",
			"https://discord.com/not-a-webhook",
			"https://cdn.discordapp.com/api/webhooks/1/a",
		},
	}
	for typ, urls := range bad {
		for _, u := range urls {
			if err := ValidateConfig(typ, map[string]string{"webhookUrl": u}); err == nil {
				t.Errorf("%s %q must be rejected", typ, u)
			}
		}
	}

	// Documented overrides.
	t.Setenv("PULSENODE_ALERTS_ALLOW_ANY_WEBHOOK_HOST", "true")
	if err := ValidateConfig(TypeSlack, map[string]string{"webhookUrl": "https://mattermost.example.com/hooks/abc"}); err != nil {
		t.Errorf("override should allow a Slack-compatible host: %v", err)
	}
	t.Setenv("PULSENODE_ALERTS_ALLOW_ANY_WEBHOOK_HOST", "")
	t.Setenv("PULSENODE_ALERTS_ALLOW_PRIVATE", "true")
	if err := ValidateConfig(TypeDiscord, map[string]string{"webhookUrl": "https://chat.internal.lan/hook"}); err != nil {
		t.Errorf("allow-private should also lift the pin: %v", err)
	}
}
