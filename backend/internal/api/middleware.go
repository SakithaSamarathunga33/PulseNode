package api

import (
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/httprate"
)

// clientIP returns the browser's IP. go-api is only reachable through Caddy,
// which sets X-Real-IP from its resolved client address (overwriting anything
// the client sent), so it is trusted here; RemoteAddr is the fallback.
func clientIP(r *http.Request) string {
	if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); net.ParseIP(ip) != nil {
		return ip
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// RateLimit returns a per-client-IP rate limiter middleware.
func RateLimit(reqs int, window time.Duration) func(http.Handler) http.Handler {
	return httprate.Limit(reqs, window, httprate.WithKeyFuncs(func(r *http.Request) (string, error) {
		return clientIP(r), nil
	}))
}

// sameOriginWrites rejects state-changing requests whose Origin (or Referer) is
// another site. The session cookie is SameSite=Lax, which still lets sibling
// subdomains — e.g. apps deployed through PulseNode on the same domain — send
// it with a no-preflight text/plain POST. Requests with neither header (curl,
// scripts, the installer) are allowed; browsers always send one of them.
func (s *Server) sameOriginWrites(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		src := r.Header.Get("Origin")
		if src == "" {
			src = r.Header.Get("Referer")
		}
		if src != "" && !s.trustedOrigin(src, r.Host) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "cross-origin request blocked"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// trustedOrigin reports whether src (an Origin or Referer URL) is the panel
// itself: either the host the request was sent to, or a configured origin.
func (s *Server) trustedOrigin(src, host string) bool {
	u, err := url.Parse(src)
	if err != nil || u.Host == "" {
		return false
	}
	configured := func(h string) bool {
		for _, o := range s.origins {
			if ou, err := url.Parse(o); err == nil && strings.EqualFold(ou.Host, h) {
				return true
			}
		}
		return false
	}
	if strings.EqualFold(u.Host, host) {
		// With login off there is no cookie to protect, so the only defence against
		// DNS rebinding (attacker's name resolving to this server, Origin == Host) is
		// to insist the Host is one the operator configured.
		if s.insecureNoAuth && len(s.origins) > 0 && !configured(host) {
			return false
		}
		return true
	}
	return configured(u.Host)
}

// AuditLog records every state-changing request into the audit_log table.
func (s *Server) AuditLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rw := &statusRecorder{ResponseWriter: w, code: 200}
		next.ServeHTTP(rw, r)

		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			return
		}
		actor := "anonymous"
		if c, err := r.Cookie(sessionCookieName); err == nil {
			if claims, ok := s.auth.ParseToken(c.Value); ok {
				actor, _ = claims["sub"].(string)
			}
		}
		s.db.InsertAuditLog(actor, r.Method+" "+r.URL.Path, r.URL.Path, clientIP(r), rw.code)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.code = code
	r.ResponseWriter.WriteHeader(code)
}

// Flush forwards to the underlying ResponseWriter so SSE / streaming works.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets chi and other middleware reach the underlying writer.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// requireAuth replaces s.auth.Require. It validates either the pn_session cookie or a
// Bearer token against the admin account. It fails closed: with no admin account yet,
// every request is rejected until one is created via /api/auth/setup (which needs the
// setup token), unless the operator explicitly set PULSENODE_INSECURE_NO_AUTH=true.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := s.db.GetUser()
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "auth unavailable"})
			return
		}
		if user == nil {
			if s.insecureNoAuth {
				next.ServeHTTP(w, r)
				return
			}
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Admin account not set up", "setupRequired": true})
			return
		}
		// Cookie path (browser sessions). Slide the session on each authenticated
		// request — re-issue a fresh token so an active user isn't logged out
		// mid-action when the original 30-min token expires. Idle sessions still
		// expire (no requests → no renewal).
		if c, err := r.Cookie(sessionCookieName); err == nil {
			if authTime, ok := s.validSession(c.Value, user); ok {
				s.issueSession(w, r, user, authTime)
				next.ServeHTTP(w, r)
				return
			}
		}
		// Bearer token path (API / scripts).
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			if _, ok := s.validSession(strings.TrimPrefix(h, "Bearer "), user); ok {
				next.ServeHTTP(w, r)
				return
			}
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
	})
}
