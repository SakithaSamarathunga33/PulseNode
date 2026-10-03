"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import {
  RefreshCw, Square, RotateCcw,
  FileText, Terminal, BarChart2, Trash2,
  X, Send, Loader2, Play, AlertTriangle,
} from "lucide-react"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog"
import { Terminal as CacheTerminal, AnimatedSpan } from "@/components/magicui/terminal"
import { CONTAINERS as MOCK_CONTAINERS, HOST as MOCK_HOST } from "@/lib/mock-data"
import { nodeApi, API_BASE } from "@/lib/api"
import { getSocket } from "@/lib/socket"
import type { Container, ContainerStats, HostInfo, SystemMetrics } from "@/lib/types"
import { Pill } from "@/components/dashboard/Pill"
import {
  Docker, PostgreSQL, MySQL, MariaDB, Redis, MongoDB,
  ClickHouse, Elastic, NodeJs, Python,
  NestJS, NuxtJs, NextJs,
} from "developer-icons"

type DeveloperIcon = React.ComponentType<React.SVGProps<SVGSVGElement> & { size?: number }>

const IMAGE_ICONS: Array<[RegExp, DeveloperIcon]> = [
  [/postgres/i,   PostgreSQL],
  [/mysql/i,      MySQL],
  [/mariadb/i,    MariaDB],
  [/redis/i,      Redis],
  [/mongo/i,      MongoDB],
  [/clickhouse/i, ClickHouse],
  [/elastic/i,    Elastic],
  [/node/i,       NodeJs],
  [/python/i,     Python],
  [/nestjs/i,     NestJS],
  [/nuxt/i,       NuxtJs],
  [/next/i,       NextJs],
]

function ImageIcon({ image }: { image: string }) {
  for (const [re, Icon] of IMAGE_ICONS) {
    if (re.test(image)) return <Icon size={16} className="shrink-0" />
  }
  return <Docker size={16} className="shrink-0" />
}

type ContainerHistory = Record<string, { cpuHist: number[]; ramHist: number[] }>

function pushCapped<T>(arr: T[], val: T, max = 20): T[] {
  return arr.length >= max ? [...arr.slice(-(max - 1)), val] : [...arr, val]
}

// ── Mini sparkline ─────────────────────────────────────────────────────────────

function MiniSpark({
  data, color = "var(--acc)", width = 64, height = 24,
}: { data: number[]; color?: string; width?: number; height?: number }) {
  const slice = data.slice(-20)
  const max = Math.max(...slice)
  const min = Math.min(...slice)
  const range = max - min || 1
  const step = width / (slice.length - 1)
  const pts = slice.map((v, i) =>
    `${(i * step).toFixed(1)},${(height - 2 - ((v - min) / range) * (height - 4)).toFixed(1)}`
  )
  const d = `M ${pts.join(" L ")}`
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block shrink-0">
      <path d={`${d} L ${width},${height} L 0,${height} Z`} fill={color} fillOpacity={0.14} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.3} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

// ── Stat card ──────────────────────────────────────────────────────────────────

function StatCard({
  label, value, unit, sub, spark, delta, deltaTone = "flat", sparkColor = "var(--acc)",
}: {
  label: string; value: React.ReactNode; unit?: string; sub?: React.ReactNode;
  spark?: number[]; delta?: string; deltaTone?: "up" | "down" | "flat"; sparkColor?: string;
}) {
  const deltaStyle =
    deltaTone === "up"   ? { color: "var(--ok)",  background: "var(--ok-soft)" } :
    deltaTone === "down" ? { color: "var(--bad)", background: "var(--bad-soft)" } :
                           { color: "var(--fg-3)", background: "var(--bg-3)" }

  return (
    <div className="relative rounded-xl p-4 overflow-hidden"
      style={{ background: "var(--card)", border: "1px solid var(--border)", boxShadow: "var(--shadow-card)" }}>
      <div className="flex items-start justify-between mb-3">
        <span className="text-[10px] font-semibold uppercase tracking-widest"
          style={{ color: "var(--fg-3)" }}>{label}</span>
        {delta && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={deltaStyle}>
            {delta}
          </span>
        )}
      </div>
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold" style={{ color: sparkColor }}>{value}</span>
            {unit && <span className="text-sm" style={{ color: "var(--fg-3)" }}>{unit}</span>}
          </div>
          {sub && <div className="text-[11px] mt-1" style={{ color: "var(--fg-3)" }}>{sub}</div>}
        </div>
        {spark && <MiniSpark data={spark} color={sparkColor} />}
      </div>
    </div>
  )
}

