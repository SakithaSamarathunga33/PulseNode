package api

import (
	"context"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog/log"

	"pulsenode/backend/internal/proxy"
)

// Built-in proxy API (see internal/proxy). When the server has no Traefik,
// PulseNode runs its own so deployed projects get routed with automatic HTTPS.
// A server with an external Traefik is left alone: status reports mode
// "external" and enabling the managed proxy is refused.

// proxyState serializes the lifecycle calls and remembers the last failure so the
// status endpoint can show it. The zero value is ready to use.
type proxyState struct {
	mu       sync.Mutex
	mgr      *proxy.Manager // nil → a manager driving the local docker CLI
	lastErr  string
	conflict bool
}

// proxyEnableTimeout covers pulling the Traefik image and waiting for readiness.
const proxyEnableTimeout = 4 * time.Minute

func (s *Server) proxyManager() *proxy.Manager {
	if s.proxySt.mgr != nil {
		return s.proxySt.mgr
	}
	return proxy.NewManager()
}

type proxyStatusResponse struct {
	Mode      string `json:"mode"` // managed | external | none
	Running   bool   `json:"running"`
	Container string `json:"container"`
	Network   string `json:"network"`
	HTTPPort  int    `json:"httpPort"`
	HTTPSPort int    `json:"httpsPort"`
	AcmeEmail string `json:"acmeEmail"`
	Enabled   bool   `json:"enabled"` // PulseNode may run its own proxy when none is found
	Error     string `json:"error"`
	Conflict  bool   `json:"conflict"` // last start failed because ports 80/443 are taken
}

// proxyStatusLocked builds the status response. Caller holds proxySt.mu.
func (s *Server) proxyStatusLocked(ctx context.Context) proxyStatusResponse {
	m := s.proxyManager()
	setting, _ := s.db.GetSetting(proxy.SettingManaged)
	email, _ := s.db.GetSetting(proxy.SettingACMEEmail)
	resp := proxyStatusResponse{
		Mode: "none", HTTPPort: proxy.HTTPPort, HTTPSPort: proxy.HTTPSPort,
		AcmeEmail: email, Enabled: proxy.Enabled(setting),
		Error: s.proxySt.lastErr, Conflict: s.proxySt.conflict,
	}
	st, err := m.Status(ctx)
	if err != nil && resp.Error == "" {
		resp.Error = "could not inspect the proxy: " + err.Error()
	}
	external := ""
	if !st.Running {
		external = m.DetectExternal(ctx)
	}
	switch {
	case st.Running:
		resp.Mode, resp.Running = "managed", true
		resp.Container, resp.Network = proxy.Container, proxy.Network
		// A running proxy supersedes an earlier failure message.
		resp.Error, resp.Conflict = "", false
	case external != "":
		resp.Mode, resp.Running, resp.Network = "external", true, external
		resp.Error, resp.Conflict = "", false
	case st.Exists:
		resp.Mode = "managed"
		resp.Container, resp.Network = proxy.Container, proxy.Network
	}
	return resp
}

func (s *Server) proxyStatus(w http.ResponseWriter, r *http.Request) {
	s.proxySt.mu.Lock()
	defer s.proxySt.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, s.proxyStatusLocked(ctx))
}

// proxyFail records err for the status endpoint and answers with the status
// object (so clients can read .error and .conflict from the same shape).
func (s *Server) proxyFail(w http.ResponseWriter, ctx context.Context, code int, err error) {
	s.proxySt.lastErr = err.Error()
	s.proxySt.conflict = proxy.IsPortConflict(err)
	resp := s.proxyStatusLocked(ctx)
	resp.Error, resp.Conflict = s.proxySt.lastErr, s.proxySt.conflict
	writeJSON(w, code, resp)
}

func (s *Server) proxyOK(w http.ResponseWriter, ctx context.Context) {
	s.proxySt.lastErr, s.proxySt.conflict = "", false
	writeJSON(w, http.StatusOK, s.proxyStatusLocked(ctx))
}

// validACMEEmail accepts "" (clear) or a bare address like ops@example.com.
func validACMEEmail(e string) bool {
	if e == "" {
		return true
	}
	a, err := mail.ParseAddress(e)
	return err == nil && a.Address == e && len(e) <= 254 && !strings.ContainsAny(e, " \r\n\t,;<>")
}

