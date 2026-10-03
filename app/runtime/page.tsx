"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Box, Cpu, MemoryStick, Activity, ArrowUp, ArrowDown, ChevronsUpDown, AlertCircle, Flame } from "lucide-react"
import { nodeApi } from "@/lib/api"
import type { Container } from "@/lib/types"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { LiveBadge } from "@/components/pn/LiveBadge"
import { EmptyState } from "@/components/pn/EmptyState"
import { Segmented } from "@/components/pn/Segmented"
import { StatCard } from "@/components/dashboard/StatCard"
import { Pill } from "@/components/dashboard/Pill"
import { ProgressBar } from "@/components/dashboard/ProgressBar"
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
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

function HeartbeatBar({ statuses, windowMs }: { statuses: BeatStatus[]; windowMs: number }) {
  const bucketMs = windowMs / BAR_COUNT
  const now = Date.now()
  const fmt = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  return (
    <div className="flex items-center gap-[3px]" role="img" aria-label={`Heartbeat history, oldest to newest: ${statuses.filter(s => s === "up").length} up, ${statuses.filter(s => s === "down").length} down, ${statuses.filter(s => s !== "up" && s !== "down").length} no data`}>
      {statuses.map((s, i) => {
        const end = now - (BAR_COUNT - 1 - i) * bucketMs
        const label = s === "down" ? "Down" : s === "up" ? "Up" : "No data"
        return (
          <div
            key={i}
            title={`${label} · ${fmt(end - bucketMs)} – ${fmt(end)}`}
            className={cn(
              "h-5 w-[5px] shrink-0 rounded-sm",
              s === "down" ? "bg-[repeating-linear-gradient(45deg,var(--danger)_0_2px,color-mix(in_srgb,var(--danger)_35%,transparent)_2px_4px)]" : s === "up" ? "bg-success" : "bg-muted",
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

  function fetchStats() {
    nodeApi.get<ContainerStat[]>("/api/docker/container-stats")
      .then(({ data }) => {
        if (Array.isArray(data)) {
          setContainers(data)
          setLastUpdate(new Date())
          setError(false)
        }
      })
      .catch(() => setError(true))
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
        .finally(() => setAllLoaded(true))
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
  const upCount     = allContainers.filter(c => c.state === "running").length

  return (
    <>
      <PageHeader
        icon={Box}
        title="Runtime Monitor"
        description={view === "resources"
          ? "Live CPU and memory usage for all running Docker containers"
          : "Up/down history for every container, recorded every 60s"}
        actions={
          view === "resources" ? (
            <LiveBadge stale={error}>
              {error ? "Updates failing" : "Live · every 3s"}
              {lastUpdate && !error && (
                <span className="font-normal tabular-nums text-muted-foreground">
                  · {lastUpdate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              )}
            </LiveBadge>
          ) : (
            <LiveBadge>History · every 60s</LiveBadge>
          )
        }
      >
        <Tabs value={view} onValueChange={v => setView(v as "resources" | "uptime")}>
          <TabsList variant="line">
            <TabsTrigger value="resources"><Cpu className="size-3.5" />Resources</TabsTrigger>
            <TabsTrigger value="uptime"><Activity className="size-3.5" />Uptime</TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>

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
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)}
              </div>
            ) : containers.length > 0 && (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard label="Running containers" value={containers.length} icon={Box} />
                <StatCard
                  label="Avg CPU usage" value={avgCpu.toFixed(1)} unit="%" icon={Cpu}
                  sub={`Total ${totalCpu.toFixed(1)}%`} animate={false}
                />
                <StatCard label="Total RAM used" value={fmtMb(totalRamMb)} icon={MemoryStick} />
                <StatCard
                  label="Highest CPU" value={hottest ? hottest.cpu.toFixed(1) : "—"} unit={hottest ? "%" : undefined}
                  icon={Flame} tone={hottest && hottest.cpu > 70 ? "bad" : "warn"}
                  sub={hottest?.name} animate={false}
                />
              </div>
            )}

            <Card className="gap-0 py-0">
              <CardHeader className="border-b py-3">
                <CardTitle>Containers</CardTitle>
                <CardDescription>{containers.length} running</CardDescription>
                <CardAction>
                  <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/containers" />}>Manage</Button>
                </CardAction>
              </CardHeader>

              {loading ? (
                <TableSkeleton />
              ) : containers.length === 0 ? (
                <EmptyState
                  icon={Box} title="No running containers" className="rounded-none border-0"
                  description="Containers that are running will show their CPU and memory here."
                />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <SortHead label="Container" k="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                        <TableHead>Image</TableHead>
                        <SortHead label="CPU" k="cpu" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                        <SortHead label="RAM" k="ramMb" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                        <TableHead>RAM %</TableHead>
                        <TableHead className="text-right">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sorted.map(c => (
                        <TableRow key={c.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Box className="size-4 shrink-0 text-[var(--hue-fg)]" />
                              <div className="min-w-0">
                                <p className="text-sm font-medium">{c.name}</p>
                                <p className="font-mono text-xs text-muted-foreground">{c.id}</p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground" title={c.image}>
                            {c.image.length > 36 ? c.image.slice(0, 36) + "…" : c.image}
                          </TableCell>
                          <TableCell>
                            <div className="flex min-w-[140px] items-center gap-2">
                              <ProgressBar value={c.cpu} tone={usageTone(c.cpu)} className="flex-1" />
                              <span className={cn("w-14 shrink-0 text-right font-mono text-xs tabular-nums", TEXT_TONE[usageTone(c.cpu)])}>
                                {c.cpu.toFixed(1)}%
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex min-w-[160px] items-center gap-2">
                              <ProgressBar value={c.ramPct} tone={usageTone(c.ramPct)} className="flex-1" />
                              <span className="w-[4.5rem] shrink-0 text-right font-mono text-xs tabular-nums">{fmtMb(c.ramMb)}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className={cn("font-mono text-xs tabular-nums", TEXT_TONE[usageTone(c.ramPct)])}>
                              {c.ramPct.toFixed(1)}%
                            </span>
                            {c.ramLimitMb > 0 && (
                              <span className="ml-1.5 text-xs text-muted-foreground">of {fmtMb(c.ramLimitMb)}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Pill tone="ok" dot>running</Pill>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Card>
          </>
        )}

        {view === "uptime" && (
          <Card className="gap-0 py-0">
            <CardHeader className="border-b py-3">
              <CardTitle>Uptime</CardTitle>
              <CardDescription>{upCount} / {allContainers.length} up</CardDescription>
              <CardAction>
                <Segmented
                  aria-label="History range"
                  value={range}
                  onChange={setRange}
                  options={RANGE_OPTIONS.map(r => ({ value: r, label: r }))}
                />
              </CardAction>
            </CardHeader>

            {!allLoaded ? (
              <TableSkeleton />
            ) : allContainers.length === 0 ? (
              <EmptyState icon={Activity} title="No containers found" className="rounded-none border-0"
                description="Uptime history appears once containers exist." />
            ) : (
              <ul className="divide-y">
                {allContainers.map(c => {
                  const beats = heartbeats.find(h => h.name === c.name)?.beats ?? []
                  const ups = beats.filter(b => b.up).length
                  const pct = beats.length ? (ups / beats.length) * 100 : null
                  const isUp = c.state === "running"
                  return (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3.5">
                      <div className="flex min-w-0 items-center gap-3">
                        <Pill tone={isUp ? "ok" : "bad"} dot>{isUp ? "Up" : "Down"}</Pill>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{c.name}</p>
                          <p className="truncate font-mono text-xs text-muted-foreground">{c.uptime}</p>
                        </div>
                      </div>
                      <div className="flex max-w-full shrink-0 items-center gap-4 overflow-x-auto">
                        <HeartbeatBar statuses={bucketBeats(beats, RANGE_MS[range])} windowMs={RANGE_MS[range]} />
                        <span className={cn(
                          "w-14 text-right font-mono text-xs tabular-nums",
                          pct === null ? "text-muted-foreground" : pct >= 99 ? "text-success" : pct >= 90 ? "text-warning" : "text-danger",
                        )}>
                          {pct === null ? "—" : `${pct.toFixed(1)}%`}
                        </span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        )}
      </PageBody>
    </>
  )
}
