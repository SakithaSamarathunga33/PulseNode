"use client"

import { ArrowDownRight, ArrowUpRight, CircleCheck, Clock, Cpu, Globe, HardDrive, MapPin, MemoryStick, Monitor, Network, OctagonAlert, Server, SquareTerminal, TriangleAlert } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { LiveLineChart } from "@/components/charts/live-line-chart"
import { LiveLine } from "@/components/charts/live-line"
import { appendLive, type LivePoint } from "@/lib/live-buffer"
import { getSocket } from "@/lib/socket"
import type { HostInfo, SystemMetrics } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Truncate } from "@/components/pn/Truncate"
import { toneFor, trendOf, TONE_TEXT, type Tone } from "./utils"
import { Panel } from "@/components/pn/Panel"
import { AnimatedCircularProgressBar } from "@/components/magicui/animated-circular-progress-bar"
import { ValueFlash } from "@/components/interior/value-flash"

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
  /** Usage % for the capacity meter and status; cells without it show no meter. */
  pct?: number
  hist: number[]
  unitTrend: string
  /** Series colour for the icon (and the live chart). */
  color: string
  /** Show the live inbound-traffic chart instead of a capacity meter. */
  live?: boolean
}

/** Seconds of inbound traffic the Network card's live chart keeps on screen. */
const LIVE_WINDOW_SEC = 60
const LIVE_H = 48

/** Inbound traffic streamed from system:metrics, stamped on arrival (browser clock). */
function NetworkLive({ color }: { color: string }) {
  const [data, setData] = useState<LivePoint[]>([])
  const lastTs = useRef<number | null>(null)

  useEffect(() => {
    try {
      const socket = getSocket()
      const onMetrics = (m: SystemMetrics) => {
        if (m.ts && m.ts === lastTs.current) return // a repeated snapshot, not a new sample
        lastTs.current = m.ts ?? null
        setData(prev => appendLive(prev, { time: Date.now() / 1000, value: m.netIn }, LIVE_WINDOW_SEC))
      }
      socket.on("system:metrics", onMetrics)
      return () => { socket.off("system:metrics", onMetrics) }
    } catch { return undefined } // socket unavailable during SSR
  }, [])

  if (data.length < 2) {
    return <p className="grid place-items-center text-[11px] text-muted-foreground" style={{ height: LIVE_H }}>Waiting for live traffic…</p>
  }
  return (
    <div aria-hidden className="-mx-1">
      <LiveLineChart
        data={data}
        value={data[data.length - 1].value}
        window={LIVE_WINDOW_SEC}
        margin={{ top: 6, right: 8, bottom: 2, left: 2 }}
        style={{ height: LIVE_H }}
      >
        <LiveLine dataKey="value" stroke={color} badge={false} momentumColors={{ up: color, down: color, flat: color }} />
      </LiveLineChart>
    </div>
  )
}

const PILL: Record<Tone, string> = { ok: "bg-success/12", warn: "bg-warning/12", bad: "bg-danger/12" }
const GAUGE: Record<Tone, string> = { ok: "var(--success)", warn: "var(--warning)", bad: "var(--danger)" }

function HostCell({ cell }: { cell: Cell }) {
  const hasPct = cell.pct !== undefined
  const tone: Tone = hasPct ? toneFor(cell.pct!) : "ok"
  const status = STATUS[tone]
  const StatusIcon = status.icon
  const trend = trendOf(cell.hist, cell.unitTrend)
  const TrendIcon = trend.up ? ArrowUpRight : ArrowDownRight
  const numeric = Number(cell.value)

  return (
    <Panel className="flex min-w-0 flex-col gap-3 rounded-xl p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
          <cell.icon className="size-4" style={{ color: cell.color }} strokeWidth={1.75} />
          {cell.label}
        </span>
        {hasPct && (
          <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-current/15 ring-inset", TONE_TEXT[tone], PILL[tone])}>
            <StatusIcon className="size-3" /> {status.label}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-baseline gap-x-1">
            {Number.isFinite(numeric)
              ? <ValueFlash value={numeric} label={cell.label} className="-ml-1.5 text-[28px] leading-none font-semibold tracking-tight" />
              : <span className="text-[28px] leading-none font-semibold tracking-tight tabular-nums">{cell.value}</span>}
            <span className="text-sm text-muted-foreground">{cell.unit}</span>
          </div>
          <span className="inline-flex items-center gap-0.5 text-xs font-medium tabular-nums text-muted-foreground">
            <TrendIcon className="size-3" /> {trend.text}
          </span>
        </div>
        {hasPct && !cell.live && (
          <div role="meter" aria-label={`${cell.label} usage`} aria-valuenow={Math.round(cell.pct!)} aria-valuemin={0} aria-valuemax={100} className="shrink-0">
            <AnimatedCircularProgressBar
              value={Math.min(100, Math.max(0, cell.pct!))}
              gaugePrimaryColor={GAUGE[tone]}
              gaugeSecondaryColor="var(--muted)"
              className="size-16 text-sm font-semibold tabular-nums"
            />
          </div>
        )}
      </div>

      {cell.live && <NetworkLive color={cell.color} />}

      <Truncate text={cell.meta} className="mt-auto text-xs text-muted-foreground" />
    </Panel>
  )
}

/** Four host vitals with trends: capacity meters for CPU, memory and disk, a live inbound-traffic chart for network; plus the host info strip. */
export function HostHealth({
  host, cpuHist, ramHist, diskHist, netInHist, netRx, netTx,
}: {
  host: HostInfo
  cpuHist: number[]
  ramHist: number[]
  diskHist: number[]
  netInHist: number[]
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
      key: "net", label: "Network", icon: Network, value: fmt(netRx), unit: "KB/s in", hist: netInHist, unitTrend: "", color: "var(--chart-3)", live: true,
      meta: `↑ ${fmt(netTx)} KB/s out · live, last ${LIVE_WINDOW_SEC}s`,
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
      <div className="flex flex-wrap gap-x-6 gap-y-1.5 rounded-lg border bg-card/60 px-4 py-2.5 text-xs text-muted-foreground">
        {info.filter(([, v]) => v).map(([k, v, mono, Icon]) => (
          <span key={k} className="inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap">
            <Icon className="size-3.5 shrink-0" aria-hidden />{k}:<Truncate text={v} mono={mono} className="font-medium text-foreground/85" />
          </span>
        ))}
      </div>
    </section>
  )
}
