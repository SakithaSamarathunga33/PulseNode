"use client"

import { useState, useRef, useEffect } from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { Download, MoreHorizontal, Zap, Trash2 } from "lucide-react"
import { HOST as MOCK_HOST, SPARKS as MOCK_SPARKS } from "@/lib/mock-data"
import { nodeApi, pythonApi, API_BASE } from "@/lib/api"
import { getSocket } from "@/lib/socket"
import type { HostInfo, SystemMetrics } from "@/lib/types"

type PyMetrics = {
  cpu: number; ram: number; disk: number
  diskRead: number; diskWrite: number
  netIn: number; netOut: number; ts: number
}
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogFooter, AlertDialogCancel,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Terminal, AnimatedSpan } from "@/components/magicui/terminal"
import { StatCard } from "@/components/dashboard/StatCard"
import { UPlotChart } from "@/components/dashboard/UPlotChart"
import { cn } from "@/lib/utils"

// ── Chart helpers ─────────────────────────────────────────────────────────────

function ChartCard({
  title, value, unit, children, dot = false,
}: {
  title: string; value: string; unit?: string; children: React.ReactNode; dot?: boolean
}) {
  return (
    <div className="gsap-enter rounded-xl bg-pulseNode-navyLight border border-pulseNode-border/10 shadow-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-pulseNode-border/10">
        <div className="flex items-center gap-2">
          {dot && <span className="w-1.5 h-1.5 rounded-full bg-green-400 status-live" />}
          <span className="text-xs font-semibold text-helm-fg">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold font-mono text-pulseNode-cyan">{value}</span>
          {unit && <span className="text-xs text-helm-fg3">{unit}</span>}
          <button className="p-1 rounded text-helm-fg3 hover:text-helm-fg transition-colors">
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>
      <div className="chart-animate px-2 pt-3 pb-2">
        {children}
      </div>
    </div>
  )
}

const TIME_OPTIONS = ["5m", "1h", "6h", "24h", "7d"]

// ── Page ───────────────────────────────────────────────────────────────────────

const HISTORY_LEN = 180

function pushHistory(arr: number[], val: number): number[] {
  const next = [...arr, val]
  if (next.length > HISTORY_LEN) next.shift()
  return next
}

