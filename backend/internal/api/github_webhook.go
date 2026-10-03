package api

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"pulsenode/backend/internal/db"
	"pulsenode/backend/internal/github"
	"pulsenode/backend/internal/queue"
)

const webhookSecretKey = "github_webhook_secret"

// getOrCreateWebhookSecret returns the master webhook secret, generating and
// persisting one the first time it's requested. It is stored ENCRYPTED; a
// plaintext value written by an older version is re-encrypted in place. The master
// is the legacy shared secret (hooks installed before per-project secrets keep
// signing with it) and the root of every per-project secret.
func (s *Server) getOrCreateWebhookSecret() (string, error) {
	stored, err := s.db.GetSetting(webhookSecretKey)
	if err != nil {
		return "", err
	}
	if stored == "" {
		b := make([]byte, 24)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		secret := hex.EncodeToString(b)
		enc, err := db.Encrypt(secret)
		if err != nil {
			return "", err
		}
		if err := s.db.SetSetting(webhookSecretKey, enc); err != nil {
			return "", err
		}
		return secret, nil
	}
	if !db.IsEncrypted(stored) { // legacy plaintext: migrate
		if enc, err := db.Encrypt(stored); err == nil {
			if err := s.db.SetSetting(webhookSecretKey, enc); err != nil {
				log.Printf("[webhook] could not encrypt stored secret: %v", err)
			}
		}
		return stored, nil
	}
	return db.Decrypt(stored)
}

// projectWebhookSecret derives the secret for one project from the master:
// HMAC-SHA256(master, "project:"+id). GitHub signs with ONE secret per hook, so
// installing this per project means someone who administers repo A's hook (and so
// sees its secret) cannot forge pushes for repo B's projects.
func projectWebhookSecret(master, projectID string) string {
	mac := hmac.New(sha256.New, []byte(master))
	mac.Write([]byte("project:" + projectID))
	return hex.EncodeToString(mac.Sum(nil))
}

// legacyWebhookSecretAllowed reports whether deliveries signed with the shared
// master secret are still accepted (hooks installed by older versions). Set
// PULSENODE_WEBHOOK_LEGACY_SECRET=false once every hook was repaired.
func legacyWebhookSecretAllowed() bool {
	return !strings.EqualFold(os.Getenv("PULSENODE_WEBHOOK_LEGACY_SECRET"), "false")
}

// webhookTargetURL is the public URL GitHub should deliver push events to. It
// mirrors the OAuth-callback derivation (NEXT_PUBLIC_ORIGIN + the /go Caddy
// prefix). Empty when the origin isn't configured.
func (s *Server) webhookTargetURL() string {
	origin := strings.TrimRight(os.Getenv("NEXT_PUBLIC_ORIGIN"), "/")
	if origin == "" {
		return ""
	}
	return origin + "/go/api/github/webhook"
}

// installProjectWebhook best-effort registers the push webhook on a project's
// repo using the connected GitHub token, so users don't have to add it by hand.
// Returns a short status: installed | exists | skipped | error.
func (s *Server) installProjectWebhook(proj *db.Project) (string, error) {
	hookURL := s.webhookTargetURL()
	if hookURL == "" {
		return "skipped", fmt.Errorf("NEXT_PUBLIC_ORIGIN is not configured")
	}
	owner, repo, ok := github.ParseOwnerRepo(proj.RepoURL)
	if !ok {
		return "skipped", fmt.Errorf("not a GitHub repository")
	}
	acct, _ := s.db.GetGitHubAccount()
	if acct == nil {
		return "skipped", fmt.Errorf("GitHub account not connected")
	}
	master, err := s.getOrCreateWebhookSecret()
	if err != nil {
		return "error", err
	}
	// Per-project secret. An existing hook for the repo is left as is (it keeps
	// whatever secret it was created with, which the handler still accepts).
	created, err := github.NewClient(acct.AccessToken).EnsureWebhook(owner, repo, hookURL, projectWebhookSecret(master, proj.ID))
	if err != nil {
		return "error", err
	}
	if created {
		return "installed", nil
	}
	return "exists", nil
}

