package api

import (
	"encoding/json"
	"net/http"

	"golang.org/x/crypto/bcrypt"
)

const sessionCookieName = "pn_session"
const sessionTTL = int64(1800) // 30 minutes

func setSessionCookie(w http.ResponseWriter, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

// GET /api/auth/status
// Returns {enabled, loggedIn, username?}. Extends the session window on each valid call.
func (s *Server) authStatus(w http.ResponseWriter, r *http.Request) {
	user, err := s.db.GetUser()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "db error"})
		return
	}
	if user == nil {
		if s.insecureNoAuth {
			writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "loggedIn": false})
			return
		}
		// Login is mandatory: send the browser to /login, which shows the
		// create-admin form when setupRequired is set.
		writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "loggedIn": false, "setupRequired": true})
		return
	}
	c, err := r.Cookie(sessionCookieName)
	if err != nil || !s.auth.ValidateToken(c.Value) {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "loggedIn": false})
		return
	}
	// Slide the session: issue a fresh token with a full 30-min window.
	setSessionCookie(w, s.auth.MakeJWT(user.Username, sessionTTL), int(sessionTTL))
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "loggedIn": true, "username": user.Username})
}

// POST /api/auth/login
// Body: {"username":"...","password":"..."}
func (s *Server) authLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	user, err := s.db.GetUser()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "db error"})
		return
	}
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "login not configured"})
		return
	}
	// Always run bcrypt so a wrong username takes as long as a wrong password.
	pwOK := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.Password)) == nil
	if user.Username != body.Username || !pwOK {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid credentials"})
		return
	}
	setSessionCookie(w, s.auth.MakeJWT(user.Username, sessionTTL), int(sessionTTL))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// POST /api/auth/logout
func (s *Server) authLogout(w http.ResponseWriter, r *http.Request) {
	setSessionCookie(w, "", -1)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// POST /api/auth/setup — create or update the admin account.
// Body: {"username":"...","password":"...","current_password":"...","setup_token":"..."}
// current_password is required if the account already exists; setup_token is required
// to create the first account (see initSetupToken).
func (s *Server) authSetup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username        string `json:"username"`
		Password        string `json:"password"`
		CurrentPassword string `json:"current_password"`
		SetupToken      string `json:"setup_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if len(body.Username) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "username is required"})
		return
	}
	if len(body.Password) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password must be at least 8 characters"})
		return
	}
	existing, err := s.db.GetUser()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "db error"})
		return
	}
	if existing != nil {
		if bcrypt.CompareHashAndPassword([]byte(existing.PasswordHash), []byte(body.CurrentPassword)) != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Current password is incorrect"})
			return
		}
	} else if !s.insecureNoAuth && !s.checkSetupToken(body.SetupToken) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid setup token"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), 12)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to hash password"})
		return
	}
	if err := s.db.UpsertUser(body.Username, string(hash)); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save user"})
		return
	}
	if existing == nil {
		s.clearSetupToken()
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
