import { cn } from "@/lib/utils"

interface Vulns { crit: number; high: number; med: number; low: number }

const CHIPS: { key: keyof Vulns; letter: string; cls: string }[] = [
  { key: "crit", letter: "C", cls: "bg-[var(--sev-crit-bg)] text-[var(--sev-crit-fg)]" },
  { key: "high", letter: "H", cls: "bg-[var(--sev-high-bg)] text-[var(--sev-high-fg)]" },
  { key: "med", letter: "M", cls: "bg-[var(--sev-med-bg)] text-[var(--sev-med-fg)]" },
  { key: "low", letter: "L", cls: "bg-[var(--sev-low-bg)] text-[var(--sev-low-fg)]" },
]

/** Vulnerability counts by severity (C/H/M/L); "—" when clean. */
export function VulnBar({ v }: { v: Vulns }) {
  if (v.crit + v.high + v.med + v.low === 0) return <span className="font-mono text-xs text-muted-foreground">—</span>
  return (
    <div className="flex items-center gap-1">
      {CHIPS.filter(c => v[c.key] > 0).map(c => (
        <span key={c.key} className={cn("rounded px-1.5 py-0.5 font-mono text-[11px] font-bold tabular-nums", c.cls)}>
          {c.letter}:{v[c.key]}
        </span>
      ))}
    </div>
  )
}
