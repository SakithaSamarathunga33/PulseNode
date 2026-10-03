"use client"

import { useEffect, useRef } from "react"
import { Loader2, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

/** Streamed output of `docker builder prune` (state machine lives in the stats page). */
export function ClearCacheDialog({ open, lines, state, onClose }: {
  open: boolean
  lines: string[]
  state: "idle" | "running" | "done" | "error"
  onClose: () => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Trash2 className="size-4 text-danger" /> Clear Docker build cache</DialogTitle>
          <DialogDescription>Runs <code className="font-mono text-xs">docker builder prune -f</code> on the host.</DialogDescription>
        </DialogHeader>
        <div
          ref={bodyRef}
          role="log"
          aria-live="polite"
          className="h-72 overflow-y-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-5"
        >
          {lines.map((line, i) => (
            <div
              key={i}
              className={cn(
                "break-all whitespace-pre-wrap",
                line.startsWith("✔") ? "text-success" : line.startsWith("✗") ? "text-danger" : line.startsWith("$") ? "text-info" : "text-muted-foreground",
              )}
            >
              {line}
            </div>
          ))}
          {state === "running" && <Loader2 className="mt-1 size-3.5 animate-spin text-muted-foreground" aria-label="Running" />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{state === "running" ? "Cancel" : "Close"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