// getProjectWebhook reports whether the auto-deploy push webhook is installed on
// the project's repo.
func (s *Server) getProjectWebhook(w http.ResponseWriter, r *http.Request) {
	proj, err := s.db.GetProject(chi.URLParam(r, "id"))
	if err != nil || proj == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "project not found"})
		return
	}
	hookURL := s.webhookTargetURL()
	resp := map[string]any{"url": hookURL, "installed": false, "supported": false}
	owner, repo, ok := github.ParseOwnerRepo(proj.RepoURL)
	acct, _ := s.db.GetGitHubAccount()
	if ok && acct != nil && hookURL != "" {
		resp["supported"] = true
		has, err := github.NewClient(acct.AccessToken).HasWebhook(owner, repo, hookURL)
		if err != nil {
			resp["error"] = err.Error()
		} else {
			resp["installed"] = has
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// installProjectWebhookHandler (re)installs the webhook on demand — for projects
// created before GitHub was connected, or to repair a missing/removed hook.
func (s *Server) installProjectWebhookHandler(w http.ResponseWriter, r *http.Request) {
	proj, err := s.db.GetProject(chi.URLParam(r, "id"))
	if err != nil || proj == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "project not found"})
		return
	}
	status, err := s.installProjectWebhook(proj)
	resp := map[string]any{
		"status":    status,
		"url":       s.webhookTargetURL(),
		"installed": status == "installed" || status == "exists",
	}
	if err != nil {
		resp["error"] = err.Error()
	}
	writeJSON(w, http.StatusOK, resp)
}

// githubWebhookInfo returns the secret the user must configure on the GitHub
// webhook. The frontend builds the full URL from its own origin + the go-api
// base path, so this only needs to hand back the secret and the event list.
func (s *Server) githubWebhookInfo(w http.ResponseWriter, r *http.Request) {
	secret, err := s.getOrCreateWebhookSecret()
	if err != nil {
		writeError(w, err)
		return
	}
	// ?project=<id> returns that project's own secret (for a manual hook); without
	// it the shared legacy secret is returned.
	if id := r.URL.Query().Get("project"); id != "" {
		secret = projectWebhookSecret(secret, id)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"secret":      secret,
		"path":        "/api/github/webhook",
		"contentType": "application/json",
		"events":      []string{"push"},
	})
}

