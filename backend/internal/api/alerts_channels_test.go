package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"pulsenode/backend/internal/db"
)

func newChannelTestServer(t *testing.T) (*Server, http.Handler) {
	t.Helper()
	t.Setenv("AES_KEY", strings.Repeat("k", 32))
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{db: d}
	r := chi.NewRouter()
	r.Get("/alerts/channels", s.listNotificationChannels)
	r.Post("/alerts/channels", s.createNotificationChannel)
	r.Patch("/alerts/channels/{id}", s.updateNotificationChannel)
	r.Post("/alerts/channels/test", s.testDraftChannel)
	return s, r
}

func doJSON(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
	return rec
}

func createChannel(t *testing.T, h http.Handler, body string) string {
	t.Helper()
	rec := doJSON(h, http.MethodPost, "/alerts/channels", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	var v struct{ ID string }
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil || v.ID == "" {
		t.Fatalf("create response: %s", rec.Body.String())
	}
	return v.ID
}

func TestChannelListNeverReturnsWebhookURLOrSecrets(t *testing.T) {
	_, h := newChannelTestServer(t)
	createChannel(t, h, `{"name":"hook","type":"webhook","config":{"url":"https://ntfy.example.com/topic-PATHSECRET?auth=QUERYSECRET","secret":"HMACSECRET"}}`)
	createChannel(t, h, `{"name":"mail","type":"smtp","config":{"host":"smtp.example.com","port":"587","username":"u","password":"SMTPSECRET","from":"a@b.co","to":"c@d.co"}}`)
	createChannel(t, h, `{"name":"slack","type":"slack","config":{"webhookUrl":"https://hooks.slack.com/services/T/B/SLACKSECRET"}}`)

	rec := doJSON(h, http.MethodGet, "/alerts/channels", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d", rec.Code)
	}
	body := rec.Body.String()
	for _, secret := range []string{"PATHSECRET", "QUERYSECRET", "HMACSECRET", "SMTPSECRET", "SLACKSECRET"} {
		if strings.Contains(body, secret) {
			t.Fatalf("response leaked %s: %s", secret, body)
		}
	}
	for _, want := range []string{`"urlSet":"true"`, `"urlHint":"https://ntfy.example.com/…"`, `"passwordSet":"true"`, `"webhookUrlHint":"https://hooks.slack.com/…"`} {
		if !strings.Contains(body, want) {
			t.Errorf("response missing %s: %s", want, body)
		}
	}
}

func TestChannelPatchRefusesToRedirectStoredSecrets(t *testing.T) {
	s, h := newChannelTestServer(t)
	id := createChannel(t, h, `{"name":"mail","type":"smtp","config":{"host":"smtp.example.com","port":"587","username":"u","password":"SMTPSECRET","from":"a@b.co","to":"c@d.co"}}`)

	// Moving the host without re-entering the password must fail with a message naming both.
	rec := doJSON(h, http.MethodPatch, "/alerts/channels/"+id, `{"config":{"host":"evil.example.net","port":"587","username":"u","password":"","from":"a@b.co","to":"c@d.co"}}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "password") || !strings.Contains(rec.Body.String(), "host") {
		t.Fatalf("want 400 naming password+host, got %d %s", rec.Code, rec.Body.String())
	}
	c, _ := s.db.GetNotificationChannel(id)
	plain, _ := db.Decrypt(c.Config)
	if !strings.Contains(plain, "smtp.example.com") || strings.Contains(plain, "evil.example.net") {
		t.Fatalf("stored channel must be unchanged: %s", plain)
	}

	// Same destination + blank password: allowed, password kept.
	rec = doJSON(h, http.MethodPatch, "/alerts/channels/"+id, `{"config":{"host":"smtp.example.com","port":"587","username":"u","password":"","from":"a@b.co","to":"new@d.co"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("same destination edit: %d %s", rec.Code, rec.Body.String())
	}
	c, _ = s.db.GetNotificationChannel(id)
	if plain, _ = db.Decrypt(c.Config); !strings.Contains(plain, "SMTPSECRET") || !strings.Contains(plain, "new@d.co") {
		t.Fatalf("password must be kept and recipient updated: %s", plain)
	}

	// New host with a re-entered password: allowed.
	rec = doJSON(h, http.MethodPatch, "/alerts/channels/"+id, `{"config":{"host":"smtp.other.org","port":"587","username":"u","password":"fresh","from":"a@b.co","to":"new@d.co"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("re-entered password: %d %s", rec.Code, rec.Body.String())
	}
}

func TestChannelDraftTestFollowsSameRule(t *testing.T) {
	_, h := newChannelTestServer(t)
	id := createChannel(t, h, `{"name":"mail","type":"smtp","config":{"host":"smtp.example.com","port":"587","username":"u","password":"SMTPSECRET","from":"a@b.co","to":"c@d.co"}}`)

	rec := doJSON(h, http.MethodPost, "/alerts/channels/test", `{"id":"`+id+`","name":"mail","type":"smtp","config":{"host":"evil.example.net","port":"587","username":"u","password":"","from":"a@b.co","to":"c@d.co"}}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "password") {
		t.Fatalf("draft test to a new host must demand the password: %d %s", rec.Code, rec.Body.String())
	}

	// Webhook: draft with a new host and blank signing secret is refused before anything is sent.
	hid := createChannel(t, h, `{"name":"hook","type":"webhook","config":{"url":"https://hooks.example.com/a","secret":"HMACSECRET"}}`)
	rec = doJSON(h, http.MethodPost, "/alerts/channels/test", `{"id":"`+hid+`","name":"hook","type":"webhook","config":{"url":"https://attacker.example.net/x","secret":""}}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "secret") {
		t.Fatalf("webhook draft to a new host: %d %s", rec.Code, rec.Body.String())
	}
}

func TestChannelCreateRejectsUnpinnedChatHosts(t *testing.T) {
	_, h := newChannelTestServer(t)
	rec := doJSON(h, http.MethodPost, "/alerts/channels", `{"name":"s","type":"slack","config":{"webhookUrl":"https://example.com/services/T/B/x"}}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("slack on a foreign host must be rejected, got %d %s", rec.Code, rec.Body.String())
	}
}
