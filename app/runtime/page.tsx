"use client"

import { useState, useEffect, useRef } from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { Box, RefreshCw, ArrowUpDown, Cpu, MemoryStick, Activity } from "lucide-react"
import { nodeApi } from "@/lib/api"
import type { Container } from "@/lib/types"
import Link from "next/link"

const BAR_COUNT = 50
const RANGE_OPTIONS = ["24h", "3d", "7d"] as const
type Range = (typeof RANGE_OPTIONS)[number]
const RANGE_MS: Record<Range, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "3d":  3 * 24 * 60 * 60 * 1000,
  "7d":  7 * 24 * 60 * 60 * 1000,
}

type ContainerStat = {
  id: string
  name: string
  image: string
  state: string
  cpu: number
  ramPct: number
  ramMb: number
  ramLimitMb: number
}

type HeartbeatPoint = { up: boolean; at: string }
type ContainerHeartbeats = { name: string; beats: HeartbeatPoint[] }
type BeatStatus = "up" | "down" | "none"

// Buckets raw beats into BAR_COUNT slices spanning the selected range, most
// recent on the right. A bucket is "down" if any check in it failed, "none"
// if no data exists yet for that slice (e.g. before tracking started).
function bucketBeats(beats: HeartbeatPoint[], windowMs: number): BeatStatus[] {
  const bucketMs = windowMs / BAR_COUNT
  const buckets: BeatStatus[] = Array(BAR_COUNT).fill("none")
  const now = Date.now()
  for (const b of beats) {
    const age = now - new Date(b.at).getTime()
    if (age < 0 || age > windowMs) continue
    const idx = BAR_COUNT - 1 - Math.floor(age / bucketMs)
    if (idx < 0 || idx >= BAR_COUNT) continue
    if (!b.up) buckets[idx] = "down"
    else if (buckets[idx] === "none") buckets[idx] = "up"
  }
  return buckets
}

type SortKey = "cpu" | "ramMb" | "name"

function fmtMb(mb: number) {
  return mb < 1024 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(2)} GB`
}

function Bar({ value, warn = 60, danger = 80, color }: { value: number; warn?: number; danger?: number; color?: string }) {
  const c = color ?? (value >= danger ? "var(--bad)" : value >= warn ? "var(--warn)" : "var(--pn-cyan)")
  return (
    <div className="flex-1 h-[5px] rounded-full overflow-hidden" style={{ background: "var(--bg-3)" }}>
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(100, value)}%`, background: c }} />
    </div>
  )
}

function HeartbeatBar({ statuses }: { statuses: BeatStatus[] }) {
  return (
    <div className="flex items-center gap-[3px]">
      {statuses.map((s, i) => (
        <div
          key={i}
          className="w-[5px] h-5 rounded-sm shrink-0"
          style={{ background: s === "down" ? "var(--bad)" : s === "up" ? "var(--ok)" : "var(--bg-3)" }}
        />
      ))}
    </div>
  )
}

function StatCard({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl px-5 py-4 flex items-center gap-4" style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: "var(--bg-3)" }}>
        {icon}
      </div>
      <div>
        <p className="text-[11px]" style={{ color: "var(--fg-3)" }}>{label}</p>
        <p className="text-xl font-bold leading-tight" style={{ color: "var(--fg)" }}>{value}</p>
        {sub && <p className="text-[11px]" style={{ color: "var(--fg-3)" }}>{sub}</p>}
      </div>
    </div>
  )
}

