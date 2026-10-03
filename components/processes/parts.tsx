"use client"

import { AlertTriangle, ChevronDown, MoreHorizontal, PauseCircle, XCircle } from "lucide-react"
import type { Process } from "@/lib/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Pill } from "@/components/dashboard/Pill"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"

export type DialogState = { type: "kill" | "suspend"; proc: Process } | null
export type Risk = "critical" | "high" | "medium"

export function procName(p: Process) {
  return p.name || p.cmd.split("/").pop()?.split(" ")[0] || p.cmd
}

/** Risk level badge — always text, plus an icon for critical/high. */
export function RiskPill({ risk }: { risk: Risk }) {
  if (risk === "critical") return <Pill tone="bad"><AlertTriangle className="size-3" />Critical</Pill>
  if (risk === "high") return <Pill tone="warn"><AlertTriangle className="size-3" />High</Pill>
  return <Pill tone="info">Medium</Pill>
}

export function ProcessActions({ proc, onRequest }: {
  proc: Process
  onRequest: (type: "kill" | "suspend", p: Process) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="xs" aria-label={`Actions for PID ${proc.pid}`} />}
      >
        <MoreHorizontal className="size-3.5" />
        Actions
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-mono">PID {proc.pid} · {procName(proc)}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onRequest("suspend", proc)}>
          <PauseCircle className="text-warning" />
          <span className="flex flex-col">
            <span className="font-medium">Suspend</span>
            <span className="text-xs text-muted-foreground">SIGSTOP · pause execution</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={() => onRequest("kill", proc)}>
          <XCircle />
          <span className="flex flex-col">
            <span className="font-medium">Kill process</span>
            <span className="text-xs text-muted-foreground">SIGKILL · force terminate</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ProcessConfirm({ dialog, onClose, onConfirmKill, onConfirmSuspend }: {
  dialog: DialogState
  onClose: () => void
  onConfirmKill: (p: Process) => void
  onConfirmSuspend: (p: Process) => void
}) {
  const isKill = dialog?.type === "kill"
  const proc = dialog?.proc
  return (
    <ConfirmDialog
      open={!!dialog}
      onOpenChange={o => { if (!o) onClose() }}
      tone={isKill ? "danger" : "warning"}
      icon={isKill ? XCircle : PauseCircle}
      title={isKill ? "Kill process?" : "Suspend process?"}
      description={isKill
        ? "This will immediately terminate the process. Any unsaved work will be lost and cannot be undone."
        : "This will pause the process with SIGSTOP. It stays in memory and can be resumed later."}
      confirmLabel={isKill ? "Kill" : "Suspend"}
      target={proc && (
        <div className="space-y-0.5">
          <div className="font-sans text-sm font-semibold">PID {proc.pid} · {procName(proc)}</div>
          <div className="text-muted-foreground">{proc.user} · {proc.cmd}</div>
        </div>
      )}
      onConfirm={() => {
        if (!dialog) return
        if (isKill) onConfirmKill(dialog.proc); else onConfirmSuspend(dialog.proc)
        onClose()
      }}
    />
  )
}
