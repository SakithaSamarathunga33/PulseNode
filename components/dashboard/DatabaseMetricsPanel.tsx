"use client"

import { useState, useEffect, useCallback } from "react"
import { nodeApi } from "@/lib/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { LiveBadge } from "@/components/pn/LiveBadge"
import { ProgressBar } from "@/components/dashboard/ProgressBar"
import { cn } from "@/lib/utils"
import type { Database, DbMetricItem, DbMetrics } from "@/lib/types"

function MetricCard({ item }: { item: DbMetricItem }) {
  const valueColor =
    item.tone === "ok"   ? "text-success" :
    item.tone === "warn" ? "text-warning" :
    item.tone === "bad"  ? "text-danger"  :
    "text-foreground"

  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card px-3.5 py-3">
      <div className="truncate text-[13px] text-muted-foreground">{item.label}</div>
      <div className={cn("truncate text-xl font-semibold tabular-nums", valueColor)} title={String(item.value)}>
        {String(item.value)}
      </div>
    </div>
  )
}

/** Connections used vs the engine's default limit (from the backend, not the server's real max), as a neutral meter. */
function ConnectionMeter({ db }: { db: Database }) {
  const pct = db.maxConns > 0 ? (db.conns / db.maxConns) * 100 : 0
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-muted-foreground">Connections used</span>
        <span className="font-mono tabular-nums">
          {db.conns}<span className="text-muted-foreground"> / {db.maxConns} default · {Math.round(pct)}%</span>
        </span>
      </div>
      <ProgressBar value={pct} tone="info" label={`${db.name} connections used of the engine default limit`} />
    </div>
  )
}

export function DatabaseMetricsPanel({ db }: { db: Database; onClose?: () => void }) {
  const [metrics, setMetrics] = useState<DbMetrics | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchMetrics = useCallback(() => {
    nodeApi
      .get<DbMetrics>(`/api/database/${db.name}/metrics`)
      .then(({ data }) => { setMetrics(data); setError(null) })
      .catch(err => setError(err instanceof Error ? err.message : "Failed to load metrics"))
      .finally(() => setLoading(false))
  }, [db.name])

  useEffect(() => {
    fetchMetrics()
    const timer = setInterval(() => { if (!document.hidden) fetchMetrics() }, 5000)
    return () => clearInterval(timer)
  }, [fetchMetrics])

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2.5">
        {!loading && !error ? <LiveBadge>Live</LiveBadge> : <span className="text-xs font-medium text-muted-foreground">Metrics</span>}
        <span className="text-xs text-muted-foreground">refreshes every 5s</span>
      </div>

      <div className="space-y-3 p-3">
        <ConnectionMeter db={db} />
        {loading && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[72px] rounded-lg" />)}
          </div>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {metrics && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {(Array.isArray(metrics.metrics) ? metrics.metrics : []).map((m, i) => (
              <MetricCard key={i} item={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
