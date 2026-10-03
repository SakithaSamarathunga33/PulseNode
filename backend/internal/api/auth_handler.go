package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"pulsenode/backend/internal/db"
)

const sessionCookieName = "pn_session"
const sessionTTL = int64(1800)         // 30 minutes idle
const sessionMaxAge = int64(12 * 3600) // absolute cap, even for active sessions

// isHTTPS reports whether the browser reached the panel over TLS. go-api is only
// reachable through Caddy, which overwrites X-Forwarded-Proto from untrusted peers.
func isHTTPS(r *http.Request) bool {
	return r.TLS != nil ||
		r.Header.Get("X-Forwarded-Proto") == "https" ||
		strings.HasPrefix(os.Getenv("NEXT_PUBLIC_ORIGIN"), "https://")
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
}

// sessionVersion fingerprints the password hash, so changing the password
// invalidates every session issued before the change.
func sessionVersion(u *db.User) string {
	h := sha256.Sum256([]byte(u.PasswordHash))
	return hex.EncodeToString(h[:8])
}

// issueSession sets a fresh session cookie for u. authTime is the original login
// time and is carried across refreshes to enforce sessionMaxAge.
func (s *Server) issueSession(w http.ResponseWriter, r *http.Request, u *db.User, authTime int64) {
	tok := s.auth.MakeJWT(u.Username, sessionTTL, map[string]any{"ver": sessionVersion(u), "auth_time": authTime})
	setSessionCookie(w, r, tok, int(sessionTTL))
}

// validSession reports whether token is a live session for u and returns its
// original login time.
func (s *Server) validSession(token string, u *db.User) (int64, bool) {
	claims, ok := s.auth.ParseToken(token)
	if !ok {
		return 0, false
	}
	sub, _ := claims["sub"].(string)
	ver, _ := claims["ver"].(string)
	authTime, _ := claims["auth_time"].(float64)
	if sub != u.Username || subtle.ConstantTimeCompare([]byte(ver), []byte(sessionVersion(u))) != 1 {
		return 0, false
	}
	if authTime <= 0 || time.Now().Unix()-int64(authTime) > sessionMaxAge {
		return 0, false
	}
	return int64(authTime), true
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
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "loggedIn": false})
		return
	}
	authTime, ok := s.validSession(c.Value, user)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "loggedIn": false})
		return
	}
	// Slide the session: issue a fresh token with a full 30-min window.
	s.issueSession(w, r, user, authTime)
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
	s.issueSession(w, r, user, time.Now().Unix())
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// POST /api/auth/logout
func (s *Server) authLogout(w http.ResponseWriter, r *http.Request) {
	setSessionCookie(w, r, "", -1)
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
	} else if u, err := s.db.GetUser(); err == nil && u != nil {
		// The password change revoked every other session; keep this one signed in.
		s.issueSession(w, r, u, time.Now().Unix())
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
