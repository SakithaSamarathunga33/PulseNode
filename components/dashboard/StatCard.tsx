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

function MiniSparkline({ data, id }: { data: number[]; id: string }) {
  if (data.length < 2) return null
  const max = Math.max(...data), min = Math.min(...data), range = max - min || 1
  const w = 96, h = 32
  const x = (i: number) => (i * w) / (data.length - 1)
  const y = (v: number) => h - 3 - ((v - min) / range) * (h - 6)
  const d = data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block overflow-visible text-[var(--tone)]" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity={0.22} />
          <stop offset="1" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r={2.25} fill="currentColor" />
    </svg>
  )
}

/** Headline metric tile on the card surface; tone colours the icon, sparkline and status. */
export function StatCard({
  label, value, unit, sub, icon: Icon, spark, delta, deltaTone, tone = "acc", animate = true,
}: StatCardProps) {
  const isNum = typeof value === "number"
  return (
    <div
      style={{ "--tone": TONE_VAR[tone] } as React.CSSProperties}
      className="group/stat relative min-w-0 overflow-hidden rounded-xl border bg-card p-4 shadow-card transition-colors hover:border-[var(--border-2)]"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-ui font-medium text-muted-foreground">
          {Icon && <Icon className="size-4 shrink-0 text-[var(--tone)]" strokeWidth={1.75} />}
          <span className="truncate">{label}</span>
        </span>
        {delta && (
          <span
            className={cn(
              "shrink-0 rounded-md px-1.5 py-0.5 font-mono text-2xs tabular-nums",
              deltaTone === "up" && "bg-success/12 text-success",
              deltaTone === "down" && "bg-danger/12 text-danger",
              (!deltaTone || deltaTone === "flat") && "bg-muted text-muted-foreground",
            )}
          >
            {delta}
          </span>
        )}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-1">
            <span className="text-metric leading-none font-semibold tracking-tight tabular-nums">
              {isNum && animate ? <NumberTicker value={value as number} className="text-metric leading-none font-semibold" /> : value}
            </span>
            {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
          </div>
          {sub && <div className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">{sub}</div>}
        </div>
        {spark && <div className="shrink-0"><MiniSparkline data={spark} id={`spark-${label.replace(/\W+/g, "-")}`} /></div>}
      </div>
    </div>
  )
}
