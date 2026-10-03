"use client"

import { useRef, useState, useEffect } from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { NETWORKS as MOCK_NETWORKS } from "@/lib/mock-data"
import { nodeApi } from "@/lib/api"
import { getSocket } from "@/lib/socket"
import type { DockerNetwork, SystemMetrics } from "@/lib/types"
import { StatCard } from "@/components/dashboard/StatCard"
import { UPlotChart } from "@/components/dashboard/UPlotChart"
import { Pill } from "@/components/dashboard/Pill"

/* ── Mini Network Chart ─────────────────────────────────────────────── */
function NetChart({ data, color, title }: { data: number[]; color: string; title: string }) {
  return (
    <div className="bg-pulseNode-navyLight rounded-xl border border-pulseNode-border/10 shadow-card p-4">
      <div className="text-[10px] uppercase tracking-wider text-helm-fg3 mb-3 font-semibold">{title}</div>
      <UPlotChart
        height={120}
        series={[{ label: title, values: data, color, fill: "rgba(47, 211, 242, 0.10)" }]}
      />
    </div>
  )
}

/* ── Driver tone ────────────────────────────────────────────────────── */
function driverTone(d: string): "acc" | "warn" | "outline" {
  if (d === "bridge") return "acc"
  if (d === "host")   return "warn"
  return "outline"
}

/* ── Topology SVG ───────────────────────────────────────────────────── */
function TopologySVG() {
  const cx = 200, cy = 160, r = 110
  const nodes = Array.from({ length: 8 }, (_, i) => {
    const angle = (i / 8) * 2 * Math.PI - Math.PI / 2
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), label: `c${i + 1}` }
  })

  return (
    <svg width="100%" viewBox="0 0 400 320" className="block max-h-[220px]">
      {/* lines hub→node */}
      {nodes.map((n, i) => (
        <line
          key={i}
          x1={cx} y1={cy} x2={n.x} y2={n.y}
          stroke="rgba(220,232,245,0.2)"
          strokeWidth="1"
          strokeDasharray="2 3"
        />
      ))}
      {/* center hub */}
      <circle cx={cx} cy={cy} r={32} fill="rgba(24,220,226,0.08)" stroke="var(--pn-cyan)" strokeWidth="1.5" />
      <text x={cx} y={cy + 4} textAnchor="middle" fontSize="11" fill="var(--pn-cyan)" fontWeight="600">coolify</text>
      {/* container nodes */}
      {nodes.map((n, i) => (
        <g key={i}>
          <circle cx={n.x} cy={n.y} r={20} fill="var(--pn-navy-light)" stroke="rgba(220,232,245,0.2)" strokeWidth="1" />
          <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize="10" fill="rgba(248,250,252,0.7)">{n.label}</text>
        </g>
      ))}
    </svg>
  )
}

/* ── Coolify network pill tags ──────────────────────────────────────── */
const COOLIFY_CONTAINERS = [
  "z13q1pr5wxh003jb", "xbtcom504737r6a8", "coolify-proxy",
  "coolify-sentinel", "coolify-realtime", "coolify-db", "coolify-redis", "minio-store",
]

/* ── Page ────────────────────────────────────────────────────────────── */
function pushCapped(arr: number[], val: number, max = 60) {
  return arr.length >= max ? [...arr.slice(-(max - 1)), val] : [...arr, val]
}

export default function NetworksPage() {
  const container = useRef<HTMLDivElement>(null)
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

  useGSAP(() => {
    gsap.from(".gsap-enter", {
      y: 20, opacity: 0, duration: 0.5, stagger: 0.08, ease: "power2.out",
    })
  }, { scope: container })

  const totalContainers = networks.reduce((s, n) => s + n.containers, 0)

  return (
    <div ref={container} className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-helm-fg">Networks</h1>
          <p className="text-sm text-helm-fg3 mt-0.5">
            {networks.length} networks · {totalContainers} container attachments
          </p>
        </div>
        <button onClick={fetchNetworks} className="border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg px-3 py-1.5 rounded-lg text-sm transition-colors">
          Refresh
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="gsap-enter">
          <StatCard label="Networks"    value={networks.length} tone="acc" />
        </div>
        <div className="gsap-enter">
          <StatCard label="Throughput" value={rxRate} unit="KB/s" tone="info" spark={rxHist} />
        </div>
        <div className="gsap-enter">
          <StatCard label="Active conns" value={totalContainers} tone="acc" />
        </div>
        <div className="gsap-enter">
          <StatCard label="Dropped"     value={0} tone="ok" />
        </div>
      </div>

      {/* Ingress / Egress charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="gsap-enter">
          <NetChart data={rxHist} color="var(--pn-cyan)" title="Ingress (RX KB/s)" />
        </div>
        <div className="gsap-enter">
          <NetChart data={txHist} color="var(--pn-blue)" title="Egress (TX KB/s)"  />
        </div>
      </div>

      {/* Networks table */}
      <div className="gsap-enter rounded-xl border border-pulseNode-border/10 shadow-card overflow-hidden bg-pulseNode-navyLight">
        <div className="overflow-x-auto">
          <table className="pn-table w-full">
            <thead>
              <tr>
                <th>Name</th>
                <th>Driver</th>
                <th>Scope</th>
                <th>Subnet</th>
                <th>Gateway</th>
                <th className="right">Containers</th>
                <th>Flags</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {networks.map(net => (
                <tr key={net.name}>
                  <td>
                    <div className="flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{
                          background: net.driver === "bridge"
                            ? "var(--pn-cyan)"
                            : net.driver === "host"
                            ? "var(--color-warning)"
                            : "var(--pn-muted)",
                        }}
                      />
                      <span className="font-medium text-helm-fg">{net.name}</span>
                    </div>
                  </td>
                  <td>
                    <Pill tone={driverTone(net.driver)}>{net.driver}</Pill>
                  </td>
                  <td className="dim">{net.scope}</td>
                  <td className="mono-cell dim">{net.subnet}</td>
                  <td className="mono-cell dim">{net.gateway}</td>
                  <td className="right dim">{net.containers}</td>
                  <td>
                    <div className="flex gap-1 flex-wrap">
                      {net.attachable && (
                        <code className="text-[10px] bg-pulseNode-navy/60 px-1.5 py-0.5 rounded text-helm-fg3">
                          attachable
                        </code>
                      )}
                      {net.internal && (
                        <code className="text-[10px] bg-pulseNode-navy/60 px-1.5 py-0.5 rounded text-helm-fg3">
                          internal
                        </code>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button className="border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg px-2 py-1 rounded-lg text-xs transition-colors">
                        Inspect
                      </button>
                      <button className="border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg px-2 py-1 rounded-lg text-xs transition-colors">
                        Connect
                      </button>
                      <button className="border border-red-500/20 text-red-400/60 hover:text-red-400 px-2 py-1 rounded-lg text-xs transition-colors">
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Topology card */}
      <div className="gsap-enter bg-pulseNode-navyLight rounded-xl border border-pulseNode-border/10 shadow-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-semibold text-helm-fg">Network Topology</div>
            <div className="text-[11px] text-helm-fg3 mt-0.5">coolify bridge network · {COOLIFY_CONTAINERS.length} containers</div>
          </div>
          <Pill tone="acc" dot>coolify</Pill>
        </div>
        <TopologySVG />
        <div className="mt-4 flex flex-wrap gap-2">
          {COOLIFY_CONTAINERS.map(c => (
            <span key={c} className="px-2 py-0.5 rounded-full bg-pn-cyan/10 text-pn-cyan text-[10px] font-mono">
              {c}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
