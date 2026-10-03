"use client"

import { Trash2 } from "lucide-react"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import type { Database } from "@/lib/types"

export function DeleteDialog({ db, onConfirm, onClose }: {
  db: Database; onConfirm: () => void; onClose: () => void
}) {
  return (
    <ConfirmDialog
      open
      onOpenChange={open => { if (!open) onClose() }}
      icon={Trash2}
      title="Delete cluster?"
      description="This will permanently remove the database container and all its data. This action cannot be undone."
      target={<><span className="font-semibold">{db.name}</span><br /><span className="text-muted-foreground">{db.engine} · {db.host}:{db.port}</span></>}
      confirmLabel="Delete"
      onConfirm={() => { onConfirm(); onClose() }}
    />
  )
}
