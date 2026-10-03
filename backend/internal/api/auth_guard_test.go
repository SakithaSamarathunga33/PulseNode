package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func limiterAt(max int, window time.Duration) (*loginLimiter, *time.Time) {
	now := time.Now()
	l := newLoginLimiter(max, window)
	l.now = func() time.Time { return now }
	return l, &now
}

func TestPairLimitBlocksOnlyThatIPAndExpires(t *testing.T) {
	l, now := limiterAt(3, time.Minute)
	for i := 0; i < 3; i++ {
		l.fail("Admin", "10.0.0.1")
	}
	if wait, blocked := l.check(" ADMIN ", "10.0.0.1"); !blocked || wait <= 0 || wait > time.Minute {
		t.Fatalf("3 failures from one IP must block it for ≤1m, got blocked=%v wait=%v", blocked, wait)
	}
	if _, blocked := l.check("admin", "10.0.0.2"); blocked {
		t.Fatal("another IP must not be blocked by one IP's failures")
	}
	*now = now.Add(61 * time.Second)
	if _, blocked := l.check("admin", "10.0.0.1"); blocked {
		t.Fatal("the block must expire once the failures leave the window")
	}
}

// An attacker rotating (forged) source IPs, each staying under its own limit, can
// push the account over the ceiling — that must only SLOW unfamiliar IPs, never
// lock the owner out for good, and never touch an IP the owner signs in from.
func TestAttackerCannotLockOutTheOwner(t *testing.T) {
	l, now := limiterAt(3, 15*time.Minute) // pairMax 3, knownPairMax 9, ceiling 6
	l.success("admin", "203.0.113.7")      // the owner's usual IP

	for i := 0; i < 8; i++ { // 8 failures from 8 different IPs
		ip := fmt.Sprintf("198.51.100.%d", i)
		if _, blocked := l.check("admin", ip); blocked && i < 6 {
			t.Fatalf("attempt %d from a fresh IP blocked below the ceiling", i)
		}
		l.fail("admin", ip)
	}

	if _, blocked := l.check("admin", "203.0.113.7"); blocked {
		t.Fatal("the owner's known IP must never be slowed by the account ceiling")
	}
	wait, blocked := l.check("admin", "192.0.2.50")
	if !blocked {
		t.Fatal("over the ceiling, an unfamiliar IP must be slowed")
	}
	if wait <= 0 || wait > l.gapMax {
		t.Fatalf("slow-down must be bounded by gapMax, got %v", wait)
	}
	// …but only slowed: after the gap it gets through, and a successful login
	// clears the account's failures for everyone.
	*now = now.Add(wait + time.Second)
	if _, blocked := l.check("admin", "192.0.2.50"); blocked {
		t.Fatal("an unfamiliar IP must be admitted again after the gap — slow, not locked")
	}
	l.success("admin", "192.0.2.50")
	if _, blocked := l.check("admin", "192.0.2.99"); blocked {
		t.Fatal("a successful login must clear the account-wide count")
	}
}

func TestKnownIPSurvivesLongerAttack(t *testing.T) {
	l, _ := limiterAt(3, time.Minute)
	l.success("admin", "203.0.113.7")
	for i := 0; i < 8; i++ { // would hard-block an unfamiliar IP after 3
		l.fail("admin", "203.0.113.7")
	}
	if _, blocked := l.check("admin", "203.0.113.7"); blocked {
		t.Fatal("known IP gets knownPairMax (9), 8 failures must not block it")
	}
	l.fail("admin", "203.0.113.7")
	if _, blocked := l.check("admin", "203.0.113.7"); !blocked {
		t.Fatal("known IPs are still bounded")
	}
}

// Flooding the limiter with thousands of IPs / usernames must neither grow it
// without bound nor reset the account-wide counter (the old overflow bucket "*"
// stopped counting guesses once the map filled up).
func TestFloodCannotResetOrBypassTheAccountCeiling(t *testing.T) {
	l, _ := limiterAt(3, time.Hour)
	for i := 0; i < loginLimiterMaxPairs+1500; i++ {
		l.fail("admin", fmt.Sprintf("10.%d.%d.%d", i/65536, (i/256)%256, i%256))
	}
	if len(l.pairs) > loginLimiterMaxPairs {
		t.Fatalf("pair map grew to %d (max %d)", len(l.pairs), loginLimiterMaxPairs)
	}
	if u := l.users["admin"]; u == nil || len(u.fails) < l.userCeiling {
		t.Fatalf("account-wide count was lost by the flood: %+v", u)
	}
	l.check("admin", "192.0.2.1") // one attempt per gap is let through …
	if _, blocked := l.check("admin", "192.0.2.2"); !blocked {
		t.Fatal("… and the next unfamiliar one must still be slowed after a flood")
	}

	// Made-up usernames are counted per IP only: no per-name state at all.
	l2, _ := limiterAt(3, time.Hour)
	for i := 0; i < 6000; i++ {
		l2.fail(unknownAccount, fmt.Sprintf("172.16.%d.%d", (i/256)%256, i%256))
	}
	if len(l2.users) != 0 {
		t.Fatalf("unknown usernames must not create account state, got %d", len(l2.users))
	}
	if len(l2.pairs) > loginLimiterMaxPairs {
		t.Fatalf("pair map grew to %d", len(l2.pairs))
	}
}

