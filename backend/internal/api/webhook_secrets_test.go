package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pulsenode/backend/internal/db"
)

// newWebhookTestServer is newAuthTestServer plus an AES key (production always has
// one: main() calls EnsureEncryptionKey before serving).
func newWebhookTestServer(t *testing.T) *Server {
	t.Helper()
	t.Setenv("AES_KEY", "0123456789abcdef0123456789abcdef")
	return newAuthTestServer(t)
}

func webhookReq(body, sig, delivery string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/github/webhook", strings.NewReader(body))
	r.Header.Set("X-Hub-Signature-256", sig)
	r.Header.Set("X-GitHub-Event", "ping")
	if delivery != "" {
		r.Header.Set("X-GitHub-Delivery", delivery)
	}
	return r
}

func postWebhook(s *Server, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	s.githubWebhook(rec, r)
	return rec
}

func TestMasterWebhookSecretIsEncryptedAtRest(t *testing.T) {
	s := newWebhookTestServer(t)
	secret, err := s.getOrCreateWebhookSecret()
	if err != nil || secret == "" {
		t.Fatalf("secret: %q %v", secret, err)
	}
	stored, _ := s.db.GetSetting(webhookSecretKey)
	if stored == secret || !db.IsEncrypted(stored) {
		t.Fatal("master secret must be stored encrypted, not as plaintext")
	}
	again, _ := s.getOrCreateWebhookSecret()
	if again != secret {
		t.Fatal("secret must be stable across reads")
	}
}

func TestPlaintextWebhookSecretIsMigrated(t *testing.T) {
	s := newWebhookTestServer(t)
	legacy := "0123456789abcdef0123456789abcdef0123456789abcdef"
	if err := s.db.SetSetting(webhookSecretKey, legacy); err != nil {
		t.Fatal(err)
	}
	got, err := s.getOrCreateWebhookSecret()
	if err != nil || got != legacy {
		t.Fatalf("existing hooks must keep their secret: %q %v", got, err)
	}
	stored, _ := s.db.GetSetting(webhookSecretKey)
	if stored == legacy || !db.IsEncrypted(stored) {
		t.Fatal("plaintext secret must be re-encrypted in place")
	}
	if again, _ := s.getOrCreateWebhookSecret(); again != legacy {
		t.Fatalf("secret changed after migration: %q", again)
	}
}

func TestProjectWebhookSecretsAreDistinct(t *testing.T) {
	a, b := projectWebhookSecret("master", "p1"), projectWebhookSecret("master", "p2")
	if a == b || a == "master" || len(a) != 64 {
		t.Fatalf("derived secrets must differ per project and from the master: %q %q", a, b)
	}
	if projectWebhookSecret("master", "p1") != a {
		t.Fatal("derivation must be deterministic")
	}
	if projectWebhookSecret("other", "p1") == a {
		t.Fatal("derivation must depend on the master")
	}
}

func TestWebhookPerProjectAndLegacyVerification(t *testing.T) {
	s := newWebhookTestServer(t)
	master, _ := s.getOrCreateWebhookSecret()
	for _, p := range []*db.Project{
		{ID: "pa", Name: "a", RepoURL: "https://github.com/o/repoa", Branch: "main", BuildMethod: "auto"},
		{ID: "pb", Name: "b", RepoURL: "https://github.com/o/repob", Branch: "main", BuildMethod: "auto"},
	} {
		if err := s.db.CreateProject(p); err != nil {
			t.Fatal(err)
		}
	}
	bodyA := `{"zen":"a","repository":{"full_name":"o/repoa"}}`

	// The repo's own project secret is accepted.
	if rec := postWebhook(s, webhookReq(bodyA, sign(projectWebhookSecret(master, "pa"), []byte(bodyA)), "d-a1")); rec.Code != http.StatusOK {
		t.Fatalf("project secret rejected: %d %s", rec.Code, rec.Body)
	}
	// Another repo's project secret must NOT sign for repo A.
	bodyA2 := `{"zen":"a2","repository":{"full_name":"o/repoa"}}`
	if rec := postWebhook(s, webhookReq(bodyA2, sign(projectWebhookSecret(master, "pb"), []byte(bodyA2)), "d-a2")); rec.Code != http.StatusUnauthorized {
		t.Fatalf("a secret of a different repo's project signed for repo A: %d", rec.Code)
	}
	// An unknown repository can only be signed by the master.
	bodyU := `{"zen":"u","repository":{"full_name":"o/unknown"}}`
	if rec := postWebhook(s, webhookReq(bodyU, sign(projectWebhookSecret(master, "pa"), []byte(bodyU)), "d-u1")); rec.Code != http.StatusUnauthorized {
		t.Fatalf("project secret signed for an unknown repo: %d", rec.Code)
	}
	// Legacy shared secret keeps working until switched off.
	bodyL := `{"zen":"legacy","repository":{"full_name":"o/repoa"}}`
	if rec := postWebhook(s, webhookReq(bodyL, sign(master, []byte(bodyL)), "d-l1")); rec.Code != http.StatusOK {
		t.Fatalf("legacy secret should still be accepted: %d", rec.Code)
	}
	t.Setenv("PULSENODE_WEBHOOK_LEGACY_SECRET", "false")
	bodyL2 := `{"zen":"legacy2","repository":{"full_name":"o/repoa"}}`
	if rec := postWebhook(s, webhookReq(bodyL2, sign(master, []byte(bodyL2)), "d-l2")); rec.Code != http.StatusUnauthorized {
		t.Fatalf("legacy secret must be refused when disabled: %d", rec.Code)
	}
}

func TestWebhookRejectsMalformedSignatureBeforeAnyWork(t *testing.T) {
	s := newWebhookTestServer(t)
	for _, sig := range []string{"", "sha256=", "sha256=abcd", "md5=00", "sha256=" + strings.Repeat("z", 64)} {
		if rec := postWebhook(s, webhookReq(`{}`, sig, "")); rec.Code != http.StatusUnauthorized {
			t.Errorf("sig %q: want 401, got %d", sig, rec.Code)
		}
	}
}

// Replaying a captured signed body under a fresh X-GitHub-Delivery id must still
// be recognised: the id is an unsigned header, the signature is not.
func TestWebhookReplayWithChangedDeliveryIDIsDuplicate(t *testing.T) {
	s := newWebhookTestServer(t)
	master, _ := s.getOrCreateWebhookSecret()
	// A push for a repo with no project: processed (nothing triggered) and recorded.
	body := `{"ref":"refs/heads/main","zen":"replay-test-unique","repository":{"full_name":"o/none"}}`
	sig := sign(master, []byte(body))
	push := func(delivery string) *http.Request {
		r := webhookReq(body, sig, delivery)
		r.Header.Set("X-GitHub-Event", "push")
		return r
	}
	if rec := postWebhook(s, push("first-id")); rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "duplicate") {
		t.Fatalf("first delivery should be processed: %d %s", rec.Code, rec.Body)
	}
	rec := postWebhook(s, push("different-id"))
	if !strings.Contains(rec.Body.String(), "duplicate") {
		t.Fatalf("replay with a new delivery id must be flagged duplicate: %d %s", rec.Code, rec.Body)
	}
}
