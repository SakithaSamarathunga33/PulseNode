import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { LiveBadge } from "@/components/pn/LiveBadge"

export type LegendItem = { label: string; color: string }

/** Titled chart panel: current value + unit in the header, legend under the plot. */
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
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          {title}
          {live && <LiveBadge>Live</LiveBadge>}
        </CardTitle>
        <CardAction className="flex items-baseline gap-1">
          <span className="font-mono text-base font-semibold tabular-nums">{value}</span>
          {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
        </CardAction>
      </CardHeader>
      <CardContent className="px-2">
        {children}
        {legend && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-2 text-xs text-muted-foreground">
            {legend.map(l => (
              <span key={l.label} className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: l.color }} />
                {l.label}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