export default function RuntimePage() {
  const [view, setView]             = useState<"resources" | "uptime">("resources")
  const [containers, setContainers] = useState<ContainerStat[]>([])
  const [loading, setLoading]       = useState(true)
  const [sortKey, setSortKey]       = useState<SortKey>("cpu")
  const [sortDir, setSortDir]       = useState<"asc" | "desc">("desc")
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [allContainers, setAllContainers] = useState<Container[]>([])
  const [heartbeats, setHeartbeats] = useState<ContainerHeartbeats[]>([])
  const [range, setRange]           = useState<Range>("24h")
  const containerRef = useRef<HTMLDivElement>(null)

  useGSAP(() => {
    gsap.fromTo(".gsap-enter", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.07, ease: "power2.out" })
  }, { scope: containerRef, dependencies: [loading, view] })

  function fetchStats() {
    nodeApi.get<ContainerStat[]>("/api/docker/container-stats")
      .then(({ data }) => {
        if (Array.isArray(data)) {
          setContainers(data)
          setLastUpdate(new Date())
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchStats()
    const id = setInterval(() => { if (!document.hidden) fetchStats() }, 3000)
    return () => clearInterval(id)
  }, [])

  // Uptime tab — current container list (for live status/uptime label), polled
  // frequently since it's cheap and drives the status dot.
  useEffect(() => {
    function fetchAll() {
      nodeApi.get<Container[]>("/api/docker/containers")
        .then(({ data }) => { if (Array.isArray(data)) setAllContainers(data) })
        .catch(() => {})
    }
    fetchAll()
    const id = setInterval(() => { if (!document.hidden) fetchAll() }, 5000)
    return () => clearInterval(id)
  }, [])

  // Uptime tab — real persisted history from the backend (recorded once a
  // minute server-side), refetched when the range changes or on that same
  // cadence since more frequent polling wouldn't reveal new data anyway.
  useEffect(() => {
    function fetchHeartbeats() {
      nodeApi.get<ContainerHeartbeats[]>(`/api/docker/heartbeats?since=${range}`)
        .then(({ data }) => { if (Array.isArray(data)) setHeartbeats(data) })
        .catch(() => {})
    }
    fetchHeartbeats()
    const id = setInterval(() => { if (!document.hidden) fetchHeartbeats() }, 60000)
    return () => clearInterval(id)
  }, [range])

  const sorted = [...containers].sort((a, b) => {
    const av = a[sortKey as keyof ContainerStat] as number | string
    const bv = b[sortKey as keyof ContainerStat] as number | string
    if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv as string) : (bv as string).localeCompare(av)
    return sortDir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number)
  })

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "desc" ? "asc" : "desc")
    else { setSortKey(key); setSortDir("desc") }
  }

  const totalCpu    = containers.reduce((s, c) => s + c.cpu, 0)
  const totalRamMb  = containers.reduce((s, c) => s + c.ramMb, 0)
  const avgCpu      = containers.length ? totalCpu / containers.length : 0
  const hottest     = containers.length ? [...containers].sort((a, b) => b.cpu - a.cpu)[0] : null

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw size={20} className="animate-spin" style={{ color: "var(--fg-3)" }} />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="p-6 space-y-6">

      {/* Header */}
      <div className="gsap-enter flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2" style={{ color: "var(--fg)" }}>
            <Box size={18} style={{ color: "var(--acc)" }} />
            Runtime Monitor
          </h1>
          <p className="text-sm mt-0.5" style={{ color: "var(--fg-3)" }}>
            {view === "resources"
              ? "Live CPU and memory usage for all running Docker containers"
              : "Uptime Kuma–style up/down history for every container"}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--fg-3)" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 status-live" />
          {view === "resources" ? "Live · refreshes every 3s" : "History recorded every 60s"}
          {lastUpdate && view === "resources" && (
            <span className="ml-1">· {lastUpdate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
          )}
        </div>
      </div>

      {/* View tabs */}
      <div className="gsap-enter flex items-center gap-0" style={{ borderBottom: "1px solid var(--border)" }}>
        {([
          { key: "resources", label: "Resources", icon: <Cpu size={13} /> },
          { key: "uptime",     label: "Uptime",    icon: <Activity size={13} /> },
        ] as const).map(t => (
          <button
            key={t.key}
            onClick={() => setView(t.key)}
            className="px-4 py-2 text-xs font-medium transition-colors flex items-center gap-1.5"
            style={{
              color: view === t.key ? "var(--fg)" : "var(--fg-3)",
              borderBottom: view === t.key ? "2px solid var(--acc)" : "2px solid transparent",
              marginBottom: "-1px",
            }}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      {view === "resources" && containers.length > 0 && (
        <div className="gsap-enter grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="Running containers"
            value={String(containers.length)}
            icon={<Box size={16} style={{ color: "var(--acc)" }} />}
          />
          <StatCard
            label="Avg CPU usage"
            value={`${avgCpu.toFixed(1)}%`}
            sub={`Total: ${totalCpu.toFixed(1)}%`}
            icon={<Cpu size={16} style={{ color: "var(--pn-cyan)" }} />}
          />
          <StatCard
            label="Total RAM used"
            value={fmtMb(totalRamMb)}
            icon={<MemoryStick size={16} style={{ color: "var(--pn-blue)" }} />}
          />
          <StatCard
            label="Highest CPU"
            value={hottest ? `${hottest.cpu.toFixed(1)}%` : "—"}
            sub={hottest?.name}
            icon={<Cpu size={16} style={{ color: hottest && hottest.cpu > 70 ? "var(--bad)" : "var(--warn)" }} />}
          />
        </div>
      )}

      {/* Container table */}
      {view === "resources" && (
      <div className="gsap-enter rounded-xl overflow-hidden" style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
        <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="text-sm font-semibold" style={{ color: "var(--fg)" }}>
            Containers
            <span className="ml-2 text-[11px] font-normal" style={{ color: "var(--fg-3)" }}>
              {containers.length} running
            </span>
          </span>
          <Link href="/containers" className="text-xs transition-opacity hover:opacity-70" style={{ color: "var(--acc)" }}>
            Manage →
          </Link>
        </div>

        {containers.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <Box size={32} style={{ color: "var(--fg-4)" }} />
            <p className="text-sm" style={{ color: "var(--fg-3)" }}>No running containers</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="pn-table w-full">
              <thead>
                <tr>
                  <th>
                    <button className="flex items-center gap-1 hover:opacity-70 transition-opacity" onClick={() => toggleSort("name")}>
                      Container {sortKey === "name" && <ArrowUpDown size={10} />}
                    </button>
                  </th>
                  <th>Image</th>
                  <th>
                    <button className="flex items-center gap-1 hover:opacity-70 transition-opacity" onClick={() => toggleSort("cpu")}>
                      CPU% {sortKey === "cpu" && <ArrowUpDown size={10} />}
                    </button>
                  </th>
                  <th>
                    <button className="flex items-center gap-1 hover:opacity-70 transition-opacity" onClick={() => toggleSort("ramMb")}>
                      RAM {sortKey === "ramMb" && <ArrowUpDown size={10} />}
                    </button>
                  </th>
                  <th>RAM %</th>
                  <th className="right">Status</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(c => (
                  <tr key={c.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <Box size={13} style={{ color: "var(--acc)", flexShrink: 0 }} />
                        <div>
                          <p className="text-[12px] font-semibold" style={{ color: "var(--fg)" }}>{c.name}</p>
                          <p className="text-[10px] font-mono" style={{ color: "var(--fg-4)" }}>{c.id}</p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="text-[11px] font-mono" style={{ color: "var(--fg-3)" }}>
                        {c.image.length > 36 ? c.image.slice(0, 36) + "…" : c.image}
                      </span>
                    </td>
                    <td>
                      <div className="flex items-center gap-2 min-w-[120px]">
                        <Bar value={c.cpu} />
                        <span className="text-[12px] font-mono w-12 text-right shrink-0"
                          style={{ color: c.cpu >= 80 ? "var(--bad)" : c.cpu >= 60 ? "var(--warn)" : "var(--fg)" }}>
                          {c.cpu.toFixed(1)}%
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-2 min-w-[140px]">
                        <Bar value={c.ramPct} color={c.ramPct >= 80 ? "var(--bad)" : c.ramPct >= 60 ? "var(--warn)" : "var(--pn-blue)"} />
                        <span className="text-[12px] font-mono w-16 text-right shrink-0" style={{ color: "var(--fg)" }}>
                          {fmtMb(c.ramMb)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px] font-mono" style={{ color: c.ramPct >= 80 ? "var(--bad)" : c.ramPct >= 60 ? "var(--warn)" : "var(--fg)" }}>
                          {c.ramPct.toFixed(1)}%
                        </span>
                        {c.ramLimitMb > 0 && (
                          <span className="text-[10px]" style={{ color: "var(--fg-4)" }}>
                            of {fmtMb(c.ramLimitMb)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="right">
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium"
                        style={{ background: "color-mix(in srgb, var(--ok) 15%, transparent)", color: "var(--ok)" }}>
                        <span className="w-1 h-1 rounded-full status-live" style={{ background: "var(--ok)" }} />
                        running
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}

      {/* Uptime tab — Uptime Kuma–style heartbeat history */}
      {view === "uptime" && (
        <div className="gsap-enter rounded-xl overflow-hidden" style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
          <div className="flex items-center justify-between px-5 py-3 flex-wrap gap-2" style={{ borderBottom: "1px solid var(--border)" }}>
            <span className="text-sm font-semibold" style={{ color: "var(--fg)" }}>
              Uptime
              <span className="ml-2 text-[11px] font-normal" style={{ color: "var(--fg-3)" }}>
                {allContainers.filter(c => c.state === "running").length} / {allContainers.length} up
              </span>
            </span>
            <div className="flex items-center rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)" }}>
              {RANGE_OPTIONS.map(r => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className="px-2.5 py-1 text-[11px] font-medium transition-colors"
                  style={{
                    background: range === r ? "var(--acc)" : "transparent",
                    color: range === r ? "#fff" : "var(--fg-3)",
                  }}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {allContainers.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16">
              <Activity size={32} style={{ color: "var(--fg-4)" }} />
              <p className="text-sm" style={{ color: "var(--fg-3)" }}>No containers found</p>
            </div>
          ) : (
            allContainers.map(c => {
              const beats  = heartbeats.find(h => h.name === c.name)?.beats ?? []
              const upCount = beats.filter(b => b.up).length
              const pct    = beats.length ? (upCount / beats.length) * 100 : null
              const isUp   = c.state === "running"
              return (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-4 px-5 py-3.5 flex-wrap"
                  style={{ borderBottom: "1px solid var(--border)" }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`w-2.5 h-2.5 rounded-full flex-shrink-0${isUp ? " status-live" : ""}`}
                      style={{ background: isUp ? "var(--ok)" : "var(--bad)" }}
                    />
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold truncate" style={{ color: "var(--fg)" }}>{c.name}</p>
                      <p className="text-[11px] font-mono truncate" style={{ color: "var(--fg-3)" }}>{c.uptime}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <HeartbeatBar statuses={bucketBeats(beats, RANGE_MS[range])} />
                    <span
                      className="text-[12px] font-mono w-14 text-right"
                      style={{ color: pct === null ? "var(--fg-3)" : pct >= 99 ? "var(--ok)" : pct >= 90 ? "var(--warn)" : "var(--bad)" }}
                    >
                      {pct === null ? "—" : `${pct.toFixed(1)}%`}
                    </span>
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
