package api

import (
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog/log"

	"pulsenode/backend/internal/db"
	"pulsenode/backend/internal/github"
)

// SeedGitHubAppFromEnv seeds GitHub App settings from environment variables on
// first run. This lets the server admin pre-configure the App so users only
// need to click "Install" — no manual form entry needed.
// Only writes keys that aren't already in the DB; a UI save always wins.
// GITHUB_APP_PRIVATE_KEY_FILE takes a file path (avoids multi-line env var
// issues); GITHUB_APP_PRIVATE_KEY can be used as a fallback inline value.
// publicDefaultAppWebhookSecret was the GITHUB_APP_WEBHOOK_SECRET default in
// docker-compose.yml, so it is public and must never authenticate a webhook.
const publicDefaultAppWebhookSecret = "pulsenode"

func (s *Server) SeedGitHubAppFromEnv() {
	defer func() {
		if v, _ := s.db.GetSetting("github_app_webhook_secret"); v == publicDefaultAppWebhookSecret {
			log.Warn().Msg("GitHub App webhook secret is the old public default and is ignored — set a new secret in the GitHub App and in GITHUB_APP_WEBHOOK_SECRET / GitHub settings")
		}
	}()
	pairs := []struct{ key, envName string }{
		{"github_app_id", "GITHUB_APP_ID"},
		{"github_app_slug", "GITHUB_APP_SLUG"},
		{"github_app_webhook_secret", "GITHUB_APP_WEBHOOK_SECRET"},
	}
	for _, p := range pairs {
		val := os.Getenv(p.envName)
		if val == "" {
			continue
		}
		existing, _ := s.db.GetSetting(p.key)
		if existing != "" {
			continue
		}
		_ = s.db.SetSetting(p.key, val)
	}

	// Private key: prefer a file path so newlines are preserved exactly.
	existing, _ := s.db.GetSetting("github_app_private_key")
	if existing == "" {
		var pemData string
		if file := os.Getenv("GITHUB_APP_PRIVATE_KEY_FILE"); file != "" {
			if b, err := os.ReadFile(file); err == nil {
				pemData = strings.TrimSpace(string(b))
			}
		}
		if pemData == "" {
			pemData = strings.TrimSpace(os.Getenv("GITHUB_APP_PRIVATE_KEY"))
		}
		if pemData != "" {
			_ = s.db.SetSetting("github_app_private_key", pemData)
		}
	}
}

// ── App settings ──────────────────────────────────────────────────────────────

func (s *Server) githubAppSettings(w http.ResponseWriter, r *http.Request) {
	appID, _ := s.db.GetSetting("github_app_id")
	pkPEM, _ := s.db.GetSetting("github_app_private_key")
	slug, _ := s.db.GetSetting("github_app_slug")
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": appID != "" && pkPEM != "",
		"appId":      appID,
		"slug":       slug,
		"hasKey":     pkPEM != "",
	})
}

