package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func sign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func TestValidSignature(t *testing.T) {
	secret := "topsecret"
	body := []byte(`{"ref":"refs/heads/main"}`)
	good := sign(secret, body)

	cases := []struct {
		name   string
		secret string
		header string
		body   []byte
		want   bool
	}{
		{"valid", secret, good, body, true},
		{"wrong secret", "other", good, body, false},
		{"tampered body", secret, good, []byte(`{"ref":"refs/heads/evil"}`), false},
		{"missing prefix", secret, hex.EncodeToString([]byte("x")), body, false},
		{"empty header", secret, "", body, false},
		{"not hex", secret, "sha256=zzzz", body, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := validSignature(c.secret, c.header, c.body); got != c.want {
				t.Fatalf("validSignature = %v, want %v", got, c.want)
			}
		})
	}
}

func TestSplitFullName(t *testing.T) {
	cases := []struct {
		in          string
		owner, repo string
		ok          bool
	}{
		{"octocat/hello", "octocat", "hello", true},
		{"a/b/c", "a", "b/c", true},
		{"noslash", "", "", false},
		{"/repo", "", "", false},
		{"owner/", "", "", false},
	}
	for _, c := range cases {
		owner, repo, ok := splitFullName(c.in)
		if owner != c.owner || repo != c.repo || ok != c.ok {
			t.Errorf("splitFullName(%q) = (%q,%q,%v), want (%q,%q,%v)", c.in, owner, repo, ok, c.owner, c.repo, c.ok)
		}
	}
}

func TestFirstLine(t *testing.T) {
	if got := firstLine("subject\n\nbody"); got != "subject" {
		t.Errorf("firstLine = %q", got)
	}
	if got := firstLine("oneline"); got != "oneline" {
		t.Errorf("firstLine = %q", got)
	}
}

func TestDeliveryCacheDedupes(t *testing.T) {
	c := &deliveryCache{ids: map[string]time.Time{}}
	if c.seen("a") {
		t.Fatal("unseen delivery reported as seen")
	}
	c.add("a")
	if !c.seen("a") {
		t.Fatal("added delivery must be seen")
	}
	c.ids["old"] = time.Now().Add(-2 * deliveryTTL)
	if c.seen("old") {
		t.Fatal("expired delivery must not count as seen")
	}
	for i := 0; i < deliveryCap+10; i++ {
		c.add(fmt.Sprintf("id-%d", i))
	}
	if len(c.ids) > deliveryCap {
		t.Fatalf("cache grew to %d, cap %d", len(c.ids), deliveryCap)
	}
}

func TestWebhookRejectsOversizedBody(t *testing.T) {
	s := &Server{}
	body := strings.NewReader(strings.Repeat("x", maxWebhookBody+1))
	req := httptest.NewRequest(http.MethodPost, "/api/github/webhook", body)
	rec := httptest.NewRecorder()
	s.githubWebhook(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}
