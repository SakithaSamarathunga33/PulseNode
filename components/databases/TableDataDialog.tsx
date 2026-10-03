"use client"

import { useCallback, useEffect, useState } from "react"
import { ChevronLeft, ChevronRight, Download, Table2, XCircle } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { nodeApi } from "@/lib/api"
import type { Database, DbQueryResult } from "@/lib/types"
import { ResultTable } from "@/components/dashboard/DatabaseQueryEditor"
import { Pill } from "@/components/dashboard/Pill"

// Read-only data viewer with pagination (100 rows / page)
const PAGE_SIZE = 100

function exportResultCsv(result: DbQueryResult, name: string) {
  const esc = (v: unknown) => JSON.stringify(v ?? "")
  const header = result.columns.map(esc).join(",")
  const body   = result.rows.map(r => r.map(esc).join(",")).join("\n")
  const blob   = new Blob([header + "\n" + body], { type: "text/csv" })
  const url    = URL.createObjectURL(blob)
  const a      = document.createElement("a")
  a.href = url; a.download = `${name}.csv`; a.click()
  URL.revokeObjectURL(url)
}

export function TableDataDialog({ db, database, table, onClose }: {
  db: Database; database: string; table: string; onClose: () => void
}) {
  const [page,    setPage]    = useState(0)
  const [result,  setResult]  = useState<DbQueryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const fetchPage = useCallback((p: number) => {
    const offset = p * PAGE_SIZE
    const q = db.engine === "redis"   ? "KEYS *"
             : db.engine === "mongodb" ? `${table} {}`
             : `SELECT * FROM ${table} LIMIT ${PAGE_SIZE} OFFSET ${offset};`
    let cancelled = false
    setLoading(true); setError(null); setResult(null)
    nodeApi.post<DbQueryResult>(`/api/database/${db.name}/query`, {
      query: q, database: database || undefined, force: false,
    })
      .then(res => { if (!cancelled) setResult(res) })
      .catch((err: unknown) => { if (!cancelled) setError((err as { message?: string })?.message || "Query failed") })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [db.name, db.engine, database, table])

  useEffect(() => fetchPage(page), [fetchPage, page])

  // For non-SQL engines, pagination doesn't apply
  const isPaginatable = db.engine !== "redis" && db.engine !== "mongodb"
  const hasNextPage   = isPaginatable && (result?.rowCount ?? 0) >= PAGE_SIZE
  const hasPrevPage   = page > 0
  const rowStart      = page * PAGE_SIZE + 1
  const rowEnd        = page * PAGE_SIZE + (result?.rowCount ?? 0)

  const goNext = () => setPage(p => p + 1)
  const goPrev = () => setPage(p => Math.max(0, p - 1))

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-3 sm:max-w-[92vw]">
        <DialogHeader className="pr-10">
          <DialogTitle className="flex items-center gap-2">
            <Table2 className="size-4 shrink-0 text-[var(--hue,var(--primary))]" />
            <span className="truncate font-mono">{table}</span>
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <span className="truncate">{database ? `${database} · ` : ""}{db.name}</span>
            {result && (
              <Pill tone="outline" className="font-mono tabular-nums">
                {result.rowCount} row{result.rowCount !== 1 ? "s" : ""} · {result.columns.length} col{result.columns.length !== 1 ? "s" : ""} · {result.durationMs}ms
              </Pill>
            )}
            {result && result.columns.length > 0 && (
              <Button size="xs" variant="outline" className="ml-auto" onClick={() => exportResultCsv(result, table)}>
                <Download /> Export CSV
              </Button>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Body — scrolls both axes inside the dialog */}
        <div className="min-h-[10rem] min-w-0 overflow-hidden rounded-lg border">
          {loading && (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
            </div>
          )}
          {error && !loading && (
            <div className="p-3">
              <Alert variant="destructive">
                <XCircle />
                <AlertDescription className="break-all font-mono text-xs">{error}</AlertDescription>
              </Alert>
            </div>
          )}
          {result && !loading && (
            result.columns.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">No rows to display.</div>
            ) : (
              <ResultTable result={result} fullscreen scrollClassName="max-h-[calc(90vh-14rem)]" />
            )
          )}
        </div>

        {/* Pagination footer */}
        {isPaginatable && !error && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {loading
                ? "Loading…"
                : result && result.rowCount > 0
                  ? `Rows ${rowStart}–${rowEnd}`
                  : page === 0 ? "No rows" : "No more rows"}
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={goPrev} disabled={!hasPrevPage || loading} aria-label="Previous page">
                <ChevronLeft /> Prev
              </Button>
              <span className="min-w-14 text-center text-xs tabular-nums text-muted-foreground">Page {page + 1}</span>
              <Button size="sm" variant="outline" onClick={goNext} disabled={!hasNextPage || loading} aria-label="Next page">
                Next <ChevronRight />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
