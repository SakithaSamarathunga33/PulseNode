package api

import (
	"strings"
	"sync"
	"time"
)

// loginLimiter locks an account after too many failed attempts inside a sliding
// window. It is keyed by the account (not the client IP) because the IP can be
// spoofed by anything sharing the proxy network, which would make a per-IP limit
// useless against password guessing. Trade-off: someone who knows the username can
// keep the account locked; that is preferred to letting passwords be guessed.
// State is in memory and resets on restart.
type loginLimiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	fails  map[string][]time.Time
	now    func() time.Time
}

const loginLimiterMaxKeys = 4096

func newLoginLimiter(max int, window time.Duration) *loginLimiter {
	return &loginLimiter{max: max, window: window, fails: map[string][]time.Time{}, now: time.Now}
}

func limiterKey(k string) string {
	k = strings.ToLower(strings.TrimSpace(k))
	if len(k) > 64 {
		k = k[:64]
	}
	return k
}

// prune drops failures older than the window. Caller holds l.mu.
func (l *loginLimiter) prune(key string, now time.Time) []time.Time {
	cutoff := now.Add(-l.window)
	kept := l.fails[key][:0]
	for _, t := range l.fails[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(l.fails, key)
		return nil
	}
	l.fails[key] = kept
	return kept
}

// locked reports whether key is locked out and for how much longer.
func (l *loginLimiter) locked(key string) (time.Duration, bool) {
	key = limiterKey(key)
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	f := l.prune(key, now)
	if len(f) < l.max {
		return 0, false
	}
	return f[len(f)-l.max].Add(l.window).Sub(now), true
}

// fail records one failed attempt.
func (l *loginLimiter) fail(key string) {
	key = limiterKey(key)
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if _, ok := l.fails[key]; !ok && len(l.fails) >= loginLimiterMaxKeys {
		for k := range l.fails { // bounded memory: forget keys whose window has passed
			l.prune(k, now)
		}
		if len(l.fails) >= loginLimiterMaxKeys {
			key = "*" // overflow bucket shared by unknown names
		}
	}
	l.fails[key] = append(l.prune(key, now), now)
}

// reset forgets key's failures (after a successful login).
func (l *loginLimiter) reset(key string) {
	l.mu.Lock()
	delete(l.fails, limiterKey(key))
	l.mu.Unlock()
}

// loginGuard: 10 failed attempts per account per 15 minutes.
var loginGuard = newLoginLimiter(10, 15*time.Minute)

// sessionRevocations remembers logged-out sessions. A session is identified by
// its original login time (auth_time), which every refreshed token carries, so
// revoking it kills every copy of the cookie, not only the latest. In memory:
// a restart forgets revocations, but tokens still expire (idle 30 min, max 12 h).
type sessionRevocations struct {
	mu sync.Mutex
	m  map[int64]int64 // auth_time → unix time after which the entry is moot
}

func newSessionRevocations() *sessionRevocations {
	return &sessionRevocations{m: map[int64]int64{}}
}

func (r *sessionRevocations) revoke(authTime int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now().Unix()
	for t, exp := range r.m {
		if exp <= now {
			delete(r.m, t)
		}
	}
	r.m[authTime] = authTime + sessionMaxAge
}

func (r *sessionRevocations) isRevoked(authTime int64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.m[authTime]
	return ok
}

var revokedSessions = newSessionRevocations()
