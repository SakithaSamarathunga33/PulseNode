package api

import (
	"crypto/subtle"
	"net/http"
	"os"
	"strings"

	"github.com/rs/zerolog/log"

	"pulsenode/backend/internal/builder"
	"pulsenode/backend/internal/github"
)

const oauthStateCookie = "pn_oauth_state"

func (s *Server) githubAuthURL(w http.ResponseWriter, r *http.Request) {
	origin := os.Getenv("NEXT_PUBLIC_ORIGIN")
	callback := origin + "/go/api/github/callback"
	// state binds the callback to this browser, so a victim can't be tricked
	// into completing an OAuth flow the attacker started (account swap).
	state := randomHex(16)
	http.SetCookie(w, &http.Cookie{
		Name: oauthStateCookie, Value: state, Path: "/", MaxAge: 600,
		HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]string{"url": github.AuthURL(callback, state)})
}

func (s *Server) githubCallback(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "missing code", http.StatusBadRequest)
		return
	}
	c, err := r.Cookie(oauthStateCookie)
	state := r.URL.Query().Get("state")
	if err != nil || state == "" || subtle.ConstantTimeCompare([]byte(c.Value), []byte(state)) != 1 {
		http.Error(w, "invalid OAuth state — start the GitHub connection again", http.StatusBadRequest)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: oauthStateCookie, Value: "", Path: "/", MaxAge: -1})
	origin := os.Getenv("NEXT_PUBLIC_ORIGIN")
	callback := origin + "/go/api/github/callback"

	token, err := github.ExchangeCode(code, callback)
	if err != nil {
		log.Warn().Err(err).Msg("github oauth code exchange failed")
		http.Error(w, "GitHub authorization failed", http.StatusBadRequest)
		return
	}

	client := github.NewClient(token)
	user, err := client.CurrentUser()
	if err != nil {
		log.Warn().Err(err).Msg("github oauth: fetch user failed")
		http.Error(w, "failed to fetch GitHub user", http.StatusInternalServerError)
		return
	}

	if err := s.db.UpsertGitHubAccount(user.Login, user.AvatarURL, token, "oauth"); err != nil {
		log.Error().Err(err).Msg("github oauth: store account failed")
		http.Error(w, "failed to store GitHub account", http.StatusInternalServerError)
		return
	}

	// Redirect back to the GitHub page in the frontend
	http.Redirect(w, r, origin+"/github?connected=1", http.StatusFound)
}

func (s *Server) githubAccount(w http.ResponseWriter, r *http.Request) {
	acct, err := s.db.GetGitHubAccount()
	if err != nil {
		writeError(w, err)
		return
	}
	if acct == nil {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"login":     acct.Login,
		"avatarUrl": acct.AvatarURL,
		"tokenType": acct.TokenType,
	})
}

func (s *Server) githubDisconnect(w http.ResponseWriter, r *http.Request) {
	if err := s.db.DeleteGitHubAccount(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) githubSavePAT(w http.ResponseWriter, r *http.Request) {
	var body struct{ Token string `json:"token"` }
	if err := decodeJSON(r, &body); err != nil || body.Token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token required"})
		return
	}
	client := github.NewClient(body.Token)
	user, err := client.CurrentUser()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid token: " + err.Error()})
		return
	}
	if err := s.db.UpsertGitHubAccount(user.Login, user.AvatarURL, body.Token, "pat"); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"login": user.Login, "avatarUrl": user.AvatarURL})
}

func (s *Server) githubRepos(w http.ResponseWriter, r *http.Request) {
	acct, err := s.db.GetGitHubAccount()
	if err != nil || acct == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no GitHub account connected"})
		return
	}
	repos, err := github.NewClient(acct.AccessToken).ListRepos()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, repos)
}

func (s *Server) githubBranches(w http.ResponseWriter, r *http.Request) {
	acct, err := s.db.GetGitHubAccount()
	if err != nil || acct == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no GitHub account connected"})
		return
	}
	// expect ?repo=owner/repo
	full := r.URL.Query().Get("repo")
	parts := strings.SplitN(full, "/", 2)
	if len(parts) != 2 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "repo must be owner/repo"})
		return
	}
	branches, err := github.NewClient(acct.AccessToken).ListBranches(parts[0], parts[1])
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, branches)
}

// detectRepoLayout probes a repo's root (via the GitHub contents API) and
// reports whether it is a frontend/ + backend/ monorepo — so the new-project
// form can mirror what the deploy pipeline will do (build two services, route
// frontend at / and backend at /api). Mirrors builder.DetectMonorepo without a
// local clone.
func (s *Server) detectRepoLayout(w http.ResponseWriter, r *http.Request) {
	acct, err := s.db.GetGitHubAccount()
	if err != nil || acct == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no GitHub account connected"})
		return
	}
	// Accept either owner/repo or a full clone URL (the settings page only has
	// the project's RepoURL).
	raw := strings.TrimSpace(r.URL.Query().Get("repo"))
	var owner, repo string
	if o, rp, ok := github.ParseOwnerRepo(raw); ok {
		owner, repo = o, rp
	} else if parts := strings.SplitN(raw, "/", 2); len(parts) == 2 && parts[0] != "" && parts[1] != "" {
		owner, repo = parts[0], parts[1]
	}
	if owner == "" || repo == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "repo must be owner/repo or a clone URL"})
		return
	}
	branch := r.URL.Query().Get("branch")
	client := github.NewClient(acct.AccessToken)

	root, err := client.ListContents(owner, repo, "", branch)
	if err != nil {
		// Treat an unreadable repo as "no special layout" rather than an error —
		// the form still works and the deploy pipeline detects it later.
		writeJSON(w, http.StatusOK, map[string]any{"monorepo": false})
		return
	}
	hasDir := func(name string) bool {
		for _, e := range root {
			if e.Type == "dir" && e.Name == name {
				return true
			}
		}
		return false
	}
	dirBuildable := func(dir string) bool {
		items, err := client.ListContents(owner, repo, dir, branch)
		if err != nil {
			return false
		}
		for _, e := range items {
			if e.Type == "file" && builder.IsBuildMarker(e.Name) {
				return true
			}
		}
		return false
	}

	if hasDir("frontend") && hasDir("backend") && dirBuildable("frontend") && dirBuildable("backend") {
		writeJSON(w, http.StatusOK, map[string]any{
			"monorepo": true,
			"frontend": "/",
			"backend":  "/api",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"monorepo": false})
}

func (s *Server) githubSaveOAuthSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClientID     string `json:"clientId"`
		ClientSecret string `json:"clientSecret"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	// Persist to .env.local (appended/replaced)
	if err := upsertEnvLocal("GITHUB_CLIENT_ID", body.ClientID); err != nil {
		writeError(w, err)
		return
	}
	if err := upsertEnvLocal("GITHUB_CLIENT_SECRET", body.ClientSecret); err != nil {
		writeError(w, err)
		return
	}
	// Also set in process env so OAuth works immediately without restart
	os.Setenv("GITHUB_CLIENT_ID", body.ClientID)
	os.Setenv("GITHUB_CLIENT_SECRET", body.ClientSecret)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) githubOAuthSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"clientId":     os.Getenv("GITHUB_CLIENT_ID"),
		"hasSecret":    os.Getenv("GITHUB_CLIENT_SECRET") != "",
		"configured":   os.Getenv("GITHUB_CLIENT_ID") != "" && os.Getenv("GITHUB_CLIENT_SECRET") != "",
	})
}
