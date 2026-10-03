"use client"

import { ChevronDown, ChevronsUpDown, ChevronUp, FileText, Loader2, Play, RotateCcw, Square, Terminal, Trash2 } from "lucide-react"
import type { Container } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { ImageIcon } from "./ImageIcon"
import { shortId, splitImage, toneFor, TONE_BG } from "./utils"

export type SortKey = "name" | "image" | "state" | "cpu" | "ram"
export type Sort = { key: SortKey; dir: 1 | -1 }

export type RowHandlers = {
  onLogs: (c: Container) => void
  onTerm: (c: Container) => void
  onRestart: (c: Container) => void
  onStart: (c: Container) => void
  onStop: (c: Container) => void
  onRemove: (c: Container) => void
}

type Busy = Record<string, boolean>
const isBusy = (b: Busy, id: string) => ["start", "stop", "restart", "remove"].some(k => b[`${k}-${id}`])

const STATE_STYLE: Record<string, string> = {
  running: "bg-success/12 text-success",
  exited: "bg-danger/12 text-danger",
  paused: "bg-warning/14 text-warning",
  stopped: "bg-muted text-muted-foreground",
}
const STATE_LABEL: Record<string, string> = { running: "Running", exited: "Exited", paused: "Paused", stopped: "Stopped" }

export function StatePill({ state, busy }: { state: string; busy?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap",
        busy ? "bg-info/12 text-info" : (STATE_STYLE[state] ?? STATE_STYLE.stopped),
      )}
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : <span className="size-1.5 rounded-full bg-current" />}
      {busy ? "Working…" : (STATE_LABEL[state] ?? state)}
    </span>
  )
}

function UsageCell({ pct, running }: { pct: number; running: boolean }) {
  return (
    <div className="inline-flex items-center justify-end gap-2">
      <span className="min-w-11 text-right font-mono text-xs tabular-nums">{running ? `${pct.toFixed(1)}%` : "—"}</span>
      <span className="inline-block h-1 w-11 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span
          className={cn("block h-full rounded-full transition-[width] duration-500", TONE_BG[toneFor(pct)])}
          style={{ width: `${running ? Math.min(100, pct) : 0}%` }}
        />
      </span>
    </div>
  )
}

function IconAction({
  icon, label, onClick, disabled, danger,
}: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick}
            className={cn(danger && "text-danger hover:bg-danger/12 hover:text-danger")}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function RowActions({ c, busy, h }: { c: Container; busy: Busy; h: RowHandlers }) {
  const running = c.state === "running"
  const working = isBusy(busy, c.id)
  const spinning = (k: string, icon: React.ReactNode) => (busy[`${k}-${c.id}`] ? <Loader2 className="size-4 animate-spin" /> : icon)
  return (
    <div className="flex justify-end gap-0.5">
      <IconAction icon={<FileText className="size-4" />} label={`Logs for ${c.name}`} onClick={() => h.onLogs(c)} />
      <IconAction
        icon={<Terminal className="size-4" />} label={running ? `Open terminal in ${c.name}` : "Terminal (container not running)"}
        disabled={!running} onClick={() => h.onTerm(c)}
      />
      <IconAction
        icon={spinning("restart", <RotateCcw className="size-4" />)} label={`Restart ${c.name}`}
        disabled={working} onClick={() => h.onRestart(c)}
      />
      {running ? (
        <IconAction icon={spinning("stop", <Square className="size-4" />)} label={`Stop ${c.name}`} disabled={working} onClick={() => h.onStop(c)} />
      ) : (
        <IconAction icon={spinning("start", <Play className="size-4" />)} label={`Start ${c.name}`} disabled={working} onClick={() => h.onStart(c)} />
      )}
      <IconAction
        icon={spinning("remove", <Trash2 className="size-4" />)} label={`Remove ${c.name}`} danger
        disabled={working} onClick={() => h.onRemove(c)}
      />
    </div>
  )
}

