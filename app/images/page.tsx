"use client"

import { useRef, useState, useEffect, useCallback } from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { IMAGES as MOCK_IMAGES } from "@/lib/mock-data"
import { nodeApi } from "@/lib/api"
import type { DockerImage } from "@/lib/types"
import { StatCard } from "@/components/dashboard/StatCard"
import { Pill } from "@/components/dashboard/Pill"
import { VulnBar } from "@/components/dashboard/VulnBar"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Loader2, X } from "lucide-react"
import {
  Docker, GitHubDark, PostgreSQL, MySQL, MariaDB, Redis,
  MongoDB, ClickHouse, Elastic,
} from "developer-icons"

/* ── FilterChip ─────────────────────────────────────────────────────── */
function FilterChip({ label, value }: { label: string; value: string }) {
  return (
    <button className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-pulseNode-navyLight border border-pulseNode-border/15 text-xs text-helm-fg3 hover:text-helm-fg transition-colors">
      <span className="text-helm-fg4 text-[10px]">{label}</span>
      <span className="text-helm-fg text-xs">{value}</span>
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  )
}

/* ── Registry / image icon ───────────────────────────────────────────── */
type DeveloperIcon = React.ComponentType<React.SVGProps<SVGSVGElement> & { size?: number }>

const IMAGE_ICON_MAP: Array<[RegExp, DeveloperIcon]> = [
  [/postgres/i,   PostgreSQL],
  [/mysql/i,      MySQL],
  [/mariadb/i,    MariaDB],
  [/redis/i,      Redis],
  [/mongo/i,      MongoDB],
  [/clickhouse/i, ClickHouse],
  [/elastic/i,    Elastic],
  [/ghcr\.io/i,   GitHubDark],
]

function RegistryIcon({ repo }: { repo: string }) {
  for (const [re, Icon] of IMAGE_ICON_MAP) {
    if (re.test(repo)) return <Icon size={22} className={Icon === GitHubDark ? "shrink-0 theme-dark-surface-icon" : "shrink-0"} />
  }
  // Default: Docker Hub or unknown
  return <Docker size={22} className="shrink-0" />
}

/* ── Helper: parse MB from size string ──────────────────────────────── */
function parseMb(s: string): number {
  const n = parseFloat(s)
  if (s.includes("GB")) return n * 1024
  return n
}

