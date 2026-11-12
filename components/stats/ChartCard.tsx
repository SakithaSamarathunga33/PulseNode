import type { LucideIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { LiveBadge } from "@/components/pn/LiveBadge"

export type LegendItem = { label: string; color: string }

/** Titled chart panel: title, then current value + unit with the legend inline, plot below. */
export function ChartCard({
  icon: Icon, title, value, unit, live, legend, children,
}: {
  /** Small title icon in the area hue. */
  icon?: LucideIcon
  title: string
  value: React.ReactNode
  unit?: string
  live?: boolean
  legend?: LegendItem[]
  children: React.ReactNode
}) {
  return (
    <Card className="gap-3 py-4">
      <div className="space-y-2 px-4">
        <div className="flex items-center gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            {Icon && <Icon className="size-4 text-[var(--hue)]" strokeWidth={1.75} />}
            {title}
          </h2>
          {live && <LiveBadge>Live</LiveBadge>}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
          <span className="text-metric leading-none font-semibold tracking-tight tabular-nums">{value}</span>
          {unit && <span className="text-ui text-muted-foreground">{unit}</span>}
          {legend && legend.length > 1 && legend.map(l => (
            <span key={l.label} className="ml-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
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
