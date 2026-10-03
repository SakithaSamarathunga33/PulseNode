"use client"

import { useState, useRef, useEffect } from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import {
  Shield, Package, ChevronDown, Search, Play,
  Eye, Download, RotateCcw, CheckCircle, XCircle, Loader2, X,
} from "lucide-react"
import { SCANS as MOCK_SCANS } from "@/lib/mock-data"
import { nodeApi, pythonApi } from "@/lib/api"
import { StatCard } from "@/components/dashboard/StatCard"
import { Pill } from "@/components/dashboard/Pill"
import { VulnBar } from "@/components/dashboard/VulnBar"
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet"
import type { Scan } from "@/lib/types"

// ── Helpers ────────────────────────────────────────────────────────────────────

function FilterChip({ label, value }: { label: string; value: string }) {
  return (
    <button className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-pulseNode-navyLight border border-pulseNode-border/15 text-xs text-helm-fg3 hover:text-helm-fg transition-colors">
      <span className="text-helm-fg4">{label}</span>
      <span className="text-helm-fg">{value}</span>
      <ChevronDown size={10} />
    </button>
  )
}

function StatusPill({ status }: { status: Scan["status"] }) {
  switch (status) {
    case "done":
      return (
        <Pill tone="ok">
          <CheckCircle size={10} />
          Done
        </Pill>
      )
    case "failed":
      return (
        <Pill tone="bad">
          <XCircle size={10} />
          Failed
        </Pill>
      )
    case "running":
      return (
        <Pill tone="info">
          <Loader2 size={10} className="animate-spin" />
          Running
        </Pill>
      )
    default:
      return <Pill tone="outline">{status}</Pill>
  }
}

// 30-bar trend data
const TREND_BARS = Array.from({ length: 30 }, (_, i) => {
  const seed = ((i + 1) * 7) % 13
  return { c: seed % 4, h: seed % 5, m: (seed % 6) + 1, l: (seed % 8) + 2 }
})

const X_LABELS = ["30d ago", "20d", "10d", "today"]

