import { cn } from "@/lib/utils"

/** Pulsing "Live · 3s" indicator. Set `stale` when updates stopped. */
export function LiveBadge({ children = "Live", stale, className }: { children?: React.ReactNode; stale?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", stale ? "text-warning" : "text-success", className)}>
      <span className={cn("size-1.5 rounded-full bg-current", !stale && "status-live")} />
      {children}
    </span>
  )
}
