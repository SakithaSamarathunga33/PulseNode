"use client"

import { useMemo } from "react"
import { Link2 } from "lucide-react"
import { RingChart } from "@/components/charts/ring-chart"
import { Ring } from "@/components/charts/ring"
import { RingCenter } from "@/components/charts/ring-center"
import { TimeSeriesChart } from "@/components/dashboard/TimeSeriesChart"
import { Truncate } from "@/components/pn/Truncate"
import type { Database } from "@/lib/types"
import { Panel } from "@/components/pn/Panel"

const TOP_N = 4
const RING_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"]
const POLL_MS = 10000

const usage = (db: Database) => (db.maxConns > 0 ? (db.conns / db.maxConns) * 100 : 0)

/**
 * Connection pool usage for the busiest databases, beside the session's total-connections trend.
 * `maxConns` is the engine's default limit from the backend (not the server's real max_connections), so the
 * percentage is shown neutrally rather than toned as a warning.
 */
export function ConnectionsOverview({ databases, history }: { databases: Database[]; history: number[] }) {
  const busiest = useMemo(
    () => [...databases].sort((a, b) => usage(b) - usage(a) || b.conns - a.conns).slice(0, TOP_N),
    [databases],
  )
  const rings = busiest.map((db, i) => ({
    label: db.name, value: db.conns, maxValue: Math.max(db.maxConns, 1), color: RING_COLORS[i],
  }))
  const now = history.at(-1) ?? 0
  const peak = history.length ? Math.max(...history) : 0
  const minutes = Math.round(((history.length - 1) * POLL_MS) / 60000)

  return (
    <Panel role="region" aria-labelledby="db-conns-title" className="grid gap-5 rounded-xl p-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-4">
        <h2 id="db-conns-title" className="inline-flex items-center gap-2 text-sm font-semibold">
          <Link2 className="size-4 text-[var(--hue)]" strokeWidth={1.75} />Connection pools
        </h2>
        <div className="flex items-center gap-5">
          <div className="w-[112px] shrink-0" aria-hidden>
            <RingChart data={rings} strokeWidth={9} ringGap={5} baseInnerRadius={20}>
              {rings.map((r, i) => <Ring key={r.label} index={i} color={r.color} showGlow={false} />)}
              <RingCenter defaultLabel={databases.length > TOP_N ? `Top ${TOP_N}` : "Open"} />
            </RingChart>
          </div>
          <ul className="min-w-0 flex-1 space-y-1.5 text-ui" aria-label="Connections used of the engine default limit">
            {busiest.map((db, i) => {
              const pct = usage(db)
              return (
                <li key={db.name} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2">
                  <span className="inline-flex min-w-0 items-center gap-2 text-muted-foreground">
                    <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: RING_COLORS[i] }} />
                    <Truncate text={db.name} />
                  </span>
                  <span className="font-mono tabular-nums">{db.conns}<span className="text-muted-foreground">/{db.maxConns}</span></span>
                  <span className="w-10 text-right font-mono text-xs tabular-nums text-muted-foreground">{Math.round(pct)}%</span>
                </li>
              )
            })}
          </ul>
        </div>
        <p className="text-xs text-muted-foreground">Limits are engine defaults; your server&apos;s configured maximum may differ.</p>
      </div>

      <div className="min-w-0 space-y-2 border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h2 className="text-sm font-semibold">Open connections · this session</h2>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">now {now} · peak {peak}</span>
        </div>
        <div role="img" aria-label={history.length < 2 ? "Collecting connection samples…" : `Total open connections over the last ${minutes} minutes: now ${now}, peak ${peak}.`}>
          <TimeSeriesChart height={128} stepMs={POLL_MS} decimals={0} series={[{ label: "Connections", values: history, color: "var(--chart-1)" }]} />
        </div>
      </div>
    </Panel>
  )
}
