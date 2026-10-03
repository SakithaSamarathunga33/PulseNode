import type { LucideIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { UPlotChart } from "@/components/dashboard/UPlotChart"

/** Live throughput chart (KB/s) for one direction. `color` is a CSS colour token, e.g. var(--chart-1). */
export function NetChart({ data, color, title, icon: Icon, current }: {
  data: number[]; color: string; title: string; icon: LucideIcon; current: number
}) {
  const peak = data.length ? Math.round(Math.max(...data)) : 0
  return (
    <Card className="gap-3 py-4">
      <div className="flex items-start justify-between gap-3 px-[18px]">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span style={{ color }}><Icon className="size-4" /></span>{title}
          </h2>
          <p className="flex items-baseline gap-1.5">
            <span className="text-[22px] font-semibold tracking-tight tabular-nums">{current}</span>
            <span className="text-[13px] text-muted-foreground">KB/s</span>
          </p>
        </div>
        <p className="text-right text-xs leading-relaxed text-muted-foreground">
          peak <b className="font-semibold text-foreground/80 tabular-nums">{peak}</b> KB/s<br />recent samples
        </p>
      </div>
      <div className="px-2">
        <UPlotChart
          height={140}
          series={[{ label: title, values: data, color, fill: `color-mix(in srgb, ${color} 16%, transparent)` }]}
        />
      </div>
    </Card>
  )
}
