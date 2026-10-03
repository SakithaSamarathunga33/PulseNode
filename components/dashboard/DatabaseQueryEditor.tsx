"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Download, Loader2, Maximize2, Play, X, XCircle } from "lucide-react"
import { nodeApi } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import { Pill } from "@/components/dashboard/Pill"
import { cn } from "@/lib/utils"
import type { ApiError } from "@/lib/api"
import type { Database, DbSchemaResult, DbQueryResult } from "@/lib/types"

// ── ResultTable ───────────────────────────────────────────────────────────────

export function ResultTable({ result, fullscreen = false, scrollClassName }: { result: DbQueryResult; fullscreen?: boolean; scrollClassName?: string }) {
  const scroll = scrollClassName ?? (fullscreen ? "max-h-[calc(92vh-9rem)]" : "max-h-64")
  return (
    <div className={cn("overflow-auto", scroll)}>
      <table className="border-collapse text-xs" style={{ tableLayout: "auto", whiteSpace: "nowrap" }}>
        <thead>
          <tr className="sticky top-0 z-10">
            {result.columns.map(c => (
              <th
                key={c}
                className="border-b border-r bg-muted px-3 py-1.5 text-left font-mono font-semibold text-muted-foreground last:border-r-0"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className={cn("border-b last:border-b-0 hover:bg-muted/60", i % 2 === 1 && "bg-muted/30")}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={cn("border-r px-3 py-1.5 font-mono last:border-r-0", fullscreen ? "max-w-[480px]" : "max-w-[200px]")}
                  title={cell == null ? "null" : String(cell)}
                >
                  {cell == null
                    ? <span className="text-xs italic text-muted-foreground">null</span>
                    : <span className="block truncate">{String(cell)}</span>
                  }
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── QueryResult ───────────────────────────────────────────────────────────────

function QueryResult({ result }: { result: DbQueryResult }) {
  const [expanded, setExpanded] = useState(false)
  const isSelect = result.columns.length > 0
  const isDml    = !isSelect && result.rowCount > 0
  const isDdl    = !isSelect && result.rowCount === 0

  function exportCsv() {
    const header = result.columns.join(",")
    const body   = result.rows.map(r => r.map(v => JSON.stringify(v ?? "")).join(",")).join("\n")
    const blob   = new Blob([header + "\n" + body], { type: "text/csv" })
    const url    = URL.createObjectURL(blob)
    const a      = document.createElement("a")
    a.href = url; a.download = "query-result.csv"; a.click()
    URL.revokeObjectURL(url)
  }

  // DDL / non-returning statement, or INSERT / UPDATE / DELETE with affected rows
  if (isDdl || isDml) return (
    <div className="flex items-center gap-2 border-t bg-success/10 px-4 py-3">
      <CheckCircle2 className="size-4 text-success" />
      <span className="text-sm font-medium text-success">
        {isDdl ? "Query executed successfully" : `${result.rowCount} row${result.rowCount !== 1 ? "s" : ""} affected`}
      </span>
      <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">{result.durationMs}ms</span>
    </div>
  )

  const summary = (
    <>
      <span className="font-medium tabular-nums text-foreground">
        {result.rowCount} row{result.rowCount !== 1 ? "s" : ""}
      </span>
      <span aria-hidden>·</span>
      <span className="tabular-nums">{result.durationMs}ms</span>
      <span aria-hidden>·</span>
      <span className="tabular-nums">{result.columns.length} col{result.columns.length !== 1 ? "s" : ""}</span>
    </>
  )

  return (
    <>
      {/* Inline result (compact) */}
      <div className="border-t">
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          {summary}
          <div className="ml-auto flex items-center gap-1">
            <Button size="xs" variant="ghost" onClick={exportCsv}>
              <Download /> Export CSV
            </Button>
            <Button size="icon-xs" variant="ghost" onClick={() => setExpanded(true)} aria-label="Open results fullscreen" title="Fullscreen">
              <Maximize2 />
            </Button>
          </div>
        </div>
        <ResultTable result={result} />
      </div>

      {/* Fullscreen results */}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex max-h-[92vh] flex-col sm:max-w-[96vw]">
          <DialogHeader className="pr-10">
            <DialogTitle>Query results</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2 text-xs">
              {summary}
              <Button size="xs" variant="outline" onClick={exportCsv} className="ml-auto">
                <Download /> Export CSV
              </Button>
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-hidden rounded-lg border">
            <ResultTable result={result} fullscreen />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ── DatabaseQueryEditor ───────────────────────────────────────────────────────

const PAGE_SIZE = 100

export function DatabaseQueryEditor({
  db,
  onClose,
  initialQuery = "",
}: {
  db: Database
  onClose: () => void
  initialQuery?: string
}) {
  const [schema,           setSchema]           = useState<DbSchemaResult>({ databases: [], tables: [] })
  const [selectedDatabase, setSelectedDatabase] = useState("")
  const [query,            setQuery]            = useState(initialQuery)
  const [result,           setResult]           = useState<DbQueryResult | null>(null)
  const [error,            setError]            = useState<string | null>(null)
  const [loading,          setLoading]          = useState(false)
  const [showWarning,      setShowWarning]      = useState(false)
  // Set while results came from the table picker — enables Prev/Next paging
  const [tableView,        setTableView]        = useState<{ table: string; page: number } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isRedis = db.engine === "redis"
  const isMongo = db.engine === "mongodb"
  const hasQuery = query.trim().length > 0

  const loadSchema = useCallback((dbName?: string) => {
    const qs = dbName ? `?database=${encodeURIComponent(dbName)}` : ""
    nodeApi
      .get<DbSchemaResult>(`/api/database/${db.name}/schema${qs}`)
      .then(({ data }) => {
        setSchema(prev => ({
          databases: data.databases.length ? data.databases : prev.databases,
          tables:    data.tables,
        }))
        if (!dbName && data.databases.length > 0) setSelectedDatabase(data.databases[0])
      })
      .catch(err => setError((err as ApiError).message ?? "Failed to load schema"))
  }, [db.name])

  // Load database list on mount
  useEffect(() => { loadSchema() }, [loadSchema])

  // Reload table list when selected database changes
  useEffect(() => {
    if (!selectedDatabase) return
    loadSchema(selectedDatabase)
    setTableView(null)
  }, [loadSchema, selectedDatabase])

  const runQuery = useCallback(
    async (force = false) => {
      if (!hasQuery) return
      setLoading(true)
      setError(null)
      setResult(null)
      setTableView(null)
      try {
        const res = await nodeApi.post<DbQueryResult>(`/api/database/${db.name}/query`, {
          query,
          database: selectedDatabase || undefined,
          force,
        })
        setResult(res)
        // Refresh sidebar tables so newly created tables appear immediately
        loadSchema(selectedDatabase || undefined)
      } catch (err: unknown) {
        const apiErr = err as ApiError
        if (apiErr?.status === 422) {
          setShowWarning(true)
        } else {
          setError(apiErr?.message || "Query failed")
          // Refresh sidebar even on error — prior statements may have committed
          loadSchema(selectedDatabase || undefined)
        }
      } finally {
        setLoading(false)
      }
    },
    [query, db.name, selectedDatabase, hasQuery, loadSchema]
  )

  async function loadTablePage(tableName: string, page: number) {
    const q = isRedis ? "KEYS *"
            : isMongo ? `${tableName} {}`
            : `SELECT * FROM ${tableName} LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE};`
    setQuery(q)
    setError(null)
    setResult(null)
    setLoading(true)
    try {
      const res = await nodeApi.post<DbQueryResult>(`/api/database/${db.name}/query`, {
        query: q,
        database: selectedDatabase || undefined,
        force: false,
      })
      setResult(res)
      setTableView(isRedis || isMongo ? null : { table: tableName, page })
    } catch (err: unknown) {
      setError((err as ApiError)?.message || "Query failed")
    } finally {
      setLoading(false)
    }
  }

  function handleTableClick(tableName: string) {
    loadTablePage(tableName, 0)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault()
      runQuery()
    }
  }

  const placeholder = isRedis
    ? "KEYS *\nGET mykey\nSET mykey value"
    : isMongo
    ? "users {\"active\": true}\ncollectionName {}"
    : "SELECT * FROM users LIMIT 100;"

  const isWarn = error ? /already exists|duplicate/i.test(error) : false

  return (
    <>
      <div className="overflow-hidden rounded-lg border bg-card">
        {/* Header / control bar — database + table pickers */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2.5">
          <span className="text-sm font-semibold">{db.name}</span>

          {!isRedis && !isMongo && schema.databases.length > 0 && (
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Database</Label>
              <Select value={selectedDatabase} onValueChange={v => setSelectedDatabase((v as string) ?? "")}>
                <SelectTrigger className="min-w-[120px]" aria-label="Database">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {schema.databases.map(d => (
                    <SelectItem key={d} value={d}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {!isRedis && (
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">{isMongo ? "Collection" : "Table"}</Label>
              <Select
                value=""
                disabled={schema.tables.length === 0}
                onValueChange={v => { if (v) handleTableClick(v as string) }}
              >
                <SelectTrigger className="min-w-[150px]" aria-label={isMongo ? "Collection" : "Table"}>
                  <SelectValue placeholder={schema.tables.length === 0 ? "No tables" : `Select… (${schema.tables.length})`} />
                </SelectTrigger>
                <SelectContent>
                  {schema.tables.map(t => (
                    <SelectItem key={t.name} value={t.name}>
                      {t.name}{t.rows ? ` · ${t.rows.toLocaleString()} rows` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <Pill tone={error && !result ? "bad" : "ok"} dot>{error && !result ? "Error" : "Connected"}</Pill>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close query editor"
            className="ml-auto"
          >
            <X />
          </Button>
        </div>

        {/* Body: terminal-surface editor */}
        <div
          className="m-3 overflow-hidden rounded-xl border border-[var(--t-border)] bg-[var(--t-bg)] text-[var(--t-fg)]"
        >
          <div className="flex items-center gap-2 border-b border-[var(--t-border)] bg-[var(--t-bar)] px-3 py-1.5">
            <span className="font-mono text-xs text-[var(--t-muted)]">
              {db.engine}{selectedDatabase ? ` · ${selectedDatabase}` : ""}
            </span>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              className="text-[var(--t-muted)] hover:bg-[var(--t-hover)] hover:text-[var(--t-fg)]"
              onClick={() => { setQuery(""); setResult(null); setError(null); setTableView(null) }}
            >
              Clear
            </Button>
            <Button size="sm" onClick={() => runQuery()} disabled={loading || !hasQuery}>
              {loading ? <Loader2 className="animate-spin" /> : <Play />}
              {loading ? "Running…" : "Run"}
              <kbd className="ml-1 rounded border border-current/30 px-1 font-mono text-[11px] opacity-80">
                Ctrl ↵
              </kbd>
            </Button>
          </div>
          <Label htmlFor={`query-${db.name}`} className="sr-only">Query</Label>
          <Textarea
            id={`query-${db.name}`}
            ref={textareaRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="block min-h-36 w-full resize-y rounded-none border-0 bg-transparent px-3.5 py-3 font-mono text-[13px] leading-relaxed text-[var(--t-fg)] shadow-none placeholder:text-[var(--t-muted)] focus-visible:ring-0 dark:bg-transparent"
            rows={7}
            spellCheck={false}
          />
          <div className="border-t border-[var(--t-border)] px-3.5 py-1.5 font-mono text-[11px] text-[var(--t-muted)]">
            {isRedis ? "Redis command" : isMongo ? "collection {filter}" : "SQL"}
          </div>
        </div>

        {/* Error / warning banner */}
        {error && (
          <div className="border-t p-3">
            <Alert variant={isWarn ? "default" : "destructive"} className={cn(isWarn && "border-warning/40 bg-warning/10 text-warning")}>
              {isWarn ? <AlertTriangle /> : <XCircle />}
              <AlertDescription className={cn("break-all font-mono text-xs", isWarn && "text-warning")}>
                {error}
                {isWarn && <span className="ml-2 opacity-80">(other statements in the batch may have succeeded)</span>}
              </AlertDescription>
            </Alert>
          </div>
        )}

        {/* Results */}
        {result && <QueryResult result={result} />}

        {/* Table paging — shown when results came from the table picker */}
        {result && tableView && (() => {
          const total = schema.tables.find(t => t.name === tableView.table)?.rows
          const from = tableView.page * PAGE_SIZE + (result.rowCount > 0 ? 1 : 0)
          const to = tableView.page * PAGE_SIZE + result.rowCount
          return (
            <div className="flex flex-wrap items-center gap-2 border-t bg-muted/40 px-3 py-1.5">
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {tableView.table} · rows {from}–{to}{total ? ` of ~${total.toLocaleString()}` : ""}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading || tableView.page === 0}
                  onClick={() => loadTablePage(tableView.table, tableView.page - 1)}
                >
                  <ChevronLeft /> Prev
                </Button>
                <span className="text-xs tabular-nums text-muted-foreground">Page {tableView.page + 1}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading || result.rowCount < PAGE_SIZE}
                  onClick={() => loadTablePage(tableView.table, tableView.page + 1)}
                >
                  Next <ChevronRight />
                </Button>
              </div>
            </div>
          )
        })()}
      </div>

      {/* Destructive query confirmation dialog */}
      <ConfirmDialog
        open={showWarning}
        onOpenChange={setShowWarning}
        icon={AlertTriangle}
        tone="warning"
        title="Run potentially destructive query?"
        description="This query may modify or remove a large amount of data."
        items={[{
          primary: query.length > 90 ? `${query.slice(0, 90)}…` : query,
          secondary: `${db.name}${selectedDatabase ? ` · ${selectedDatabase}` : ""}`,
        }]}
        note={`Detected: ${
          /\bdrop\b/i.test(query) ? "DROP"
          : /\btruncate\b/i.test(query) ? "TRUNCATE"
          : /\bdelete\b/i.test(query) ? "DELETE without WHERE"
          : /\bupdate\b/i.test(query) ? "UPDATE without WHERE"
          : "bulk data change"
        }. This may not be reversible.`}
        confirmLabel="Run anyway"
        onConfirm={() => { setShowWarning(false); runQuery(true) }}
      />
    </>
  )
}
