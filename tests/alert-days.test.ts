import { describe, expect, it } from "vitest"
import { bucketByDay } from "@/components/alerts/alert-days"

const now = new Date(2026, 10, 12, 15, 0)
const at = (daysAgo: number, h = 10) => new Date(2026, 10, 12 - daysAgo, h).toISOString()

describe("bucketByDay", () => {
  it("returns seven empty days, oldest first, when there are no alerts", () => {
    const rows = bucketByDay([], now)
    expect(rows).toHaveLength(7)
    expect(rows.every(r => r.critical + r.warning + r.info === 0)).toBe(true)
  })

  it("counts alerts per local day and severity", () => {
    const rows = bucketByDay([
      { firedAt: at(0), severity: "critical" },
      { firedAt: at(0, 1), severity: "warning" },
      { firedAt: at(6), severity: "info" },
      { firedAt: at(3), severity: "critical" },
    ], now)
    expect(rows[6]).toMatchObject({ critical: 1, warning: 1, info: 0 })
    expect(rows[3].critical).toBe(1)
    expect(rows[0].info).toBe(1)
  })

  it("ignores alerts older than the window and invalid timestamps", () => {
    const rows = bucketByDay([
      { firedAt: at(7), severity: "critical" },
      { firedAt: "not a date", severity: "critical" },
    ], now)
    expect(rows.reduce((a, r) => a + r.critical, 0)).toBe(0)
  })

  it("counts unknown severities as info", () => {
    const rows = bucketByDay([{ firedAt: at(1), severity: undefined as unknown as "info" }], now)
    expect(rows[5].info).toBe(1)
  })
})
