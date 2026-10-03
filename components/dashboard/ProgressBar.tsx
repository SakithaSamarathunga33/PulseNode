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

/** Thin usage bar. With no tone it turns amber above 70% and red above 85%. */
export function ProgressBar({ value, tone = "", className, label = "Usage" }: ProgressBarProps) {
  const t = tone || (value > 85 ? "bad" : value > 70 ? "warn" : "ok")
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div
      role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-500 ease-out", FILL[t as keyof typeof FILL])} style={{ width: `${pct}%` }} />
    </div>
  )
}
