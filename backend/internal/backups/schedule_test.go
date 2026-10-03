package backups

import (
	"testing"
	"time"
)

func TestNextRunDailyWeeklyHourly(t *testing.T) {
	utc := time.UTC
	at := func(y int, mo time.Month, d, h, m int) time.Time { return time.Date(y, mo, d, h, m, 0, 0, utc) }

	// 2026-10-03 is a Saturday.
	from := at(2026, 10, 3, 10, 30)
	cases := []struct {
		name          string
		freq          string
		hour, weekday int
		want          time.Time
	}{
		{"daily later today", FreqDaily, 14, 0, at(2026, 10, 3, 14, 0)},
		{"daily already passed", FreqDaily, 2, 0, at(2026, 10, 4, 2, 0)},
		{"daily exactly now is not 'after'", FreqDaily, 10, 0, at(2026, 10, 4, 10, 0)}, // 10:00 < 10:30 → tomorrow
		{"hourly", FreqHourly, 0, 0, at(2026, 10, 3, 11, 0)},
		{"weekly same day later", FreqWeekly, 18, 6, at(2026, 10, 3, 18, 0)},
		{"weekly same day passed", FreqWeekly, 9, 6, at(2026, 10, 10, 9, 0)},
		{"weekly other day", FreqWeekly, 3, 1, at(2026, 10, 5, 3, 0)}, // Monday
	}
	for _, c := range cases {
		got := NextRun(c.freq, c.hour, c.weekday, from)
		if !got.Equal(c.want) {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
		if !got.After(from) {
			t.Errorf("%s: %v is not after %v", c.name, got, from)
		}
	}
	// Exactly at the run time: the next run is the following period.
	if got := NextRun(FreqDaily, 10, 0, at(2026, 10, 3, 10, 0)); !got.Equal(at(2026, 10, 4, 10, 0)) {
		t.Errorf("exact boundary: %v", got)
	}
	if got := NextRun(FreqHourly, 0, 0, at(2026, 10, 3, 23, 59)); !got.Equal(at(2026, 10, 4, 0, 0)) {
		t.Errorf("hourly across midnight: %v", got)
	}
}

func TestNextRunAcrossDST(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata not available")
	}
	// Spring forward 2026-03-08: 02:00 does not exist. Daily at hour 2 must still
	// fire once, within 25 hours, and strictly in the future.
	from := time.Date(2026, 3, 7, 12, 0, 0, 0, loc)
	next := NextRun(FreqDaily, 2, 0, from)
	if !next.After(from) || next.Sub(from) > 26*time.Hour {
		t.Fatalf("spring-forward: %v", next)
	}
	next2 := NextRun(FreqDaily, 2, 0, next)
	if !next2.After(next) || next2.Sub(next) < 20*time.Hour || next2.Sub(next) > 26*time.Hour {
		t.Fatalf("day after spring-forward: %v -> %v", next, next2)
	}
	// Fall back 2026-11-01: hourly runs must still advance.
	f := time.Date(2026, 11, 1, 0, 30, 0, 0, loc)
	for i := 0; i < 6; i++ {
		n := NextRun(FreqHourly, 0, 0, f)
		if !n.After(f) {
			t.Fatalf("fall-back hourly did not advance: %v -> %v", f, n)
		}
		f = n
	}
}

func TestValidateSchedule(t *testing.T) {
	if err := ValidateSchedule(FreqDaily, 2, 0, 7); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		f       string
		h, w, r int
	}{{"monthly", 2, 0, 7}, {FreqDaily, 24, 0, 7}, {FreqDaily, -1, 0, 7}, {FreqWeekly, 2, 7, 7}, {FreqDaily, 2, 0, 0}, {FreqDaily, 2, 0, MaxRetention + 1}} {
		if ValidateSchedule(c.f, c.h, c.w, c.r) == nil {
			t.Errorf("accepted invalid %+v", c)
		}
	}
}
