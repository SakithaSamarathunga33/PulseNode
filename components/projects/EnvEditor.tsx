"use client"

import { Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/** One editable variable. `id` keeps React keys stable while rows are added or removed. */
export type EnvRow = { id: number; key: string; value: string }

let nextId = 1
export const newEnvRow = (key = "", value = ""): EnvRow => ({ id: nextId++, key, value })

/** Parses the stored JSON map (`{"KEY":"value"}`) into rows; anything else gives no rows. */
export function envRowsFromJson(json: string | undefined | null): EnvRow[] {
  try {
    const obj: unknown = JSON.parse(json || "{}")
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return Object.entries(obj as Record<string, unknown>).map(([k, v]) => newEnvRow(k, String(v ?? "")))
    }
  } catch { /* unreadable env: start empty */ }
  return []
}

/** Rows to a plain map. Blank keys are skipped; a later duplicate wins (same as a .env file). */
export function envRowsToObject(rows: EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const k = r.key.trim()
    if (k) out[k] = r.value
  }
  return out
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Same rules the backend enforces before a deploy: plain names, no line breaks in values. */
export function envRowProblem(r: EnvRow): string | null {
  const k = r.key.trim()
  if (!k && !r.value) return null
  if (!k) return "Name is required"
  if (!KEY_RE.test(k)) return "Use letters, digits and _ (not starting with a digit)"
  if (/[\r\n\0]/.test(r.value)) return "Value cannot contain line breaks"
  return null
}

/** First problem across several editors, phrased for a toast or alert; null when all rows are valid. */
export function envProblem(rows: EnvRow[], label = "Environment"): string | null {
  const seen = new Set<string>()
  for (const r of rows) {
    const p = envRowProblem(r)
    if (p) return `${label}: ${r.key.trim() || "(blank name)"} — ${p.toLowerCase()}`
    const k = r.key.trim()
    if (k) {
      if (seen.has(k)) return `${label}: ${k} is defined twice`
      seen.add(k)
    }
  }
  return null
}

const SECRET_RE = /SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL/i

/**
 * Key/value editor for environment variables. Values whose name looks like a secret are
 * masked. Values are encrypted at rest by the API, never shown in lists or logs.
 */
export function EnvEditor({ title, description, rows, onChange, idPrefix, className }: {
  title: string
  description?: React.ReactNode
  rows: EnvRow[]
  onChange: (rows: EnvRow[]) => void
  idPrefix: string
  className?: string
}) {
  const update = (id: number, patch: Partial<EnvRow>) =>
    onChange(rows.map(r => (r.id === id ? { ...r, ...patch } : r)))

  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card", className)}>
      <div className="flex items-center justify-between gap-2 border-b py-1.5 pr-2 pl-3.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="truncate text-xs text-muted-foreground">{description}</p>}
        </div>
        <Button type="button" variant="ghost" size="xs" onClick={() => onChange([...rows, newEnvRow()])}>
          <Plus className="size-3.5" />Add
        </Button>
      </div>
      <div className="space-y-1.5 p-2.5">
        {rows.length === 0 && <p className="px-0.5 py-1.5 text-xs text-muted-foreground">No variables.</p>}
        {rows.map((r, i) => {
          const problem = envRowProblem(r)
          return (
            <div key={r.id}>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto] items-center gap-1.5">
                <Input
                  value={r.key}
                  onChange={e => update(r.id, { key: e.target.value })}
                  aria-label={`${title}: variable ${i + 1} name`}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={problem ? `${idPrefix}-${r.id}-err` : undefined}
                  placeholder="KEY"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-8 font-mono text-xs"
                />
                <Input
                  value={r.value}
                  onChange={e => update(r.id, { value: e.target.value })}
                  aria-label={`${title}: variable ${i + 1} value`}
                  type={SECRET_RE.test(r.key) ? "password" : "text"}
                  placeholder="value"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-8 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${r.key || `variable ${i + 1}`}`}
                  onClick={() => onChange(rows.filter(x => x.id !== r.id))}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
              {problem && <p id={`${idPrefix}-${r.id}-err`} className="mt-1 text-xs text-danger">{problem}</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
