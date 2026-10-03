"use client"

import { Loader2 } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

/**
 * Confirmation for destructive or risky actions (remove, kill, delete, rollback).
 * Replaces window.confirm(); `target` shows what will be affected.
 */
export function ConfirmDialog({
  open, onOpenChange, title, description, target, items, note, confirmLabel = "Confirm", tone = "danger",
  icon: Icon, loading, onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  target?: React.ReactNode
  /** What will be affected: a primary line (name) and a secondary line (image, subnet…) each. */
  items?: { primary: string; secondary?: string }[]
  /** Consequence line under the list, coloured by tone (e.g. "This action cannot be undone."). */
  note?: React.ReactNode
  confirmLabel?: string
  tone?: "danger" | "warning" | "default"
  icon?: LucideIcon
  loading?: boolean
  onConfirm: () => void | Promise<void>
}) {
  const media = tone === "danger" ? "bg-danger/12 text-danger" : tone === "warning" ? "bg-warning/12 text-warning" : "bg-primary/12 text-primary"
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          {Icon && <AlertDialogMedia className={media}><Icon /></AlertDialogMedia>}
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {target && <div className="rounded-lg border bg-muted/50 px-3 py-2 font-mono text-xs break-all">{target}</div>}
        {items && items.length > 0 && (
          <ul className="max-h-48 divide-y overflow-auto rounded-lg border bg-muted/40 py-1">
            {items.map(it => (
              <li key={it.primary + (it.secondary ?? "")} className="flex flex-col gap-px px-3 py-1.5 font-mono">
                <span className="text-[13px] font-medium break-all">{it.primary}</span>
                {it.secondary && <span className="text-xs break-all text-muted-foreground">{it.secondary}</span>}
              </li>
            ))}
          </ul>
        )}
        {note && (
          <p className={tone === "danger" ? "text-sm font-medium text-danger" : tone === "warning" ? "text-sm font-medium text-warning" : "text-sm text-muted-foreground"}>
            {note}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant={tone === "danger" ? "destructive" : "default"}
            disabled={loading}
            onClick={() => void onConfirm()}
          >
            {loading && <Loader2 className="size-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
