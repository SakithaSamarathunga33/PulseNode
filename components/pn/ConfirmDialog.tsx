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
  open, onOpenChange, title, description, target, confirmLabel = "Confirm", tone = "danger",
  icon: Icon, loading, onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  target?: React.ReactNode
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