// githubWebhook receives GitHub push events and queues auto-deploys for matching
// projects. It is public (no auth middleware) but every request is authenticated
// by verifying the HMAC-SHA256 signature against the stored secret. The branch
// poller remains as a fallback for installs that haven't configured webhooks.
func (s *Server) githubWebhook(w http.ResponseWriter, r *http.Request) {
	// The HMAC needs the whole body, so bound the read up front instead of letting an unauthenticated POST stream
	// unlimited data into memory.
	r.Body = http.MaxBytesReader(w, r.Body, maxWebhookBody)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "payload too large"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "read body"})
		return
	}

	// Cheap pre-checks before any parsing or secret derivation: the signature
	// header must be well formed (sha256= + 32 hex-encoded bytes).
	sigHeader := r.Header.Get("X-Hub-Signature-256")
	sigBytes, ok := decodeSignatureHeader(sigHeader)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid signature"})
		return
	}

	master, err := s.getOrCreateWebhookSecret()
	if err != nil || master == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "webhook secret unavailable"})
		return
	}
	// The repository named in the payload selects which per-project secrets can
	// have signed it. It is untrusted until the signature below verifies, and only
	// narrows the candidates (an unknown repo can only be signed by the master).
	var named struct {
		Repository struct {
			FullName string `json:"full_name"`
		} `json:"repository"`
	}
	_ = json.Unmarshal(body, &named)
	projects, err := s.db.ListProjects()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "unavailable"})
		return
	}
	candidates := []string{}
	if wo, wr, ok := splitFullName(named.Repository.FullName); ok {
		for _, p := range projects {
			if o, r2, ok := github.ParseOwnerRepo(p.RepoURL); ok && strings.EqualFold(o, wo) && strings.EqualFold(r2, wr) {
				candidates = append(candidates, projectWebhookSecret(master, p.ID))
			}
		}
	}
	if legacyWebhookSecretAllowed() {
		candidates = append(candidates, master) // hooks installed before per-project secrets
	}
	// Also accept events signed with the GitHub App webhook secret so both
	// per-repo hooks and GitHub App installations share the same endpoint.
	appSecret, _ := s.db.GetSetting("github_app_webhook_secret")
	if appSecret != "" && appSecret != publicDefaultAppWebhookSecret { // that default was published in the old compose file
		candidates = append(candidates, appSecret)
	}
	verified := false
	for _, c := range candidates {
		if validSignature(c, sigHeader, body) {
			verified = true
			break
		}
	}
	if !verified {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid signature"})
		return
	}

	// Replay protection: a captured, correctly-signed delivery must not trigger
	// deploys again. The signature (an HMAC of the body) is part of the key, so
	// replaying the same body under a fresh X-GitHub-Delivery id is still caught.
	delivery := r.Header.Get("X-GitHub-Delivery")
	sigKey := "sig:" + hex.EncodeToString(sigBytes)
	if recentDeliveries.seen(sigKey) || (delivery != "" && recentDeliveries.seen(delivery)) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "duplicate"})
		return
	}

	switch r.Header.Get("X-GitHub-Event") {
	case "push":
		// handled below
	case "ping", "":
		writeJSON(w, http.StatusOK, map[string]string{"status": "pong"})
		return
	default:
		writeJSON(w, http.StatusOK, map[string]string{"status": "ignored"})
		return
	}

	var payload struct {
		Ref        string `json:"ref"`
		Deleted    bool   `json:"deleted"`
		Repository struct {
			FullName string `json:"full_name"`
		} `json:"repository"`
		HeadCommit struct {
			ID      string `json:"id"`
			Message string `json:"message"`
		} `json:"head_commit"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid payload"})
		return
	}

	branch := strings.TrimPrefix(payload.Ref, "refs/heads/")
	if payload.Deleted || branch == payload.Ref || payload.Repository.FullName == "" {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ignored"})
		return
	}
	wantOwner, wantRepo, _ := splitFullName(payload.Repository.FullName)

	triggered := []string{}
	for _, p := range projects {
		if !p.AutoDeploy || p.Branch != branch || p.Status == "building" || p.Status == "queued" {
			continue
		}
		owner, repo, ok := github.ParseOwnerRepo(p.RepoURL)
		if !ok || !strings.EqualFold(owner, wantOwner) || !strings.EqualFold(repo, wantRepo) {
			continue
		}
		// Already built (or already known) — nothing new to deploy.
		if payload.HeadCommit.ID != "" && payload.HeadCommit.ID == p.LastCommitSHA {
			continue
		}
		dep := &db.Deployment{ID: db.NewID("dep"), ProjectID: p.ID, Status: "queued", Trigger: "auto"}
		// The commit recorded here is display metadata only. The project's baseline
		// commit is NOT taken from the payload: the build records the commit it
		// actually checked out, so a replayed/stale payload can't move the baseline.
		switch err := s.queue.Submit(dep, payload.HeadCommit.ID, firstLine(payload.HeadCommit.Message)); {
		case err == nil:
			triggered = append(triggered, p.Name)
		case errors.Is(err, queue.ErrBusy):
			// a build for this project is already running; the poller catches up afterwards
		case errors.Is(err, queue.ErrQueueFull), errors.Is(err, queue.ErrClosed):
			// Tell GitHub it failed so the delivery can be redelivered; don't mark it seen.
			w.Header().Set("Retry-After", "30")
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		default:
			log.Printf("[webhook] %s: submit: %v", p.Name, err)
		}
	}
	recentDeliveries.add(sigKey)
	if delivery != "" {
		recentDeliveries.add(delivery)
	}

	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "triggered": triggered})
}

// maxWebhookBody bounds the unauthenticated read. GitHub allows up to 25 MB, but
// a push payload (commit list capped at 20, no file contents) is a few KB.
const maxWebhookBody = 5 << 20

// deliveryCache remembers X-GitHub-Delivery IDs for a while so replays are ignored.
type deliveryCache struct {
	mu  sync.Mutex
	ids map[string]time.Time
}

const (
	deliveryTTL = time.Hour
	deliveryCap = 4096
)

var recentDeliveries = &deliveryCache{ids: map[string]time.Time{}}

func (c *deliveryCache) seen(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	t, ok := c.ids[id]
	return ok && time.Since(t) < deliveryTTL
}

func (c *deliveryCache) add(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if len(c.ids) >= deliveryCap {
		for k, t := range c.ids {
			if now.Sub(t) >= deliveryTTL {
				delete(c.ids, k)
			}
		}
		for k := range c.ids { // still full of live entries: evict arbitrary ones
			if len(c.ids) < deliveryCap {
				break
			}
			delete(c.ids, k)
		}
	}
	c.ids[id] = now
}

// decodeSignatureHeader parses "sha256=<64 hex>" without touching any secret.
func decodeSignatureHeader(header string) ([]byte, bool) {
	const prefix = "sha256="
	if !strings.HasPrefix(header, prefix) {
		return nil, false
	}
	b, err := hex.DecodeString(strings.TrimPrefix(header, prefix))
	if err != nil || len(b) != sha256.Size {
		return nil, false
	}
	return b, true
}

// validSignature reports whether the GitHub X-Hub-Signature-256 header matches
// an HMAC-SHA256 of body keyed with secret.
func validSignature(secret, header string, body []byte) bool {
	const prefix = "sha256="
	// An empty key is public knowledge: anyone can compute HMAC("", body).
	if secret == "" || !strings.HasPrefix(header, prefix) {
		return false
	}
	want, err := hex.DecodeString(strings.TrimPrefix(header, prefix))
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hmac.Equal(want, mac.Sum(nil))
}

func splitFullName(full string) (owner, repo string, ok bool) {
	parts := strings.SplitN(full, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
