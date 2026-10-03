package api

import (
	"strings"
	"sync"
	"time"
)

// loginLimiter throttles password guessing without letting an attacker lock the
// real admin out.
//
// Three limits, none of which trusts the client IP alone (X-Real-IP can be forged
// by anything that shares the proxy network):
//   - per (account, IP): pairMax failures hard-block that IP for the window. An IP
//     that has logged in to the account before ("known") gets the larger
//     knownPairMax so a spoofer burning a pair cannot easily lock the owner out.
//   - per account across all IPs: after userCeiling failures in the window,
//     UNFAMILIAR IPs are slowed to one attempt per gap (growing with the failure
//     count, capped at gapMax) — never hard-blocked, so the owner can still sign in
//     from a new place by waiting. Known IPs skip this ceiling.
//   - attempts for usernames that do not exist ("?") are only counted per IP: they
//     can never succeed, so there is nothing to protect and no per-name state for
//     an attacker to fill or evict.
//
// State is in memory, bounded, and resets on restart.
type loginLimiter struct {
	mu           sync.Mutex
	now          func() time.Time
	window       time.Duration
	pairMax      int
	knownPairMax int
	userCeiling  int
	gapStep      time.Duration
	gapMax       time.Duration
	pairs        map[string][]time.Time // account|ip → failure times
	users        map[string]*acctState
	known        map[string]time.Time // account|ip → last successful login
}

type acctState struct {
	fails     []time.Time
	lastAdmit time.Time // last attempt let through while over the ceiling
}

const (
	loginLimiterMaxPairs = 4096
	loginLimiterMaxUsers = 64
	loginLimiterMaxKnown = 256
	unknownAccount       = "?"
)

func newLoginLimiter(pairMax int, window time.Duration) *loginLimiter {
	return &loginLimiter{
		now: time.Now, window: window,
		pairMax: pairMax, knownPairMax: pairMax * 3, userCeiling: pairMax * 2,
		gapStep: 30 * time.Second, gapMax: 15 * time.Minute,
		pairs: map[string][]time.Time{}, users: map[string]*acctState{}, known: map[string]time.Time{},
	}
}

func limiterKey(k string) string {
	k = strings.ToLower(strings.TrimSpace(k))
	if len(k) > 64 {
		k = k[:64]
	}
	return k
}

func pairKey(account, ip string) string { return limiterKey(account) + "|" + ip }

// within keeps the failures still inside the window.
func (l *loginLimiter) within(ts []time.Time, now time.Time) []time.Time {
	cutoff := now.Add(-l.window)
	kept := ts[:0]
	for _, t := range ts {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	return kept
}

// check reports whether an attempt for account from ip must wait, and for how long.
func (l *loginLimiter) check(account, ip string) (time.Duration, bool) {
	account = limiterKey(account)
	pk := pairKey(account, ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()

	_, known := l.known[pk]
	if f := l.within(l.pairs[pk], now); len(f) > 0 {
		l.pairs[pk] = f
		limit := l.pairMax
		if known {
			limit = l.knownPairMax
		}
		if len(f) >= limit {
			return f[len(f)-limit].Add(l.window).Sub(now), true
		}
	} else {
		delete(l.pairs, pk)
	}

	if account == unknownAccount || known {
		return 0, false
	}
	u := l.users[account]
	if u == nil {
		return 0, false
	}
	u.fails = l.within(u.fails, now)
	if n := len(u.fails); n >= l.userCeiling {
		gap := l.gapStep * time.Duration(n-l.userCeiling+1)
		if gap > l.gapMax {
			gap = l.gapMax
		}
		if since := now.Sub(u.lastAdmit); since < gap {
			return gap - since, true
		}
		u.lastAdmit = now // this attempt is the one let through
	}
	return 0, false
}

// fail records one failed attempt for account from ip.
func (l *loginLimiter) fail(account, ip string) {
	account = limiterKey(account)
	pk := pairKey(account, ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if _, ok := l.pairs[pk]; !ok && len(l.pairs) >= loginLimiterMaxPairs {
		l.evictPairs(now)
	}
	l.pairs[pk] = append(l.within(l.pairs[pk], now), now)
	if account == unknownAccount {
		return
	}
	u := l.users[account]
	if u == nil {
		if len(l.users) >= loginLimiterMaxUsers {
			return // callers only pass the real account(s), so this is unreachable in practice
		}
		u = &acctState{}
		l.users[account] = u
	}
	u.fails = append(l.within(u.fails, now), now)
}

// evictPairs makes room: drop expired entries first, then the oldest one. Only
// the best-effort per-IP counters live here; the per-account ceiling is separate,
// so flooding this map cannot reset it.
func (l *loginLimiter) evictPairs(now time.Time) {
	var oldestKey string
	var oldest time.Time
	for k, ts := range l.pairs {
		f := l.within(ts, now)
		if len(f) == 0 {
			delete(l.pairs, k)
			continue
		}
		l.pairs[k] = f
		if last := f[len(f)-1]; oldestKey == "" || last.Before(oldest) {
			oldestKey, oldest = k, last
		}
	}
	if len(l.pairs) >= loginLimiterMaxPairs && oldestKey != "" {
		delete(l.pairs, oldestKey)
	}
}

// success clears the failures of account/ip and the account-wide count, and
// remembers ip as one the owner signs in from.
func (l *loginLimiter) success(account, ip string) {
	account = limiterKey(account)
	pk := pairKey(account, ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.pairs, pk)
	delete(l.users, account)
	if account == unknownAccount {
		return
	}
	if _, ok := l.known[pk]; !ok && len(l.known) >= loginLimiterMaxKnown {
		var oldestKey string
		var oldest time.Time
		for k, t := range l.known {
			if oldestKey == "" || t.Before(oldest) {
				oldestKey, oldest = k, t
			}
		}
		delete(l.known, oldestKey)
	}
	l.known[pk] = l.now()
}

// loginGuard: 10 failures per (account, IP) per 15 minutes; 20 per account then slows unfamiliar IPs.
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
