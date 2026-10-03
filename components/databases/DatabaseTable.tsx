"use client"

import { useTimeouts } from "@/lib/use-timeouts"
import { Fragment, useState } from "react"
import { toast } from "sonner"
import {
  AlertTriangle, BarChart3, Check, ChevronDown, ChevronRight, ChevronsUpDown, ChevronUp,
  Copy, Download, TerminalSquare, Trash2, Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Pill } from "@/components/dashboard/Pill"
import { DbIcon } from "@/components/dashboard/DbIcon"
import { toneFor, TONE_BG } from "@/components/containers/utils"
import { cn, copyText } from "@/lib/utils"
import type { Database } from "@/lib/types"
import { DatabaseWorkspace, type WorkspaceTab } from "./DatabaseWorkspace"
import { engineColor, statusLabel, statusTone } from "./shared"

export type SortKey = "name" | "engine" | "state" | "conns" | "qps" | "slow"
export type Sort = { key: SortKey; dir: 1 | -1 }

export type DbHandlers = {
  onDelete: (db: Database) => void
  onBackup: (db: Database) => void
  onRestore: (db: Database) => void
}

const STICKY = "sticky right-0 z-10 bg-card shadow-[-8px_0_12px_-10px_rgb(0_0_0/0.35)]"

function ConnSpark({ data, color }: { data: number[]; color: string }) {
  const values = data.length > 1 ? data : [0, 0]
  const w = 80
  const h = 24
  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min || 1
  const step = w / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - ((v - min) / range) * (h - 4)).toFixed(1)}`)
  const d = `M ${pts.join(" L ")}`
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block" style={{ color }} role="img" aria-label="Connection activity">
      <path d={`${d} L ${w},${h} L 0,${h} Z`} fill="currentColor" fillOpacity={0.14} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconAction({ label, onClick, danger, children }: {
  label: string; onClick: () => void; danger?: boolean; children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost" size="icon-sm" onClick={onClick} aria-label={label}
            className={cn(danger && "text-danger hover:bg-danger/12 hover:text-danger")}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ConnCell({ db }: { db: Database }) {
  const pct = db.maxConns > 0 ? Math.round((db.conns / db.maxConns) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs whitespace-nowrap tabular-nums">
        {db.conns > 0 ? db.conns : "—"}<span className="text-muted-foreground"> / {db.maxConns}</span>
      </span>
      <span className="inline-block h-1 w-10 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className={cn("block h-full rounded-full", TONE_BG[toneFor(pct)])} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
    </div>
  )
}

function SlowCell({ n }: { n: number }) {
  return n > 0 ? (
    <span className="inline-flex items-center gap-1 font-mono text-xs tabular-nums text-warning">
      <AlertTriangle className="size-3.5" aria-hidden />{n}
    </span>
  ) : (
    <span className="font-mono text-xs tabular-nums text-muted-foreground">0</span>
  )
}

function EndpointButton({ db }: { db: Database }) {
  const [copied, setCopied] = useState(false)
  const ep = `${db.host}:${db.port}`
  const later = useTimeouts()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Copy endpoint ${ep}`}
            onClick={async () => {
              if (await copyText(ep)) { setCopied(true); toast.success("Endpoint copied"); later(() => setCopied(false), 1600) }
              else toast.error("Copy failed")
            }}
            className="inline-flex max-w-[210px] items-center gap-1.5 rounded-sm font-mono text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2"
          />
        }
      >
        <span className="truncate">{ep}</span>
        {copied ? <Check className="size-3 shrink-0 text-success" /> : <Copy className="size-3 shrink-0" />}
      </TooltipTrigger>
      <TooltipContent>Copy endpoint</TooltipContent>
    </Tooltip>
  )
}

