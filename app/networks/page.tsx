"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { Activity, AlertCircle, ArrowDownLeft, ArrowUpRight, Boxes, Network, RefreshCw, ShieldOff } from "lucide-react"
import { nodeApi } from "@/lib/api"
import { getSocket } from "@/lib/socket"
import type { DockerNetwork, SystemMetrics } from "@/lib/types"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { LiveBadge } from "@/components/pn/LiveBadge"
import { EmptyState } from "@/components/pn/EmptyState"
import { SummaryStrip } from "@/components/pn/SummaryStrip"
import { NetChart } from "@/components/networks/NetChart"
import {
  NetworkCards, NetworkTable, isSystem, sortValue, type Sort, type SortKey,
} from "@/components/networks/NetworkTable"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

function pushCapped(arr: number[], val: number, max = 60) {
  return arr.length >= max ? [...arr.slice(-(max - 1)), val] : [...arr, val]
}

export default function NetworksPage() {
  const [networks,  setNetworks]  = useState<DockerNetwork[]>([])
  const [loaded,    setLoaded]    = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [rxHist,    setRxHist]    = useState<number[]>([0, 0])
  const [txHist,    setTxHist]    = useState<number[]>([0, 0])
  const [sort,      setSort]      = useState<Sort>({ key: "containers", dir: -1 })

  const fetchNetworks = useCallback(() => {
    nodeApi.get<DockerNetwork[]>("/api/docker/networks")
      .then(({ data }) => { setNetworks(Array.isArray(data) ? data : []); setLoadError(false) })
      .catch(() => setLoadError(true))
      .finally(() => setLoaded(true))
  }, [])

  useEffect(() => {
    fetchNetworks()
    const socket = getSocket()
    const onMetrics = (m: SystemMetrics) => {
      setRxHist(prev => pushCapped(prev, m.netIn))
      setTxHist(prev => pushCapped(prev, m.netOut))
    }
    socket.on("system:metrics", onMetrics)
    return () => { socket.off("system:metrics", onMetrics) }
  }, [fetchNetworks])

  const onSort = (key: SortKey) =>
    setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "containers" ? -1 : 1 }))

  const rows = useMemo(() => {
    const get = sortValue[sort.key]
    return [...networks].sort((a, b) => { const x = get(a), y = get(b); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir })
  }, [networks, sort])

  const totalContainers = networks.reduce((s, n) => s + n.containers, 0)
  const userDefined = networks.filter(n => !isSystem(n)).length
  const internal = networks.filter(n => n.internal).length
  const attachable = networks.filter(n => n.attachable).length
  const rxRate = Math.round(rxHist[rxHist.length - 1] ?? 0)
  const txRate = Math.round(txHist[txHist.length - 1] ?? 0)

  return (
    <>
      <PageHeader
        icon={Network}
        title="Networks"
        description="Docker networks, host throughput and container attachments."
        actions={
          <>
            <LiveBadge>Live</LiveBadge>
            <Button variant="outline" size="sm" onClick={fetchNetworks}>
              <RefreshCw className="size-3.5" />Refresh
            </Button>
          </>
        }
      />
      <PageBody className="motion-safe:animate-in motion-safe:fade-in-0 duration-300">
        {loadError && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load networks</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-3">
              The Docker API did not respond. The list may be out of date.
              <Button size="sm" variant="outline" onClick={fetchNetworks}><RefreshCw className="size-3.5" />Retry</Button>
            </AlertDescription>
          </Alert>
        )}

        {!loaded ? (
          <Skeleton className="h-[112px] rounded-xl" />
        ) : (
          <SummaryStrip
            items={[
              { label: "Networks", icon: Network, value: networks.length, meta: `${userDefined} user-defined · ${networks.length - userDefined} system` },
              { label: "Attachments", icon: Boxes, value: totalContainers, unit: "containers", meta: `across ${networks.filter(n => n.containers > 0).length} networks` },
              { label: "Throughput", icon: Activity, value: rxRate + txRate, unit: "KB/s", meta: `↓ ${rxRate}  ↑ ${txRate} KB/s` },
              { label: "Isolated", icon: ShieldOff, value: internal, unit: "internal", meta: `${attachable} attachable` },
            ]}
          />
        )}

        <section aria-label="Throughput" className="grid grid-cols-1 gap-4 min-[1000px]:grid-cols-2">
          <NetChart data={rxHist} color="var(--chart-3)" title="Ingress" icon={ArrowDownLeft} current={rxRate} />
          <NetChart data={txHist} color="var(--chart-1)" title="Egress" icon={ArrowUpRight} current={txRate} />
        </section>

        <section aria-labelledby="nw-list" className="space-y-3">
          <h2 id="nw-list" className="text-lg font-semibold">Docker networks</h2>
          {!loaded ? (
            <div className="space-y-3 rounded-xl border bg-card p-4">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={Network} title="No networks found" description="Docker did not report any networks." />
          ) : (
            <>
              <div className="md:hidden"><NetworkCards rows={rows} /></div>
              <Card className="hidden gap-0 overflow-hidden py-0 md:block">
                <div className="overflow-x-auto"><NetworkTable rows={rows} sort={sort} onSort={onSort} /></div>
              </Card>
            </>
          )}
        </section>
      </PageBody>
    </>
  )
}
