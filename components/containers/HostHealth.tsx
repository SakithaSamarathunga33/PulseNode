"use client"

import { ArrowDownRight, ArrowUpRight, CircleCheck, Cpu, HardDrive, MemoryStick, Network, OctagonAlert, TriangleAlert } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { HostInfo } from "@/lib/types"
import { cn } from "@/lib/utils"
import { sparkPaths, toneFor, trendOf, TONE_BG, TONE_TEXT, type Tone } from "./utils"

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
}

function HostCell({ cell }: { cell: Cell }) {
  const hasMeter = cell.pct !== undefined
  const tone: Tone = hasMeter ? toneFor(cell.pct!) : "ok"
  const status = STATUS[tone]
  const StatusIcon = status.icon
  const trend = trendOf(cell.hist, cell.unitTrend)
  const TrendIcon = trend.up ? ArrowUpRight : ArrowDownRight
  const main = sparkPaths(cell.hist)
  const second = cell.hist2 ? sparkPaths(cell.hist2, 200, 44, Math.max(...cell.hist, 1) * 1.15) : null

  return (
    <div className="flex min-w-0 flex-col gap-2.5 bg-card px-4 pt-4">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <cell.icon className="size-4" /> {cell.label}
        </span>
        <span className={cn("inline-flex items-center gap-1 text-[11px] font-semibold", TONE_TEXT[tone])}>
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

      <div className="truncate text-xs text-muted-foreground" title={cell.meta}>{cell.meta}</div>

      {hasMeter && (
        <div
          role="meter" aria-label={`${cell.label} usage`} aria-valuenow={Math.round(cell.pct!)} aria-valuemin={0} aria-valuemax={100}
          className="relative h-1 rounded-full bg-muted"
        >
          <div
            className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500", TONE_BG[tone])}
            style={{ width: `${Math.max(0, Math.min(100, cell.pct!))}%` }}
          />
          <span className="absolute -top-0.5 left-[60%] h-2 w-px bg-border" aria-hidden />
          <span className="absolute -top-0.5 left-[80%] h-2 w-px bg-border" aria-hidden />
        </div>
      )}

      <svg
        viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden
        className={cn("-mx-4 block h-11 w-[calc(100%+2rem)]", hasMeter ? TONE_TEXT[tone] : "text-[var(--hue,var(--primary))]")}
      >
        <path d={main.area} fill="currentColor" opacity={0.12} />
        <path d={main.line} vectorEffect="non-scaling-stroke" fill="none" stroke="currentColor" strokeWidth={1.5} />
        {second && (
          <path
            d={second.line} vectorEffect="non-scaling-stroke" fill="none"
            stroke="var(--primary)" strokeWidth={1.5} strokeDasharray="3 3"
          />
        )}
      </svg>
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
      key: "cpu", label: "CPU", icon: Cpu, value: fmt(host.cpu.usage), unit: "%", pct: host.cpu.usage, hist: cpuHist, unitTrend: "%",
      meta: `${host.cpu.cores} cores · ${host.cpu.model.split("@")[0].trim()} · load ${(host.load[0] ?? 0).toFixed(2)}`,
    },
    {
      key: "mem", label: "Memory", icon: MemoryStick, value: fmt(host.memory.used), unit: `/ ${fmt(host.memory.total)} ${host.memory.unit}`,
      pct: host.memory.pct, hist: ramHist, unitTrend: "%",
      meta: `${host.memory.pct.toFixed(1)}% used · swap ${fmt(host.swap.used)}/${fmt(host.swap.total)}`,
    },
    {
      key: "disk", label: "Disk", icon: HardDrive, value: fmt(host.disk.used), unit: `/ ${fmt(host.disk.total)} ${host.disk.unit}`,
      pct: host.disk.pct, hist: diskHist, unitTrend: "%",
      meta: `${host.disk.pct.toFixed(1)}% used · ${fmt(host.disk.free)} ${host.disk.unit} free`,
    },
    {
      key: "net", label: "Network", icon: Network, value: fmt(netRx), unit: "KB/s in", hist: netInHist, hist2: netOutHist, unitTrend: "",
      meta: `↑ ${fmt(netTx)} KB/s out`,
    },
  ]
  const info: [string, string, boolean][] = [
    ["Host", host.name, false], ["Region", host.region, false], ["IP", host.ip, true],
    ["OS", host.distro, false], ["Kernel", host.kernel, true], ["Uptime", host.uptime, false],
  ]

  return (
    <section aria-label="Host health" className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
        {cells.map(c => <HostCell key={c.key} cell={c} />)}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1.5 border-t bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
        {info.filter(([, v]) => v).map(([k, v, mono]) => (
          <span key={k} className="inline-flex gap-1.5 whitespace-nowrap">
            {k}<span className={cn("text-foreground/80", mono && "font-mono")}>{v}</span>
          </span>
        ))}
      </div>
    </section>
  )
}
