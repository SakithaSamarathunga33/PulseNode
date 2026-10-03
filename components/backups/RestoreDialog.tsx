"use client"

import { useState } from "react"
import { ArchiveRestore, Loader2 } from "lucide-react"
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { absTime, fmtSize, targetText, type HistoryEntry } from "./shared"

/** Restoring overwrites the live database: the user must type its name first. */
export function RestoreDialog({ entry, busy, onConfirm, onClose }: {
  entry: HistoryEntry; busy: boolean; onConfirm: () => void | Promise<void>; onClose: () => void
}) {
  const name = entry.targetName || entry.target.replace(/^db:/, "")
  const [typed, setTyped] = useState("")
  const ok = typed === name
  return (
    <AlertDialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-warning/12 text-warning"><ArchiveRestore /></AlertDialogMedia>
          <AlertDialogTitle>Restore this backup?</AlertDialogTitle>
          <AlertDialogDescription>
            The database is replaced by the backup. Everything written since {absTime(entry.startedAt)} is lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="divide-y rounded-lg border bg-muted/40 py-1">
          <li className="flex flex-col gap-px px-3 py-1.5 font-mono">
            <span className="text-[13px] font-medium break-all">{targetText(entry.target, entry.targetName)}</span>
            <span className="text-xs break-all text-muted-foreground">{entry.scheduleName} · {absTime(entry.startedAt)} · {fmtSize(entry.sizeBytes)}{entry.encrypted ? " · encrypted" : ""}</span>
          </li>
        </ul>
        <p className="text-sm font-medium text-warning">This replaces the live data and cannot be undone.</p>
        <div className="space-y-1.5">
          <Label htmlFor="restore-confirm">Type <span className="font-mono text-foreground">{name}</span> to confirm</Label>
          <Input id="restore-confirm" value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button disabled={!ok || busy} onClick={() => void onConfirm()}>
            {busy && <Loader2 className="size-4 animate-spin" />} Restore database
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
