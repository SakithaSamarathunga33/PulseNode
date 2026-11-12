import { describe, expect, it } from "vitest"
import { appendLive } from "@/lib/live-buffer"

describe("appendLive", () => {
  it("appends a point without mutating the previous buffer", () => {
    const prev = [{ time: 100, value: 1 }]
    const next = appendLive(prev, { time: 103, value: 2 }, 60)
    expect(next).toEqual([{ time: 100, value: 1 }, { time: 103, value: 2 }])
    expect(prev).toHaveLength(1)
  })

  it("drops points older than the window, keeping one just outside so the line reaches the edge", () => {
    const prev = [10, 20, 30, 40].map(t => ({ time: t, value: t }))
    const next = appendLive(prev, { time: 100, value: 0 }, 65)
    // 100 - 65 = 35 → keep 30 (last point before the cutoff) and everything after.
    expect(next.map(p => p.time)).toEqual([30, 40, 100])
  })

  it("ignores a point that is not newer than the last one", () => {
    const prev = [{ time: 50, value: 1 }]
    expect(appendLive(prev, { time: 50, value: 9 }, 60)).toBe(prev)
    expect(appendLive(prev, { time: 40, value: 9 }, 60)).toBe(prev)
  })
})
