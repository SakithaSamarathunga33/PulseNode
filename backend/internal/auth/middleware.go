package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type Config struct {
	Enabled bool
	Secret  string
}

type Middleware struct {
	enabled bool
	secret  []byte
}

func NewMiddleware(cfg Config) *Middleware {
	return &Middleware{enabled: cfg.Enabled, secret: []byte(cfg.Secret)}
}

func (m *Middleware) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !m.enabled {
			next.ServeHTTP(w, r)
			return
		}
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			writeAuthError(w, "Missing Authorization header")
			return
		}
		if !m.validJWT(strings.TrimPrefix(header, "Bearer ")) {
			writeAuthError(w, "Invalid or expired token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (m *Middleware) validJWT(token string) bool {
	_, ok := m.ParseToken(token)
	return ok
}

// ParseToken verifies the signature and expiry of token and returns its claims.
// Tokens without an exp claim are rejected so a leaked token can't live forever.
func (m *Middleware) ParseToken(token string) (map[string]any, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, false
	}
	mac := hmac.New(sha256.New, m.secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(parts[2])) {
		return nil, false
	}

	var claims map[string]any
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(payload, &claims) != nil {
		return nil, false
	}
	exp, ok := claims["exp"].(float64)
	if !ok || int64(exp) <= nowUnix() {
		return nil, false
	}
	return claims, true
}

func nowUnix() int64 {
	return time.Now().Unix()
}

// ValidateToken reports whether the given JWT string is valid and unexpired.
func (m *Middleware) ValidateToken(token string) bool {
	return m.validJWT(token)
}

// MakeJWT creates a signed JWT for the given username, expiring in ttlSecs seconds.
// extra claims (if any) are merged into the payload.
func (m *Middleware) MakeJWT(username string, ttlSecs int64, extra ...map[string]any) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	claims := map[string]any{"sub": username, "exp": time.Now().Unix() + ttlSecs}
	for _, e := range extra {
		for k, v := range e {
			claims[k] = v
		}
	}
	payload, _ := json.Marshal(claims)
	enc := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, m.secret)
	mac.Write([]byte(header + "." + enc))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return header + "." + enc + "." + sig
}

func writeAuthError(w http.ResponseWriter, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(`{"error":"` + message + `"}`))
}
