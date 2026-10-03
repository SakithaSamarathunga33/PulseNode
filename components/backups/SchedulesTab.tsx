"use client"

import { CalendarClock, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react"
import { Pill } from "@/components/dashboard/Pill"
import { EmptyState } from "@/components/pn/EmptyState"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { absTime, frequencyText, isPanel, relTime, targetText, type Destination, type Schedule } from "./shared"

export function runTone(status?: string | null): "ok" | "bad" | "info" | "outline" {
  return status === "success" ? "ok" : status === "failed" ? "bad" : status === "running" ? "info" : "outline"
}
export function runLabel(status?: string | null) {
  return status === "success" ? "Succeeded" : status === "failed" ? "Failed" : status === "running" ? "Running" : "No runs yet"
}

type Props = {
  schedules: Schedule[]
  destinations: Destination[]
  runningIds: Set<string>
  onNew: () => void
  onEdit: (s: Schedule) => void
  onDelete: (s: Schedule) => void
  onRun: (s: Schedule) => void
  onToggle: (s: Schedule, enabled: boolean) => void
}

function destNames(s: Schedule, destinations: Destination[]) {
  const names = (s.destinationIds ?? []).map(id => destinations.find(d => d.id === id)?.name ?? "removed destination")
  return names.length ? names.join(", ") : "—"
}

function RowActions({ s, running, onEdit, onDelete, onRun }: { s: Schedule; running: boolean } & Pick<Props, "onEdit" | "onDelete" | "onRun">) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      <Tooltip>
        <TooltipTrigger render={
          <Button variant="ghost" size="icon-sm" aria-label={`Run ${s.name} now`} disabled={running} onClick={() => onRun(s)}>
            {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          </Button>
        } />
        <TooltipContent>{running ? "Running…" : "Run now"}</TooltipContent>
      </Tooltip>
      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${s.name}`} onClick={() => onEdit(s)}><Pencil className="size-4" /></Button>
      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${s.name}`} onClick={() => onDelete(s)}><Trash2 className="size-4 text-danger" /></Button>
    </div>
  )
}

function LastRun({ s, running }: { s: Schedule; running: boolean }) {
  const status = running ? "running" : s.lastStatus
  return (
    <div className="flex flex-col items-start gap-0.5">
      <Pill tone={runTone(status)} dot>{runLabel(status)}</Pill>
      {s.lastRunAt ? <span className="text-xs text-muted-foreground" title={absTime(s.lastRunAt)}>{relTime(s.lastRunAt)}</span> : null}
    </div>
  )
}

export function SchedulesTab({ schedules, destinations, runningIds, onNew, onEdit, onDelete, onRun, onToggle }: Props) {
  if (schedules.length === 0) {
    return (
      <EmptyState
        icon={CalendarClock} title="No backup schedules yet"
        description="Create a schedule to back up the panel or a database automatically and copy it off the server."
        action={<Button onClick={onNew}><Plus className="size-4" /> New schedule</Button>}
      />
    )
  }
  return (
    <>
      <Card className="hidden gap-0 overflow-hidden py-0 md:block">
        <div className="overflow-x-auto">
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Schedule</TableHead>
                <TableHead>Backs up</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Stored in</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map(s => {
                const running = runningIds.has(s.id)
                return (
                  <TableRow key={s.id} className="h-[54px]">
                    <TableCell>
                      <p className="text-sm font-medium">{s.name}</p>
                      <p className="text-xs text-muted-foreground">keep {s.retention} · {s.encrypt ? "encrypted" : "not encrypted"}</p>
                    </TableCell>
                    <TableCell className="text-sm">
                      {isPanel(s.target) ? "Panel" : <span className="font-mono text-[13px]">{targetText(s.target, s.targetName)}</span>}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{frequencyText(s)}</TableCell>
                    <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground" title={destNames(s, destinations)}>{destNames(s, destinations)}</TableCell>
                    <TableCell><LastRun s={s} running={running} /></TableCell>
                    <TableCell className="text-sm whitespace-nowrap text-muted-foreground" title={absTime(s.nextRunAt)}>
                      {s.enabled ? relTime(s.nextRunAt) : "paused"}
                    </TableCell>
                    <TableCell><Switch checked={s.enabled} onCheckedChange={v => onToggle(s, v)} aria-label={`Enable schedule ${s.name}`} /></TableCell>
                    <TableCell><RowActions s={s} running={running} onEdit={onEdit} onDelete={onDelete} onRun={onRun} /></TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </Card>

      <ul className="space-y-3 md:hidden">
        {schedules.map(s => {
          const running = runningIds.has(s.id)
          return (
            <li key={s.id}>
              <Card className="gap-3 py-4">
                <div className="flex items-start justify-between gap-3 px-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{s.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{targetText(s.target, s.targetName)}</p>
                  </div>
                  <Switch checked={s.enabled} onCheckedChange={v => onToggle(s, v)} aria-label={`Enable schedule ${s.name}`} />
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-4 text-xs">
                  <div><dt className="text-muted-foreground">When</dt><dd className="text-sm">{frequencyText(s)}</dd></div>
                  <div><dt className="text-muted-foreground">Keep</dt><dd className="text-sm">{s.retention} · {s.encrypt ? "encrypted" : "plain"}</dd></div>
                  <div><dt className="text-muted-foreground">Last run</dt><dd><LastRun s={s} running={running} /></dd></div>
                  <div><dt className="text-muted-foreground">Next run</dt><dd className="text-sm">{s.enabled ? relTime(s.nextRunAt) : "paused"}</dd></div>
                  <div className="col-span-2"><dt className="text-muted-foreground">Stored in</dt><dd className="text-sm break-words">{destNames(s, destinations)}</dd></div>
                </dl>
                <div className="px-3"><RowActions s={s} running={running} onEdit={onEdit} onDelete={onDelete} onRun={onRun} /></div>
              </Card>
            </li>
          )
        })}
      </ul>
    </>
  )
}