// ── Logs panel ─────────────────────────────────────────────────────────────────

function LogsPanel({ container, onClose }: { container: Container; onClose: () => void }) {
  const [logs, setLogs]       = useState("Loading…")
  const [loading, setLoading] = useState(true)
  const [tail, setTail]       = useState(200)
  const scrollRef             = useRef<HTMLDivElement>(null)

  const fetchLogs = useCallback(async () => {
    try {
      const { data } = await nodeApi.get<{ logs: string }>(`/api/docker/logs/${container.id}?tail=${tail}`)
      setLogs(data.logs || "(no output)")
    } catch {
      setLogs("[error fetching logs]")
    } finally {
      setLoading(false)
    }
  }, [container.id, tail])

  useEffect(() => {
    setLoading(true)
    fetchLogs()
    const t = setInterval(() => { if (!document.hidden) fetchLogs() }, 5000)
    return () => clearInterval(t)
  }, [fetchLogs])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [logs])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2">
          <FileText size={14} style={{ color: "var(--acc)" }} />
          <span className="font-semibold text-sm" style={{ color: "var(--fg)" }}>Logs</span>
          <span className="text-xs font-mono px-2 py-0.5 rounded"
            style={{ background: "var(--bg-3)", color: "var(--fg-3)" }}>{container.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={tail}
            onChange={e => setTail(Number(e.target.value))}
            className="text-xs px-2 py-1 rounded focus:outline-hidden"
            style={{ background: "var(--bg-3)", border: "1px solid var(--border)", color: "var(--fg-2)" }}
          >
            {[50, 100, 200, 500, 1000].map(n => (
              <option key={n} value={n}>{n} lines</option>
            ))}
          </select>
          <button onClick={fetchLogs} title="Refresh"
            className="p-1.5 rounded transition-colors"
            style={{ color: "var(--fg-3)" }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = "var(--fg)" }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = "var(--fg-3)" }}>
            <RefreshCw size={13} />
          </button>
          <button onClick={onClose} title="Close"
            className="p-1.5 rounded transition-colors"
            style={{ color: "var(--fg-3)" }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = "var(--fg)" }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = "var(--fg-3)" }}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Live badge */}
      <div className="flex items-center gap-1.5 px-4 py-1.5 shrink-0"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-2)" }}>
        <span className="w-1.5 h-1.5 rounded-full status-live" style={{ background: "var(--ok)" }} />
        <span className="text-[10px]" style={{ color: "var(--fg-3)" }}>Live · refreshes every 3s</span>
        {loading && <Loader2 size={10} className="animate-spin ml-auto" style={{ color: "var(--fg-3)" }} />}
      </div>

      {/* Log output */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4"
        style={{ background: "var(--bg)" }}>
        <pre className="text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all"
          style={{ color: "var(--fg-2)" }}>{logs}</pre>
      </div>
    </div>
  )
}

// ── Terminal panel ──────────────────────────────────────────────────────────────

type TermLine = { type: "cmd" | "out" | "err"; text: string }

