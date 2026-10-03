"use client"

import { useState } from "react"
import {
  AlertTriangle, BarChart3, ChevronDown, ChevronRight, Database as DatabaseIcon,
  Download, TerminalSquare, Trash2, Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Pill } from "@/components/dashboard/Pill"
import { ProgressBar } from "@/components/dashboard/ProgressBar"
import { DbIcon } from "@/components/dashboard/DbIcon"
import { DatabaseQueryEditor } from "@/components/dashboard/DatabaseQueryEditor"
import { DatabaseMetricsPanel } from "@/components/dashboard/DatabaseMetricsPanel"
import { cn } from "@/lib/utils"
import type { Database } from "@/lib/types"
import { TablesPanel } from "./TablesPanel"
import { engineColor, statusTone } from "./shared"

type TabId = "overview" | "query" | "metrics"

function ConnSpark({ data, color }: { data: number[]; color: string }) {
  const values = data.length > 1 ? data : [0, 0]
  const w = 92
  const h = 28
  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min || 1
  const step = w / (values.length - 1)
  const pts = values.map((v, i) =>
    `${(i * step).toFixed(1)},${(h - 2 - ((v - min) / range) * (h - 4)).toFixed(1)}`
  )
  const d = `M ${pts.join(" L ")}`

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block" style={{ color }} aria-hidden>
      <path d={`${d} L ${w},${h} L 0,${h} Z`} fill="currentColor" fillOpacity={0.14} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconAction({ label, onClick, className, children }: {
  label: string; onClick: () => void; className?: string; children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={onClick} aria-label={label} className={className} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

const STICKY_ACTIONS = "sticky right-0 z-10 bg-card shadow-[-12px_0_14px_-14px_var(--foreground)]"

function DatabaseRow({
  db, connHist, expanded, onExpand, onDelete, onBackup, onRestore,
}: {
  db: Database
  connHist: number[]
  expanded: boolean
  onExpand: () => void
  onDelete: (db: Database) => void
  onBackup: (db: Database) => void
  onRestore: (db: Database) => void
}) {
  const [tab, setTab] = useState<TabId>("overview")

  function openTab(t: TabId) {
    if (!expanded) onExpand()
    setTab(t)
  }

  const color = engineColor(db.engine)
  const connPct = db.maxConns > 0 ? Math.round((db.conns / db.maxConns) * 100) : 0
  const isCoolify = db.name.toLowerCase().includes("coolify")
  const tone = statusTone(db.state)

  return (
    <>
      <TableRow className={cn("group", expanded && "bg-muted/40")}>
        <TableCell className="w-8 pr-0">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onExpand}
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${db.name}` : `Expand ${db.name}`}
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </Button>
        </TableCell>
        <TableCell className="min-w-[240px]">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background">
              <DbIcon engine={db.engine} size={20} />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-semibold">{db.name}</span>
                {isCoolify && <Pill tone="info">Coolify</Pill>}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-xs text-muted-foreground">
                <span className="uppercase">{db.engine}</span>
                {db.version && <span className="truncate">{db.version}</span>}
              </div>
            </div>
          </div>
        </TableCell>
        <TableCell>
          <Pill tone={tone} dot>{db.state}</Pill>
        </TableCell>
        <TableCell className="font-mono text-xs tabular-nums">{db.size}</TableCell>
        <TableCell className="min-w-[150px]">
          <div className="flex items-center justify-between gap-2 font-mono text-xs tabular-nums">
            <span>{db.conns > 0 ? db.conns : "-"}</span>
            <span className="text-muted-foreground">/ {db.maxConns}</span>
          </div>
          <ProgressBar
            className="mt-1"
            value={Math.min(connPct, 100)}
            tone={connPct > 85 ? "bad" : connPct > 65 ? "warn" : "ok"}
          />
        </TableCell>
        <TableCell className="text-right font-mono text-xs tabular-nums">{db.qps > 0 ? db.qps.toLocaleString() : "-"}</TableCell>
        <TableCell className="text-right">
          {db.slow > 0 ? (
            <span className="inline-flex items-center gap-1 font-mono text-xs tabular-nums text-warning">
              <AlertTriangle className="size-3.5" />
              {db.slow}
            </span>
          ) : (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">0</span>
          )}
        </TableCell>
        <TableCell>
          <code className="block max-w-[210px] truncate font-mono text-xs text-muted-foreground">
            {db.host}:{db.port}
          </code>
        </TableCell>
        <TableCell>
          <ConnSpark data={connHist} color={color} />
        </TableCell>
        <TableCell className={cn(STICKY_ACTIONS, expanded && "bg-muted")}>
          <div className="flex items-center justify-end gap-1">
            <Button
              variant={expanded && tab === "query" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => openTab("query")}
            >
              <TerminalSquare /> Query
            </Button>
            <Button
              variant={expanded && tab === "metrics" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => openTab("metrics")}
            >
              <BarChart3 /> Metrics
            </Button>
            <IconAction label={`Backup ${db.name}`} onClick={() => onBackup(db)}><Download /></IconAction>
            <IconAction label={`Restore ${db.name}`} onClick={() => onRestore(db)}><Upload /></IconAction>
            <IconAction label={`Delete ${db.name}`} onClick={() => onDelete(db)} className="text-danger hover:bg-danger/10 hover:text-danger">
              <Trash2 />
            </IconAction>
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={10} className="bg-muted/30 p-3 whitespace-normal">
            {/* Pinned to the scroll container's width so the panel never stretches with the wide table */}
            <div className="sticky left-0 w-[calc(100cqw-1.5rem)]">
            <Tabs value={tab} onValueChange={v => setTab(v as TabId)}>
              <TabsList variant="line">
                <TabsTrigger value="overview"><DatabaseIcon /> Overview</TabsTrigger>
                <TabsTrigger value="query"><TerminalSquare /> Query</TabsTrigger>
                <TabsTrigger value="metrics"><BarChart3 /> Metrics</TabsTrigger>
              </TabsList>
              <TabsContent value="overview">{tab === "overview" && <TablesPanel db={db} />}</TabsContent>
              <TabsContent value="query">
                {tab === "query" && <DatabaseQueryEditor db={db} initialQuery="" onClose={() => setTab("overview")} />}
              </TabsContent>
              <TabsContent value="metrics">
                {tab === "metrics" && <DatabaseMetricsPanel db={db} onClose={() => setTab("overview")} />}
              </TabsContent>
            </Tabs>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

export function DatabaseTable({
  databases, connHist, expandedDb, onExpand, onDelete, onBackup, onRestore,
}: {
  databases: Database[]
  connHist: Record<string, number[]>
  expandedDb: string | null
  onExpand: (name: string) => void
  onDelete: (db: Database) => void
  onBackup: (db: Database) => void
  onRestore: (db: Database) => void
}) {
  return (
    <Table className="min-w-[1180px]">
      <TableHeader>
        <TableRow>
          <TableHead className="w-8"><span className="sr-only">Expand</span></TableHead>
          <TableHead>Database</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Size</TableHead>
          <TableHead>Connections</TableHead>
          <TableHead className="text-right">QPS</TableHead>
          <TableHead className="text-right">Slow</TableHead>
          <TableHead>Endpoint</TableHead>
          <TableHead>Activity</TableHead>
          <TableHead className={cn(STICKY_ACTIONS, "text-right")}>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {databases.map(db => (
          <DatabaseRow
            key={db.name}
            db={db}
            connHist={connHist[db.name] ?? connHist[db.host] ?? []}
            expanded={expandedDb === db.name}
            onExpand={() => onExpand(db.name)}
            onDelete={onDelete}
            onBackup={onBackup}
            onRestore={onRestore}
          />
        ))}
      </TableBody>
    </Table>
  )
}
