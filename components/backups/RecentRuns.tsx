"use client"

import { useMemo, useState } from "react"
import { History } from "lucide-react"
import { BarSparkline } from "@/components/charts/sparkline"
import { StatusDot } from "@/components/pn/StatusDot"
import { runLabel } from "./SchedulesTab"
import { absTime, fmtSize, toMs, type HistoryEntry } from "./shared"
import { Panel } from "@/components/pn/Panel"

const COUNTS = [
  { status: "success", label: "Succeeded", tone: "ok", cls: "text-success" },
  { status: "failed", label: "Failed", tone: "bad", cls: "text-danger" },
  { status: "running", label: "Running", tone: "info", cls: "text-info" },
] as const

/** Outcome counts and a backup-size bar per run (oldest → newest) for the loaded history. */
export function RecentRuns({ history }: { history: HistoryEntry[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const runs = useMemo(
    () => [...history].sort((a, b) => (toMs(a.startedAt) ?? 0) - (toMs(b.startedAt) ?? 0)),
    [history],
  )
  const counts = COUNTS.map(c => ({ ...c, n: history.filter(h => h.status === c.status).length }))
  const done = counts[0].n + counts[1].n
  const shown = runs[hover ?? runs.length - 1]

  return (
    <Panel role="region" aria-labelledby="bh-recent" className="grid gap-5 rounded-xl p-4 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
      <div className="space-y-3">
        <h2 id="bh-recent" className="inline-flex items-center gap-2 text-sm font-semibold">
          <History className="size-4 text-[var(--hue)]" strokeWidth={1.75} />Last {history.length} runs
        </h2>
        <p className="flex items-baseline gap-1.5">
          <span className="text-metric leading-none font-semibold tracking-tight tabular-nums">
            {done ? Math.round((counts[0].n / done) * 100) : 0}%
          </span>
          <span className="text-sm text-muted-foreground">succeeded</span>
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-ui">
          {counts.map(c => (
            <li key={c.status} className="inline-flex items-center gap-1.5 text-muted-foreground">
              <span className={c.cls}><StatusDot tone={c.tone} /></span>{c.label}
              <span className="font-mono text-foreground tabular-nums">{c.n}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="min-w-0 space-y-2 border-t pt-4 md:border-t-0 md:border-l md:pt-0 md:pl-5">
        <h2 className="text-sm font-semibold">Backup size per run</h2>
        <div aria-hidden>
          <BarSparkline
            data={runs} dataKey={h => h.sizeBytes || 0} height={56} color="var(--chart-1)"
            barGap={2} barRadius={2} onHoverChange={i => setHover(i)}
          />
        </div>
        {shown && (
          <p className="text-xs text-muted-foreground tabular-nums">
            {hover === null ? "Latest · " : ""}{absTime(shown.startedAt)} · <span className="font-mono text-foreground">{fmtSize(shown.sizeBytes)}</span> · {runLabel(shown.status)}
          </p>
        )}
      </div>
    </Panel>
  )
}
