"use client"

import { useMemo } from "react"
import { AreaChart } from "@/components/charts/area-chart"
import { Area } from "@/components/charts/area"
import { Grid } from "@/components/charts/grid"
import { ChartTooltip } from "@/components/charts/tooltip"
import { toChartRows, type TimeSeries } from "@/lib/chart-rows"

export type { TimeSeries }

const MARGIN = { top: 12, right: 6, bottom: 8, left: 6 }

/**
 * Live area chart (Bklit) for the host metric histories. Series values are plotted
 * evenly spaced, newest on the right; hover shows every series' value with `unit`.
 * The y-axis fits the data unless `max` pins it (e.g. 100 for percentages); the tooltip carries exact numbers.
 */
export function TimeSeriesChart({
  series, height = 200, stepMs = 5000, unit = "", decimals = 1, max,
}: {
  series: TimeSeries[]
  height?: number
  stepMs?: number
  unit?: string
  decimals?: number
  /** Pins the top of the y-axis (an invisible constant series) so small values read as small. */
  max?: number
}) {
  const data = useMemo(() => toChartRows(series, stepMs, max), [series, stepMs, max])
  const ready = data.length >= 2

  return (
    <AreaChart
      data={data}
      aspectRatio="auto"
      style={{ height }}
      margin={MARGIN}
      status={ready ? "ready" : "loading"}
      animationDuration={700}
    >
      <Grid horizontal numTicksRows={4} strokeOpacity={0.7} />
      {max !== undefined && (
        <Area dataKey="ceiling" fill="transparent" fillOpacity={0} stroke="transparent" showLine={false} showHighlight={false} animate={false} />
      )}
      {series.map((s, i) => (
        <Area key={s.label} dataKey={`s${i}`} fill={s.color} stroke={s.color} strokeWidth={1.75} fillOpacity={0.35} />
      ))}
      <ChartTooltip
        showDatePill={false}
        dotSize={4}
        rows={point => series.map((s, i) => ({
          color: s.color,
          label: s.label,
          value: `${Number(point[`s${i}`] ?? 0).toFixed(decimals)}${unit}`,
        }))}
      />
    </AreaChart>
  )
}
