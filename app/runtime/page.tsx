"use client"

import { useState, useEffect, useRef } from "react"
import { Box, Cpu, MemoryStick, Activity, ArrowUp, ArrowDown, ChevronsUpDown, AlertCircle, Flame } from "lucide-react"
import { nodeApi } from "@/lib/api"
import type { Container } from "@/lib/types"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { LiveBadge } from "@/components/pn/LiveBadge"
import { EmptyState } from "@/components/pn/EmptyState"
import { Segmented } from "@/components/pn/Segmented"
import { SummaryStrip } from "@/components/pn/SummaryStrip"
import { StatusDot } from "@/components/pn/StatusDot"
import { Pill } from "@/components/dashboard/Pill"
import { ProgressBar } from "@/components/dashboard/ProgressBar"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

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

function usageTone(v: number): "ok" | "warn" | "bad" {
  return v >= 80 ? "bad" : v >= 60 ? "warn" : "ok"
}

const TEXT_TONE = { ok: "text-foreground", warn: "text-warning", bad: "text-danger" } as const

function HeartbeatBar({ statuses, windowMs, name, pct, downs }: { statuses: BeatStatus[]; windowMs: number; name: string; pct: number | null; downs: number }) {
  const bucketMs = windowMs / BAR_COUNT
  const now = Date.now()
  const fmt = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  return (
    <div
      className="grid h-[26px] grid-cols-[repeat(50,minmax(0,1fr))] gap-px sm:gap-[3px]"
      role="img"
      aria-label={`${name} uptime ${pct === null ? "unknown" : pct.toFixed(2) + "%"}, ${downs} down intervals`}
    >
      {statuses.map((st, i) => {
        const end = now - (BAR_COUNT - 1 - i) * bucketMs
        const label = st === "down" ? "Down" : st === "up" ? "Up" : "No data"
        return (
          <span
            key={i}
            title={`${label} · ${fmt(end - bucketMs)} – ${fmt(end)}`}
            className={cn(
              "rounded-[2px] transition-transform hover:scale-y-110",
              st === "down" ? "bg-danger" : st === "up" ? "bg-success" : "border bg-muted",
            )}
          />
        )
      })}
    </div>
  )
}

function SortHead({
  label, k, sortKey, sortDir, onSort, className,
}: { label: string; k: SortKey; sortKey: SortKey; sortDir: "asc" | "desc"; onSort: (k: SortKey) => void; className?: string }) {
  const active = sortKey === k
  const Icon = !active ? ChevronsUpDown : sortDir === "asc" ? ArrowUp : ArrowDown
  return (
    <TableHead aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"} className={className}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          "-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
          active && "text-foreground",
        )}
      >
        {label}
        <Icon className={cn("size-3.5", !active && "opacity-50")} />
      </button>
    </TableHead>
  )
}

function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-4">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
    </div>
  )
}

