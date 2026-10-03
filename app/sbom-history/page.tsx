"use client"

import { useRef, useState, useEffect } from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import {
  FileCode2, ChevronDown, Download,
  ExternalLink, Package,
} from "lucide-react"
import { SBOMS as MOCK_SBOMS } from "@/lib/mock-data"
import { pythonApi } from "@/lib/api"
import type { SBOM } from "@/lib/types"
import { StatCard } from "@/components/dashboard/StatCard"
import { NumberTicker } from "@/components/magicui/number-ticker"
import { cn } from "@/lib/utils"

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

function FormatBadge({ format }: { format: string }) {
  const isCyclone = format.startsWith("CycloneDX")
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold",
        isCyclone
          ? "bg-pn-blue/15 text-pn-blue"
          : "bg-pn-cyan/15 text-pn-cyan"
      )}
    >
      {format}
    </span>
  )
}

const ECOSYSTEM_COLORS: Record<string, string> = {
  go:    "var(--eco-go)",
  npm:   "var(--eco-npm)",
  deb:   "var(--eco-deb)",
  other: "var(--db-other)",
}

const ECOSYSTEM_LABELS: Record<string, string> = {
  go:    "Go",
  npm:   "npm",
  deb:   "Debian",
  other: "Other",
}

function EcosystemBar({ eco }: { eco: { go: number; npm: number; deb: number; other: number } }) {
  const total = eco.go + eco.npm + eco.deb + eco.other || 1
  const segments = (["go", "npm", "deb", "other"] as const).filter(k => eco[k] > 0)

  return (
    <div className="space-y-2">
      {/* Bar */}
      <div className="flex h-2 rounded-full overflow-hidden">
        {segments.map(k => (
          <div
            key={k}
            style={{
              width: `${(eco[k] / total) * 100}%`,
              background: ECOSYSTEM_COLORS[k],
            }}
          />
        ))}
      </div>
      {/* Legend grid */}
      <div className="grid grid-cols-4 gap-1">
        {(["go", "npm", "deb", "other"] as const).map(k => (
          <div key={k} className="flex items-center gap-1">
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ background: ECOSYSTEM_COLORS[k] }}
            />
            <span className="text-[9px] text-helm-fg3 truncate">{ECOSYSTEM_LABELS[k]}</span>
            <span className="text-[9px] font-mono text-helm-fg2 ml-auto tabular-nums">
              {eco[k]}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function SBOMHistoryPage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [sboms, setSboms] = useState<SBOM[]>(MOCK_SBOMS)

  useEffect(() => {
    pythonApi.get<SBOM[]>("/security/sboms")
      .then(({ data }) => { if (data.length > 0) setSboms(data) })
      .catch(() => {})
  }, [])

  const totalPackages = sboms.reduce((a, s) => a + s.packages, 0)

  useGSAP(() => {
    gsap.fromTo(
      containerRef.current?.querySelectorAll(".gsap-enter") ?? [],
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5, stagger: 0.08, ease: "power2.out" }
    )
  }, { scope: containerRef })

  return (
    <div ref={containerRef} className="p-6 space-y-6">
      {/* ── Header ── */}
      <div className="gsap-enter flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-helm-fg flex items-center gap-2">
            <FileCode2 size={18} className="text-pulseNode-cyan" />
            SBOMs
          </h1>
          <p className="text-sm text-helm-fg3 mt-1">
            Software bills of materials
            {" · "}
            <span className="text-helm-fg font-medium">{sboms.length} images</span>
            {" · "}
            <span className="text-helm-fg font-medium">{totalPackages.toLocaleString()} packages tracked</span>
          </p>
        </div>
      </div>

      {/* ── Stat Cards ── */}
      <div className="gsap-enter grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="SBOMs"           value={sboms.length}    tone="acc"  accent sub="generated" />
        <StatCard label="Packages Total"  value={totalPackages}   tone="info" sub="across all images" />
        <StatCard label="Unique Licenses" value={34}              tone="info" sub="license types" />
        <StatCard label="EOL Packages"    value={12}              tone="warn" sub="end-of-life" />
      </div>

      {/* ── Filter Row ── */}
      <div className="gsap-enter flex items-center gap-3 flex-wrap">
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-helm-fg3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            placeholder="Search images…"
            className="pl-8 pr-3 py-1.5 rounded-lg bg-pulseNode-navyLight border border-pulseNode-border/15 text-xs text-helm-fg placeholder:text-helm-fg4 focus:outline-hidden focus:border-pulseNode-cyan/40 w-52"
          />
        </div>
        <FilterChip label="Format" value="All" />
        <FilterChip label="Ecosystem" value="All" />
        {/* Format btn-group */}
        <div className="flex items-center rounded-lg border border-pulseNode-border/15 overflow-hidden ml-auto">
          {["SPDX", "CycloneDX", "JSON"].map((fmt, i) => (
            <button
              key={fmt}
              className={cn(
                "px-3 py-1.5 text-xs transition-colors",
                i === 0
                  ? "bg-pulseNode-cyan/15 text-pulseNode-cyan"
                  : "text-helm-fg3 hover:text-helm-fg"
              )}
            >
              {fmt}
            </button>
          ))}
        </div>
      </div>

      {/* ── SBOM Cards Grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {sboms.map(sbom => (
          <div
            key={sbom.image}
            className="gsap-enter rounded-xl bg-pulseNode-navyLight border border-pulseNode-border/10 shadow-card p-4 space-y-4"
          >
            {/* Card Header */}
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-pulseNode-navy border border-pulseNode-border/10 flex items-center justify-center shrink-0">
                <Package size={14} className="text-pulseNode-cyan" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-xs text-helm-fg truncate">{sbom.image}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] text-helm-fg3">{sbom.generated}</span>
                  <FormatBadge format={sbom.format} />
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button className="border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg px-2 py-1 rounded-lg text-xs transition-colors">
                  <Download size={11} />
                </button>
                <button className="border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg px-2 py-1 rounded-lg text-xs transition-colors">
                  <ExternalLink size={11} />
                </button>
              </div>
            </div>

            {/* Package Count + Licenses */}
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-pn-cyan">
                <NumberTicker value={sbom.packages} />
              </span>
              <span className="text-sm text-helm-fg3">packages</span>
              <span className="ml-auto text-xs text-helm-fg3">
                + {sbom.licenses} licenses
              </span>
            </div>

            {/* Ecosystem Bar */}
            <EcosystemBar eco={sbom.ecosystem} />
          </div>
        ))}
      </div>
    </div>
  )
}
