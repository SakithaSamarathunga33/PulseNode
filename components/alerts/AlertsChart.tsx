"use client"

import { useMemo } from "react"
import { BarChart3 } from "lucide-react"
import { BarChart } from "@/components/charts/bar-chart"
import { Bar } from "@/components/charts/bar"
import { BarXAxis } from "@/components/charts/bar-x-axis"
import { Grid } from "@/components/charts/grid"
import { ChartTooltip } from "@/components/charts/tooltip"
import { HISTORY_LIMIT, type AlertEvent } from "./shared"
import { ALERT_DAYS, bucketByDay } from "./alert-days"
import { Panel } from "@/components/pn/Panel"

const DAYS = ALERT_DAYS
const MARGIN = { top: 8, right: 4, bottom: 34, left: 4 }
const SERIES = [
  { key: "critical", label: "Critical", color: "var(--danger)" },
  { key: "warning", label: "Warning", color: "var(--warning)" },
  { key: "info", label: "Info", color: "var(--info)" },
] as const

/** Alerts fired per day over the last week, stacked by severity (Bklit BarChart). */
export function AlertsChart({ events }: { events: AlertEvent[] }) {
  const rows = useMemo(() => bucketByDay(events), [events])
  const totals = useMemo(
    () => SERIES.map(s => ({ ...s, value: rows.reduce((a, r) => a + r[s.key], 0) })),
    [rows],
  )
  const total = totals.reduce((a, s) => a + s.value, 0)
  const summary = `${total} alerts fired in the last ${DAYS} days: ${totals.map(s => `${s.value} ${s.label.toLowerCase()}`).join(", ")}.`

  return (
    <Panel role="region" aria-labelledby="alerts-chart-title" className="space-y-3 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="alerts-chart-title" className="inline-flex items-center gap-2 text-sm font-semibold">
          <BarChart3 className="size-4 text-[var(--hue)]" strokeWidth={1.75} aria-hidden />Alerts fired · last {DAYS} days
        </h2>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]" aria-label="Severity totals">
          {totals.map(s => (
            <li key={s.key} className="inline-flex items-center gap-1.5 text-muted-foreground">
              <span aria-hidden className="size-2 rounded-[2px]" style={{ background: s.color }} />
              {s.label} <span className="font-mono text-foreground tabular-nums">{s.value}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="sr-only">{summary}</p>
      {events.length >= HISTORY_LIMIT && (
        <p className="text-xs text-muted-foreground">Counted from the latest {HISTORY_LIMIT} alerts; older days may be incomplete.</p>
      )}
      {total === 0 ? (
        <p className="text-[13px] text-muted-foreground">No alerts fired in the last {DAYS} days.</p>
      ) : (
        <div aria-hidden>
          <BarChart data={rows} xDataKey="name" stacked aspectRatio="auto" className="h-[180px]" margin={MARGIN} barGap={0.35} animationDuration={600}>
            <Grid horizontal numTicksRows={3} strokeOpacity={0.7} />
            {SERIES.map(s => <Bar key={s.key} dataKey={s.key} fill={s.color} lineCap={2} />)}
            <BarXAxis showAllLabels />
            <ChartTooltip rows={p => SERIES.map(s => ({ color: s.color, label: s.label, value: Number(p[s.key] ?? 0) }))} />
          </BarChart>
        </div>
      )}
    </Panel>
  )
}
