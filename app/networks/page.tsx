"use client"

import { useState, useEffect } from "react"
import { Boxes, Download, Network, RefreshCw, Upload } from "lucide-react"
import { NETWORKS as MOCK_NETWORKS } from "@/lib/mock-data"
import { nodeApi } from "@/lib/api"
import { getSocket } from "@/lib/socket"
import type { DockerNetwork, SystemMetrics } from "@/lib/types"
import { StatCard } from "@/components/dashboard/StatCard"
import { Pill } from "@/components/dashboard/Pill"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { EmptyState } from "@/components/pn/EmptyState"
import { NetChart } from "@/components/networks/NetChart"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

function driverTone(d: string): "acc" | "warn" | "outline" {
  if (d === "bridge") return "acc"
  if (d === "host")   return "warn"
  return "outline"
}

function pushCapped(arr: number[], val: number, max = 60) {
  return arr.length >= max ? [...arr.slice(-(max - 1)), val] : [...arr, val]
}

export default function NetworksPage() {
  const [networks,  setNetworks]  = useState<DockerNetwork[]>(MOCK_NETWORKS)
  const [rxHist,    setRxHist]    = useState<number[]>([0, 0])
  const [txHist,    setTxHist]    = useState<number[]>([0, 0])
  const [rxRate,    setRxRate]    = useState(0)

  function fetchNetworks() {
    nodeApi.get<DockerNetwork[]>("/api/docker/networks")
      .then(({ data }) => setNetworks(data))
      .catch(() => {})
  }

  useEffect(() => {
    fetchNetworks()

    const socket = getSocket()
    const onMetrics = (m: SystemMetrics) => {
      setRxHist(prev => pushCapped(prev, m.netIn))
      setTxHist(prev => pushCapped(prev, m.netOut))
      setRxRate(Math.round(m.netIn))
    }
    socket.on("system:metrics", onMetrics)
    return () => { socket.off("system:metrics", onMetrics) }
  }, [])

  const totalContainers = networks.reduce((s, n) => s + n.containers, 0)
  const txRate = Math.round(txHist[txHist.length - 1] ?? 0)

  return (
    <>
      <PageHeader
        icon={Network}
        title="Networks"
        description={`${networks.length} networks · ${totalContainers} container attachments`}
        actions={
          <Button variant="outline" size="sm" onClick={fetchNetworks}>
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        }
      />
      <PageBody className="motion-safe:animate-in motion-safe:fade-in-0 duration-300">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Networks" icon={Network} value={networks.length} tone="acc" />
          <StatCard label="Container attachments" icon={Boxes} value={totalContainers} tone="acc" />
          <StatCard label="Ingress" icon={Download} value={rxRate} unit="KB/s" tone="info" spark={rxHist} />
          <StatCard label="Egress" icon={Upload} value={txRate} unit="KB/s" tone="info" spark={txHist} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <NetChart data={rxHist} color="var(--chart-1)" title="Ingress (RX)" current={rxRate} />
          <NetChart data={txHist} color="var(--chart-3)" title="Egress (TX)" current={txRate} />
        </div>

        <Card className="gap-0 py-0">
          {networks.length === 0 ? (
            <EmptyState className="m-4" icon={Network} title="No networks found" description="Docker did not report any networks." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Name</TableHead>
                    <TableHead>Driver</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Subnet</TableHead>
                    <TableHead>Gateway</TableHead>
                    <TableHead className="text-right">Containers</TableHead>
                    <TableHead className="pr-4">Flags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {networks.map(net => (
                    <TableRow key={net.name}>
                      <TableCell className="pl-4 font-medium">{net.name}</TableCell>
                      <TableCell><Pill tone={driverTone(net.driver)}>{net.driver}</Pill></TableCell>
                      <TableCell className="text-muted-foreground">{net.scope}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{net.subnet || "—"}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{net.gateway || "—"}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{net.containers}</TableCell>
                      <TableCell className="pr-4">
                        <div className="flex flex-wrap gap-1">
                          {net.attachable && <Badge variant="outline" className="font-mono">attachable</Badge>}
                          {net.internal && <Badge variant="outline" className="font-mono">internal</Badge>}
                          {!net.attachable && !net.internal && <span className="text-muted-foreground">—</span>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      </PageBody>
    </>
  )
}
