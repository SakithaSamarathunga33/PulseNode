import { describe, expect, it } from "vitest"
import { toChartRows } from "@/lib/chart-rows"

describe("toChartRows", () => {
  it("spaces points stepMs apart from a fixed origin, oldest first", () => {
    const rows = toChartRows([{ label: "CPU", values: [10, 20, 30], color: "x" }], 5000)
    expect(rows.map(r => (r.date as Date).getTime())).toEqual([0, 5000, 10000])
    expect(rows.map(r => r.s0)).toEqual([10, 20, 30])
  })

  it("gives identical rows for identical values (no clock dependence)", () => {
    const series = [{ label: "CPU", values: [1, 2], color: "x" }]
    expect(toChartRows(series, 1000)).toEqual(toChartRows(series, 1000))
  })

  it("right-aligns a shorter series so both end on the newest point", () => {
    const rows = toChartRows([
      { label: "RX", values: [1, 2, 3, 4], color: "x" },
      { label: "TX", values: [7, 8], color: "y" },
    ], 1000)
    expect(rows).toHaveLength(4)
    expect(rows.map(r => r.s1)).toEqual([0, 0, 7, 8])
  })

  it("adds a constant ceiling column when max is given", () => {
    const rows = toChartRows([{ label: "CPU", values: [5, 6], color: "x" }], 1000, 100)
    expect(rows.map(r => r.ceiling)).toEqual([100, 100])
  })

  it("returns no rows for empty series", () => {
    expect(toChartRows([], 1000)).toEqual([])
    expect(toChartRows([{ label: "CPU", values: [], color: "x" }], 1000)).toEqual([])
  })
})
