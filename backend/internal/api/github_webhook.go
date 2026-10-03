package api

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"

	"pulsenode/backend/internal/db"
	"pulsenode/backend/internal/github"
)

const webhookSecretKey = "github_webhook_secret"

// getOrCreateWebhookSecret returns the stored webhook secret, generating and
// persisting one the first time it's requested.
func (s *Server) getOrCreateWebhookSecret() (string, error) {
	secret, err := s.db.GetSetting(webhookSecretKey)
	if err != nil {
		return "", err
	}
	if secret != "" {
		return secret, nil
	}
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	secret = hex.EncodeToString(b)
	if err := s.db.SetSetting(webhookSecretKey, secret); err != nil {
		return "", err
	}
	return secret, nil
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
	secret, err := s.getOrCreateWebhookSecret()
	if err != nil {
		return "error", err
	}
	created, err := github.NewClient(acct.AccessToken).EnsureWebhook(owner, repo, hookURL, secret)
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
	body, err := io.ReadAll(io.LimitReader(r.Body, 5<<20)) // 5 MB cap
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "read body"})
		return
	}

	secret, err := s.getOrCreateWebhookSecret()
	if err != nil || secret == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "webhook secret unavailable"})
		return
	}
	// Also accept events signed with the GitHub App webhook secret so both
	// per-repo hooks and GitHub App installations share the same endpoint.
	appSecret, _ := s.db.GetSetting("github_app_webhook_secret")
	if appSecret == publicDefaultAppWebhookSecret {
		appSecret = "" // published in the old compose file — anyone could sign with it
	}
	sigHeader := r.Header.Get("X-Hub-Signature-256")
	if !validSignature(secret, sigHeader, body) && !validSignature(appSecret, sigHeader, body) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid signature"})
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

	projects, err := s.db.ListProjects()
	if err != nil {
		writeError(w, err)
		return
	}

	triggered := []string{}
	for _, p := range projects {
		if !p.AutoDeploy || p.Branch != branch || p.Status == "building" || p.Status == "queued" {
			continue
		}
		owner, repo, ok := github.ParseOwnerRepo(p.RepoURL)
		if !ok || !strings.EqualFold(owner, wantOwner) || !strings.EqualFold(repo, wantRepo) {
			continue
		}
		dep := &db.Deployment{ID: db.NewID("dep"), ProjectID: p.ID, Status: "queued", Trigger: "auto"}
		if err := s.db.CreateDeployment(dep); err != nil {
			continue
		}
		if payload.HeadCommit.ID != "" {
			_ = s.db.UpdateDeploymentCommit(dep.ID, payload.HeadCommit.ID, firstLine(payload.HeadCommit.Message))
			_ = s.db.UpdateProjectCommit(p.ID, payload.HeadCommit.ID)
		}
		_ = s.db.UpdateProjectStatus(p.ID, "building", "")
		s.queue.Enqueue(dep.ID)
		triggered = append(triggered, p.Name)
	}

	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "triggered": triggered})
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
