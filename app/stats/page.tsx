"use client"

import { useState, useRef, useEffect } from "react"
import { BarChart3, Cpu, HardDrive, MemoryStick, Network, Trash2 } from "lucide-react"
import { HOST as MOCK_HOST, SPARKS as MOCK_SPARKS } from "@/lib/mock-data"
import { nodeApi, pythonApi, API_BASE } from "@/lib/api"
import { getSocket } from "@/lib/socket"
import type { HostInfo, SystemMetrics } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { StatCard } from "@/components/dashboard/StatCard"
import { ProgressBar } from "@/components/dashboard/ProgressBar"
import { UPlotChart } from "@/components/dashboard/UPlotChart"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { LiveBadge } from "@/components/pn/LiveBadge"
import { ChartCard } from "@/components/stats/ChartCard"
import { ClearCacheDialog } from "@/components/stats/ClearCacheDialog"

type PyMetrics = {
  cpu: number; ram: number; disk: number
  diskRead: number; diskWrite: number
  netIn: number; netOut: number; ts: number
}

const C1 = "var(--chart-1)", C2 = "var(--chart-2)", C3 = "var(--chart-3)"
const fill = (c: string) => `color-mix(in srgb, ${c} 16%, transparent)`
const statusTone = (pct: number) => (pct > 85 ? "bad" : pct > 70 ? "warn" : "acc") as "bad" | "warn" | "acc"

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-xs text-muted-foreground">{k}</dt>
      <dd className="min-w-0 truncate text-right font-mono text-xs tabular-nums" title={typeof v === "string" ? v : undefined}>{v}</dd>
    </div>
  )
}

function LegendRow({ color, label, value, pct }: { color: string; label: string; value: string; pct: number }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="flex items-center gap-2 text-muted-foreground">
        <span className="size-2 rounded-full" style={{ background: color }} />{label}
      </span>
      <span className="flex items-center gap-2">
        <span className="font-mono tabular-nums">{value}</span>
        <span className="w-10 text-right font-mono tabular-nums text-muted-foreground">{pct.toFixed(1)}%</span>
      </span>
    </div>
  )
}

const HISTORY_LEN = 180

function pushHistory(arr: number[], val: number): number[] {
  const next = [...arr, val]
  if (next.length > HISTORY_LEN) next.shift()
  return next
}


