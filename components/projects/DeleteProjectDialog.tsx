"use client"

import { useState } from "react"
import { Loader2, Trash2 } from "lucide-react"
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** Permanent delete: the project name has to be typed before the button enables. */
export function DeleteProjectDialog({ name, detail, loading, onConfirm, onClose }: {
  name: string
  detail?: string
  loading?: boolean
  onConfirm: () => void | Promise<void>
  onClose: () => void
}) {
  const [typed, setTyped] = useState("")
  const ok = typed === name
  return (
    <AlertDialog open onOpenChange={open => { if (!open && !loading) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-danger/12 text-danger"><Trash2 /></AlertDialogMedia>
          <AlertDialogTitle>Delete project?</AlertDialogTitle>
          <AlertDialogDescription>
            Containers, images and routes are removed, along with the project&apos;s deployment history. The repository is untouched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="divide-y rounded-lg border bg-muted/40 py-1">
          <li className="flex flex-col gap-px px-3 py-1.5 font-mono">
            <span className="text-[13px] font-medium break-all">{name}</span>
            {detail && <span className="text-xs break-all text-muted-foreground">{detail}</span>}
          </li>
        </ul>
        <p className="text-sm font-medium text-danger">This action cannot be undone.</p>
        <div className="space-y-1.5">
          <Label htmlFor="delete-project-confirm">
            Type <span className="font-mono text-foreground">{name}</span> to confirm
          </Label>
          <Input
            id="delete-project-confirm"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={!ok || loading} onClick={() => void onConfirm()}>
            {loading && <Loader2 className="size-4 animate-spin" />}
            Delete project
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
