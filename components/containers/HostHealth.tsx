"use client"

import { ArrowDownRight, ArrowUpRight, CircleCheck, Clock, Cpu, Globe, HardDrive, MapPin, MemoryStick, Monitor, Network, OctagonAlert, Server, SquareTerminal, TriangleAlert } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { HostInfo } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Truncate } from "@/components/pn/Truncate"
import { sparkPaths, toneFor, trendOf, TONE_TEXT, type Tone } from "./utils"

const STATUS: Record<Tone, { label: string; icon: LucideIcon }> = {
  ok: { label: "Normal", icon: CircleCheck },
  warn: { label: "Elevated", icon: TriangleAlert },
  bad: { label: "High", icon: OctagonAlert },
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

type Cell = {
  key: string
  label: string
  icon: LucideIcon
  value: string
  unit: string
  meta: string
  pct?: number
  hist: number[]
  hist2?: number[]
  unitTrend: string
  /** Series colour for the icon tile and sparkline. */
  color: string
}

const PILL: Record<Tone, string> = { ok: "bg-success/12", warn: "bg-warning/12", bad: "bg-danger/12" }

function HostCell({ cell }: { cell: Cell }) {
  const hasPct = cell.pct !== undefined
  const tone: Tone = hasPct ? toneFor(cell.pct!) : "ok"
  const status = STATUS[tone]
  const StatusIcon = status.icon
  const trend = trendOf(cell.hist, cell.unitTrend)
  const TrendIcon = trend.up ? ArrowUpRight : ArrowDownRight
  const main = sparkPaths(cell.hist)
  const second = cell.hist2 ? sparkPaths(cell.hist2, 200, 44, Math.max(...cell.hist, 1) * 1.15) : null

  return (
    <div
      style={{ ["--m" as string]: cell.color }}
      className="flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-2xl border bg-card px-4 pt-4 shadow-card"
      {...(hasPct ? { role: "meter", "aria-label": `${cell.label} usage`, "aria-valuenow": Math.round(cell.pct!), "aria-valuemin": 0, "aria-valuemax": 100 } : {})}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2.5 text-sm font-semibold">
          <span className="grid size-8 place-items-center rounded-lg bg-[color-mix(in_srgb,var(--m)_14%,transparent)] text-[var(--m)]">
            <cell.icon className="size-4" />
          </span>
          {cell.label}
        </span>
        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", TONE_TEXT[tone], PILL[tone])}>
          <StatusIcon className="size-3" /> {status.label}
        </span>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-3xl leading-none font-semibold tracking-tight tabular-nums">{cell.value}</span>
        <span className="text-[15px] font-medium text-muted-foreground">{cell.unit}</span>
        <span className="flex-1" />
        <span className="inline-flex items-center gap-0.5 text-xs font-medium tabular-nums text-muted-foreground">
          <TrendIcon className="size-3" /> {trend.text}
        </span>
      </div>

      <svg viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden className="-mx-4 block h-12 w-[calc(100%+2rem)] text-[var(--m)]">
        <defs>
          <linearGradient id={`spark-${cell.key}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.28} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={main.area} fill={`url(#spark-${cell.key})`} />
        <path d={main.line} vectorEffect="non-scaling-stroke" fill="none" stroke="currentColor" strokeWidth={1.75} />
        {second && (
          <path d={second.line} vectorEffect="non-scaling-stroke" fill="none" stroke="currentColor" strokeOpacity={0.55} strokeWidth={1.5} strokeDasharray="3 3" />
        )}
      </svg>

      <Truncate text={cell.meta} className="-mt-1 pb-3.5 text-xs text-muted-foreground" />
    </div>
  )
}

/** Four host vitals (CPU, memory, disk, network) with threshold meters and trends, plus the host info strip. */
export function HostHealth({
  host, cpuHist, ramHist, diskHist, netInHist, netOutHist, netRx, netTx,
}: {
  host: HostInfo
  cpuHist: number[]
  ramHist: number[]
  diskHist: number[]
  netInHist: number[]
  netOutHist: number[]
  netRx: number
  netTx: number
}) {
  const cells: Cell[] = [
    {
      key: "cpu", label: "CPU", icon: Cpu, value: fmt(host.cpu.usage), unit: "%", pct: host.cpu.usage, hist: cpuHist, unitTrend: "%", color: "var(--chart-1)",
      meta: `${host.cpu.cores} cores · ${host.cpu.model.split("@")[0].trim()} · load ${(host.load[0] ?? 0).toFixed(2)}`,
    },
    {
      key: "mem", label: "Memory", icon: MemoryStick, value: fmt(host.memory.used), unit: `/ ${fmt(host.memory.total)} ${host.memory.unit}`,
      pct: host.memory.pct, hist: ramHist, unitTrend: "%", color: "var(--chart-5)",
      meta: `${host.memory.pct.toFixed(1)}% used · swap ${fmt(host.swap.used)}/${fmt(host.swap.total)}`,
    },
    {
      key: "disk", label: "Disk", icon: HardDrive, value: fmt(host.disk.used), unit: `/ ${fmt(host.disk.total)} ${host.disk.unit}`,
      pct: host.disk.pct, hist: diskHist, unitTrend: "%", color: "var(--chart-2)",
      meta: `${host.disk.pct.toFixed(1)}% used · ${fmt(host.disk.free)} ${host.disk.unit} free`,
    },
    {
      key: "net", label: "Network", icon: Network, value: fmt(netRx), unit: "KB/s in", hist: netInHist, hist2: netOutHist, unitTrend: "", color: "var(--chart-3)",
      meta: `↑ ${fmt(netTx)} KB/s out`,
    },
  ]
  const info: [string, string, boolean, LucideIcon][] = [
    ["Host", host.name, false, Server], ["Region", host.region, false, MapPin], ["IP", host.ip, true, Globe],
    ["OS", host.distro, false, Monitor], ["Kernel", host.kernel, true, SquareTerminal], ["Uptime", host.uptime, false, Clock],
  ]

  return (
    <section aria-label="Host health" className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cells.map(c => <HostCell key={c.key} cell={c} />)}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1.5 rounded-xl border bg-card px-4 py-2.5 text-xs text-muted-foreground shadow-card">
        {info.filter(([, v]) => v).map(([k, v, mono, Icon]) => (
          <span key={k} className="inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap">
            <Icon className="size-3.5 shrink-0" aria-hidden />{k}:<Truncate text={v} mono={mono} className="font-medium text-foreground/85" />
          </span>
        ))}
      </div>
    </section>
  )
}