func authGuardServer(t *testing.T) (*Server, func(user, pw, ip string) *httptest.ResponseRecorder) {
	t.Helper()
	old := loginGuard
	loginGuard = newLoginLimiter(3, time.Minute)
	t.Cleanup(func() { loginGuard = old })
	s := newAuthTestServer(t)
	if rec := postSetup(s, `{"username":"admin","password":"password123","setup_token":"test-setup-token-0123456789"}`); rec.Code != http.StatusOK {
		t.Fatalf("setup: %d", rec.Code)
	}
	login := func(user, pw, ip string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"`+user+`","password":"`+pw+`"}`))
		req.Header.Set("X-Real-IP", ip)
		rec := httptest.NewRecorder()
		s.authLogin(rec, req)
		return rec
	}
	return s, login
}

func TestAdminCannotBeLockedOutByAnAttackerIP(t *testing.T) {
	_, login := authGuardServer(t)
	for i := 0; i < 3; i++ {
		if rec := login("admin", "wrong", "198.51.100.9"); rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: %d", i, rec.Code)
		}
	}
	rec := login("admin", "wrong", "198.51.100.9")
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("the attacking IP must get 429 + Retry-After, got %d", rec.Code)
	}
	if rec := login("admin", "password123", "203.0.113.7"); rec.Code != http.StatusOK {
		t.Fatalf("the owner from another IP must still sign in, got %d", rec.Code)
	}
}

func TestWrongUsernamesNeverLockTheRealAccount(t *testing.T) {
	_, login := authGuardServer(t)
	for i := 0; i < 20; i++ {
		login(fmt.Sprintf("nobody%d", i), "x", "198.51.100.9")
	}
	if rec := login("admin", "password123", "198.51.100.9"); rec.Code != http.StatusOK {
		t.Fatalf("guessing other usernames must not affect the real account, got %d", rec.Code)
	}
	if len(loginGuard.users) > 1 {
		t.Fatalf("no per-username state for made-up names, got %d entries", len(loginGuard.users))
	}
}

func TestSetupCurrentPasswordSharesTheLoginBudget(t *testing.T) {
	s, login := authGuardServer(t)
	setup := func(ip string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/setup", strings.NewReader(`{"username":"admin","password":"newpassword1","current_password":"nope"}`))
		req.Header.Set("X-Real-IP", ip)
		rec := httptest.NewRecorder()
		s.authSetup(rec, req)
		return rec.Code
	}
	for i := 0; i < 3; i++ {
		if code := setup("198.51.100.9"); code != http.StatusUnauthorized {
			t.Fatalf("setup attempt %d: %d", i, code)
		}
	}
	// Same IP, same account: the login endpoint is now blocked too — no second budget.
	if rec := login("admin", "password123", "198.51.100.9"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("setup guesses must spend the login budget, login got %d", rec.Code)
	}
	if code := setup("198.51.100.9"); code != http.StatusTooManyRequests {
		t.Fatalf("setup must be blocked as well, got %d", code)
	}
}

func TestSuccessfulLoginClearsFailures(t *testing.T) {
	_, login := authGuardServer(t)
	login("admin", "bad", "10.0.0.1")
	login("admin", "bad", "10.0.0.1")
	if rec := login("admin", "password123", "10.0.0.1"); rec.Code != http.StatusOK {
		t.Fatalf("correct password below the limit must succeed, got %d", rec.Code)
	}
	login("admin", "bad", "10.0.0.1")
	login("admin", "bad", "10.0.0.1")
	if rec := login("admin", "password123", "10.0.0.1"); rec.Code != http.StatusOK {
		t.Fatalf("the success must have reset the counter, got %d", rec.Code)
	}
}