function RowActions({ db, onOpen, h }: { db: Database; onOpen: (t: WorkspaceTab) => void; h: DbHandlers }) {
  return (
    <div className="flex justify-end gap-0.5">
      <IconAction label={`Query ${db.name}`} onClick={() => onOpen("query")}><TerminalSquare className="size-4" /></IconAction>
      <IconAction label={`Metrics for ${db.name}`} onClick={() => onOpen("metrics")}><BarChart3 className="size-4" /></IconAction>
      <IconAction label={`Backup ${db.name}`} onClick={() => h.onBackup(db)}><Download className="size-4" /></IconAction>
      <IconAction label={`Restore ${db.name}`} onClick={() => h.onRestore(db)}><Upload className="size-4" /></IconAction>
      <IconAction label={`Delete ${db.name}`} danger onClick={() => h.onDelete(db)}><Trash2 className="size-4" /></IconAction>
    </div>
  )
}

function EngineBadge({ db, size = 28 }: { db: Database; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-lg border bg-background"
      style={{ width: size, height: size, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${engineColor(db.engine)} 25%, transparent)` }}
    >
      <DbIcon engine={db.engine} size={Math.round(size * 0.6)} />
    </span>
  )
}

function SortHead({ label, k, sort, onSort, className }: {
  label: string; k: SortKey; sort: Sort; onSort: (k: SortKey) => void; className?: string
}) {
  const on = sort.key === k
  const Icon = on ? (sort.dir > 0 ? ChevronUp : ChevronDown) : ChevronsUpDown
  return (
    <TableHead aria-sort={on ? (sort.dir > 0 ? "ascending" : "descending") : "none"} className={className}>
      <button
        type="button" onClick={() => onSort(k)}
        className={cn("inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-2", on && "text-foreground")}
      >
        {label}<Icon className="size-3" />
      </button>
    </TableHead>
  )
}

function ExpandButton({ db, expanded, onExpand }: { db: Database; expanded: boolean; onExpand: () => void }) {
  return (
    <Button
      variant="ghost" size="icon-sm" onClick={onExpand} aria-expanded={expanded}
      aria-label={expanded ? `Collapse ${db.name}` : `Expand ${db.name}`}
    >
      {expanded ? <ChevronDown /> : <ChevronRight />}
    </Button>
  )
}

type Common = {
  connHist: Record<string, number[]>
  expandedDb: string | null
  onExpand: (name: string) => void
  handlers: DbHandlers
}

function useTabs() {
  const [tabs, setTabs] = useState<Record<string, WorkspaceTab>>({})
  return { tabOf: (n: string) => tabs[n] ?? "overview", setTab: (n: string, t: WorkspaceTab) => setTabs(p => ({ ...p, [n]: t })) }
}

/** Desktop table: sortable columns, expandable workspace row, sticky actions. */
export function DatabaseTable({
  databases, sort, onSort, connHist, expandedDb, onExpand, handlers,
}: Common & { databases: Database[]; sort: Sort; onSort: (k: SortKey) => void }) {
  const { tabOf, setTab } = useTabs()
  return (
    <Table className="min-w-[1240px]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-10"><span className="sr-only">Expand</span></TableHead>
          <SortHead label="Database" k="name" sort={sort} onSort={onSort} />
          <SortHead label="Engine" k="engine" sort={sort} onSort={onSort} />
          <TableHead>Version</TableHead>
          <SortHead label="State" k="state" sort={sort} onSort={onSort} />
          <TableHead className="text-right">Size</TableHead>
          <SortHead label="Connections" k="conns" sort={sort} onSort={onSort} />
          <SortHead label="QPS" k="qps" sort={sort} onSort={onSort} className="text-right" />
          <SortHead label="Slow" k="slow" sort={sort} onSort={onSort} className="text-right" />
          <TableHead>Endpoint</TableHead>
          <TableHead>Activity</TableHead>
          <TableHead className={cn(STICKY, "border-l pr-3.5 text-right")}>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {databases.map(db => {
          const expanded = expandedDb === db.name
          const open = (t: WorkspaceTab) => { setTab(db.name, t); if (!expanded) onExpand(db.name) }
          return (
            <Fragment key={db.name}>
              <TableRow className={cn("h-[54px]", expanded && "bg-muted/40")}>
                <TableCell className="w-10 pl-2"><ExpandButton db={db} expanded={expanded} onExpand={() => onExpand(db.name)} /></TableCell>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <EngineBadge db={db} />
                    <div className="flex min-w-0 flex-col">
                      <span className="max-w-[220px] truncate font-semibold" title={db.name}>{db.name}</span>
                      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        {db.host}
                      </span>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap capitalize">{db.engine}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{db.version || "—"}</TableCell>
                <TableCell><Pill tone={statusTone(db.state)} dot>{statusLabel(db.state)}</Pill></TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{db.size}</TableCell>
                <TableCell><ConnCell db={db} /></TableCell>
                <TableCell className="text-right font-mono text-xs font-medium tabular-nums">{db.qps > 0 ? db.qps.toLocaleString() : "—"}</TableCell>
                <TableCell className="text-right"><SlowCell n={db.slow} /></TableCell>
                <TableCell><EndpointButton db={db} /></TableCell>
                <TableCell><ConnSpark data={connHist[db.name] ?? connHist[db.host] ?? []} color={engineColor(db.engine)} /></TableCell>
                <TableCell className={cn(STICKY, "border-l px-2", expanded && "bg-muted")}>
                  <RowActions db={db} onOpen={open} h={handlers} />
                </TableCell>
              </TableRow>
              {expanded && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={12} className="p-0 whitespace-normal">
                    {/* Pinned to the scroll container's width so the panel never stretches with the wide table */}
                    <div className="sticky left-0 w-[100cqw]">
                      <DatabaseWorkspace db={db} tab={tabOf(db.name)} onTab={t => setTab(db.name, t)} />
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** Phone layout: one card per database with the essentials; expanding shows the workspace. */
export function DatabaseCards({ databases, connHist, expandedDb, onExpand, handlers }: Common & { databases: Database[] }) {
  const { tabOf, setTab } = useTabs()
  return (
    <div className="flex flex-col gap-2 p-3">
      {databases.map(db => {
        const expanded = expandedDb === db.name
        const open = (t: WorkspaceTab) => { setTab(db.name, t); if (!expanded) onExpand(db.name) }
        return (
          <article key={db.name} className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-card">
            <div className="flex flex-col gap-3 p-3.5">
              <div className="flex items-start justify-between gap-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <EngineBadge db={db} />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-semibold">{db.name}</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">{db.engine} {db.version}</span>
                  </div>
                </div>
                <Pill tone={statusTone(db.state)} dot>{statusLabel(db.state)}</Pill>
              </div>
              <dl className="m-0 grid grid-cols-3 gap-2">
                {[["Size", db.size], ["QPS", db.qps > 0 ? db.qps.toLocaleString() : "—"], ["Conns", `${db.conns > 0 ? db.conns : "—"} / ${db.maxConns}`]].map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-[11px] text-muted-foreground">{k}</dt>
                    <dd className="m-0 text-sm font-medium tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex items-center justify-between gap-2">
                <EndpointButton db={db} />
                <ConnSpark data={connHist[db.name] ?? connHist[db.host] ?? []} color={engineColor(db.engine)} />
              </div>
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="lg" className="flex-1" aria-expanded={expanded} onClick={() => onExpand(db.name)}>
                  {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} {expanded ? "Collapse" : "Open"}
                </Button>
                <Button variant="outline" size="icon-lg" aria-label={`Query ${db.name}`} onClick={() => open("query")}><TerminalSquare className="size-4" /></Button>
                <Button variant="outline" size="icon-lg" aria-label={`Backup ${db.name}`} onClick={() => handlers.onBackup(db)}><Download className="size-4" /></Button>
                <Button variant="outline" size="icon-lg" aria-label={`Restore ${db.name}`} onClick={() => handlers.onRestore(db)}><Upload className="size-4" /></Button>
                <Button variant="outline" size="icon-lg" aria-label={`Delete ${db.name}`} className="text-danger hover:text-danger" onClick={() => handlers.onDelete(db)}><Trash2 className="size-4" /></Button>
              </div>
            </div>
            {expanded && <DatabaseWorkspace db={db} tab={tabOf(db.name)} onTab={t => setTab(db.name, t)} />}
          </article>
        )
      })}
    </div>
  )
}
