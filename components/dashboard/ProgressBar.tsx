"use client"

import { cn } from "@/lib/utils"

interface ProgressBarProps {
  value: number
  tone?: "ok" | "warn" | "bad" | "info" | ""
  className?: string
  /** What is being measured, e.g. "CPU usage" — read by screen readers. */
  label?: string
}

const FILL = {
  ok: "bg-success", warn: "bg-warning", bad: "bg-danger", info: "bg-info", "": "bg-primary",
} as const

/** Thin usage bar. With no tone it turns amber at 60% and red at 80% (same thresholds as toneFor across the app). */
export function ProgressBar({ value, tone = "", className, label = "Usage" }: ProgressBarProps) {
  const t = tone || (value >= 80 ? "bad" : value >= 60 ? "warn" : "ok")
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div
      role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-border/60", className)}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-500 ease-out", FILL[t as keyof typeof FILL])} style={{ width: `${pct}%` }} />
    </div>
  )
}
