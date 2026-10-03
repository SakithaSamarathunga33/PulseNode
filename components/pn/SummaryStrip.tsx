import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export type SummaryItem = {
  label: string
  value: React.ReactNode
  unit?: string
  meta?: React.ReactNode
  icon?: LucideIcon
  /** Colour of the meta line (status colours only); default is muted. */
  tone?: "ok" | "warn" | "bad"
}

const META_TONE = { ok: "text-success", warn: "text-warning", bad: "text-danger" } as const

/**
 * The page's headline numbers as ONE card split by hairlines (instead of a row of
 * separate cards): label + icon, a big tabular value with its unit, one meta line.
 */
export function SummaryStrip({ items, className, "aria-label": ariaLabel = "Summary" }: {
  items: SummaryItem[]
  className?: string
  "aria-label"?: string
}) {
  return (
    <section
      aria-label={ariaLabel}
      className={cn(
        "grid gap-px overflow-hidden rounded-xl border bg-border shadow-card",
        items.length >= 4 ? "grid-cols-2 min-[1000px]:grid-cols-4" : items.length === 3 ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-2",
        className,
      )}
    >
      {items.map(item => (
        <div key={item.label} className="flex min-w-0 flex-col gap-1.5 bg-card px-4 py-4">
          <span className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground">
            {item.icon && <item.icon className="size-4" />}
            <span className="truncate">{item.label}</span>
          </span>
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-[28px] leading-none font-semibold tracking-tight tabular-nums">{item.value}</span>
            {item.unit && <span className="text-sm text-muted-foreground">{item.unit}</span>}
          </span>
          {item.meta && (
            <span className={cn("truncate text-xs", item.tone ? META_TONE[item.tone] : "text-muted-foreground")}>{item.meta}</span>
          )}
        </div>
      ))}
    </section>
  )
}
