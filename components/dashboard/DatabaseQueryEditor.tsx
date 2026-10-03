"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Maximize2, Play, X } from "lucide-react"
import { nodeApi } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import type { ApiError } from "@/lib/api"
import type { Database, DbSchemaResult, DbQueryResult } from "@/lib/types"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"

// ── ResultTable ───────────────────────────────────────────────────────────────

export function ResultTable({ result, fullscreen = false, scrollClassName }: { result: DbQueryResult; fullscreen?: boolean; scrollClassName?: string }) {
  const scroll = scrollClassName ?? (fullscreen ? "max-h-[calc(100vh-120px)]" : "max-h-64")
  return (
    <div className={`overflow-auto ${scroll}`}>
      <table className="text-[11px] border-collapse" style={{ tableLayout: "auto", whiteSpace: "nowrap" }}>
        <thead>
          <tr className="bg-pulseNode-navyLight sticky top-0 z-10">
            {result.columns.map(c => (
              <th
                key={c}
                className="px-3 py-1.5 text-left text-helm-fg3 font-semibold border-b border-r border-pulseNode-border/10 last:border-r-0 bg-pulseNode-navyLight"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className={`border-b border-pulseNode-border/5 ${i % 2 === 0 ? "" : "bg-pulseNode-border/[0.03]"} hover:bg-pn-electric/5`}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`px-3 py-1.5 font-mono text-helm-fg border-r border-pulseNode-border/5 last:border-r-0 ${fullscreen ? "max-w-[480px]" : "max-w-[200px]"}`}
                  title={cell == null ? "null" : String(cell)}
                >
                  {cell == null
                    ? <span className="text-helm-fg3/50 italic text-[10px]">null</span>
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

  // DDL / non-returning statement
  if (isDdl) return (
    <div className="border-t border-pulseNode-border/10 px-4 py-3 flex items-center gap-2 bg-emerald-500/5">
      <span className="text-emerald-400 text-base">✓</span>
      <span className="text-xs text-emerald-400 font-medium">Query executed successfully</span>
      <span className="text-[10px] text-helm-fg3 ml-auto">{result.durationMs}ms</span>
    </div>
  )

  // INSERT / UPDATE / DELETE with affected rows
  if (isDml) return (
    <div className="border-t border-pulseNode-border/10 px-4 py-3 flex items-center gap-2 bg-emerald-500/5">
      <span className="text-emerald-400 text-base">✓</span>
      <span className="text-xs text-emerald-400 font-medium">
        {result.rowCount} row{result.rowCount !== 1 ? "s" : ""} affected
      </span>
      <span className="text-[10px] text-helm-fg3 ml-auto">{result.durationMs}ms</span>
    </div>
  )

  const toolbar = (fullscreen: boolean) => (
    <div className={`flex items-center gap-2 px-3 py-1.5 border-b border-pulseNode-border/10 ${fullscreen ? "bg-pulseNode-navy" : "bg-pulseNode-navy/50"}`}>
      <span className="text-[10px] text-green-400">
        {result.rowCount} row{result.rowCount !== 1 ? "s" : ""}
      </span>
      <span className="text-pulseNode-border/30">·</span>
      <span className="text-[10px] text-helm-fg3">{result.durationMs}ms</span>
      <span className="text-pulseNode-border/30">·</span>
      <span className="text-[10px] text-helm-fg3">{result.columns.length} col{result.columns.length !== 1 ? "s" : ""}</span>
      <div className="ml-auto flex items-center gap-2">
        <button onClick={exportCsv} className="text-[10px] text-helm-fg3 hover:text-helm-fg transition-colors">
          Export CSV
        </button>
        {!fullscreen && (
          <button
            onClick={() => setExpanded(true)}
            title="Expand to full screen"
            className="flex items-center gap-1 text-[10px] text-helm-fg3 hover:text-pn-electric transition-colors"
          >
            <Maximize2 size={11} />
            <span>Expand</span>
          </button>
        )}
      </div>
    </div>
  )

  return (
    <>
      {/* Inline result (compact) */}
      <div className="border-t border-pulseNode-border/10">
        {toolbar(false)}
        <ResultTable result={result} />
      </div>

      {/* Fullscreen modal */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-pulseNode-navy/95 backdrop-blur-xs"
          onKeyDown={e => e.key === "Escape" && setExpanded(false)}
          tabIndex={-1}
        >
          {/* Modal header */}
          <div className="flex items-center gap-3 px-5 py-3 border-b border-pulseNode-border/20 bg-pulseNode-navyLight shrink-0">
            <span className="text-sm font-semibold text-helm-fg">Query Results</span>
            <span className="text-[10px] text-helm-fg3 bg-pulseNode-border/20 rounded px-1.5 py-0.5">
              {result.rowCount} rows · {result.columns.length} columns · {result.durationMs}ms
            </span>
            <div className="ml-auto flex items-center gap-3">
              <button onClick={exportCsv} className="text-xs text-helm-fg3 hover:text-helm-fg transition-colors">
                Export CSV
              </button>
              <button
                onClick={() => setExpanded(false)}
                className="flex items-center gap-1.5 text-xs text-helm-fg3 hover:text-helm-fg transition-colors"
              >
                <X size={14} />
                Close
              </button>
            </div>
          </div>

          {/* Full table */}
          <div className="flex-1 overflow-auto p-4">
            <div className="rounded-lg border border-pulseNode-border/20 overflow-hidden">
              <ResultTable result={result} fullscreen />
            </div>
          </div>
        </div>
      )}
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

  function loadSchema(dbName?: string) {
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
  }

  // Load database list on mount
  useEffect(() => { loadSchema() }, [db.name]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reload table list when selected database changes
  useEffect(() => {
    if (!selectedDatabase) return
    loadSchema(selectedDatabase)
    setTableView(null)
  }, [db.name, selectedDatabase]) // eslint-disable-line react-hooks/exhaustive-deps

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
    [query, db.name, selectedDatabase, hasQuery] // eslint-disable-line react-hooks/exhaustive-deps
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

  return (
    <>
      <div className="bg-pulseNode-navyLight rounded-lg border border-pulseNode-border/10 overflow-hidden">
        {/* Header / control bar — database + table pickers */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-pulseNode-border/10">
          <span className="font-semibold text-sm text-helm-fg">{db.name}</span>

          {!isRedis && !isMongo && schema.databases.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-helm-fg3">DB</span>
              <Select value={selectedDatabase} onValueChange={v => setSelectedDatabase((v as string) ?? "")}>
                <SelectTrigger className="min-w-[120px]">
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
              <span className="text-[10px] font-semibold uppercase tracking-wider text-helm-fg3">
                {isMongo ? "Collection" : "Table"}
              </span>
              <Select
                value=""
                disabled={schema.tables.length === 0}
                onValueChange={v => { if (v) handleTableClick(v as string) }}
              >
                <SelectTrigger className="min-w-[150px]">
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

          <span className={`text-[10px] ${error && !result ? "text-red-400" : "text-green-400"}`}>
            {error && !result ? "● error" : "● connected"}
          </span>
          <button
            onClick={onClose}
            aria-label="Close query editor"
            className="ml-auto text-helm-fg3 hover:text-helm-fg text-sm transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Body: full-width editor */}
        <div className="flex flex-col h-72">
          <textarea
            ref={textareaRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1 bg-pulseNode-navy font-mono text-xs text-helm-fg p-3 resize-none outline-hidden placeholder:text-helm-fg3/40 min-h-0"
            spellCheck={false}
          />
          {/* Toolbar */}
          <div className="flex items-center gap-2 px-3 py-2 border-t border-pulseNode-border/10 shrink-0">
            <Button size="sm" onClick={() => runQuery()} disabled={loading || !hasQuery}>
              <Play size={13} />
              {loading ? "Running…" : "Run"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setQuery(""); setResult(null); setError(null); setTableView(null) }}
            >
              Clear
            </Button>
            <span className="ml-auto text-[10px] text-helm-fg3">
              {isRedis
                ? "Redis command"
                : isMongo
                ? "collection {filter}"
                : "Ctrl+↵ to run"}
            </span>
          </div>
        </div>

        {/* Error / warning banner */}
        {error && (() => {
          const isWarn = /already exists|duplicate/i.test(error)
          return (
            <div className={`px-4 py-2.5 border-t flex items-start gap-2 ${
              isWarn
                ? "bg-amber-500/10 border-amber-500/20"
                : "bg-red-500/10 border-red-500/20"
            }`}>
              <span className={`shrink-0 mt-0.5 ${isWarn ? "text-amber-400" : "text-red-400"}`}>
                {isWarn ? "⚠" : "✕"}
              </span>
              <p className={`text-xs font-mono break-all ${isWarn ? "text-amber-400" : "text-red-400"}`}>
                {error}
                {isWarn && <span className="ml-2 not-italic opacity-70">(other statements in the batch may have succeeded)</span>}
              </p>
            </div>
          )
        })()}

        {/* Results */}
        {result && <QueryResult result={result} />}

        {/* Table paging — shown when results came from the table picker */}
        {result && tableView && (() => {
          const total = schema.tables.find(t => t.name === tableView.table)?.rows
          const from = tableView.page * PAGE_SIZE + (result.rowCount > 0 ? 1 : 0)
          const to = tableView.page * PAGE_SIZE + result.rowCount
          return (
            <div className="flex items-center gap-2 px-3 py-1.5 border-t border-pulseNode-border/10 bg-pulseNode-navy/50">
              <span className="text-[10px] text-helm-fg3">
                {tableView.table} · rows {from}–{to}{total ? ` of ~${total.toLocaleString()}` : ""}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading || tableView.page === 0}
                  onClick={() => loadTablePage(tableView.table, tableView.page - 1)}
                >
                  ← Prev
                </Button>
                <span className="text-[10px] text-helm-fg3">Page {tableView.page + 1}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading || result.rowCount < PAGE_SIZE}
                  onClick={() => loadTablePage(tableView.table, tableView.page + 1)}
                >
                  Next →
                </Button>
              </div>
            </div>
          )
        })()}
      </div>

      {/* Destructive query confirmation dialog */}
      <AlertDialog open={showWarning} onOpenChange={setShowWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Destructive query detected</AlertDialogTitle>
            <AlertDialogDescription>
              This query may permanently delete or modify data (DROP, TRUNCATE, or DELETE/UPDATE without WHERE). Are you sure you want to run it?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setShowWarning(false); runQuery(true) }}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              Run anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
