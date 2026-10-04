"use client"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * One-line text that ends in "…" when it does not fit; the full value appears in a
 * tooltip on hover and on keyboard focus. Give the parent (or `className`) a width
 * limit — `min-w-0` / `max-w-*` — so there is something to truncate against.
 */
export function Truncate({ text, tip, className, mono }: {
  text: string
  /** Tooltip body; defaults to `text`. */
  tip?: React.ReactNode
  className?: string
  mono?: boolean
}) {
  if (!text) return <span className={cn("text-muted-foreground", className)}>—</span>
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className={cn(
              "block min-w-0 truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              mono && "font-mono",
              className,
            )}
          />
        }
      >
        {text}
      </TooltipTrigger>
      <TooltipContent className={cn("max-w-sm break-all", mono && "font-mono")}>{tip ?? text}</TooltipContent>
    </Tooltip>
  )
}