export default function StatsPage() {
  const [host, setHost]             = useState<HostInfo>(MOCK_HOST)
  const [cpuHist,      setCpuHist]      = useState<number[]>(MOCK_SPARKS.cpuLong)
  const [ramHist,      setRamHist]      = useState<number[]>(MOCK_SPARKS.memLong)
  const [diskHist,     setDiskHist]     = useState<number[]>(MOCK_SPARKS.disk)
  const [diskReadHist, setDiskReadHist] = useState<number[]>([0])
  const [diskWriteHist,setDiskWriteHist]= useState<number[]>([0])
  const [netHist,      setNetHist]      = useState<number[]>(MOCK_SPARKS.net)
  const [netTxHist,    setNetTxHist]    = useState<number[]>(MOCK_SPARKS.netTx)
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

  // Memory breakdown — real values only (no cached/buffers data is collected)
  const memUsed  = host.memory.used
  const memTotal = host.memory.total
  const memFree  = Math.max(0, memTotal - memUsed)
  const usedPct  = memTotal > 0 ? (memUsed / memTotal) * 100 : 0
  const freePct  = memTotal > 0 ? (memFree / memTotal) * 100 : 0
  const lastRead  = diskReadHist[diskReadHist.length - 1] ?? 0
  const lastWrite = diskWriteHist[diskWriteHist.length - 1] ?? 0

  return (
    <>
      <PageHeader
        icon={BarChart3}
        title="System Stats"
        description={`${host.name} · ${host.region} · ${host.ip}`}
        actions={<LiveBadge>Live</LiveBadge>}
      />
      <PageBody className="motion-safe:animate-in motion-safe:fade-in-0 duration-300">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="CPU" icon={Cpu} value={host.cpu.usage} unit="%" spark={cpuHist}
            tone={statusTone(host.cpu.usage)} sub={<span className="truncate">{host.cpu.model}</span>}
          />
          <StatCard
            label="Memory" icon={MemoryStick} value={host.memory.pct} unit="%" spark={ramHist}
            tone={statusTone(host.memory.pct)} sub={<span>{host.memory.used}/{host.memory.total} {host.memory.unit} used</span>}
          />
          <StatCard
            label="Disk" icon={HardDrive} value={host.disk.pct} unit="%" spark={diskHist}
            tone={statusTone(host.disk.pct)} sub={<span>{host.disk.free} {host.disk.unit} free</span>}
          />
          <StatCard
            label="Network RX" icon={Network} value={host.network.rx} unit={host.network.unit} spark={netHist}
            tone="info" sub={<span>TX {host.network.tx} {host.network.unit}</span>}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChartCard title="CPU usage" value={host.cpu.usage} unit="%" live legend={[{ label: "CPU %", color: C1 }]}>
            <UPlotChart series={[{ label: "CPU%", values: cpuHist, color: C1, fill: fill(C1) }]} max={100} />
          </ChartCard>

          <ChartCard title="Memory usage" value={host.memory.pct} unit="%" live legend={[{ label: "Memory %", color: C2 }]}>
            <UPlotChart series={[{ label: "MEM%", values: ramHist, color: C2, fill: fill(C2) }]} max={100} />
          </ChartCard>

          <ChartCard
            title="Disk I/O"
            value={`R ${lastRead.toFixed(1)} · W ${lastWrite.toFixed(1)}`}
            unit="MB/s"
            legend={[{ label: "Read", color: C1 }, { label: "Write", color: C3 }]}
          >
            <UPlotChart
              mode="bar"
              series={[
                { label: "Read", values: diskReadHist, color: C1 },
                { label: "Write", values: diskWriteHist, color: C3 },
              ]}
            />
          </ChartCard>

          <ChartCard
            title="Network"
            value={`↓ ${host.network.rx} · ↑ ${host.network.tx}`}
            unit={host.network.unit}
            legend={[{ label: "RX (in)", color: C1 }, { label: "TX (out)", color: C3 }]}
          >
            <UPlotChart
              series={[
                { label: "RX", values: netHist, color: C1 },
                { label: "TX", values: netTxHist, color: C3 },
              ]}
            />
          </ChartCard>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card size="sm">
            <CardHeader><CardTitle className="text-sm">Host info</CardTitle></CardHeader>
            <CardContent>
              <dl className="divide-y">
                <KV k="Hostname" v={host.name} />
                <KV k="Distro" v={host.distro} />
                <KV k="Kernel" v={host.kernel} />
                <KV k="Uptime" v={host.uptime} />
                <KV k="IP" v={host.ip} />
                <KV k="Region" v={host.region} />
                <KV k="CPU model" v={host.cpu.model} />
                <KV k="Swap" v={`${host.swap.used}/${host.swap.total} GB (${host.swap.pct}%)`} />
              </dl>
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader><CardTitle className="text-sm">Memory breakdown</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-2xl font-bold tabular-nums">
                {host.memory.used} <span className="text-sm font-normal text-muted-foreground">/ {host.memory.total} {host.memory.unit}</span>
              </p>
              <div className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`Memory ${usedPct.toFixed(0)}% used, ${freePct.toFixed(0)}% free`}>
                <div className="rounded-l-full" style={{ width: `${usedPct}%`, background: C1 }} />
              </div>
              <div className="space-y-2">
                <LegendRow color={C1} label="Used" value={`${memUsed} ${host.memory.unit}`} pct={usedPct} />
                <LegendRow color="var(--muted)" label="Free" value={`${memFree.toFixed(1)} ${host.memory.unit}`} pct={freePct} />
              </div>
              <div className="border-t pt-4">
                <p className="mb-2 text-xs font-medium text-muted-foreground">Swap</p>
                <div className="flex items-center gap-3">
                  <ProgressBar value={host.swap.pct} className="flex-1" />
                  <span className="font-mono text-xs tabular-nums">{host.swap.used}/{host.swap.total} GB</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader><CardTitle className="text-sm">Disk</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-2xl font-bold tabular-nums">
                {host.disk.pct}% <span className="text-sm font-normal text-muted-foreground">used</span>
              </p>
              <ProgressBar value={host.disk.pct} className="h-3" />
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Used", val: host.disk.used },
                  { label: "Free", val: host.disk.free },
                  { label: "Total", val: host.disk.total },
                ].map(item => (
                  <div key={item.label} className="rounded-lg bg-muted/60 px-3 py-2">
                    <p className="text-xs text-muted-foreground">{item.label}</p>
                    <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{item.val} <span className="text-xs font-normal text-muted-foreground">{host.disk.unit}</span></p>
                  </div>
                ))}
              </div>
              <dl className="divide-y border-t pt-2">
                <KV k="Read rate" v={`${lastRead.toFixed(1)} MB/s`} />
                <KV k="Write rate" v={`${lastWrite.toFixed(1)} MB/s`} />
              </dl>
              <Button
                variant="destructive" size="sm" className="w-full"
                onClick={handleClearCache}
                disabled={cacheState === "running"}
              >
                <Trash2 className="size-3.5" />
                Clear build cache
              </Button>
            </CardContent>
          </Card>
        </div>

        <ClearCacheDialog open={cacheOpen} lines={cacheLines} state={cacheState} onClose={handleCacheDialogClose} />
      </PageBody>
    </>
  )
}