function SortHead({
  label, k, sort, onSort, className,
}: { label: string; k: SortKey; sort: Sort; onSort: (k: SortKey) => void; className?: string }) {
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

const GROUP = "px-3 pt-2.5 pb-1 text-[11px] font-semibold tracking-wider uppercase text-muted-foreground"
const STICKY = "sticky right-0 bg-card shadow-[-8px_0_12px_-10px_rgb(0_0_0/0.35)]"

/** Desktop table: grouped headers (Identity / Runtime / Resources), selection, sortable columns, sticky actions. */
export function ContainerTable({
  rows, selected, onToggle, onToggleAll, sort, onSort, busy, handlers,
}: {
  rows: Container[]
  selected: Record<string, boolean>
  onToggle: (id: string, v: boolean) => void
  onToggleAll: (v: boolean) => void
  sort: Sort
  onSort: (k: SortKey) => void
  busy: Busy
  handlers: RowHandlers
}) {
  const allChecked = rows.length > 0 && rows.every(r => selected[r.id])
  return (
    <Table className="min-w-[1120px]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-10" />
          <TableHead colSpan={3} className={GROUP}>Identity</TableHead>
          <TableHead colSpan={3} className={cn(GROUP, "border-l")}>Runtime</TableHead>
          <TableHead colSpan={2} className={cn(GROUP, "border-l text-right")}>Resources</TableHead>
          <TableHead className={cn(STICKY, "border-l")} />
        </TableRow>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-10 pl-3.5">
            <Checkbox checked={allChecked} onCheckedChange={v => onToggleAll(!!v)} aria-label="Select all visible containers" />
          </TableHead>
          <SortHead label="Name" k="name" sort={sort} onSort={onSort} />
          <SortHead label="Image" k="image" sort={sort} onSort={onSort} />
          <TableHead>Ports</TableHead>
          <SortHead label="State" k="state" sort={sort} onSort={onSort} className="border-l" />
          <TableHead>Uptime</TableHead>
          <TableHead>Created</TableHead>
          <SortHead label="CPU" k="cpu" sort={sort} onSort={onSort} className="border-l text-right" />
          <SortHead label="RAM" k="ram" sort={sort} onSort={onSort} className="text-right" />
          <TableHead className={cn(STICKY, "border-l pr-3.5 text-right")}>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(c => {
          const { repo, tag } = splitImage(c.image)
          const running = c.state === "running"
          const checked = !!selected[c.id]
          return (
            <TableRow key={c.id} data-state={checked ? "selected" : undefined} className="h-[50px]">
              <TableCell className="w-10 pl-3.5">
                <Checkbox checked={checked} onCheckedChange={v => onToggle(c.id, !!v)} aria-label={`Select ${c.name}`} />
              </TableCell>
              <TableCell>
                <div className="flex flex-col">
                  <span className="max-w-[200px] truncate font-medium" title={c.name}>{c.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{shortId(c.id)}</span>
                </div>
              </TableCell>
              <TableCell className="max-w-[300px]">
                <div className="flex min-w-0 items-center gap-1.5">
                  <ImageIcon image={c.image} />
                  <span className="truncate font-mono text-xs text-muted-foreground" title={c.image}>{repo}</span>
                  <span className="shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{tag}</span>
                </div>
              </TableCell>
              <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground">{c.ports || "—"}</TableCell>
              <TableCell className="border-l"><StatePill state={c.state} busy={isBusy(busy, c.id)} /></TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">{c.uptime}</TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">{c.created}</TableCell>
              <TableCell className="border-l text-right"><UsageCell pct={c.cpu} running={running} /></TableCell>
              <TableCell className="text-right"><UsageCell pct={c.ram} running={running} /></TableCell>
              <TableCell className={cn(STICKY, "border-l px-2")}><RowActions c={c} busy={busy} h={handlers} /></TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** Phone layout: one card per container with the essentials and touch-sized actions. */
export function ContainerCards({
  rows, busy, handlers,
}: { rows: Container[]; busy: Busy; handlers: RowHandlers }) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map(c => {
        const { repo, tag } = splitImage(c.image)
        const running = c.state === "running"
        const working = isBusy(busy, c.id)
        return (
          <article key={c.id} className="flex flex-col gap-3 rounded-xl border bg-card p-3.5 shadow-card">
            <div className="flex items-start justify-between gap-2.5">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-semibold">{c.name}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">{repo}:{tag}</span>
              </div>
              <StatePill state={c.state} busy={working} />
            </div>
            <dl className="m-0 grid grid-cols-3 gap-2">
              {[["CPU", running ? `${c.cpu.toFixed(1)}%` : "—"], ["RAM", running ? `${c.ram.toFixed(1)}%` : "—"], ["Uptime", c.uptime]].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[11px] text-muted-foreground">{k}</dt>
                  <dd className="m-0 text-sm font-medium tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="flex gap-1.5">
              <Button variant="outline" size="lg" className="flex-1" onClick={() => handlers.onLogs(c)}><FileText className="size-3.5" /> Logs</Button>
              <Button variant="outline" size="lg" className="flex-1" disabled={working} onClick={() => handlers.onRestart(c)}><RotateCcw className="size-3.5" /> Restart</Button>
              <Button
                variant="outline" size="icon-lg" disabled={working} aria-label={`${running ? "Stop" : "Start"} ${c.name}`}
                onClick={() => (running ? handlers.onStop(c) : handlers.onStart(c))}
              >
                {running ? <Square className="size-4" /> : <Play className="size-4" />}
              </Button>
              <Button
                variant="outline" size="icon-lg" disabled={working} aria-label={`Remove ${c.name}`}
                className="text-danger hover:text-danger" onClick={() => handlers.onRemove(c)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </article>
        )
      })}
    </div>
  )
}
