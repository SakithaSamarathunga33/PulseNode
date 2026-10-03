"use client"

import type { LucideIcon } from "lucide-react"
import { NumberTicker } from "@/components/magicui/number-ticker"
import { cn } from "@/lib/utils"

interface StatCardProps {
  label: string
  value: number | string
  unit?: string
  sub?: React.ReactNode
  icon?: LucideIcon
  spark?: number[]
  delta?: string
  deltaTone?: "up" | "down" | "flat"
  /** "acc" uses the page's area hue; the others are fixed status colours. */
  tone?: "acc" | "warn" | "bad" | "info" | "ok"
  accent?: boolean
  animate?: boolean
}

const TONE_VAR: Record<string, string> = {
  acc: "var(--hue, var(--primary))",
  ok: "var(--success)", warn: "var(--warning)", bad: "var(--danger)", info: "var(--info)",
}

function MiniSparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null
  const max = Math.max(...data), min = Math.min(...data), range = max - min || 1
  const w = 84, h = 30
  const x = (i: number) => (i * w) / (data.length - 1)
  const y = (v: number) => h - 3 - ((v - min) / range) * (h - 6)
  const d = data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block overflow-visible text-[var(--tone)]" aria-hidden>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="currentColor" fillOpacity={0.16} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r={2.4} fill="currentColor" />
    </svg>
  )
}

/** Headline metric tile, tinted with its tone (page area hue by default). */
export function StatCard({
  label, value, unit, sub, icon: Icon, spark, delta, deltaTone, tone = "acc", animate = true,
}: StatCardProps) {
  const isNum = typeof value === "number"
  return (
    <div
      style={{ "--tone": TONE_VAR[tone] } as React.CSSProperties}
      className="relative min-w-0 overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--tone)_22%,var(--border))] bg-[color-mix(in_srgb,var(--tone)_7%,var(--card))] p-4 shadow-card"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
          {Icon && (
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[color-mix(in_srgb,var(--tone)_16%,transparent)] text-[var(--tone)]">
              <Icon className="size-3.5" />
            </span>
          )}
          <span className="truncate">{label}</span>
        </span>
        {delta && (
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px]",
              deltaTone === "up" && "bg-success/12 text-success",
              deltaTone === "down" && "bg-danger/12 text-danger",
              (!deltaTone || deltaTone === "flat") && "bg-muted text-muted-foreground",
            )}
          >
            {delta}
          </span>
        )}
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold tabular-nums tracking-tight">
              {isNum && animate ? <NumberTicker value={value as number} className="text-2xl font-bold" /> : value}
            </span>
            {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
          </div>
          {sub && <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">{sub}</div>}
        </div>
        {spark && <div className="shrink-0"><MiniSparkline data={spark} /></div>}
      </div>
    </div>
  )
}