func (s *Server) proxyEnable(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AcmeEmail *string `json:"acmeEmail"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(r, &body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
	}
	if body.AcmeEmail != nil {
		e := strings.TrimSpace(*body.AcmeEmail)
		if !validACMEEmail(e) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "acmeEmail must be a valid e-mail address"})
			return
		}
		body.AcmeEmail = &e
	}

	s.proxySt.mu.Lock()
	defer s.proxySt.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), proxyEnableTimeout)
	defer cancel()
	m := s.proxyManager()

	if ext := m.DetectExternal(ctx); ext != "" {
		s.proxyFail(w, ctx, http.StatusConflict, &proxy.ExternalTraefikError{Network: ext})
		return
	}
	if body.AcmeEmail != nil {
		if err := s.db.SetSetting(proxy.SettingACMEEmail, *body.AcmeEmail); err != nil {
			s.proxyFail(w, ctx, http.StatusInternalServerError, err)
			return
		}
	}
	email, _ := s.db.GetSetting(proxy.SettingACMEEmail)
	if err := m.Ensure(ctx, proxy.Options{ACMEEmail: email}); err != nil {
		code := http.StatusInternalServerError
		if proxy.IsPortConflict(err) {
			code = http.StatusConflict
		}
		s.proxyFail(w, ctx, code, err)
		return
	}
	if err := s.db.SetSetting(proxy.SettingManaged, "true"); err != nil {
		s.proxyFail(w, ctx, http.StatusInternalServerError, err)
		return
	}
	s.proxyOK(w, ctx)
}

func (s *Server) proxyDisable(w http.ResponseWriter, r *http.Request) {
	s.proxySt.mu.Lock()
	defer s.proxySt.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.proxyManager().Remove(ctx); err != nil {
		s.proxyFail(w, ctx, http.StatusInternalServerError, err)
		return
	}
	if err := s.db.SetSetting(proxy.SettingManaged, "false"); err != nil {
		s.proxyFail(w, ctx, http.StatusInternalServerError, err)
		return
	}
	s.proxyOK(w, ctx)
}

func (s *Server) proxySettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AcmeEmail string `json:"acmeEmail"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	email := strings.TrimSpace(body.AcmeEmail)
	if !validACMEEmail(email) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "acmeEmail must be a valid e-mail address"})
		return
	}

	s.proxySt.mu.Lock()
	defer s.proxySt.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), proxyEnableTimeout)
	defer cancel()
	// Saved first: if recreating below fails, the next reconcile/deploy still
	// brings the proxy up with the address the user asked for.
	if err := s.db.SetSetting(proxy.SettingACMEEmail, email); err != nil {
		s.proxyFail(w, ctx, http.StatusInternalServerError, err)
		return
	}
	m := s.proxyManager()
	if st, err := m.Status(ctx); err == nil && st.Running {
		if err := m.Ensure(ctx, proxy.Options{ACMEEmail: email}); err != nil {
			s.proxyFail(w, ctx, http.StatusInternalServerError, err)
			return
		}
	}
	s.proxyOK(w, ctx)
}

// ReconcileProxy brings the managed proxy back up at start-up when the user
// enabled it but the container is missing or stopped (or its spec drifted after
// a panel update). It only logs; nothing here blocks or fails the panel.
func (s *Server) ReconcileProxy(ctx context.Context) {
	setting, _ := s.db.GetSetting(proxy.SettingManaged)
	if !strings.EqualFold(strings.TrimSpace(setting), "true") || !proxy.Enabled(setting) {
		return
	}
	s.proxySt.mu.Lock()
	defer s.proxySt.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, proxyEnableTimeout)
	defer cancel()
	m := s.proxyManager()
	if ext := m.DetectExternal(ctx); ext != "" {
		log.Info().Str("network", ext).Msg("proxy: external Traefik detected, not starting the built-in proxy")
		return
	}
	email, _ := s.db.GetSetting(proxy.SettingACMEEmail)
	err := m.Ensure(ctx, proxy.Options{ACMEEmail: email})
	switch {
	case err == nil:
		log.Info().Msg("proxy: built-in proxy is running")
	case errors.Is(err, context.Canceled):
	default:
		s.proxySt.lastErr, s.proxySt.conflict = err.Error(), proxy.IsPortConflict(err)
		log.Warn().Err(err).Msg("proxy: could not start the built-in proxy")
	}
}
