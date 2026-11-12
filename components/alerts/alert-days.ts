import type { AlertEvent } from "./shared"

export const ALERT_DAYS = 7

export type DayRow = { name: string; critical: number; warning: number; info: number }

/** Buckets alerts into the last `days` local calendar days (oldest first), split by severity; unknown severities count as info. */
export function bucketByDay(events: Pick<AlertEvent, "firedAt" | "severity">[], now = new Date(), days = ALERT_DAYS): DayRow[] {
  const dates = Array.from({ length: days }, (_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1) + i))
  const index = new Map(dates.map((d, i) => [d.toDateString(), i]))
  const rows: DayRow[] = dates.map(d => ({
    name: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }),
    critical: 0, warning: 0, info: 0,
  }))
  for (const e of events) {
    const t = new Date(e.firedAt)
    const i = Number.isFinite(t.getTime()) ? index.get(t.toDateString()) : undefined
    if (i === undefined) continue
    const sev = e.severity === "critical" || e.severity === "warning" ? e.severity : "info"
    rows[i] = { ...rows[i], [sev]: rows[i][sev] + 1 }
  }
  return rows
}