function TerminalPanel({ container, onClose }: { container: Container; onClose: () => void }) {
  const [lines, setLines]   = useState<TermLine[]>([
    { type: "out", text: `Connected to ${container.name}. Type a command below.` },
  ])
  const [cmd, setCmd]       = useState("")
  const [running, setRunning] = useState(false)
  const scrollRef           = useRef<HTMLDivElement>(null)
  const inputRef            = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [lines])

  const run = async () => {
    const trimmed = cmd.trim()
    if (!trimmed || running) return
    setCmd("")
    setLines(prev => [...prev, { type: "cmd", text: `$ ${trimmed}` }])
    setRunning(true)
    try {
      const result = await nodeApi.post<{ output: string }>(`/api/docker/exec/${container.id}`, { cmd: trimmed })
      const out = (result.output || "").trimEnd()
      setLines(prev => [...prev, { type: "out", text: out || "(no output)" }])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "exec failed"
      setLines(prev => [...prev, { type: "err", text: `[error] ${msg}` }])
    } finally {
      setRunning(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2">
          <Terminal size={14} style={{ color: "var(--ok)" }} />
          <span className="font-semibold text-sm" style={{ color: "var(--fg)" }}>Terminal</span>
          <span className="text-xs font-mono px-2 py-0.5 rounded"
            style={{ background: "var(--bg-3)", color: "var(--fg-3)" }}>{container.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setLines([{ type: "out", text: "Session cleared." }])} title="Clear"
            className="text-[10px] px-2 py-1 rounded transition-colors"
            style={{ background: "var(--bg-3)", color: "var(--fg-3)", border: "1px solid var(--border)" }}>
            Clear
          </button>
          <button onClick={onClose} title="Close"
            className="p-1.5 rounded transition-colors"
            style={{ color: "var(--fg-3)" }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = "var(--fg)" }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = "var(--fg-3)" }}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Output */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 font-mono text-[11px]"
        style={{ background: "var(--bg)" }}
        onClick={() => inputRef.current?.focus()}>
        {lines.map((l, i) => (
          <div key={i} className="leading-relaxed whitespace-pre-wrap break-all"
            style={{
              color: l.type === "cmd" ? "var(--acc)" : l.type === "err" ? "var(--bad)" : "var(--fg-2)",
              marginBottom: l.type === "cmd" ? "2px" : "8px",
            }}>
            {l.text}
          </div>
        ))}
        {running && (
          <div className="flex items-center gap-1.5" style={{ color: "var(--fg-3)" }}>
            <Loader2 size={10} className="animate-spin" /> running…
          </div>
        )}
      </div>

      {/* Input */}
      <div className="flex items-center gap-2 px-3 py-2.5 shrink-0"
        style={{ borderTop: "1px solid var(--border)", background: "var(--bg-2)" }}>
        <span className="font-mono text-[11px]" style={{ color: "var(--acc)" }}>$</span>
        <input
          ref={inputRef}
          type="text"
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") run() }}
          placeholder={running ? "running…" : "type a command…"}
          disabled={running}
          className="flex-1 bg-transparent font-mono text-[11px] focus:outline-hidden"
          style={{ color: "var(--fg)", caretColor: "var(--acc)" }}
          autoFocus
        />
        <button onClick={run} disabled={running || !cmd.trim()}
          className="p-1.5 rounded transition-colors"
          style={{ color: cmd.trim() && !running ? "var(--acc)" : "var(--fg-3)" }}>
          <Send size={12} />
        </button>
      </div>
    </div>
  )
}

// ── Remove confirmation dialog ─────────────────────────────────────────────────

function RemoveDialog({ container, onConfirm, onClose }: {
  container: Container; onConfirm: () => void; onClose: () => void
}) {
  return (
    <AlertDialog open onOpenChange={open => { if (!open) onClose() }}>
      <AlertDialogContent className="max-w-sm p-0 overflow-hidden gap-0"
        style={{ background: "var(--card-elev)", border: "1px solid var(--border-2)", color: "var(--fg)" }}>
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-7"
          style={{ background: "var(--bad-soft)" }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: "var(--bad-soft)", border: "2px solid var(--bad)" }}>
            <AlertTriangle size={28} style={{ color: "var(--bad)" }} />
          </div>
          <AlertDialogHeader className="text-center gap-1">
            <AlertDialogTitle className="text-base font-bold" style={{ color: "var(--bad)" }}>
              Remove container?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[12px]" style={{ color: "var(--fg-3)" }}>
              This will permanently remove the container. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
        </div>
        <div className="flex items-center gap-3 px-5 py-3"
          style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", background: "var(--bg-2)" }}>
          <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "var(--bad-soft)", border: "1px solid var(--bad)" }}>
            <Trash2 size={13} style={{ color: "var(--bad)" }} />
          </div>
          <div className="min-w-0">
            <p className="text-[12px] font-semibold truncate" style={{ color: "var(--fg)" }}>{container.name}</p>
            <p className="text-[10px] font-mono truncate" style={{ color: "var(--fg-3)" }}>{container.image}</p>
          </div>
        </div>
        <AlertDialogFooter className="flex-row gap-3 px-5 py-4 border-0 bg-transparent rounded-none"
          style={{ background: "var(--card-elev)" }}>
          <AlertDialogCancel className="flex-1 py-2 rounded-xl text-sm font-medium transition-colors"
            style={{ background: "var(--bg-3)", border: "1px solid var(--border-2)", color: "var(--fg-2)" }}>
            Cancel
          </AlertDialogCancel>
          <button onClick={() => { onConfirm(); onClose() }}
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-bold text-white transition-opacity hover:opacity-90"
            style={{ background: "var(--bad)" }}>
            <Trash2 size={15} /> Remove
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ── Action button ──────────────────────────────────────────────────────────────

