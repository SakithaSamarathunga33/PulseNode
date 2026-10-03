package backups

import (
	"fmt"
	"time"
)

const (
	FreqHourly = "hourly"
	FreqDaily  = "daily"
	FreqWeekly = "weekly"

	DefaultRetention = 7
	MaxRetention     = 365
)

// ValidateSchedule checks the timing fields of a schedule.
func ValidateSchedule(freq string, hour, weekday, retention int) error {
	switch freq {
	case FreqHourly, FreqDaily, FreqWeekly:
	default:
		return fmt.Errorf("frequency must be hourly, daily or weekly")
	}
	if hour < 0 || hour > 23 {
		return fmt.Errorf("hour must be between 0 and 23")
	}
	if weekday < 0 || weekday > 6 {
		return fmt.Errorf("weekday must be between 0 (Sunday) and 6 (Saturday)")
	}
	if retention < 1 || retention > MaxRetention {
		return fmt.Errorf("retention must be between 1 and %d", MaxRetention)
	}
	return nil
}

// NextRun returns the first run time strictly after `from`, in from's location
// (the server's local time). hourly runs at the top of every hour, daily at
// hour:00 every day, weekly at hour:00 on the given weekday (0 = Sunday).
//
// Times are built with time.Date in the location, so a daylight-saving gap or
// overlap shifts a run by at most the DST offset instead of skipping or doubling it.
func NextRun(freq string, hour, weekday int, from time.Time) time.Time {
	loc := from.Location()
	switch freq {
	case FreqHourly:
		return time.Date(from.Year(), from.Month(), from.Day(), from.Hour()+1, 0, 0, 0, loc)
	case FreqWeekly:
		for add := 0; add <= 7; add++ {
			c := time.Date(from.Year(), from.Month(), from.Day()+add, hour, 0, 0, 0, loc)
			if int(c.Weekday()) == weekday && c.After(from) {
				return c
			}
		}
		return time.Date(from.Year(), from.Month(), from.Day()+7, hour, 0, 0, 0, loc)
	default: // daily
		c := time.Date(from.Year(), from.Month(), from.Day(), hour, 0, 0, 0, loc)
		if !c.After(from) {
			c = time.Date(from.Year(), from.Month(), from.Day()+1, hour, 0, 0, 0, loc)
		}
		return c
	}
}
