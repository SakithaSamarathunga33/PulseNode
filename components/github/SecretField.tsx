"use client"

import { useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Truncate } from "@/components/pn/Truncate"
import { CopyButton } from "@/components/interior/copy-button"

/** Read-only mono value with copy (and optional reveal) buttons. */
export function CopyField({
  id, label, value, secret,
}: { id: string; label: string; value: string; secret?: boolean }) {
  const [shown, setShown] = useState(false)
  const display = !value ? "—" : secret && !shown ? "•".repeat(24) : value

  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-1 rounded-lg border bg-muted/40 pl-3 pr-1">
        <code id={id} className="min-w-0 flex-1 py-2 text-xs"><Truncate mono text={value ? display : ""} /></code>
        {secret && (
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => setShown(s => !s)}
            aria-label={shown ? `Hide ${label}` : `Reveal ${label}`}>
            {shown ? <EyeOff /> : <Eye />}
          </Button>
        )}
        {/* interior.dev CopyButton: copies (with an http fallback), then shows "Copied" in place. */}
        <CopyButton value={value} label="Copy" copiedLabel="Copied" ariaLabel={`Copy ${label}`} disabled={!value} />
      </div>
    </div>
  )
}