function ActionBtn({
  icon, title, danger, onClick, disabled,
}: {
  icon: React.ReactNode; title: string; danger?: boolean; onClick?: () => void; disabled?: boolean
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="p-1.5 rounded-md text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ color: danger ? "var(--bad)" : "var(--fg-3)" }}
      onMouseEnter={e => {
        if (disabled) return
        const el = e.currentTarget as HTMLButtonElement
        el.style.background = danger ? "var(--bad-soft)" : "var(--bg-hover)"
        el.style.color = danger ? "var(--bad)" : "var(--fg)"
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLButtonElement
        el.style.background = "transparent"
        el.style.color = danger ? "var(--bad)" : "var(--fg-3)"
      }}
    >
      {icon}
    </button>
  )
}

// ── State badge ────────────────────────────────────────────────────────────────

function StateBadge({ state }: { state: string }) {
  switch (state) {
    case "running": return <Pill tone="ok" dot>{state}</Pill>
    case "stopped": return <Pill tone="outline">{state}</Pill>
    case "exited":  return <Pill tone="bad">{state}</Pill>
    case "paused":  return <Pill tone="warn">{state}</Pill>
    default:        return <Pill tone="outline">{state}</Pill>
  }
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ContainersPage() {
  const [tab, setTab]             = useState("running")
  const [search, setSearch]       = useState("")
  const [selected, setSelected]   = useState<Set<string>>(new Set())
  const [containers, setContainers] = useState<Container[]>(MOCK_CONTAINERS)
  const [host, setHost]             = useState<HostInfo>(MOCK_HOST)
  const [, setContainerHist] = useState<ContainerHistory>({})
  const [netHist, setNetHist]       = useState<number[]>([0, 0])
  const [cpuHist, setCpuHist]       = useState<number[]>([0, 0])
  const [ramHist, setRamHist]       = useState<number[]>([0, 0])
  const [netRx, setNetRx]           = useState(0)
  const [netTx, setNetTx]           = useState(0)
  const [panel, setPanel]           = useState<{ type: "logs" | "terminal"; container: Container } | null>(null)
  const [actionBusy, setActionBusy] = useState<Record<string, boolean>>({})
  const [removeTarget, setRemoveTarget] = useState<Container | null>(null)
  const [cacheOpen,  setCacheOpen]  = useState(false)
  const [cacheLines, setCacheLines] = useState<string[]>([])
  const [cacheState, setCacheState] = useState<"idle" | "running" | "done" | "error">("idle")
  const cacheReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    nodeApi.get<Container[]>("/api/docker/containers")
      .then(({ data }) => setContainers(data))
      .catch(() => {})
    nodeApi.get<HostInfo>("/api/host")
      .then(({ data }) => {
        setHost(data)
        setNetRx(data.network.rx)
        setNetTx(data.network.tx)
      })
      .catch(() => {})

    const socket = getSocket()

    // Live per-container CPU + RAM every 3s
    const onContainerStats = (stats: ContainerStats[]) => {
      setContainers(prev => prev.map(c => {
        const s = stats.find(s => s.containerId === c.id)
        return s ? { ...c, cpu: s.cpu, ram: s.ram } : c
      }))
      setContainerHist(prev => {
        const next = { ...prev }
        for (const s of stats) {
          const h = next[s.containerId] ?? { cpuHist: [], ramHist: [] }
          next[s.containerId] = {
            cpuHist: pushCapped(h.cpuHist, s.cpu),
            ramHist: pushCapped(h.ramHist, s.ram),
          }
        }
        return next
      })
    }

    // Live system metrics every 3s
    const onSystemMetrics = (m: SystemMetrics) => {
      setNetHist(prev => pushCapped(prev, m.netIn, 60))
      setCpuHist(prev => pushCapped(prev, m.cpu, 60))
      setRamHist(prev => pushCapped(prev, m.ram, 60))
      setNetRx(Math.round(m.netIn))
      setNetTx(Math.round(m.netOut))
      setHost(prev => ({
        ...prev,
        cpu: { ...prev.cpu, usage: Math.round(m.cpu * 10) / 10 },
        memory: { ...prev.memory, pct: Math.round(m.ram * 10) / 10 },
        disk: { ...prev.disk, pct: Math.round(m.disk * 10) / 10 },
      }))
    }

    socket.on("container:stats", onContainerStats)
    socket.on("system:metrics",  onSystemMetrics)
    return () => {
      socket.off("container:stats", onContainerStats)
      socket.off("system:metrics",  onSystemMetrics)
    }
  }, [])

  const refreshContainers = useCallback(() => {
    nodeApi.get<Container[]>("/api/docker/containers")
      .then(({ data }) => setContainers(data))
      .catch(() => {})
  }, [])

  const handleStop = useCallback(async (c: Container) => {
    setActionBusy(prev => ({ ...prev, [`stop-${c.id}`]: true }))
    try {
      await nodeApi.post(`/api/docker/stop/${c.id}`)
      setTimeout(refreshContainers, 1200)
    } catch {}
    setActionBusy(prev => ({ ...prev, [`stop-${c.id}`]: false }))
  }, [refreshContainers])

  const handleRestart = useCallback(async (c: Container) => {
    setActionBusy(prev => ({ ...prev, [`restart-${c.id}`]: true }))
    try {
      await nodeApi.post(`/api/docker/restart/${c.id}`)
      setTimeout(refreshContainers, 2000)
    } catch {}
    setActionBusy(prev => ({ ...prev, [`restart-${c.id}`]: false }))
  }, [refreshContainers])

  const handleStart = useCallback(async (c: Container) => {
    setActionBusy(prev => ({ ...prev, [`start-${c.id}`]: true }))
    try {
      await nodeApi.post(`/api/docker/start/${c.id}`)
      setTimeout(refreshContainers, 1200)
    } catch {}
    setActionBusy(prev => ({ ...prev, [`start-${c.id}`]: false }))
  }, [refreshContainers])

  const handleRemove = useCallback(async (c: Container) => {
    setRemoveTarget(c)
  }, [])

  const confirmRemove = useCallback(async (c: Container) => {
    setActionBusy(prev => ({ ...prev, [`remove-${c.id}`]: true }))
    try {
      await nodeApi.delete(`/api/docker/remove/${c.id}`)
      setContainers(prev => prev.filter(x => x.id !== c.id))
      if (panel?.container.id === c.id) setPanel(null)
    } catch {}
    setActionBusy(prev => ({ ...prev, [`remove-${c.id}`]: false }))
  }, [panel])

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
      cacheReaderRef.current = reader
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
    cacheReaderRef.current?.cancel()
    cacheReaderRef.current = null
    setCacheOpen(false)
    setCacheState("idle")
    setCacheLines([])
  }

  useGSAP(() => {
    gsap.fromTo(
      ".gsap-enter",
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.4, stagger: 0.07, ease: "power2.out" }
    )
  }, { scope: containerRef })

  const running = containers.filter(c => c.state === "running").length
  const stopped = containers.filter(c => c.state === "stopped").length
  const exited  = containers.filter(c => c.state === "exited").length

  const TABS = [
    { key: "all",     label: "All",     count: containers.length },
    { key: "running", label: "Running", count: running },
    { key: "stopped", label: "Stopped", count: stopped },
    { key: "exited",  label: "Exited",  count: exited },
  ]

  const filtered = containers.filter(c => {
    const matchTab    = tab === "all" || c.state === tab
    const q           = search.toLowerCase()
    const matchSearch = !q || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q)
    return matchTab && matchSearch
  })

  const toggleSelect = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const allChecked = filtered.length > 0 && filtered.every(c => selected.has(c.id))


  return (
    <div ref={containerRef} className="p-5 space-y-4">

      {/* ── Header ── */}
      <div className="gsap-enter flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--fg)" }}>Dashboard</h1>
          <p className="text-[12px] mt-0.5" style={{ color: "var(--fg-3)" }}>
            {containers.length} containers · {running} running · {stopped + exited} stopped
          </p>
        </div>
        <button
          onClick={refreshContainers}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all"
          style={{ background: "var(--bg-2)", border: "1px solid var(--border)", color: "var(--fg-2)" }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.background = "var(--bg-3)"; el.style.color = "var(--fg)"
            el.style.borderColor = "var(--border-2)"
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.background = "var(--bg-2)"; el.style.color = "var(--fg-2)"
            el.style.borderColor = "var(--border)"
          }}
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* ── Stat cards — 4 across ── */}
      <div className="gsap-enter grid grid-cols-4 gap-3">
        {/* Host */}
        <div className="relative rounded-xl p-4 overflow-hidden"
          style={{ background: "var(--card)", border: "1px solid var(--border)", boxShadow: "var(--shadow-card)" }}>
          <p className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--fg-3)" }}>Host</p>
          <p className="text-sm font-bold" style={{ color: "var(--fg)" }}>{host.name}</p>
          <p className="text-[11px] mt-0.5" style={{ color: "var(--fg-3)" }}>{host.distro} · {host.kernel}</p>
        </div>

        {/* Apps */}
        <StatCard
          label="Apps"
          value={<span>{containers.length}<span className="text-sm font-normal ml-1" style={{ color: "var(--fg-3)" }}>containers</span></span>}
          sub={
            <span className="flex items-center gap-2">
              <Pill tone="ok" dot>{running} running</Pill>
              <Pill tone="bad" dot>{stopped + exited} stopped</Pill>
            </span>
          }
          sparkColor="var(--acc)"
        />

        {/* CPU */}
        <StatCard
          label="CPU"
          value={host.cpu.usage}
          unit="%"
          spark={cpuHist}
          sparkColor="var(--acc)"
          sub={<span>{host.cpu.cores} cores · {host.cpu.model.split("@")[0].trim()}</span>}
        />

        {/* Memory */}
        <StatCard
          label="Memory"
          value={host.memory.pct}
          unit="%"
          spark={ramHist}
          sparkColor="var(--warn)"
          sub={<span>{host.memory.used}/{host.memory.total} {host.memory.unit}</span>}
        />
      </div>

      {/* ── Disk / Network / Load strip ── */}
      <div className="gsap-enter grid grid-cols-3 gap-0 rounded-xl overflow-hidden"
        style={{ background: "var(--card)", border: "1px solid var(--border)", boxShadow: "var(--shadow-card)" }}>
        {/* Disk */}
        <div className="px-5 py-4" style={{ borderRight: "1px solid var(--border)" }}>
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--fg-3)" }}>
              Disk Usage
            </span>
          </div>
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-xl font-bold" style={{ color: "var(--fg)" }}>{host.disk.pct}%</span>
            <span className="text-xs" style={{ color: "var(--fg-3)" }}>
              {host.disk.used} / {host.disk.total} {host.disk.unit} · {host.disk.free} {host.disk.unit} free
            </span>
          </div>
          <div className="mt-2 h-[3px] rounded-full overflow-hidden" style={{ background: "var(--bg-3)" }}>
            <div className="h-full rounded-full" style={{ width: `${host.disk.pct}%`, background: "var(--acc-2)" }} />
          </div>
          <button
            onClick={handleClearCache}
            disabled={cacheState === "running"}
            className="mt-3 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-50"
            style={{ background: "var(--bad-soft)", border: "1px solid var(--bad)", color: "var(--bad)" }}
          >
            <Trash2 size={12} />
            Clear Build Cache
          </button>
        </div>

        {/* Network */}
        <div className="px-5 py-4" style={{ borderRight: "1px solid var(--border)" }}>
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--fg-3)" }}>
              Network · last 60s
            </span>
          </div>
          <div className="flex items-end gap-4">
            <div>
              <p className="text-[10px]" style={{ color: "var(--fg-3)" }}>↓ RX</p>
              <p className="text-sm font-bold" style={{ color: "var(--ok)" }}>{netRx} KB/s</p>
            </div>
            <div>
              <p className="text-[10px]" style={{ color: "var(--fg-3)" }}>↑ TX</p>
              <p className="text-sm font-bold" style={{ color: "var(--ok)" }}>{netTx} KB/s</p>
            </div>
            <MiniSpark data={netHist} color="var(--ok)" width={80} height={28} />
          </div>
        </div>

        {/* Load Avg */}
        <div className="px-5 py-4">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--fg-3)" }}>
              Load Avg · 1m 5m 15m
            </span>
          </div>
          <div className="flex items-end gap-4">
            <div className="flex items-baseline gap-3">
              {host.load.map((l, i) => (
                <span key={i} className="text-xl font-bold" style={{ color: "var(--fg)" }}>
                  {l.toFixed(2)}
                </span>
              ))}
            </div>
            <MiniSpark data={netHist} color="var(--acc)" width={80} height={28} />
          </div>
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div className="gsap-enter flex items-center gap-0" style={{ borderBottom: "1px solid var(--border)" }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="px-4 py-2 text-xs font-medium transition-colors flex items-center gap-1.5"
            style={{
              color: tab === t.key ? "var(--fg)" : "var(--fg-3)",
              borderBottom: tab === t.key ? "2px solid var(--acc)" : "2px solid transparent",
              marginBottom: "-1px",
            }}
          >
            {t.label}
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-mono"
              style={{
                background: tab === t.key ? "var(--acc-soft)" : "var(--bg-3)",
                color: tab === t.key ? "var(--acc)" : "var(--fg-3)",
              }}
            >
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* ── Filter row ── */}
      <div className="gsap-enter flex items-center gap-2 flex-wrap">
        <input
          type="text"
          placeholder="Filter…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-[160px] max-w-[240px] px-3 py-1.5 rounded-lg text-xs focus:outline-hidden"
          style={{
            background: "var(--bg-2)",
            border: "1px solid var(--border)",
            color: "var(--fg)",
          }}
          onFocus={e => { (e.target as HTMLInputElement).style.borderColor = "var(--acc-border)" }}
          onBlur={e =>  { (e.target as HTMLInputElement).style.borderColor = "var(--border)" }}
        />
      </div>

      {/* ── Container table ── */}
      <div className="gsap-enter rounded-xl overflow-hidden"
        style={{ background: "var(--card)", border: "1px solid var(--border)", boxShadow: "var(--shadow-card)" }}>
        <div className="overflow-x-auto">
          <table className="pn-table w-full">
            <thead>
              <tr>
                <th className="w-10">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={() => {
                      if (allChecked) setSelected(new Set())
                      else setSelected(new Set(filtered.map(c => c.id)))
                    }}
                    className="w-3.5 h-3.5"
                  />
                </th>
                <th>Name</th>
                <th>Image</th>
                <th>State</th>
                <th>Uptime</th>
                <th>Ports</th>
                <th>CPU</th>
                <th>RAM</th>
                <th>Created</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} className="relative">
                  <td className="w-10">
                    <div className="flex items-center justify-center">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggleSelect(c.id)}
                        className="w-3.5 h-3.5"
                      />
                    </div>
                  </td>

                  {/* Name */}
                  <td>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium truncate max-w-[160px]" style={{ color: "var(--fg)" }}>{c.name}</span>
                      <span
                        className="px-1.5 py-0.5 rounded text-[9px] font-bold"
                        style={{ background: "var(--acc-soft-2)", color: "var(--acc)" }}
                      >
                        DOCKER
                      </span>
                      {c.ports && c.ports !== "—" && (
                        <span
                          className="px-1.5 py-0.5 rounded text-[9px] font-mono"
                          style={{ background: "var(--bg-3)", color: "var(--fg-3)" }}
                        >
                          {c.ports}
                        </span>
                      )}
                    </div>
                  </td>

                  <td className="mono-cell dim max-w-[200px]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <ImageIcon image={c.image} />
                      <span className="truncate">{c.image}</span>
                    </div>
                  </td>
                  <td><StateBadge state={c.state} /></td>
                  <td className="dim">{c.uptime}</td>
                  <td className="mono-cell dim">{c.ports}</td>

                  {/* CPU live */}
                  <td>
                    <span className="text-[11px] font-mono" style={{ color: "var(--fg)" }}>{c.cpu.toFixed(1)}%</span>
                  </td>

                  {/* RAM live */}
                  <td>
                    <span className="text-[11px] font-mono" style={{ color: "var(--fg)" }}>{c.ram.toFixed(1)}%</span>
                  </td>

                  <td className="dim">{c.created}</td>

                  {/* Actions */}
                  <td className="right">
                    <div className="flex items-center justify-end gap-0.5">
                      {c.state !== "running" ? (
                        <ActionBtn
                          icon={actionBusy[`start-${c.id}`] ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                          title="Start"
                          disabled={actionBusy[`start-${c.id}`]}
                          onClick={() => handleStart(c)}
                        />
                      ) : (
                        <ActionBtn
                          icon={actionBusy[`stop-${c.id}`] ? <Loader2 size={13} className="animate-spin" /> : <Square size={13} />}
                          title="Stop" danger
                          disabled={actionBusy[`stop-${c.id}`]}
                          onClick={() => handleStop(c)}
                        />
                      )}
                      <ActionBtn
                        icon={actionBusy[`restart-${c.id}`] ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                        title="Restart"
                        disabled={actionBusy[`restart-${c.id}`]}
                        onClick={() => handleRestart(c)}
                      />
                      <ActionBtn
                        icon={<FileText size={13} />}
                        title="Logs"
                        onClick={() => setPanel({ type: "logs", container: c })}
                      />
                      <ActionBtn
                        icon={<Terminal size={13} />}
                        title="Shell"
                        disabled={c.state !== "running"}
                        onClick={() => setPanel({ type: "terminal", container: c })}
                      />
                      <ActionBtn icon={<BarChart2 size={13} />} title="Stats" disabled />
                      <ActionBtn
                        icon={actionBusy[`remove-${c.id}`] ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                        title="Remove" danger
                        disabled={actionBusy[`remove-${c.id}`]}
                        onClick={() => handleRemove(c)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-4 py-2.5"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <span className="text-[11px]" style={{ color: "var(--fg-3)" }}>
            Showing {filtered.length} of {containers.length} containers
          </span>
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--ok)" }}>
            <span className="w-1.5 h-1.5 rounded-full status-live" style={{ background: "var(--ok)" }} />
            Live · 3s
          </div>
        </div>
      </div>

      {/* ── Remove confirmation dialog ── */}
      {removeTarget && (
        <RemoveDialog
          container={removeTarget}
          onConfirm={() => confirmRemove(removeTarget)}
          onClose={() => setRemoveTarget(null)}
        />
      )}

      {/* ── Clear build cache dialog ── */}
      <AlertDialog open={cacheOpen} onOpenChange={open => { if (!open) handleCacheDialogClose() }}>
        <AlertDialogContent className="max-w-2xl p-0 overflow-hidden gap-0"
          style={{ background: "var(--card-elev)", border: "1px solid var(--border-2)" }}>
          <AlertDialogHeader className="px-5 pt-5 pb-0">
            <AlertDialogTitle className="text-sm font-semibold flex items-center gap-2" style={{ color: "var(--fg)" }}>
              <Trash2 size={14} style={{ color: "var(--bad)" }} />
              Clear Docker Build Cache
            </AlertDialogTitle>
          </AlertDialogHeader>

          <div className="p-5">
            <CacheTerminal
              sequence={false}
              startOnView={false}
              className="max-w-full border-(--border-2) bg-(--bg-2)"
            >
              {cacheLines.map((line, i) => (
                <AnimatedSpan
                  key={i}
                  className={
                    line.startsWith("✔")
                      ? "text-green-400 font-mono text-xs"
                      : line.startsWith("✗")
                      ? "text-red-400 font-mono text-xs"
                      : "font-mono text-xs text-(--fg-3)"
                  }
                >
                  {line}
                </AnimatedSpan>
              ))}
              {cacheState === "running" && (
                <AnimatedSpan className="font-mono text-xs text-(--fg-3)">
                  <span className="animate-pulse">▋</span>
                </AnimatedSpan>
              )}
            </CacheTerminal>
          </div>

          <AlertDialogFooter className="px-5 py-4 border-t bg-transparent rounded-none" style={{ borderColor: "var(--border)" }}>
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

      {/* ── Side panel overlay ── */}
      {panel && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            style={{ background: "rgba(0,0,0,0.35)" }}
            onClick={() => setPanel(null)}
          />
          {/* Drawer */}
          <div
            className="fixed top-0 right-0 bottom-0 z-50 flex flex-col"
            style={{
              width: "clamp(340px, 38vw, 560px)",
              background: "var(--card)",
              borderLeft: "1px solid var(--border)",
              boxShadow: "-8px 0 32px rgba(0,0,0,0.25)",
            }}
          >
            {panel.type === "logs" && (
              <LogsPanel container={panel.container} onClose={() => setPanel(null)} />
            )}
            {panel.type === "terminal" && (
              <TerminalPanel container={panel.container} onClose={() => setPanel(null)} />
            )}
          </div>
        </>
      )}
    </div>
  )
}
