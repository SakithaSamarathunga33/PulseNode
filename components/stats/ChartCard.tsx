import { Card, CardContent } from "@/components/ui/card"
import { LiveBadge } from "@/components/pn/LiveBadge"

export type LegendItem = { label: string; color: string }

/** Titled chart panel: title, then current value + unit with the legend inline, plot below. */
export function ChartCard({
  title, value, unit, live, legend, children,
}: {
  title: string
  value: React.ReactNode
  unit?: string
  live?: boolean
  legend?: LegendItem[]
  children: React.ReactNode
}) {
  return (
    <Card className="gap-3 py-4">
      <div className="space-y-1.5 px-[18px]">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {title}
          {live && <LiveBadge>Live</LiveBadge>}
        </h2>
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
          <span className="text-[22px] font-semibold tracking-tight tabular-nums">{value}</span>
          {unit && <span className="text-[13px] text-muted-foreground">{unit}</span>}
          {legend && legend.length > 1 && legend.map(l => (
            <span key={l.label} className="ml-2.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-0.5 w-2.5 rounded-full" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      </div>
      <CardContent className="px-2">{children}</CardContent>
    </Card>
  )
}
