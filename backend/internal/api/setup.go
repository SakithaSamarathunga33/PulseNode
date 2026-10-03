package api

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"os"
	"path/filepath"

	"github.com/rs/zerolog/log"

	"pulsenode/backend/internal/db"
)

// jwtSecret returns the session-signing secret. A missing, short or placeholder
// value (e.g. the old compose default "change-me") would let anyone forge a
// session cookie, so it is replaced by a random secret persisted in dataDir.
func jwtSecret(dataDir string) string {
	if s := firstNonEmpty(os.Getenv("JWT_SECRET"), os.Getenv("NODE_API_SECRET")); !db.WeakSecret(s) {
		return s
	}
	s, err := db.LoadOrCreateSecret(filepath.Join(dataDir, "jwt-secret"))
	if err != nil {
		log.Warn().Err(err).Msg("could not persist JWT secret — using an in-memory one (sessions reset on restart)")
		return randomHex(32)
	}
	log.Warn().Msg("JWT_SECRET missing or weak — using a generated secret stored in PULSENODE_DATA_DIR/jwt-secret")
	return s
}

// initSetupToken prepares the one-time token required to create the first admin
// account. Without it, whoever reached a fresh install first could claim it.
// install.sh passes PULSENODE_SETUP_TOKEN; otherwise one is generated and
// printed to the go-api logs (`docker compose logs go-api`).
func (s *Server) initSetupToken(dataDir string) {
	if s.insecureNoAuth {
		log.Warn().Msg("PULSENODE_INSECURE_NO_AUTH=true — the dashboard is open to anyone who can reach it")
		return
	}
	user, err := s.db.GetUser()
	if err != nil || user != nil {
		return
	}
	s.setupTokenPath = filepath.Join(dataDir, "setup-token")
	tok := os.Getenv("PULSENODE_SETUP_TOKEN")
	if len(tok) < 16 {
		if tok, err = db.LoadOrCreateSecret(s.setupTokenPath); err != nil {
			tok = randomHex(32)
		}
	}
	s.setupMu.Lock()
	s.setupToken = tok
	s.setupMu.Unlock()
	log.Warn().Str("setup_token", tok).Msg("No admin account yet — open the dashboard and create one with this setup token")
}

// checkSetupToken reports whether tok matches the active setup token.
func (s *Server) checkSetupToken(tok string) bool {
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	return s.setupToken != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(s.setupToken)) == 1
}

// clearSetupToken invalidates the setup token once the admin account exists.
func (s *Server) clearSetupToken() {
	s.setupMu.Lock()
	s.setupToken = ""
	s.setupMu.Unlock()
	if s.setupTokenPath != "" {
		_ = os.Remove(s.setupTokenPath)
	}
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