func (s *Server) githubAppSaveSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AppID         string `json:"appId"`
		Slug          string `json:"slug"`
		PrivateKey    string `json:"privateKey"`
		WebhookSecret string `json:"webhookSecret"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.AppID == "" || body.Slug == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "appId and slug are required"})
		return
	}
	if body.PrivateKey != "" {
		if _, err := github.ParseRSAPrivateKey(body.PrivateKey); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid private key: " + err.Error()})
			return
		}
		_ = s.db.SetSetting("github_app_private_key", body.PrivateKey)
	}
	if body.WebhookSecret != "" {
		_ = s.db.SetSetting("github_app_webhook_secret", body.WebhookSecret)
	}
	_ = s.db.SetSetting("github_app_id", body.AppID)
	_ = s.db.SetSetting("github_app_slug", body.Slug)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ── Install URL ───────────────────────────────────────────────────────────────

func (s *Server) githubAppInstallURL(w http.ResponseWriter, r *http.Request) {
	slug, _ := s.db.GetSetting("github_app_slug")
	if slug == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "GitHub App not configured (missing slug)"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"url": "https://github.com/apps/" + slug + "/installations/new",
	})
}

// githubAppCallback is the public endpoint GitHub redirects to after a user
// installs, updates, or removes the app. It stores/removes the installation
// and redirects the browser back to the GitHub settings page.
func (s *Server) githubAppCallback(w http.ResponseWriter, r *http.Request) {
	origin := strings.TrimRight(os.Getenv("NEXT_PUBLIC_ORIGIN"), "/")
	action := r.URL.Query().Get("setup_action")
	rawID := r.URL.Query().Get("installation_id")

	if action == "delete" {
		if id, err := strconv.ParseInt(rawID, 10, 64); err == nil && id != 0 {
			_ = s.db.DeleteAppInstallationByInstallID(id)
		}
		http.Redirect(w, r, origin+"/github?app_uninstalled=1", http.StatusFound)
		return
	}

	installationID, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || installationID == 0 {
		http.Redirect(w, r, origin+"/github?app_error=missing_id", http.StatusFound)
		return
	}

	login, accountType := "unknown", "User"
	appID, _ := s.db.GetSetting("github_app_id")
	pkPEM, _ := s.db.GetSetting("github_app_private_key")
	if appID != "" && pkPEM != "" {
		if appClient, err := github.NewAppClient(appID, pkPEM); err == nil {
			if inst, err := appClient.GetInstallation(installationID); err == nil {
				login = inst.Account.Login
				accountType = inst.Account.Type
			}
		}
	}
	if err := s.db.UpsertAppInstallation(installationID, login, accountType); err != nil {
		http.Redirect(w, r, origin+"/github?app_error=db_error", http.StatusFound)
		return
	}
	http.Redirect(w, r, origin+"/github?app_installed=1", http.StatusFound)
}

// githubAppRegister is a JSON endpoint called by the frontend callback page
// after GitHub redirects the user to /github/app/callback. Unlike
// githubAppCallback (which does a server-side redirect), this returns JSON so
// the Next.js page can show a status message and then navigate programmatically.
func (s *Server) githubAppRegister(w http.ResponseWriter, r *http.Request) {
	action := r.URL.Query().Get("setup_action")
	rawID := r.URL.Query().Get("installation_id")

	if action == "delete" {
		if id, err := strconv.ParseInt(rawID, 10, 64); err == nil && id != 0 {
			_ = s.db.DeleteAppInstallationByInstallID(id)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "action": "deleted"})
		return
	}

	installationID, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || installationID == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing installation_id"})
		return
	}

	// Accept pre-resolved account details from the relay instance (which has
	// the private key) so key-less targets still show real account names.
	login := r.URL.Query().Get("account_login")
	accountType := r.URL.Query().Get("account_type")
	if accountType == "" {
		accountType = "User"
	}

	// When this instance holds the App key, GitHub is the source of truth:
	// verify the installation exists and use its real account, ignoring the
	// caller-supplied values.
	appID, _ := s.db.GetSetting("github_app_id")
	pkPEM, _ := s.db.GetSetting("github_app_private_key")
	if appID != "" && pkPEM != "" {
		if appClient, err := github.NewAppClient(appID, pkPEM); err == nil {
			inst, err := appClient.GetInstallation(installationID)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "installation not found for this GitHub App"})
				return
			}
			login = inst.Account.Login
			accountType = inst.Account.Type
		}
	}
	if login == "" {
		login = "unknown"
	}

	if err := s.db.UpsertAppInstallation(installationID, login, accountType); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"accountLogin": login,
		"accountType":  accountType,
	})
}

// githubAppInstallationDetails fetches account metadata for one installation
// using the App JWT — no DB write. Used by the relay callback page on an
// instance that has the private key to enrich a relay to a key-less instance.
func (s *Server) githubAppInstallationDetails(w http.ResponseWriter, r *http.Request) {
	installationID, err := strconv.ParseInt(r.URL.Query().Get("installation_id"), 10, 64)
	if err != nil || installationID == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid installation_id"})
		return
	}
	appID, _ := s.db.GetSetting("github_app_id")
	pkPEM, _ := s.db.GetSetting("github_app_private_key")
	if appID == "" || pkPEM == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "App not configured on this instance"})
		return
	}
	appClient, err := github.NewAppClient(appID, pkPEM)
	if err != nil {
		writeError(w, err)
		return
	}
	inst, err := appClient.GetInstallation(installationID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"accountLogin": inst.Account.Login,
		"accountType":  inst.Account.Type,
	})
}

// ── Installations CRUD ────────────────────────────────────────────────────────

func (s *Server) listAppInstallations(w http.ResponseWriter, r *http.Request) {
	insts, err := s.db.ListAppInstallations()
	if err != nil {
		writeError(w, err)
		return
	}
	if insts == nil {
		insts = []db.AppInstallation{}
	}
	writeJSON(w, http.StatusOK, insts)
}

func (s *Server) deleteAppInstallation(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	if err := s.db.DeleteAppInstallation(id); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ── Repos via App installations ───────────────────────────────────────────────

// githubAppRepos aggregates repos across all stored installations using
// per-installation access tokens. Errors from individual installations are
// skipped so a single bad install doesn't break the full list.
func (s *Server) githubAppRepos(w http.ResponseWriter, r *http.Request) {
	appID, _ := s.db.GetSetting("github_app_id")
	pkPEM, _ := s.db.GetSetting("github_app_private_key")
	if appID == "" || pkPEM == "" {
		writeJSON(w, http.StatusOK, []github.Repo{})
		return
	}
	appClient, err := github.NewAppClient(appID, pkPEM)
	if err != nil {
		writeError(w, err)
		return
	}
	insts, err := s.db.ListAppInstallations()
	if err != nil {
		writeError(w, err)
		return
	}

	var repos []github.Repo
	for _, inst := range insts {
		tok, err := appClient.GetInstallationToken(inst.InstallationID)
		if err != nil {
			continue
		}
		rs, err := github.InstallationRepos(tok.Token)
		if err != nil {
			continue
		}
		repos = append(repos, rs...)
	}
	if repos == nil {
		repos = []github.Repo{}
	}
	writeJSON(w, http.StatusOK, repos)
}
