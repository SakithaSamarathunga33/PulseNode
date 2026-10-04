"use client"

import { ArchiveRestore, CheckCircle2, CircleAlert, Download, History, Lock, LockOpen, Trash2 } from "lucide-react"
import { Pill } from "@/components/dashboard/Pill"
import { EmptyState } from "@/components/pn/EmptyState"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { API_BASE } from "@/lib/api"
import { selectCls } from "./DestinationDialog"
import { runLabel, runTone } from "./SchedulesTab"
import { absTime, fmtSize, isPanel, relTime, targetText, toMs, type HistoryEntry, type Schedule } from "./shared"
import { Truncate } from "@/components/pn/Truncate"

type Props = {
  history: HistoryEntry[]
  schedules: Schedule[]
  filter: string
  onFilter: (id: string) => void
  onDelete: (h: HistoryEntry) => void
  onRestore: (h: HistoryEntry) => void
}

const canRestore = (h: HistoryEntry) => h.status === "success" && !isPanel(h.target)
const canDownload = (h: HistoryEntry) => h.status === "success"

function duration(h: HistoryEntry) {
  const a = toMs(h.startedAt), b = toMs(h.finishedAt)
  if (a === null || b === null || b < a) return null
  const s = Math.round((b - a) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function Files({ h }: { h: HistoryEntry }) {
  const files = Array.isArray(h.files) ? h.files : []
  if (files.length === 0) return <span className="text-sm text-muted-foreground">—</span>
  return (
    <ul className="flex flex-col gap-0.5">
      {files.map(f => (
        <li key={f.destinationId + f.name} className={`flex items-center gap-1.5 text-xs ${f.ok ? "text-muted-foreground" : "text-danger"}`}>
          {f.ok ? <CheckCircle2 className="size-3.5 shrink-0 text-success" /> : <CircleAlert className="size-3.5 shrink-0" />}
          <Truncate text={`${f.destinationName}${f.ok ? "" : ` — ${f.error || "copy failed"}`}`} tip={f.ok ? f.name : undefined} />
        </li>
      ))}
    </ul>
  )
}

function Actions({ h, onDelete, onRestore }: { h: HistoryEntry } & Pick<Props, "onDelete" | "onRestore">) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      {canDownload(h) && (
        <Button
          variant="ghost" size="icon-sm" aria-label={`Download backup from ${absTime(h.startedAt)}`}
          nativeButton={false} render={<a href={`${API_BASE}/api/backups/history/${h.id}/download`} download />}
        ><Download className="size-4" /></Button>
      )}
      {canRestore(h) && (
        <Button variant="ghost" size="icon-sm" aria-label={`Restore ${h.targetName || "database"} from ${absTime(h.startedAt)}`} onClick={() => onRestore(h)}>
          <ArchiveRestore className="size-4" />
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" aria-label={`Delete backup from ${absTime(h.startedAt)}`} disabled={h.status === "running"} onClick={() => onDelete(h)}>
        <Trash2 className="size-4 text-danger" />
      </Button>
    </div>
  )
}

function Encryption({ h }: { h: HistoryEntry }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${h.encrypted ? "text-muted-foreground" : "text-warning"}`}>
      {h.encrypted ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
      {h.encrypted ? "Encrypted" : "Not encrypted"}
    </span>
  )
}

export function HistoryTab({ history, schedules, filter, onFilter, onDelete, onRestore }: Props) {
  const filterBar = schedules.length > 1 || filter ? (
    <div className="flex items-center gap-2">
      <label htmlFor="bh-filter" className="text-xs text-muted-foreground">Schedule</label>
      <select id="bh-filter" className={`${selectCls} w-auto min-w-44`} value={filter} onChange={e => onFilter(e.target.value)}>
        <option value="">All schedules</option>
        {schedules.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </div>
  ) : null

  if (history.length === 0) {
    return (
      <div className="space-y-3">
        {filterBar}
        <EmptyState
          icon={History} title={filter ? "No backups for this schedule yet" : "No backups yet"}
          description="Finished and running backups show up here. Use Run now on a schedule to make the first one."
        />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {filterBar}
      <Card className="hidden gap-0 overflow-hidden py-0 md:block">
        <div className="overflow-x-auto">
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Backup</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Copies</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map(h => (
                <TableRow key={h.id} className="align-top">
                  <TableCell className="py-3 text-sm whitespace-nowrap">
                    {absTime(h.startedAt)}
                    <p className="text-xs text-muted-foreground">{relTime(h.startedAt)}{duration(h) ? ` · took ${duration(h)}` : ""}</p>
                  </TableCell>
                  <TableCell className="max-w-[16rem] py-3">
                    <Truncate text={h.scheduleName} className="text-sm font-medium" />
                    <Truncate mono text={targetText(h.target, h.targetName)} className="text-xs text-muted-foreground" />
                  </TableCell>
                  <TableCell className="py-3">
                    <div className="flex flex-col items-start gap-1">
                      <Pill tone={runTone(h.status)} dot>{runLabel(h.status)}</Pill>
                      {h.status === "success" && <Encryption h={h} />}
                      {h.status === "failed" && h.error && <Truncate text={h.error} className="max-w-[260px] text-xs text-danger" />}
                    </div>
                  </TableCell>
                  <TableCell className="py-3 text-right font-mono text-xs tabular-nums">{fmtSize(h.sizeBytes)}</TableCell>
                  <TableCell className="max-w-[260px] py-3"><Files h={h} /></TableCell>
                  <TableCell className="py-3"><Actions h={h} onDelete={onDelete} onRestore={onRestore} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      <ul className="space-y-3 md:hidden">
        {history.map(h => (
          <li key={h.id}>
            <Card className="gap-3 py-4">
              <div className="flex items-start justify-between gap-3 px-4">
                <div className="min-w-0">
                  <Truncate text={h.scheduleName} className="text-sm font-medium" />
                  <Truncate mono text={targetText(h.target, h.targetName)} className="text-xs text-muted-foreground" />
                </div>
                <Pill tone={runTone(h.status)} dot>{runLabel(h.status)}</Pill>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-4 text-xs">
                <div><dt className="text-muted-foreground">Started</dt><dd className="text-sm">{absTime(h.startedAt)}</dd></div>
                <div><dt className="text-muted-foreground">Size</dt><dd className="font-mono text-sm tabular-nums">{fmtSize(h.sizeBytes)}</dd></div>
                {h.status === "success" && <div className="col-span-2"><Encryption h={h} /></div>}
                {h.status === "failed" && h.error && <div className="col-span-2 text-sm break-words text-danger">{h.error}</div>}
                <div className="col-span-2"><dt className="mb-0.5 text-muted-foreground">Copies</dt><dd><Files h={h} /></dd></div>
              </dl>
              <div className="px-3"><Actions h={h} onDelete={onDelete} onRestore={onRestore} /></div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  )
}
