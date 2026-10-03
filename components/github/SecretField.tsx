"use client"

import { useTimeouts } from "@/lib/use-timeouts"
import { useState } from "react"
import { Check, Copy, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { copyText } from "@/lib/utils"
import { toast } from "sonner"

/** Read-only mono value with copy (and optional reveal) buttons. */
export function CopyField({
  id, label, value, secret,
}: { id: string; label: string; value: string; secret?: boolean }) {
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState(false)
  const later = useTimeouts()
  const display = !value ? "—" : secret && !shown ? "•".repeat(24) : value

  const copy = async () => {
    if (!value) return
    if (await copyText(value)) {
      setCopied(true)
      toast.success(`${label} copied`)
      later(() => setCopied(false), 1600)
    }
  }

  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-1 rounded-lg border bg-muted/40 pl-3 pr-1">
        <code id={id} className="min-w-0 flex-1 truncate py-2 font-mono text-xs">{display}</code>
        {secret && (
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => setShown(s => !s)}
            aria-label={shown ? `Hide ${label}` : `Reveal ${label}`}>
            {shown ? <EyeOff /> : <Eye />}
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon-sm" onClick={copy} disabled={!value} aria-label={`Copy ${label}`}>
          {copied ? <Check className="text-success" /> : <Copy />}
        </Button>
      </div>
    </div>
  )
}
