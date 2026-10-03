import { cn } from "@/lib/utils"

export type StatusShape = "ok" | "warn" | "bad" | "info" | "off" | "accent"

/**
 * Status marker whose SHAPE carries the meaning as well as the colour:
 * circle = ok, triangle = warning, diamond = critical, ring = info, dashed ring = off.
 */
export function StatusDot({ tone, className }: { tone: StatusShape; className?: string }) {
  const common = { viewBox: "0 0 10 10", "aria-hidden": true, className: cn("size-[9px] shrink-0", className) } as const
  switch (tone) {
    case "warn":
      return <svg {...common}><path d="M5 .8 9.4 9H.6z" fill="currentColor" /></svg>
    case "bad":
      return <svg {...common}><path d="M5 .3 9.7 5 5 9.7.3 5z" fill="currentColor" /></svg>
    case "info":
      return <svg {...common}><circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
    case "off":
      return <svg {...common}><circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 1.6" /></svg>
    default:
      return <svg {...common}><circle cx="5" cy="5" r="4" fill="currentColor" /></svg>
  }
}
