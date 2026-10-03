"use client"

import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { UPlotChart } from "@/components/dashboard/UPlotChart"
import { LiveBadge } from "@/components/pn/LiveBadge"

/** Live throughput chart (KB/s) for one direction. `color` is a CSS colour token, e.g. var(--chart-1). */
export function NetChart({ data, color, title, current }: { data: number[]; color: string; title: string; current: number }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <span className="size-2 rounded-full" style={{ background: color }} />
          {title}
          <LiveBadge>Live</LiveBadge>
        </CardTitle>
        <CardAction className="flex items-baseline gap-1">
          <span className="font-mono text-base font-semibold tabular-nums">{current}</span>
          <span className="text-xs text-muted-foreground">KB/s</span>
        </CardAction>
      </CardHeader>
      <CardContent className="px-2">
        <UPlotChart
          height={140}
          series={[{ label: title, values: data, color, fill: `color-mix(in srgb, ${color} 16%, transparent)` }]}
        />
      </CardContent>
    </Card>
  )
}
