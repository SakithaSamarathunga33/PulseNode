import { describe, expect, it } from "vitest"
import { durationRows, median } from "@/components/projects/deploy-durations"

const dep = (id: string, status: string, sha: string, start: string | null, end: string | null) =>
  ({ ID: id, Status: status, CommitSHA: sha, StartedAt: start, FinishedAt: end })

describe("durationRows", () => {
  it("skips builds with unparseable timestamps instead of charting NaN", () => {
    const rows = durationRows([
      dep("d2", "success", "bbbbbbb1", "not-a-date", "2026-01-01T00:05:41Z"),
      dep("d1", "success", "aaaaaaa1", "2026-01-01T00:00:00Z", "2026-01-01T00:02:00Z"),
    ])
    expect(rows).toEqual([{ name: "aaaaaaa", success: 120 }])
  })

  it("keeps finished success/failed builds, oldest first, keyed by outcome", () => {
    const rows = durationRows([
      dep("d3", "building", "ccccccc1", "2026-01-01T00:10:00Z", null),
      dep("d2", "failed", "bbbbbbb1", "2026-01-01T00:05:00Z", "2026-01-01T00:05:41Z"),
      dep("d1", "success", "aaaaaaa1", "2026-01-01T00:00:00Z", "2026-01-01T00:02:00Z"),
    ])
    expect(rows).toEqual([
      { name: "aaaaaaa", success: 120 },
      { name: "bbbbbbb", failed: 41 },
    ])
  })

  it("skips rows without timestamps and makes repeated SHAs unique", () => {
    const rows = durationRows([
      dep("r2", "success", "abc1234", "2026-01-01T01:00:00Z", "2026-01-01T01:00:10Z"),
      dep("x", "success", "zzz", null, "2026-01-01T00:30:00Z"),
      dep("r1", "success", "abc1234", "2026-01-01T00:00:00Z", "2026-01-01T00:00:05Z"),
    ])
    expect(rows.map(r => r.name)).toEqual(["abc1234", "abc1234 (2)"])
  })
})

describe("median", () => {
  it("handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(3)
  })
})
