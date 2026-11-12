export type TimeSeries = { label: string; values: number[]; color: string }

/**
 * Series values as Bklit chart rows `{ date, s0, s1, … }`, oldest first and spaced
 * `stepMs` apart from a fixed origin, so identical values always give identical rows
 * (Bklit re-animates when the x values change). Shorter series are right-aligned
 * (padded with 0) so every series ends on the newest point. With `max`, each row also
 * gets a constant `ceiling` column, used to pin the y-axis (e.g. 0–100 for percentages).
 */
export function toChartRows(series: TimeSeries[], stepMs: number, max?: number): Record<string, unknown>[] {
  const n = Math.max(0, ...series.map(s => s.values.length))
  return Array.from({ length: n }, (_, i) => {
    const row: Record<string, unknown> = { date: new Date(i * stepMs) }
    series.forEach((s, si) => {
      const v = s.values[i - (n - s.values.length)]
      row[`s${si}`] = typeof v === "number" ? v : 0
    })
    if (max !== undefined) row.ceiling = max
    return row
  })
}