/* ── Page ────────────────────────────────────────────────────────────── */
export default function ImagesPage() {
  const container = useRef<HTMLDivElement>(null)
  const [search,   setSearch]   = useState("")
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [images,   setImages]   = useState<DockerImage[]>(MOCK_IMAGES)
  const [pruning,  setPruning]  = useState(false)
  const [pruneMsg, setPruneMsg] = useState<string | null>(null)
  const [pullOpen, setPullOpen] = useState(false)
  const [pullImage, setPullImage] = useState("")
  const [pulling,  setPulling]  = useState(false)
  const [pullMsg,  setPullMsg]  = useState<{ ok: boolean; text: string } | null>(null)

  const fetchImages = useCallback(() => {
    nodeApi.get<DockerImage[]>("/api/docker/images")
      .then(({ data }) => setImages(data))
      .catch(() => {})
  }, [])

  useEffect(() => { fetchImages() }, [fetchImages])

  const handlePrune = useCallback(async () => {
    setPruning(true)
    setPruneMsg(null)
    try {
      const res = await nodeApi.post<{ reclaimedMB: string }>("/api/docker/images/prune")
      setPruneMsg(`Pruned unused images · ${res.reclaimedMB} MB reclaimed`)
      fetchImages()
    } catch (e: unknown) {
      setPruneMsg(`Error: ${e instanceof Error ? e.message : "prune failed"}`)
    } finally {
      setPruning(false)
      setTimeout(() => setPruneMsg(null), 5000)
    }
  }, [fetchImages])

  const handlePull = useCallback(async () => {
    if (!pullImage.trim()) return
    setPulling(true)
    setPullMsg(null)
    try {
      await nodeApi.post("/api/docker/pull", { image: pullImage.trim() })
      setPullMsg({ ok: true, text: `Pulled ${pullImage.trim()} successfully` })
      fetchImages()
      setTimeout(() => { setPullOpen(false); setPullImage(""); setPullMsg(null) }, 2000)
    } catch (e: unknown) {
      setPullMsg({ ok: false, text: e instanceof Error ? e.message : "pull failed" })
    } finally {
      setPulling(false)
    }
  }, [pullImage, fetchImages])

  useEffect(() => {
    if (!pullOpen) { setPullImage(""); setPullMsg(null); setPulling(false) }
  }, [pullOpen])

  useGSAP(() => {
    gsap.from(".gsap-enter", {
      y: 20, opacity: 0, duration: 0.5, stagger: 0.08, ease: "power2.out",
    })
  }, { scope: container })

  const totalMb   = images.reduce((s, i) => s + parseMb(i.size), 0)
  const unused    = images.filter(i => i.used === 0).length
  const vulnSum   = images.reduce((s, i) => s + i.vulns.crit + i.vulns.high, 0)
  const avgLayers = images.length > 0 ? Math.round(images.reduce((s, i) => s + i.layers, 0) / images.length) : 0

  const filtered = images.filter(img =>
    img.repo.toLowerCase().includes(search.toLowerCase()) ||
    img.tag.toLowerCase().includes(search.toLowerCase())
  )

  function toggleRow(idx: number) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  function toggleAll() {
    if (selected.size === filtered.length) setSelected(new Set())
    else setSelected(new Set(Array.from({ length: filtered.length }, (_, i) => i)))
  }

  return (
    <div ref={container} className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-helm-fg">Images</h1>
          <p className="text-sm text-helm-fg3 mt-0.5">
            {images.length} images · {Math.round(totalMb)} MB · {unused} unused
          </p>
        </div>
        <div className="flex gap-2 items-center">
          {pruneMsg && (
            <span className="text-xs px-3 py-1.5 rounded-lg" style={{ background: "var(--bg-3)", color: "var(--fg-2)" }}>
              {pruneMsg}
            </span>
          )}
          <button
            onClick={handlePrune}
            disabled={pruning}
            className="flex items-center gap-1.5 border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg px-3 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            {pruning && <Loader2 size={12} className="animate-spin" />}
            Prune unused
          </button>
          <button
            onClick={() => setPullOpen(true)}
            className="bg-pn-cyan text-white px-3 py-1.5 rounded-lg text-sm font-semibold hover:bg-pn-cyan/90 transition-colors"
          >
            Pull image
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="gsap-enter">
          <StatCard label="Total images" value={images.length} tone="acc" />
        </div>
        <div className="gsap-enter">
          <StatCard label="Disk used" value={Math.round(totalMb)} unit="MB" tone="info" />
        </div>
        <div className="gsap-enter">
          <StatCard label="Vulnerabilities" value={vulnSum} tone={vulnSum > 0 ? "bad" : "ok"} sub="crit + high" />
        </div>
        <div className="gsap-enter">
          <StatCard label="Avg layers" value={avgLayers} tone="acc" />
        </div>
      </div>

      {/* Filter row */}
      <div className="gsap-enter flex flex-wrap items-center gap-3">
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-helm-fg3" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search images…"
            className="pl-8 pr-3 py-1.5 rounded-lg bg-pulseNode-navyLight border border-pulseNode-border/15 text-sm text-helm-fg placeholder:text-helm-fg3 focus:outline-hidden focus:border-pn-cyan/40 w-56"
          />
        </div>
        <FilterChip label="Registry" value="All" />
        <FilterChip label="Status"   value="All" />
        <FilterChip label="Sort"     value="Size ↓" />
        <span className="ml-auto text-[11px] text-helm-fg3">last sync · 3 min ago</span>
      </div>

      {/* Table */}
      <div className="gsap-enter rounded-xl border border-pulseNode-border/10 shadow-card overflow-hidden bg-pulseNode-navyLight">
        <div className="overflow-x-auto">
          <table className="pn-table w-full">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    checked={selected.size === filtered.length && filtered.length > 0}
                    onChange={toggleAll}
                    className="accent-pn-cyan"
                  />
                </th>
                <th>Repository</th>
                <th>Tag</th>
                <th>Digest</th>
                <th className="right">Size</th>
                <th className="right">Layers</th>
                <th>Vulnerabilities</th>
                <th>Used by</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((img, i) => (
                <tr key={i}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={() => toggleRow(i)}
                      className="accent-pn-cyan"
                    />
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <RegistryIcon repo={img.repo} />
                      <span className="text-helm-fg text-xs font-medium truncate max-w-[180px]">
                        {img.repo}
                      </span>
                    </div>
                  </td>
                  <td>
                    <code className="text-[11px] bg-pulseNode-navy/60 px-1.5 py-0.5 rounded text-pn-cyan">
                      {img.tag}
                    </code>
                  </td>
                  <td className="mono-cell dim">
                    {img.id.replace("sha256:", "").slice(0, 12)}…
                  </td>
                  <td className="right dim">{img.size}</td>
                  <td className="right dim">{img.layers}</td>
                  <td><VulnBar v={img.vulns} /></td>
                  <td>
                    <Pill tone={img.used > 0 ? "ok" : "outline"} dot={img.used > 0}>
                      {img.used > 0 ? `${img.used} container${img.used > 1 ? "s" : ""}` : "unused"}
                    </Pill>
                  </td>
                  <td className="dim">{img.created}</td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button className="border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg px-2 py-1 rounded-lg text-xs transition-colors">
                        Pull
                      </button>
                      <button className="border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg px-2 py-1 rounded-lg text-xs transition-colors">
                        Scan
                      </button>
                      <button className="border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg px-2 py-1 rounded-lg text-xs transition-colors">
                        SBOM
                      </button>
                      <AlertDialog>
                        <AlertDialogTrigger >
                          <button className="border border-red-500/20 text-red-400/60 hover:text-red-400 px-2 py-1 rounded-lg text-xs transition-colors">
                            Remove
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent className="bg-pulseNode-navyLight border-pulseNode-border/20">
                          <AlertDialogHeader>
                            <AlertDialogTitle className="text-helm-fg">Remove image?</AlertDialogTitle>
                            <AlertDialogDescription className="text-helm-fg3">
                              This will permanently remove <span className="text-helm-fg font-mono text-xs">{img.repo}:{img.tag}</span> from the host. This action cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel className="bg-transparent border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg">
                              Cancel
                            </AlertDialogCancel>
                            <AlertDialogAction className="bg-red-500/80 hover:bg-red-500 text-white">
                              Remove
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pull image modal */}
      {pullOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl p-6 space-y-4"
            style={{ background: "var(--card-elev)", border: "1px solid var(--border-2)" }}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold" style={{ color: "var(--fg)" }}>Pull image</h2>
              <button onClick={() => setPullOpen(false)} style={{ color: "var(--fg-3)" }}>
                <X size={16} />
              </button>
            </div>
            <p className="text-xs" style={{ color: "var(--fg-3)" }}>
              Enter a full image reference. Examples: <code className="text-pn-cyan">nginx:latest</code>, <code className="text-pn-cyan">postgres:16-alpine</code>
            </p>
            <input
              autoFocus
              value={pullImage}
              onChange={e => setPullImage(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handlePull() }}
              placeholder="image:tag"
              className="w-full px-3 py-2 rounded-lg text-sm font-mono focus:outline-hidden"
              style={{ background: "var(--bg-2)", border: "1px solid var(--border)", color: "var(--fg)" }}
            />
            {pullMsg && (
              <p className="text-xs" style={{ color: pullMsg.ok ? "var(--ok)" : "var(--bad)" }}>
                {pullMsg.text}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setPullOpen(false)}
                className="px-3 py-1.5 rounded-lg text-xs"
                style={{ background: "var(--bg-3)", color: "var(--fg-2)", border: "1px solid var(--border-2)" }}
              >
                Cancel
              </button>
              <button
                onClick={handlePull}
                disabled={pulling || !pullImage.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50"
                style={{ background: "var(--pn-cyan)" }}
              >
                {pulling && <Loader2 size={12} className="animate-spin" />}
                Pull
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
