"use client"

import { Check, ChevronDown, ChevronUp, ChevronsUpDown, Copy } from "lucide-react"
import type { DockerImage } from "@/lib/types"
import {
  Docker, GitHubDark, PostgreSQL, MySQL, MariaDB, Redis, MongoDB, ClickHouse, Elastic,
} from "developer-icons"
import { StatusDot } from "@/components/pn/StatusDot"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { Truncate } from "@/components/pn/Truncate"

/* ── Registry / image icon ───────────────────────────────────────────── */
type DeveloperIcon = React.ComponentType<React.SVGProps<SVGSVGElement> & { size?: number }>

const IMAGE_ICON_MAP: Array<[RegExp, DeveloperIcon]> = [
  [/postgres/i, PostgreSQL], [/mysql/i, MySQL], [/mariadb/i, MariaDB], [/redis/i, Redis],
  [/mongo/i, MongoDB], [/clickhouse/i, ClickHouse], [/elastic/i, Elastic], [/ghcr\.io/i, GitHubDark],
]

export function RegistryIcon({ repo }: { repo: string }) {
  for (const [re, Icon] of IMAGE_ICON_MAP) {
    if (re.test(repo)) return <Icon size={20} className={Icon === GitHubDark ? "shrink-0 theme-dark-surface-icon" : "shrink-0"} />
  }
  return <Docker size={20} className="shrink-0" />
}

export function parseMb(s: string): number {
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return 0
  if (s.includes("GB")) return n * 1024
  return n
}