const MOCK_CVES = [
  { id: "CVE-2024-1234", sev: "CRITICAL", pkg: "openssl",  fix: "3.0.12" },
  { id: "CVE-2024-5678", sev: "HIGH",     pkg: "libcurl",  fix: "8.5.0"  },
  { id: "CVE-2024-9012", sev: "MEDIUM",   pkg: "zlib",     fix: "1.3.1"  },
]

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ScanHistoryPage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedScan, setSelectedScan] = useState<Scan | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [scans, setScans] = useState<Scan[]>(MOCK_SCANS)
  const [scanModalOpen, setScanModalOpen] = useState(false)
  const [scanTarget, setScanTarget]       = useState("")
  const [scanning, setScanning]           = useState(false)
  const [scanMsg, setScanMsg]             = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    pythonApi.get<Scan[]>("/security/scans")
      .then(({ data }) => { if (data.length > 0) setScans(data) })
      .catch(() => {})
  }, [])

  async function runScan() {
    if (!scanTarget.trim()) return
    setScanning(true)
    setScanMsg(null)
    try {
      await nodeApi.post("/security/scan", { target: scanTarget.trim() })
      setScanMsg({ ok: true, text: `Scan queued for ${scanTarget.trim()}` })
      setTimeout(() => { setScanModalOpen(false); setScanTarget(""); setScanMsg(null) }, 2000)
    } catch (e: unknown) {
      setScanMsg({ ok: false, text: e instanceof Error ? e.message : "scan failed" })
    } finally {
      setScanning(false)
    }
  }

  const succeeded = scans.filter(s => s.status === "done").length
  const failed    = scans.filter(s => s.status === "failed").length

  const totalCrit = scans.reduce((a, s) => a + s.crit, 0)
  const totalHigh = scans.reduce((a, s) => a + s.high, 0)
  const totalMed  = scans.reduce((a, s) => a + s.med, 0)
  const totalLow  = scans.reduce((a, s) => a + s.low, 0)

  useGSAP(() => {
    gsap.fromTo(
      containerRef.current?.querySelectorAll(".gsap-enter") ?? [],
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5, stagger: 0.08, ease: "power2.out" }
    )
  }, { scope: containerRef })

  const filteredScans = scans.filter(s =>
    !search ||
    s.id.toLowerCase().includes(search.toLowerCase()) ||
    s.image.toLowerCase().includes(search.toLowerCase())
  )

  function openSheet(scan: Scan) {
    setSelectedScan(scan)
    setSheetOpen(true)
  }

  return (
    <div ref={containerRef} className="p-6 space-y-6">
      {/* ── Header ── */}
      <div className="gsap-enter flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-helm-fg flex items-center gap-2">
            <Shield size={18} className="text-pulseNode-cyan" />
            Scan History
          </h1>
          <p className="text-sm text-helm-fg3 mt-1">
            <span className="text-helm-fg font-medium">{scans.length} scans</span>
            {" · "}
            <span className="text-pn-cyan font-medium">{succeeded} succeeded</span>
            {" · "}
            <span className="text-red-400 font-medium">{failed} failed</span>
          </p>
        </div>
        <button
          onClick={() => setScanModalOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pulseNode-electric text-white text-xs font-medium hover:bg-pulseNode-electric/90 transition-colors"
        >
          <Play size={11} />
          Scan now
        </button>
      </div>

      {/* ── Stat Cards ── */}
      <div className="gsap-enter grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Critical" value={totalCrit} tone="bad" accent sub="across all scans" />
        <StatCard label="High"     value={totalHigh} tone="warn" sub="across all scans" />
        <StatCard label="Medium"   value={totalMed}  tone="info" sub="across all scans" />
        <StatCard label="Low"      value={totalLow}  tone="ok"   sub="across all scans" />
      </div>

      {/* ── Trend Chart ── */}
      <div className="gsap-enter rounded-xl bg-pulseNode-navyLight border border-pulseNode-border/10 shadow-card p-5">
        <div className="flex items-center justify-between mb-4">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-helm-fg3">
            Vulnerability Trend · 30d
          </span>
          <div className="flex items-center gap-4">
            {[
              { label: "Critical", color: "var(--color-error)" },
              { label: "High",     color: "var(--color-warning-high)" },
              { label: "Medium",   color: "var(--color-warning)" },
              { label: "Low",      color: "var(--pn-blue)" },
            ].map(l => (
              <div key={l.label} className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: l.color }} />
                <span className="text-[10px] text-helm-fg3">{l.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Bars */}
        <div className="flex items-flex-end gap-1 h-[140px]">
          {TREND_BARS.map((bar, i) => {
            const total = bar.c + bar.h + bar.m + bar.l || 1
            const pct = (v: number) => `${(v / total) * 100}%`
            return (
              <div key={i} className="flex-1 flex flex-col-reverse h-full justify-end gap-px">
                {bar.l > 0 && <div className="rounded-sm" style={{ height: pct(bar.l), background: "rgba(109,92,255,0.40)" }} />}
                {bar.m > 0 && <div className="rounded-sm" style={{ height: pct(bar.m), background: "color-mix(in srgb, var(--color-warning) 53%, transparent)" }} />}
                {bar.h > 0 && <div className="rounded-sm" style={{ height: pct(bar.h), background: "#F9731688" }} />}
                {bar.c > 0 && <div className="rounded-sm" style={{ height: pct(bar.c), background: "color-mix(in srgb, var(--color-error) 53%, transparent)" }} />}
              </div>
            )
          })}
        </div>

        {/* X-axis labels */}
        <div className="flex justify-between mt-2">
          {X_LABELS.map((l, i) => (
            <span key={i} className="text-[10px] text-helm-fg3">{l}</span>
          ))}
        </div>
      </div>

      {/* ── Scans Table ── */}
      <div className="gsap-enter rounded-xl bg-pulseNode-navyLight border border-pulseNode-border/10 shadow-card overflow-hidden">
        {/* Filter row */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-pulseNode-border/10">
          <div className="relative flex-1 max-w-xs">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-helm-fg3" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search scans…"
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-pulseNode-navy border border-pulseNode-border/15 text-xs text-helm-fg placeholder:text-helm-fg4 focus:outline-hidden focus:border-pulseNode-cyan/40"
            />
          </div>
          <FilterChip label="Severity" value="≥ Medium" />
          <FilterChip label="Status" value="All" />
          <FilterChip label="Scanner" value="All" />
        </div>

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <table className="pn-table w-full">
            <thead>
              <tr>
                <th>Scan ID</th>
                <th>Image</th>
                <th>Scanner</th>
                <th>Status</th>
                <th>Started</th>
                <th className="right">Duration</th>
                <th>Findings</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredScans.map(scan => (
                <SheetTrigger key={scan.id}>
                  <tr
                    className="cursor-pointer"
                    onClick={() => openSheet(scan)}
                  >
                    <td className="mono-cell dim">{scan.id}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <Package size={13} className="text-helm-fg3 shrink-0" />
                        <span className="font-mono text-xs text-helm-fg truncate max-w-[180px]">
                          {scan.image}
                        </span>
                      </div>
                    </td>
                    <td>
                      <Pill tone="outline">{scan.scanner}</Pill>
                    </td>
                    <td>
                      <StatusPill status={scan.status} />
                    </td>
                    <td className="dim">{scan.started}</td>
                    <td className="right mono-cell">{scan.duration}</td>
                    <td>
                      <VulnBar v={{ crit: scan.crit, high: scan.high, med: scan.med, low: scan.low }} />
                    </td>
                    <td>
                      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                        <button
                          className="border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg px-2 py-1 rounded-lg text-xs transition-colors"
                          onClick={() => openSheet(scan)}
                        >
                          <Eye size={11} />
                        </button>
                        <button className="border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg px-2 py-1 rounded-lg text-xs transition-colors">
                          <Download size={11} />
                        </button>
                        <button className="border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg px-2 py-1 rounded-lg text-xs transition-colors">
                          <RotateCcw size={11} />
                        </button>
                      </div>
                    </td>
                  </tr>
                </SheetTrigger>
              ))}
            </tbody>
          </table>

          <SheetContent className="bg-pulseNode-navyLight border-pulseNode-border/20 overflow-y-auto" style={{ width: 500 }}>
            <SheetHeader>
              <SheetTitle className="text-helm-fg font-mono text-sm">
                Scan Report: {selectedScan?.id ?? "—"}
              </SheetTitle>
              {selectedScan && (
                <p className="text-xs text-helm-fg3 font-mono truncate">{selectedScan.image}</p>
              )}
            </SheetHeader>

            {selectedScan && (
              <div className="px-4 pb-4 space-y-4">
                {/* Summary */}
                <div className="grid grid-cols-4 gap-2 mt-2">
                  {[
                    { label: "CRIT", value: selectedScan.crit, color: "var(--color-error)" },
                    { label: "HIGH", value: selectedScan.high, color: "var(--color-warning-high)" },
                    { label: "MED",  value: selectedScan.med,  color: "var(--color-warning)" },
                    { label: "LOW",  value: selectedScan.low,  color: "var(--pn-blue)" },
                  ].map(s => (
                    <div key={s.label} className="rounded-lg bg-pulseNode-navy p-2 text-center">
                      <p className="text-base font-bold" style={{ color: s.color }}>{s.value}</p>
                      <p className="text-[9px] text-helm-fg3 mt-0.5 tracking-widest">{s.label}</p>
                    </div>
                  ))}
                </div>

                <div className="border-t border-pulseNode-border/10 pt-4">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-helm-fg3 mb-3">CVE Findings</p>
                  <div className="space-y-3">
                    {MOCK_CVES.map(cve => (
                      <div key={cve.id} className="flex items-center gap-3 p-3 rounded-lg bg-pulseNode-navy">
                        <Pill tone={cve.sev === "CRITICAL" ? "bad" : cve.sev === "HIGH" ? "warn" : "info"}>
                          {cve.sev}
                        </Pill>
                        <span className="font-mono text-xs text-helm-fg3">{cve.id}</span>
                        <span className="text-sm flex-1 text-helm-fg">{cve.pkg}</span>
                        <span className="text-xs text-helm-fg3 font-mono">fix: {cve.fix}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-t border-pulseNode-border/10 pt-4 flex gap-2">
                  <button className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-pulseNode-electric text-white text-xs font-medium hover:bg-pulseNode-electric/90 transition-colors">
                    <Download size={12} />
                    Export report
                  </button>
                  <button className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg text-xs transition-colors">
                    <RotateCcw size={12} />
                    Re-scan
                  </button>
                </div>
              </div>
            )}
          </SheetContent>
        </Sheet>
      </div>

      {/* Scan now modal */}
      {scanModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl p-6 space-y-4"
            style={{ background: "var(--card-elev)", border: "1px solid var(--border-2)" }}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold" style={{ color: "var(--fg)" }}>Scan image</h2>
              <button onClick={() => { setScanModalOpen(false); setScanTarget(""); setScanMsg(null) }} style={{ color: "var(--fg-3)" }}>
                <X size={16} />
              </button>
            </div>
            <p className="text-xs" style={{ color: "var(--fg-3)" }}>
              Enter a container image to scan for vulnerabilities. Example: <code className="text-pn-cyan">nginx:latest</code>
            </p>
            <input
              autoFocus
              value={scanTarget}
              onChange={e => setScanTarget(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") runScan() }}
              placeholder="image:tag"
              className="w-full px-3 py-2 rounded-lg text-sm font-mono focus:outline-hidden"
              style={{ background: "var(--bg-2)", border: "1px solid var(--border)", color: "var(--fg)" }}
            />
            {scanMsg && (
              <p className="text-xs" style={{ color: scanMsg.ok ? "var(--ok)" : "var(--bad)" }}>
                {scanMsg.text}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setScanModalOpen(false); setScanTarget(""); setScanMsg(null) }}
                className="px-3 py-1.5 rounded-lg text-xs"
                style={{ background: "var(--bg-3)", color: "var(--fg-2)", border: "1px solid var(--border-2)" }}
              >
                Cancel
              </button>
              <button
                onClick={runScan}
                disabled={scanning || !scanTarget.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50 bg-pulseNode-electric"
              >
                {scanning && <Loader2 size={12} className="animate-spin" />}
                Scan
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
