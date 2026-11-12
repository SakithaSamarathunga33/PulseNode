import type { LucideIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { TimeSeriesChart } from "@/components/dashboard/TimeSeriesChart"

/** Live throughput chart (KB/s) for one direction. `color` is a CSS colour token, e.g. var(--chart-1). */
export function NetChart({ data, color, title, icon: Icon, current }: {
  data: number[]; color: string; title: string; icon: LucideIcon; current: number
}) {
  const peak = data.length ? Math.round(Math.max(...data)) : 0
  return (
    <Card className="gap-3 py-4">
      <div className="flex items-start justify-between gap-3 px-4">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span style={{ color }}><Icon className="size-4" /></span>{title}
          </h2>
          <p className="flex items-baseline gap-1.5">
            <span className="text-metric leading-none font-semibold tracking-tight tabular-nums">{current}</span>
            <span className="text-ui text-muted-foreground">KB/s</span>
          </p>
        </div>
        <p className="text-right text-xs leading-relaxed text-muted-foreground">
          peak <b className="font-semibold text-foreground tabular-nums">{peak}</b> KB/s<br />recent samples
        </p>
      </div>
      <div aria-hidden className="px-2">
        <TimeSeriesChart height={140} unit=" KB/s" decimals={0} series={[{ label: title, values: data, color }]} />
      </div>
    </Card>
  )
}