export default function RuntimePage() {
  const [view, setView]             = useState<"resources" | "uptime">("resources")
  const [containers, setContainers] = useState<ContainerStat[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(false)
  const [sortKey, setSortKey]       = useState<SortKey>("cpu")
  const [sortDir, setSortDir]       = useState<"asc" | "desc">("desc")
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [allContainers, setAllContainers] = useState<Container[]>([])
  const [allLoaded, setAllLoaded]   = useState(false)
  const [heartbeats, setHeartbeats] = useState<ContainerHeartbeats[]>([])
  const [range, setRange]           = useState<Range>("24h")

  // One request in flight per poll: a slow backend must not stack requests or
  // let an older response overwrite a newer one.
  const statsBusy = useRef(false)
  function fetchStats() {
    if (statsBusy.current) return
    statsBusy.current = true
    nodeApi.get<ContainerStat[]>("/api/docker/container-stats")
      .then(({ data }) => {
        if (Array.isArray(data)) {
          setContainers(data)
          setLastUpdate(new Date())
          setError(false)
        }
      })
      .catch(() => setError(true))
      .finally(() => { statsBusy.current = false; setLoading(false) })
  }

  useEffect(() => {
    fetchStats()
    const id = setInterval(() => { if (!document.hidden) fetchStats() }, 3000)
    return () => clearInterval(id)
    // fetchStats only uses state setters and a ref, so it is stable for this effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Uptime tab — current container list (for live status/uptime label), polled
  // frequently since it's cheap and drives the status dot.
  useEffect(() => {
    let busy = false
    function fetchAll() {
      if (busy) return
      busy = true
      nodeApi.get<Container[]>("/api/docker/containers")
        .then(({ data }) => { if (Array.isArray(data)) setAllContainers(data) })
        .catch(() => {})
        .finally(() => { busy = false; setAllLoaded(true) })
    }
    fetchAll()
    const id = setInterval(() => { if (!document.hidden) fetchAll() }, 5000)
    return () => clearInterval(id)
  }, [])

  // Uptime tab — real persisted history from the backend (recorded once a
  // minute server-side), refetched when the range changes or on that same
  // cadence since more frequent polling wouldn't reveal new data anyway.
  useEffect(() => {
    let busy = false
    let stale = false // set on cleanup so a response for an old range is dropped
    function fetchHeartbeats() {
      if (busy) return
      busy = true
      nodeApi.get<ContainerHeartbeats[]>(`/api/docker/heartbeats?since=${range}`)
        .then(({ data }) => { if (!stale && Array.isArray(data)) setHeartbeats(data) })
        .catch(() => {})
        .finally(() => { busy = false })
    }
    fetchHeartbeats()
    const id = setInterval(() => { if (!document.hidden) fetchHeartbeats() }, 60000)
    return () => { stale = true; clearInterval(id) }
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
  const upCount     = allContainers.filter(c => c.state === "running").length

  const rangeLabel = { "24h": "Last 24 hours", "3d": "Last 3 days", "7d": "Last 7 days" }[range]
  const rangeStart = { "24h": "24h ago", "3d": "3d ago", "7d": "7d ago" }[range]

  return (
    <>
      <PageHeader
        icon={Box}
        title="Runtime"
        description="Per-container resource usage and availability history."
        actions={
          <Segmented
            aria-label="Runtime view"
            value={view}
            onChange={setView}
            size="default"
            options={[
              { value: "resources", label: <><Cpu className="size-3.5" />Resources</> },
              { value: "uptime", label: <><Activity className="size-3.5" />Uptime</> },
            ]}
          />
        }
      />

      <PageBody className="motion-safe:animate-in fade-in-0 duration-300">
        {view === "resources" && (
          <>
            {error && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>Could not load container stats</AlertTitle>
                <AlertDescription>The last request to the stats endpoint failed. Retrying every 3 seconds.</AlertDescription>
              </Alert>
            )}

            {loading ? (
              <Skeleton className="h-[112px] rounded-xl" />
            ) : containers.length > 0 && (
              <SummaryStrip
                items={[
                  { label: "Running containers", icon: Box, value: containers.length, unit: allContainers.length ? `of ${allContainers.length}` : undefined, meta: allContainers.length ? `${Math.max(0, allContainers.length - upCount)} stopped or exited` : undefined },
                  { label: "Average CPU", icon: Cpu, value: avgCpu.toFixed(1), unit: "%", meta: "across running containers" },
                  { label: "Total RAM", icon: MemoryStick, value: fmtMb(totalRamMb).split(" ")[0], unit: fmtMb(totalRamMb).split(" ")[1], meta: "used by running containers" },
                  { label: "Highest CPU", icon: Flame, value: hottest ? hottest.cpu.toFixed(1) : "—", unit: hottest ? "%" : undefined, meta: <span className="font-mono">{hottest?.name}</span>, tone: hottest && hottest.cpu >= 80 ? "bad" : hottest && hottest.cpu >= 60 ? "warn" : undefined },
                ]}
              />
            )}

            <section aria-labelledby="rt-res" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="rt-res" className="text-lg font-semibold">Resource usage</h2>
                <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5"><span className="h-1 w-3.5 rounded-full bg-success" />&lt; 60% normal</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-1 w-3.5 rounded-full bg-warning" />60–80% warning</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-1 w-3.5 rounded-full bg-danger" />&gt; 80% critical</span>
                  <LiveBadge stale={error}>
                    {error ? "Updates failing" : "Auto · 3s"}
                    {lastUpdate && !error && (
                      <span className="font-normal tabular-nums text-muted-foreground">
                        · {lastUpdate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                    )}
                  </LiveBadge>
                </div>
              </div>

              <Card className="gap-0 overflow-hidden py-0">
                {loading ? (
                  <TableSkeleton />
                ) : containers.length === 0 ? (
                  <EmptyState
                    icon={Box} title="No running containers" className="rounded-none border-0"
                    description="Containers that are running will show their CPU and memory here."
                  />
                ) : (
                  <>
                  <ul className="divide-y sm:hidden">
                    {sorted.map(c => (
                      <li key={c.id} className="space-y-2.5 px-4 py-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{c.name}</p>
                            <p className="truncate font-mono text-[11px] text-muted-foreground" title={c.image}>{c.image}</p>
                          </div>
                          <Pill tone="ok" dot>running</Pill>
                        </div>
                        <div className="space-y-1">
                          <div className="flex justify-between text-xs"><span className="text-muted-foreground">CPU</span>
                            <span className={cn("font-medium tabular-nums", TEXT_TONE[usageTone(c.cpu)])}>{c.cpu.toFixed(1)}%</span></div>
                          <ProgressBar value={c.cpu} tone={usageTone(c.cpu)} />
                        </div>
                        <div className="space-y-1">
                          <div className="flex justify-between text-xs"><span className="text-muted-foreground">Memory</span>
                            <span className="tabular-nums"><span className={cn("font-medium", TEXT_TONE[usageTone(c.ramPct)])}>{fmtMb(c.ramMb)}</span>
                              {c.ramLimitMb > 0 && <span className="text-muted-foreground"> / {fmtMb(c.ramLimitMb)}</span>}</span></div>
                          <ProgressBar value={c.ramPct} tone={usageTone(c.ramPct)} />
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="hidden overflow-x-auto sm:block">
                    <Table className="min-w-[760px]">
                      <TableHeader>
                        <TableRow>
                          <SortHead label="Container" k="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="w-[26%]" />
                          <SortHead label="CPU" k="cpu" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="w-[28%]" />
                          <SortHead label="Memory" k="ramMb" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="w-[34%]" />
                          <TableHead className="text-right">Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sorted.map(c => (
                          <TableRow key={c.id} className="h-[52px]">
                            <TableCell>
                              <p className="text-sm font-medium">{c.name}</p>
                              <p className="font-mono text-[11px] text-muted-foreground" title={c.image}>
                                {c.image.length > 36 ? c.image.slice(0, 36) + "…" : c.image}
                              </p>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2.5">
                                <ProgressBar value={c.cpu} tone={usageTone(c.cpu)} className="flex-1" />
                                <span className={cn("w-14 shrink-0 text-right text-sm font-medium tabular-nums", TEXT_TONE[usageTone(c.cpu)])}>
                                  {c.cpu.toFixed(1)}%
                                </span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2.5">
                                <ProgressBar value={c.ramPct} tone={usageTone(c.ramPct)} className="flex-1" />
                                <span className="shrink-0 text-right text-sm tabular-nums whitespace-nowrap">
                                  <span className={cn("font-medium", TEXT_TONE[usageTone(c.ramPct)])}>{fmtMb(c.ramMb)}</span>
                                  {c.ramLimitMb > 0 && <span className="text-muted-foreground"> / {fmtMb(c.ramLimitMb)}</span>}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              <Pill tone="ok" dot>running</Pill>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  </>
                )}
              </Card>
            </section>
          </>
        )}

        {view === "uptime" && (
          <section aria-labelledby="rt-up" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <h2 id="rt-up" className="text-lg font-semibold">Uptime</h2>
                <p className="text-xs text-muted-foreground">{rangeLabel} · {upCount} / {allContainers.length} up · Recorded every 60s</p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex gap-3.5 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5"><span className="h-3.5 w-1.5 rounded-sm bg-success" />Up</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-3.5 w-1.5 rounded-sm bg-danger" />Down</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-3.5 w-1.5 rounded-sm border bg-muted" />No data</span>
                </div>
                <Segmented
                  aria-label="Time range"
                  value={range}
                  onChange={setRange}
                  options={RANGE_OPTIONS.map(r => ({ value: r, label: r }))}
                />
              </div>
            </div>

            <Card className="gap-0 overflow-hidden py-0">
              {!allLoaded ? (
                <TableSkeleton />
              ) : allContainers.length === 0 ? (
                <EmptyState icon={Activity} title="No containers found" className="rounded-none border-0"
                  description="Uptime history appears once containers exist." />
              ) : (
                <ul className="divide-y">
                  {allContainers.map(c => {
                    const beats = heartbeats.find(h => h.name === c.name)?.beats ?? []
                    const statuses = bucketBeats(beats, RANGE_MS[range])
                    const downs = statuses.filter(b => b === "down").length
                    const ups = beats.filter(b => b.up).length
                    const pct = beats.length ? (ups / beats.length) * 100 : null
                    const isUp = c.state === "running"
                    const tone = !isUp ? "bad" : downs ? "warn" : "ok"
                    return (
                      <li key={c.id} className="space-y-2.5 px-[18px] py-3.5">
                        <div className="flex items-center gap-2.5">
                          <span className={cn("inline-flex", tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : "text-danger")}>
                            <StatusDot tone={tone} />
                          </span>
                          <span className="text-sm font-medium">{c.name}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {!isUp ? "Down" : downs ? `${downs} incident${downs > 1 ? "s" : ""}` : "No incidents"}
                          </span>
                          <span className="flex-1" />
                          <span className={cn("text-[15px] font-semibold tabular-nums", downs || !isUp ? "text-warning" : "text-foreground")}>
                            {pct === null ? "—" : `${pct.toFixed(2)}%`}
                          </span>
                        </div>
                        <HeartbeatBar statuses={statuses} windowMs={RANGE_MS[range]} name={c.name} pct={pct} downs={downs} />
                        <div className="flex justify-between text-[11px] text-muted-foreground"><span>{rangeStart}</span><span>now</span></div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Card>
          </section>
        )}
      </PageBody>
    </>
  )
}
