"use client"

import { useState } from "react"
import { Trash2 } from "lucide-react"
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { Database } from "@/lib/types"

/** Permanent delete: the user must type the database name before the button enables. */
export function DeleteDialog({ db, onConfirm, onClose }: {
  db: Database; onConfirm: () => void; onClose: () => void
}) {
  const [typed, setTyped] = useState("")
  const ok = typed === db.name
  return (
    <AlertDialog open onOpenChange={open => { if (!open) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-danger/12 text-danger"><Trash2 /></AlertDialogMedia>
          <AlertDialogTitle>Delete database?</AlertDialogTitle>
          <AlertDialogDescription>
            The container and all its data will be permanently removed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="divide-y rounded-lg border bg-muted/40 py-1">
          <li className="flex flex-col gap-px px-3 py-1.5 font-mono">
            <span className="text-[13px] font-medium break-all">{db.name}</span>
            <span className="text-xs break-all text-muted-foreground">
              {db.engine}{db.version ? ` ${db.version}` : ""} · {db.size} · {db.host}:{db.port}
            </span>
          </li>
        </ul>
        <p className="text-sm font-medium text-danger">This action cannot be undone.</p>
        <div className="space-y-1.5">
          <Label htmlFor="delete-db-confirm">
            Type <span className="font-mono text-foreground">{db.name}</span> to confirm
          </Label>
          <Input
            id="delete-db-confirm"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={!ok} onClick={() => { onConfirm(); onClose() }}>
            Delete database
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
