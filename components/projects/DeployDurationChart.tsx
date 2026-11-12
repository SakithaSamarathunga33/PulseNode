"use client"

import { useMemo } from "react"
import { BarChart } from "@/components/charts/bar-chart"
import { Bar } from "@/components/charts/bar"
import { BarXAxis } from "@/components/charts/bar-x-axis"
import { Grid } from "@/components/charts/grid"
import { ChartTooltip } from "@/components/charts/tooltip"
import { StatusDot } from "@/components/pn/StatusDot"
import { fmtSeconds, type Deployment } from "@/components/projects/project-ui"
import { durationRows, median } from "@/components/projects/deploy-durations"
import { Panel } from "@/components/pn/Panel"

const MARGIN = { top: 8, right: 4, bottom: 28, left: 4 }

/**
 * Build time of the recent deployments as bars coloured by outcome. Renders nothing when
 * no deployment has both a start and finish time. The summary line carries the numbers.
 */
export function DeployDurationChart({ deployments }: { deployments: Deployment[] }) {
  const rows = useMemo(() => durationRows(deployments), [deployments])
  if (rows.length === 0) return null

  const secs = rows.map(r => r.success ?? r.failed ?? 0)
  const failed = rows.filter(r => r.failed !== undefined).length

  return (
    <Panel role="region" aria-label="Build durations" className="rounded-xl px-4 pt-4 pb-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">Build duration</h2>
        <p className="text-xs text-muted-foreground tabular-nums">
          Last {rows.length} · median {fmtSeconds(median(secs))} · slowest {fmtSeconds(Math.max(...secs))}
          {failed > 0 && <> · {failed} failed</>}
        </p>
      </div>
      <div aria-hidden className="mt-2">
        <BarChart data={rows} aspectRatio="auto" className="h-32" margin={MARGIN} stacked stackGap={1} barGap={0.3} animationDuration={600}>
          <Grid horizontal numTicksRows={3} strokeOpacity={0.7} />
          <Bar dataKey="success" fill="var(--success)" lineCap={3} />
          <Bar dataKey="failed" fill="var(--danger)" lineCap={3} />
          <BarXAxis maxLabels={6} />
          <ChartTooltip
            showDatePill={false}
            showDots={false}
            rows={point => [{
              color: point.failed !== undefined ? "var(--danger)" : "var(--success)",
              label: point.failed !== undefined ? "Failed" : "Succeeded",
              value: fmtSeconds(Number(point.failed ?? point.success ?? 0)),
            }]}
          />
        </BarChart>
      </div>
      <div className="flex items-center gap-4 border-t pt-2 text-xs text-muted-foreground" aria-hidden>
        <span className="inline-flex items-center gap-1.5"><StatusDot tone="ok" className="text-success" />Succeeded</span>
        <span className="inline-flex items-center gap-1.5"><StatusDot tone="bad" className="text-danger" />Failed</span>
      </div>
    </Panel>
  )
}