export const fmtMb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`)
export const shortDigest = (id: string) => id.replace("sha256:", "").slice(0, 12)
export const imageKey = (img: DockerImage, i: number) => `${img.id}-${img.repo}-${img.tag}-${i}`

export type SortKey = "repo" | "size" | "layers" | "vulns"
export type Sort = { key: SortKey; dir: 1 | -1 }

const total = (v: DockerImage["vulns"]) => v.crit + v.high + v.med + v.low
export const sortValue: Record<SortKey, (i: DockerImage) => string | number> = {
  repo: i => `${i.repo}:${i.tag}`,
  size: i => parseMb(i.size),
  layers: i => i.layers,
  vulns: i => i.vulns.crit * 1_000_000 + i.vulns.high * 10_000 + i.vulns.med * 100 + i.vulns.low,
}

const SEG: { key: keyof DockerImage["vulns"]; letter: string; name: string; bar: string; text: string }[] = [
  { key: "crit", letter: "C", name: "critical", bar: "bg-[var(--sev-bar-crit)]", text: "text-[var(--sev-crit-fg)]" },
  { key: "high", letter: "H", name: "high", bar: "bg-[var(--sev-bar-high)]", text: "text-[var(--sev-high-fg)]" },
  { key: "med", letter: "M", name: "medium", bar: "bg-[var(--sev-bar-med)]", text: "text-[var(--sev-med-fg)]" },
  { key: "low", letter: "L", name: "low", bar: "bg-[var(--sev-bar-low)]", text: "text-[var(--sev-low-fg)]" },
]

/** Stacked severity bar with C/H/M/L counts underneath; a quiet dash when there are no findings. */
export function VulnCell({ v }: { v: DockerImage["vulns"] }) {
  const t = total(v)
  if (t === 0) return <span className="font-mono text-xs text-muted-foreground" title="No known findings">—</span>
  const label = SEG.map(s => `${v[s.key]} ${s.name}`).join(", ")
  return (
    <div className="flex w-[150px] flex-col gap-1.5" role="img" aria-label={label} title={label}>
      <div className="flex h-1.5 gap-px overflow-hidden rounded-sm bg-muted">
        {SEG.filter(s => v[s.key] > 0).map(s => (
          <span key={s.key} className={s.bar} style={{ width: `${(v[s.key] / t) * 100}%` }} />
        ))}
      </div>
      <div className="flex gap-2 text-[11px] tabular-nums">
        {SEG.filter(s => v[s.key] > 0).map(s => (
          <span key={s.key} className={cn("font-semibold", s.text)}>{v[s.key]}<span className="font-medium text-muted-foreground"> {s.letter}</span></span>
        ))}
      </div>
    </div>
  )
}

export function UsedBy({ used }: { used: number }) {
  return used > 0 ? (
    <span className="inline-flex items-center gap-1.5 text-xs text-foreground/80">
      <span className="text-success"><StatusDot tone="ok" /></span>{used} container{used > 1 ? "s" : ""}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <StatusDot tone="off" />Unused
    </span>
  )
}

function CopyDigest({ id, copied, onCopy, label }: { id: string; copied: boolean; onCopy: (id: string) => void; label: string }) {
  return (
    <button
      type="button" onClick={() => onCopy(id)} aria-label={label} title="Copy digest"
      className="inline-flex items-center gap-1.5 rounded-sm font-mono text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2"
    >
      {shortDigest(id)}
      {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
    </button>
  )
}

function SortHead({ label, k, sort, onSort, className }: { label: string; k: SortKey; sort: Sort; onSort: (k: SortKey) => void; className?: string }) {
  const on = sort.key === k
  const Icon = !on ? ChevronsUpDown : sort.dir > 0 ? ChevronUp : ChevronDown
  return (
    <TableHead aria-sort={on ? (sort.dir > 0 ? "ascending" : "descending") : "none"} className={className}>
      <button
        type="button" onClick={() => onSort(k)}
        className={cn("inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-2", on && "text-foreground")}
      >
        {label}<Icon className={cn("size-3", !on && "opacity-50")} />
      </button>
    </TableHead>
  )
}

type Common = { rows: DockerImage[]; copied: string | null; onCopy: (id: string) => void }

export function ImageTable({ rows, copied, onCopy, sort, onSort }: Common & { sort: Sort; onSort: (k: SortKey) => void }) {
  return (
    <Table className="min-w-[1000px]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <SortHead label="Repository" k="repo" sort={sort} onSort={onSort} />
          <TableHead>Tag</TableHead>
          <TableHead>Digest</TableHead>
          <SortHead label="Size" k="size" sort={sort} onSort={onSort} className="text-right" />
          <SortHead label="Layers" k="layers" sort={sort} onSort={onSort} className="text-right" />
          <SortHead label="Vulnerabilities" k="vulns" sort={sort} onSort={onSort} />
          <TableHead>Used by</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((img, i) => (
          <TableRow key={imageKey(img, i)} className="h-[50px]">
            <TableCell>
              <div className="flex items-center gap-2">
                <RegistryIcon repo={img.repo} />
                <Truncate mono text={img.repo} className="max-w-[260px] text-xs" />
              </div>
            </TableCell>
            <TableCell>
              <Truncate mono text={img.tag} className="w-fit max-w-[10rem] rounded border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground" />
            </TableCell>
            <TableCell>
              <CopyDigest id={img.id} copied={copied === img.id} onCopy={onCopy} label={`Copy digest of ${img.repo}:${img.tag}`} />
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums whitespace-nowrap">{img.size}</TableCell>
            <TableCell className="text-right text-muted-foreground tabular-nums">{img.layers}</TableCell>
            <TableCell><VulnCell v={img.vulns} /></TableCell>
            <TableCell><UsedBy used={img.used} /></TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">{img.created}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function ImageCards({ rows, copied, onCopy }: Common) {
  return (
    <ul className="space-y-3" aria-label="Images">
      {rows.map((img, i) => (
        <li key={imageKey(img, i)} className="space-y-3 rounded-xl border bg-card p-3.5 shadow-card">
          <div className="flex items-center gap-2">
            <RegistryIcon repo={img.repo} />
            <Truncate mono text={img.repo} className="flex-1 text-xs font-medium" />
            <Truncate mono text={img.tag} className="max-w-[40%] rounded border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground" />
          </div>
          <VulnCell v={img.vulns} />
          <dl className="grid grid-cols-3 gap-2 text-xs">
            <div><dt className="text-muted-foreground">Size</dt><dd className="font-medium tabular-nums">{img.size}</dd></div>
            <div><dt className="text-muted-foreground">Layers</dt><dd className="tabular-nums">{img.layers}</dd></div>
            <div><dt className="text-muted-foreground">Created</dt><dd>{img.created}</dd></div>
          </dl>
          <div className="flex items-center justify-between gap-2">
            <UsedBy used={img.used} />
            <CopyDigest id={img.id} copied={copied === img.id} onCopy={onCopy} label={`Copy digest of ${img.repo}:${img.tag}`} />
          </div>
        </li>
      ))}
    </ul>
  )
}