export default function StatsPage() {
  const [timeRange, setTimeRange]   = useState("6h")
  const [host, setHost]             = useState<HostInfo>(MOCK_HOST)
  const [cpuHist,      setCpuHist]      = useState<number[]>(MOCK_SPARKS.cpuLong)
  const [ramHist,      setRamHist]      = useState<number[]>(MOCK_SPARKS.memLong)
  const [diskHist,     setDiskHist]     = useState<number[]>(MOCK_SPARKS.disk)
  const [diskReadHist, setDiskReadHist] = useState<number[]>([0])
  const [diskWriteHist,setDiskWriteHist]= useState<number[]>([0])
  const [netHist,      setNetHist]      = useState<number[]>(MOCK_SPARKS.net)
  const [netTxHist,    setNetTxHist]    = useState<number[]>(MOCK_SPARKS.netTx)
  const containerRef = useRef<HTMLDivElement>(null)
  const [cacheOpen,  setCacheOpen]  = useState(false)
  const [cacheLines, setCacheLines] = useState<string[]>([])
  const [cacheState, setCacheState] = useState<"idle" | "running" | "done" | "error">("idle")
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)

  const handleClearCache = async () => {
    setCacheLines(["$ docker builder prune -f"])
    setCacheState("running")
    setCacheOpen(true)

    try {
      const res = await fetch(
        `${API_BASE}/api/docker/build-cache/clear`,
        { method: "POST" }
      )
      if (!res.body) throw new Error("No response body")

      const reader = res.body.getReader()
      readerRef.current = reader
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split("\n")

        for (const raw of lines) {
          const trimmed = raw.trim()
          if (!trimmed.startsWith("data:")) continue
          try {
            const payload = JSON.parse(trimmed.slice(5).trim())
            if (payload.type === "line") {
              setCacheLines(prev => [...prev, payload.text])
            } else if (payload.type === "done") {
              setCacheLines(prev => [...prev, "✔ Build cache cleared."])
              setCacheState("done")
            } else if (payload.type === "error") {
              setCacheLines(prev => [...prev, `✗ ${payload.text}`])
              setCacheState("error")
            }
          } catch {
            // malformed SSE line — skip
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setCacheLines(prev => [...prev, `✗ ${msg}`])
      setCacheState("error")
    } finally {
      setCacheState(prev => prev === "running" ? "done" : prev)
    }
  }

  const handleCacheDialogClose = () => {
    readerRef.current?.cancel()
    readerRef.current = null
    setCacheOpen(false)
    setCacheState("idle")
    setCacheLines([])
  }

  useEffect(() => {
    nodeApi.get<HostInfo>("/api/host")
      .then(({ data }) => setHost(data))
      .catch(() => {})

    // Seed charts with real historical data from Python psutil
    pythonApi.get<PyMetrics[]>("/metrics/history")
      .then(({ data }) => {
        if (data.length > 0) {
          setCpuHist(data.map(d => d.cpu))
          setRamHist(data.map(d => d.ram))
          setDiskHist(data.map(d => d.disk))
          setDiskReadHist(data.map(d => d.diskRead  ?? 0))
          setDiskWriteHist(data.map(d => d.diskWrite ?? 0))
          setNetHist(data.map(d => d.netIn))
          setNetTxHist(data.map(d => d.netOut))
        }
      })
      .catch(() => {})

    const socket = getSocket()
    const handler = (m: SystemMetrics) => {
      setCpuHist(prev        => pushHistory(prev, m.cpu))
      setRamHist(prev        => pushHistory(prev, m.ram))
      setDiskHist(prev       => pushHistory(prev, m.disk))
      setDiskReadHist(prev   => pushHistory(prev, m.diskRead  ?? 0))
      setDiskWriteHist(prev  => pushHistory(prev, m.diskWrite ?? 0))
      setNetHist(prev        => pushHistory(prev, m.netIn))
      setNetTxHist(prev      => pushHistory(prev, m.netOut))
    }
    socket.on("system:metrics", handler)
    return () => { socket.off("system:metrics", handler) }
  }, [])

  useGSAP(() => {
    gsap.fromTo(
      ".gsap-enter",
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.45, stagger: 0.08, ease: "power2.out" }
    )
    // uPlot renders to canvas, so per-path SVG stroke animation isn't possible —
    // reveal each chart left-to-right with a clip instead (mimics a line draw)
    gsap.fromTo(
      ".chart-animate",
      { clipPath: "inset(0 100% 0 0)", opacity: 0 },
      { clipPath: "inset(0 0% 0 0)", opacity: 1, duration: 1.1, ease: "power2.out", stagger: 0.12, delay: 0.2 }
    )
  }, { scope: containerRef })

  // Memory breakdown
  const memUsed    = host.memory.used
  const memCached  = 0.6
  const memBuffers = 0.2
  const memFree    = Math.max(0, host.memory.total - memUsed - memCached - memBuffers)

  const memTotal   = host.memory.total
  const usedPct    = memTotal > 0 ? (memUsed    / memTotal) * 100 : 0
  const cachedPct  = memTotal > 0 ? (memCached  / memTotal) * 100 : 0
  const bufPct     = memTotal > 0 ? (memBuffers / memTotal) * 100 : 0
  const freePct    = memTotal > 0 ? (memFree    / memTotal) * 100 : 0

  return (
    <div ref={containerRef} className="p-6 space-y-5">
      {/* ── Header ── */}
      <div className="gsap-enter flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-helm-fg">System Stats</h1>
          <p className="text-[12px] text-helm-fg3 mt-0.5">
            {host.name} · {host.region} · {host.ip}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Time range */}
          <div className="flex items-center rounded-lg border border-pulseNode-border/15 overflow-hidden">
            {TIME_OPTIONS.map(r => (
              <button
                key={r}
                onClick={() => setTimeRange(r)}
                className={cn(
                  "px-2.5 py-1.5 text-xs transition-colors",
                  timeRange === r
                    ? "bg-pulseNode-navyLight text-helm-fg"
                    : "text-helm-fg3 hover:text-helm-fg"
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pulseNode-navyLight border border-pulseNode-border/15 text-xs text-helm-fg3 hover:text-helm-fg transition-colors">
            <Download size={12} /> Export
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pulseNode-navyLight border border-pulseNode-border/15 text-xs text-green-400 hover:text-green-300 transition-colors">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 status-live" />
            Auto · 5s
          </button>
        </div>
      </div>

      {/* ── Stat cards ── */}
      <div className="gsap-enter grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="CPU"
          value={host.cpu.usage}
          unit="%"
          spark={cpuHist}
          delta="+1.2%"
          deltaTone="up"
          tone="acc"
          accent
          sub={<span>{host.cpu.model}</span>}
        />
        <StatCard
          label="Memory"
          value={host.memory.pct}
          unit="%"
          spark={ramHist}
          delta="-0.5%"
          deltaTone="down"
          tone="warn"
          sub={<span>{host.memory.used}/{host.memory.total} {host.memory.unit} used</span>}
        />
        <StatCard
          label="Disk"
          value={host.disk.pct}
          unit="%"
          spark={diskHist}
          tone="info"
          sub={<span>{host.disk.free} {host.disk.unit} free</span>}
        />
        <StatCard
          label="Network RX"
          value={host.network.rx}
          unit={host.network.unit}
          spark={netHist}
          tone="ok"
          sub={<span>TX {host.network.tx} {host.network.unit}</span>}
        />
      </div>

      {/* ── Charts 2×2 ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* CPU */}
        <ChartCard title="CPU Usage" value={`${host.cpu.usage}%`} dot>
          <UPlotChart
            series={[{ label: "CPU%", values: cpuHist, color: "var(--pn-cyan)", fill: "rgba(47, 211, 242, 0.12)" }]}
            max={100}
          />
        </ChartCard>

        {/* Memory */}
        <ChartCard title="Memory Usage" value={`${host.memory.pct}%`} dot>
          <UPlotChart
            series={[{ label: "MEM%", values: ramHist, color: "var(--color-warning)", fill: "rgba(251, 191, 36, 0.12)" }]}
            max={100}
          />
        </ChartCard>

        {/* Disk I/O */}
        <ChartCard
          title="Disk I/O"
          value={`R:${(diskReadHist[diskReadHist.length - 1] ?? 0).toFixed(1)} W:${(diskWriteHist[diskWriteHist.length - 1] ?? 0).toFixed(1)}`}
          unit="MB/s"
        >
          <UPlotChart
            mode="bar"
            series={[
              { label: "Read", values: diskReadHist, color: "var(--pn-blue)" },
              { label: "Write", values: diskWriteHist, color: "var(--pn-cyan)" },
            ]}
          />
        </ChartCard>

        {/* Network */}
        <ChartCard title="Network" value={`↓${host.network.rx} ↑${host.network.tx}`} unit={host.network.unit}>
          <UPlotChart
            series={[
              { label: "RX", values: netHist, color: "var(--pn-cyan)" },
              { label: "TX", values: netTxHist, color: "var(--pn-blue)" },
            ]}
          />
        </ChartCard>
      </div>

      {/* ── Detail cards 3-col ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Host Info */}
        <div className="gsap-enter rounded-xl bg-pulseNode-navyLight border border-pulseNode-border/10 shadow-card p-5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-helm-fg3 mb-4">Host Info</p>
          <dl className="space-y-2.5">
            {[
              ["Hostname",  host.name],
              ["Distro",    host.distro],
              ["Kernel",    host.kernel],
              ["Uptime",    host.uptime],
              ["IP",        host.ip],
              ["Region",    host.region],
              ["CPU Model", host.cpu.model],
              ["Swap",      `${host.swap.used}/${host.swap.total} GB (${host.swap.pct}%)`],
            ].map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-2">
                <dt className="text-[11px] text-helm-fg3 shrink-0">{k}</dt>
                <dd className="text-[11px] text-helm-fg font-mono text-right truncate max-w-[180px]">{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Memory Breakdown */}
        <div className="gsap-enter rounded-xl bg-pulseNode-navyLight border border-pulseNode-border/10 shadow-card p-5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-helm-fg3 mb-4">Memory Breakdown</p>
          <p className="text-2xl font-bold text-pulseNode-cyan mb-1">
            {host.memory.used} <span className="text-sm text-helm-fg3 font-normal">/ {host.memory.total} {host.memory.unit}</span>
          </p>

          {/* Segmented bar */}
          <div className="flex h-3 rounded-full overflow-hidden gap-0.5 my-4">
            <div className="bg-pulseNode-cyan rounded-l-full" style={{ width: `${usedPct}%` }} title="Used" />
            <div className="bg-amber-400" style={{ width: `${cachedPct}%` }} title="Cached" />
            <div className="bg-pn-blue" style={{ width: `${bufPct}%` }} title="Buffers" />
            <div className="bg-pulseNode-navy rounded-r-full flex-1" title="Free" />
          </div>

          <div className="space-y-2">
            {[
              { label: "Used",    val: `${memUsed} GB`,    pct: usedPct,   color: "var(--pn-cyan)" },
              { label: "Cached",  val: `${memCached} GB`,  pct: cachedPct, color: "var(--color-warning)" },
              { label: "Buffers", val: `${memBuffers} GB`, pct: bufPct,    color: "var(--pn-blue)" },
              { label: "Free",    val: `${memFree.toFixed(1)} GB`, pct: freePct, color: "var(--pn-muted)" },
            ].map(row => (
              <div key={row.label} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: row.color }} />
                  <span className="text-[11px] text-helm-fg3">{row.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono text-helm-fg">{row.val}</span>
                  <span className="text-[10px] text-helm-fg3 w-8 text-right">{row.pct.toFixed(1)}%</span>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 pt-4 border-t border-pulseNode-border/10">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-helm-fg3 mb-2">Swap</p>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-[3px] bg-pulseNode-navy rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-amber-400" style={{ width: `${host.swap.pct}%` }} />
              </div>
              <span className="text-[11px] font-mono text-helm-fg">{host.swap.used}/{host.swap.total} GB</span>
            </div>
          </div>
        </div>

        {/* Disk */}
        <div className="gsap-enter rounded-xl bg-pulseNode-navyLight border border-pulseNode-border/10 shadow-card p-5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-helm-fg3 mb-4">Disk</p>
          <p className="text-2xl font-bold text-pulseNode-blue mb-1">
            {host.disk.pct}% <span className="text-sm text-helm-fg3 font-normal">used</span>
          </p>

          <div className="my-4 h-3 rounded-full overflow-hidden bg-pulseNode-navy">
            <div className="h-full rounded-full bg-pulseNode-blue" style={{ width: `${host.disk.pct}%` }} />
          </div>

          <div className="grid grid-cols-2 gap-3 mt-4">
            {[
              { label: "Used",  val: `${host.disk.used} ${host.disk.unit}` },
              { label: "Free",  val: `${host.disk.free} ${host.disk.unit}` },
              { label: "Total", val: `${host.disk.total} ${host.disk.unit}` },
              { label: "Type",  val: "SSD" },
            ].map(item => (
              <div key={item.label} className="rounded-lg bg-pulseNode-navy/60 px-3 py-2">
                <p className="text-[10px] text-helm-fg3">{item.label}</p>
                <p className="text-sm font-mono font-bold text-helm-fg mt-0.5">{item.val}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 pt-4 border-t border-pulseNode-border/10">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-helm-fg3 mb-2">I/O Rate</p>
            <div className="flex items-center gap-3">
              <Zap size={12} className="text-pulseNode-blue" />
              <span className="text-[11px] text-helm-fg3">Read</span>
              <span className="text-[11px] font-mono text-helm-fg ml-auto">
                {(diskReadHist[diskReadHist.length - 1] ?? 0).toFixed(1)} MB/s
              </span>
            </div>
            <div className="flex items-center gap-3 mt-1.5">
              <Zap size={12} className="text-amber-400" />
              <span className="text-[11px] text-helm-fg3">Write</span>
              <span className="text-[11px] font-mono text-helm-fg ml-auto">
                {(diskWriteHist[diskWriteHist.length - 1] ?? 0).toFixed(1)} MB/s
              </span>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-pulseNode-border/10">
            <Button
              variant="destructive"
              size="sm"
              className="w-full gap-2 text-xs"
              onClick={handleClearCache}
              disabled={cacheState === "running"}
            >
              <Trash2 size={12} />
              Clear Build Cache
            </Button>
          </div>
        </div>
      </div>

      <AlertDialog open={cacheOpen} onOpenChange={open => { if (!open) handleCacheDialogClose() }}>
        <AlertDialogContent className="max-w-2xl p-0 overflow-hidden gap-0 bg-pulseNode-navyLight border-pulseNode-border/20">
          <AlertDialogHeader className="px-5 pt-5 pb-0">
            <AlertDialogTitle className="text-sm font-semibold text-helm-fg flex items-center gap-2">
              <Trash2 size={14} className="text-red-400" />
              Clear Docker Build Cache
            </AlertDialogTitle>
          </AlertDialogHeader>

          <div className="p-5">
            <Terminal
              sequence={false}
              startOnView={false}
              className="max-w-full border-pulseNode-border/20 bg-pulseNode-navy"
            >
              {cacheLines.map((line, i) => (
                <AnimatedSpan
                  key={i}
                  className={
                    line.startsWith("✔")
                      ? "text-green-400"
                      : line.startsWith("✗")
                      ? "text-red-400"
                      : line.startsWith("$")
                      ? "text-pulseNode-blue font-mono"
                      : "text-helm-fg3 font-mono text-xs"
                  }
                >
                  {line}
                </AnimatedSpan>
              ))}
              {cacheState === "running" && (
                <AnimatedSpan className="text-helm-fg3 font-mono text-xs">
                  <span className="animate-pulse">▋</span>
                </AnimatedSpan>
              )}
            </Terminal>
          </div>

          <AlertDialogFooter className="px-5 py-4 border-t border-pulseNode-border/10 bg-transparent rounded-none">
            <AlertDialogCancel
              onClick={handleCacheDialogClose}
              variant="outline"
              className="text-xs"
            >
              {cacheState === "running" ? "Cancel" : "Close"}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
