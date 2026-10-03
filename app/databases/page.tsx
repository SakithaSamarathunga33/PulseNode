"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database as DatabaseIcon,
  Download,
  Gauge,
  HardDrive,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Table2,
  TerminalSquare,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog"
import { nodeApi, API_BASE } from "@/lib/api"
import { copyText } from "@/lib/utils"
import type { CustomConnection, Database, DbMetrics, DbQueryResult, DbSchemaResult } from "@/lib/types"
import { DatabaseQueryEditor, ResultTable } from "@/components/dashboard/DatabaseQueryEditor"
import { DatabaseMetricsPanel } from "@/components/dashboard/DatabaseMetricsPanel"
import { CreateDatabaseModal } from "@/components/dashboard/CreateDatabaseModal"
import { ConnectDatabaseModal } from "@/components/dashboard/ConnectDatabaseModal"
import { DbIcon } from "@/components/dashboard/DbIcon"

type TabId = "overview" | "query" | "metrics"

function TabBtn({ active, onClick, label, icon: Icon }: {
  active: boolean; onClick: () => void; label: string; icon: typeof DatabaseIcon
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
        active
          ? "border-pn-electric text-pn-electric"
          : "border-transparent text-helm-fg3 hover:text-helm-fg"
      }`}
    >
      <Icon size={12} />
      {label}
    </button>
  )
}

const ENGINE_COLOR: Record<string, string> = {
  postgres: "var(--db-postgres)",
  postgresql: "var(--db-postgres)",
  redis: "var(--db-redis)",
  mysql: "var(--db-mysql)",
  clickhouse: "var(--db-clickhouse)",
  mongodb: "var(--db-mongo)",
}

const STATUS_FILTERS = ["all", "ok", "warn", "bad"] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

function engineColor(engine: string) {
  return ENGINE_COLOR[engine.toLowerCase()] ?? "var(--db-other)"
}

function statusTone(state: string) {
  if (state === "ok") return "ok"
  if (state === "warn") return "warn"
  return "bad"
}

// ── Backup modal ──────────────────────────────────────────────────────────────

type BkpPhase = "idle" | "starting" | "dumping" | "done" | "error"
type BkpState = { phase: BkpPhase; jobId: string; bytes: number; error: string; name: string }

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(2)} MB`
}

function BackupModal({ db, onClose }: { db: Database; onClose: () => void }) {
  const [dbs,      setDbs]      = useState<string[]>([])
  const [tables,   setTables]   = useState<string[]>([])
  const [selDb,    setSelDb]    = useState("")
  const [selTable, setSelTable] = useState("")
  const [state,    setState]    = useState<BkpState>({ phase: "idle", jobId: "", bytes: 0, error: "", name: "" })

  useEffect(() => {
    nodeApi.get<DbSchemaResult>(`/api/database/${db.name}/schema`)
      .then(({ data }) => {
        setDbs(data.databases ?? [])
        setTables((data.tables ?? []).map(t => t.name))
      })
      .catch(() => {})
  }, [db.name])

  useEffect(() => {
    if (!state.jobId) return
    let closed = false
    const es = new EventSource(`${API_BASE}/events`)

    type BackupEvent = { jobId: string; phase: string; bytes?: number; error?: string; name?: string }

    const applyUpdate = (d: BackupEvent) => {
      if (d.jobId !== state.jobId) return
      setState(prev => ({ ...prev, phase: d.phase as BkpPhase, bytes: d.bytes ?? prev.bytes, error: d.error ?? "", name: d.name || prev.name }))
      if (d.phase === "done" || d.phase === "error") { closed = true; es.close() }
    }

    es.addEventListener("db:backup", (e: MessageEvent) => {
      try { applyUpdate(JSON.parse(e.data) as BackupEvent) } catch { /* ignore */ }
    })

    // Catch-up poll: job may have completed before SSE connected
    nodeApi.get<BackupEvent>(`/api/database/backup/${state.jobId}`)
      .then(({ data }) => { if (!closed) applyUpdate(data) })
      .catch(() => {})

    return () => { closed = true; es.close() }
  }, [state.jobId])

  const start = async () => {
    setState({ phase: "starting", jobId: "", bytes: 0, error: "", name: "" })
    try {
      const r = await fetch(`${API_BASE}/api/database/${encodeURIComponent(db.name)}/backup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ database: selDb, table: selTable }),
      })
      const d = await r.json()
      if (!r.ok) { setState(prev => ({ ...prev, phase: "error", error: d.error ?? "Failed" })); return }
      setState(prev => ({ ...prev, jobId: d.jobId, name: d.name }))
    } catch (err) { setState(prev => ({ ...prev, phase: "error", error: String(err) })) }
  }

  const download = () => {
    const a = document.createElement("a")
    a.href = `${API_BASE}/api/database/backup/${state.jobId}/download`
    a.download = state.name
    a.click()
  }

  const reset = () => setState({ phase: "idle", jobId: "", bytes: 0, error: "", name: "" })
  const running = state.phase === "starting" || state.phase === "dumping"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs"
      onClick={e => { if (e.target === e.currentTarget && !running) onClose() }}>
      <div className="w-full max-w-md rounded-2xl p-6 space-y-5"
        style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Download size={16} style={{ color: "var(--acc)" }} />
            <h2 className="text-sm font-semibold" style={{ color: "var(--fg)" }}>Backup — {db.name}</h2>
          </div>
          <button onClick={onClose} style={{ color: "var(--fg-3)" }} disabled={running}><X size={16} /></button>
        </div>

        {/* Scope selectors (only when idle) */}
        {state.phase === "idle" && (
          <div className="space-y-3">
            {dbs.length > 1 && (
              <div>
                <label className="text-xs mb-1.5 block font-medium" style={{ color: "var(--fg-3)" }}>Database</label>
                <select value={selDb} onChange={e => { setSelDb(e.target.value); setSelTable("") }}
                  className="w-full px-3 py-2 rounded-lg text-sm outline-hidden"
                  style={{ background: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)" }}>
                  <option value="">All databases</option>
                  {dbs.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            )}
            {tables.length > 0 && db.engine !== "redis" && (
              <div>
                <label className="text-xs mb-1.5 block font-medium" style={{ color: "var(--fg-3)" }}>
                  {db.engine === "mongodb" ? "Collection" : "Table"}
                  <span className="ml-1.5 font-normal" style={{ color: "var(--fg-3)" }}>(optional — all if blank)</span>
                </label>
                <select value={selTable} onChange={e => setSelTable(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-sm outline-hidden"
                  style={{ background: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)" }}>
                  <option value="">All tables</option>
                  {tables.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            )}
            {dbs.length === 0 && tables.length === 0 && (
              <p className="text-xs" style={{ color: "var(--fg-3)" }}>Full database backup will be created.</p>
            )}
          </div>
        )}

        {/* Progress panel */}
        {state.phase !== "idle" && (
          <div className="rounded-xl p-4 space-y-2" style={{ background: "var(--bg-3)", border: "1px solid var(--border)" }}>
            <div className="flex items-center gap-2">
              {running && <RefreshCw size={13} className="animate-spin" style={{ color: "var(--acc)" }} />}
              {state.phase === "done"  && <Check size={13} style={{ color: "var(--ok)" }} />}
              {state.phase === "error" && <X    size={13} style={{ color: "var(--err)" }} />}
              <span className="text-xs font-medium" style={{ color: state.phase === "done" ? "var(--ok)" : state.phase === "error" ? "var(--err)" : "var(--fg)" }}>
                {state.phase === "starting" ? "Preparing…"
                  : state.phase === "dumping" ? "Dumping data…"
                  : state.phase === "done"    ? "Backup complete"
                  :                             "Backup failed"}
              </span>
              {state.bytes > 0 && (
                <span className="ml-auto text-xs tabular-nums" style={{ color: "var(--fg-3)" }}>{fmtBytes(state.bytes)}</span>
              )}
            </div>
            {state.name && <p className="text-xs font-mono truncate" style={{ color: "var(--fg-3)" }}>{state.name}</p>}
            {state.error && <p className="text-xs" style={{ color: "var(--err)" }}>{state.error}</p>}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2">
          {state.phase === "done" ? (
            <>
              <button onClick={download}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium"
                style={{ background: "var(--acc)", color: "#fff" }}>
                <Download size={13} /> Download
              </button>
              <button onClick={reset}
                className="px-4 py-2.5 rounded-lg text-sm"
                style={{ background: "var(--bg-3)", color: "var(--fg-3)", border: "1px solid var(--border)" }}>
                New backup
              </button>
            </>
          ) : state.phase === "error" ? (
            <>
              <button onClick={reset}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium"
                style={{ background: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)" }}>
                Try again
              </button>
              <button onClick={onClose}
                className="px-4 py-2.5 rounded-lg text-sm"
                style={{ background: "var(--bg-3)", color: "var(--fg-3)", border: "1px solid var(--border)" }}>
                Close
              </button>
            </>
          ) : (
            <>
              <button onClick={start} disabled={running}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium disabled:opacity-50"
                style={{ background: "var(--acc)", color: "#fff" }}>
                {running
                  ? <><RefreshCw size={13} className="animate-spin" /> Running…</>
                  : <><Download size={13} /> Start backup</>}
              </button>
              <button onClick={onClose} disabled={running}
                className="px-4 py-2.5 rounded-lg text-sm disabled:opacity-50"
                style={{ background: "var(--bg-3)", color: "var(--fg-3)", border: "1px solid var(--border)" }}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Restore modal ─────────────────────────────────────────────────────────────

function RestoreModal({ db, onClose }: { db: Database; onClose: () => void }) {
  const [dbs,     setDbs]     = useState<string[]>([])
  const [selDb,   setSelDb]   = useState("")
  const [file,    setFile]    = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState("")
  const [output,  setOutput]  = useState("")
  const [done,    setDone]    = useState(false)
  const isRedis = db.engine?.toLowerCase() === "redis"

  useEffect(() => {
    nodeApi.get<DbSchemaResult>(`/api/database/${db.name}/schema`)
      .then(({ data }) => setDbs(data.databases ?? []))
      .catch(() => {})
  }, [db.name])

  const restore = async () => {
    if (!file) return
    setLoading(true); setError(""); setOutput("")
    try {
      const form = new FormData()
      form.append("file", file)
      if (selDb) form.append("database", selDb)
      const r = await fetch(`${API_BASE}/api/database/${encodeURIComponent(db.name)}/restore`, { method: "POST", body: form })
      const d = await r.json()
      if (!r.ok) { setError(d.error + (d.output ? "\n" + d.output : "")); return }
      setOutput(d.output || "Restore complete.")
      setDone(true)
    } catch (err) { setError(String(err)) }
    finally { setLoading(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs"
      onClick={e => { if (e.target === e.currentTarget && !loading) onClose() }}>
      <div className="w-full max-w-md rounded-2xl p-6 space-y-5"
        style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <RotateCcw size={16} style={{ color: "var(--acc)" }} />
            <h2 className="text-sm font-semibold" style={{ color: "var(--fg)" }}>Restore — {db.name}</h2>
          </div>
          <button onClick={onClose} disabled={loading} style={{ color: "var(--fg-3)" }}><X size={16} /></button>
        </div>

        {isRedis && (
          <div className="rounded-lg px-3 py-2.5 text-xs"
            style={{ background: "color-mix(in srgb, var(--warn) 12%, transparent)", color: "var(--warn)", border: "1px solid color-mix(in srgb, var(--warn) 25%, transparent)" }}>
            Redis restore will stop the container, replace dump.rdb, then restart it.
          </div>
        )}

        {!done && (
          <div className="space-y-3">
            {dbs.length > 1 && !isRedis && (
              <div>
                <label className="text-xs mb-1.5 block font-medium" style={{ color: "var(--fg-3)" }}>Target database</label>
                <select value={selDb} onChange={e => setSelDb(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-sm outline-hidden"
                  style={{ background: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)" }}>
                  <option value="">Default database</option>
                  {dbs.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="text-xs mb-1.5 block font-medium" style={{ color: "var(--fg-3)" }}>
                Backup file (.sql · .archive · .rdb)
              </label>
              <input type="file" accept=".sql,.archive,.rdb,.dump,.gz"
                onChange={e => setFile(e.target.files?.[0] ?? null)}
                className="w-full text-xs rounded-lg px-3 py-2 outline-hidden"
                style={{ background: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)" }} />
              {file && (
                <p className="text-xs mt-1" style={{ color: "var(--fg-3)" }}>
                  {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg px-3 py-2.5"
            style={{ background: "color-mix(in srgb, var(--err) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--err) 25%, transparent)" }}>
            <pre className="text-xs whitespace-pre-wrap font-mono" style={{ color: "var(--err)" }}>{error}</pre>
          </div>
        )}

        {done && (
          <div className="rounded-lg px-3 py-2.5 space-y-1"
            style={{ background: "color-mix(in srgb, var(--ok) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--ok) 25%, transparent)" }}>
            <p className="text-xs font-medium flex items-center gap-1.5" style={{ color: "var(--ok)" }}>
              <Check size={12} /> Restore complete
            </p>
            {output && <pre className="text-xs font-mono whitespace-pre-wrap opacity-70 max-h-24 overflow-y-auto" style={{ color: "var(--ok)" }}>{output.slice(0, 400)}</pre>}
          </div>
        )}

        <div className="flex gap-2">
          {done ? (
            <button onClick={onClose}
              className="flex-1 py-2.5 rounded-lg text-sm font-medium"
              style={{ background: "var(--acc)", color: "#fff" }}>
              Done
            </button>
          ) : (
            <>
              <button onClick={restore} disabled={!file || loading}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium disabled:opacity-50"
                style={{ background: "var(--acc)", color: "#fff" }}>
                {loading ? <><RefreshCw size={13} className="animate-spin" /> Restoring…</> : <><RotateCcw size={13} /> Restore</>}
              </button>
              <button onClick={onClose} disabled={loading}
                className="px-4 py-2.5 rounded-lg text-sm disabled:opacity-50"
                style={{ background: "var(--bg-3)", color: "var(--fg-3)", border: "1px solid var(--border)" }}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ConnSpark({ data, color }: { data: number[]; color: string }) {
  const values = data.length > 1 ? data : [0, 0]
  const w = 92
  const h = 28
  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min || 1
  const step = w / (values.length - 1)
  const pts = values.map((v, i) =>
    `${(i * step).toFixed(1)},${(h - 2 - ((v - min) / range) * (h - 4)).toFixed(1)}`
  )
  const d = `M ${pts.join(" L ")}`

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block">
      <path d={`${d} L ${w},${h} L 0,${h} Z`} fill={color} fillOpacity={0.12} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function KpiTile({
  label,
  value,
  icon: Icon,
  tone = "var(--acc)",
  detail,
}: {
  label: string
  value: string | number
  icon: typeof DatabaseIcon
  tone?: string
  detail?: string
}) {
  return (
    <div className="gsap-enter min-w-0 rounded-lg border border-pulseNode-border/10 bg-pulseNode-navyLight px-3 py-2 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-helm-fg3">{label}</span>
        <Icon size={13} style={{ color: tone }} />
      </div>
      <div className="mt-1 flex items-end gap-2">
        <span className="text-lg font-semibold leading-none text-helm-fg">{value}</span>
        {detail && <span className="truncate pb-0.5 text-[10px] text-helm-fg3">{detail}</span>}
      </div>
    </div>
  )
}

function ConnectionStringPanel({ dbName, database }: { dbName: string; database?: string }) {
  const [uri, setUri] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const qs = database ? `?database=${encodeURIComponent(database)}` : ""
    fetch(`${API_BASE}/api/database/${encodeURIComponent(dbName)}/connection-string${qs}`)
      .then(res => res.json())
      .then(data => {
        if (!cancelled) setUri(data.connectionString || null)
      })
      .catch(() => {
        if (!cancelled) setUri(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [dbName, database])

  async function copy() {
    if (!uri) return
    const ok = await copyText(uri)
    if (ok) {
      setCopied(true)
      setCopyFailed(false)
      setTimeout(() => setCopied(false), 1600)
    } else {
      setCopyFailed(true)
      setTimeout(() => setCopyFailed(false), 2600)
    }
  }

  return (
    <div className="rounded-lg border border-pulseNode-border/10 bg-pulseNode-navyLight">
      <div className="flex items-center gap-2 border-b border-pulseNode-border/10 px-3 py-2">
        <PlugZap size={13} className="text-pn-electric" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-helm-fg3">Connection string</span>
      </div>
      <div className="flex items-center gap-2 overflow-hidden px-3 py-2">
        {loading && <span className="text-xs text-helm-fg3">Loading…</span>}
        {!loading && uri && (
          <>
            <div className="min-w-0 flex-1 overflow-x-auto rounded-md border border-pulseNode-border/15 bg-pulseNode-navy">
              <code className="block whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-helm-fg">
                {uri}
              </code>
            </div>
            <button
              onClick={copy}
              className="pn-icon-btn shrink-0"
              title={copyFailed ? "Copy failed — select the text and copy manually" : "Copy"}
              aria-label="Copy connection string"
              style={copyFailed ? { color: "var(--bad)" } : copied ? { color: "var(--ok)" } : undefined}
            >
              {copied ? <Check size={13} /> : copyFailed ? <X size={13} /> : <Copy size={13} />}
            </button>
          </>
        )}
        {!loading && !uri && <span className="text-xs text-red-400">Could not build connection string.</span>}
      </div>
    </div>
  )
}

// ── TableDataModal — read-only data viewer with pagination (100 rows / page) ──

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

function TableDataModal({ db, database, table, onClose }: {
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  // For non-SQL engines, pagination doesn't apply
  const isPaginatable = db.engine !== "redis" && db.engine !== "mongodb"
  const hasNextPage   = isPaginatable && (result?.rowCount ?? 0) >= PAGE_SIZE
  const hasPrevPage   = page > 0
  const rowStart      = page * PAGE_SIZE + 1
  const rowEnd        = page * PAGE_SIZE + (result?.rowCount ?? 0)

  const goNext = () => setPage(p => p + 1)
  const goPrev = () => setPage(p => Math.max(0, p - 1))

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] min-w-[360px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-pulseNode-border/20 bg-pulseNode-navyLight shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-pulseNode-border/10 bg-pulseNode-navy px-5 py-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-pulseNode-border/20 bg-pulseNode-navyLight">
            <Table2 size={16} className="text-pn-electric" />
          </span>
          <div className="min-w-0">
            <div className="truncate font-mono text-sm font-semibold text-helm-fg">{table}</div>
            <div className="truncate text-[10px] text-helm-fg3">{database ? `${database} · ` : ""}{db.name}</div>
          </div>
          {result && (
            <span className="ml-1 rounded bg-pulseNode-border/20 px-1.5 py-0.5 font-mono text-[10px] text-helm-fg3">
              {result.rowCount} row{result.rowCount !== 1 ? "s" : ""} · {result.columns.length} col{result.columns.length !== 1 ? "s" : ""} · {result.durationMs}ms
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {result && result.columns.length > 0 && (
              <button
                onClick={() => exportResultCsv(result, table)}
                className="rounded-md border border-pulseNode-border/20 px-2.5 py-1 text-[11px] text-helm-fg3 transition-colors hover:text-helm-fg"
              >
                Export CSV
              </button>
            )}
            <button
              onClick={onClose}
              aria-label="Close"
              className="pn-icon-btn"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body — sizes to the table's columns (capped), scrolls both axes */}
        <div className="flex min-h-0 flex-col">
          {loading && (
            <div className="flex h-40 min-w-[420px] items-center justify-center text-xs text-helm-fg3">Loading rows…</div>
          )}
          {error && !loading && (
            <div className="m-4 flex min-w-[380px] items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-3">
              <span className="shrink-0 text-red-400">✕</span>
              <p className="break-all font-mono text-xs text-red-400">{error}</p>
            </div>
          )}
          {result && !loading && (
            result.columns.length === 0 ? (
              <div className="flex h-40 min-w-[420px] items-center justify-center text-xs text-helm-fg3">No rows to display.</div>
            ) : (
              <ResultTable result={result} scrollClassName="w-max max-w-[92vw] max-h-[calc(85vh-8rem)]" />
            )
          )}
        </div>

        {/* Pagination footer */}
        {isPaginatable && !error && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-pulseNode-border/10 bg-pulseNode-navy px-4 py-2.5">
            <span className="font-mono text-[11px] text-helm-fg3">
              {loading
                ? "Loading…"
                : result && result.rowCount > 0
                  ? `Rows ${rowStart}–${rowEnd}`
                  : page === 0 ? "No rows" : "No more rows"}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={goPrev}
                disabled={!hasPrevPage || loading}
                aria-label="Previous page"
                className="flex items-center gap-1 rounded-md border border-pulseNode-border/20 px-2.5 py-1 text-[11px] text-helm-fg3 transition-all hover:border-pn-electric/40 hover:text-helm-fg disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft size={12} />
                Prev
              </button>
              <span className="min-w-12 text-center font-mono text-[11px] text-helm-fg3">
                Page {page + 1}
              </span>
              <button
                onClick={goNext}
                disabled={!hasNextPage || loading}
                aria-label="Next page"
                className="flex items-center gap-1 rounded-md border border-pulseNode-border/20 px-2.5 py-1 text-[11px] text-helm-fg3 transition-all hover:border-pn-electric/40 hover:text-helm-fg disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
                <ChevronRight size={12} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── DbDetails — overview: browse all tables, click to view data ───────────────

function DbDetails({ db }: { db: Database }) {
  const [dbs,        setDbs]        = useState<string[]>([])
  const [selectedDb, setSelectedDb] = useState("")
  const [tables,     setTables]     = useState<Array<{ name: string; rows: number }>>([])
  const [loading,    setLoading]    = useState(true)
  const [filter,     setFilter]     = useState("")
  const [openTable,  setOpenTable]  = useState<string | null>(null)

  // Fetch databases list on mount
  useEffect(() => {
    nodeApi.get<DbSchemaResult>(`/api/database/${db.name}/schema`)
      .then(({ data }) => {
        setDbs(data.databases)
        const first = data.databases[0] || ""
        setSelectedDb(first)
        if (data.tables.length) { setTables(data.tables); setLoading(false) }
      })
      .catch(() => setLoading(false))
  }, [db.name])

  // Re-fetch tables when selected DB changes
  useEffect(() => {
    if (!selectedDb) return
    setLoading(true)
    nodeApi.get<DbSchemaResult>(`/api/database/${db.name}/schema?database=${encodeURIComponent(selectedDb)}`)
      .then(({ data }) => setTables(data.tables))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [db.name, selectedDb])

  // Merge size info from Python if available (Python has totalSize/indexSize, schema API has rows)
  const displayTables = tables.map(t => {
    const pyRow = db.tables?.find(p => p.name === t.name)
    return { ...t, totalSize: pyRow?.totalSize, indexSize: pyRow?.indexSize }
  })

  const needle = filter.trim().toLowerCase()
  const visibleTables = needle
    ? displayTables.filter(t => t.name.toLowerCase().includes(needle))
    : displayTables

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(260px,360px)]">
      <div className="space-y-3">
        <div className="rounded-lg border border-pulseNode-border/10 bg-pulseNode-navyLight">
          {/* Header: title, DB selector, count */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-pulseNode-border/10 px-3 py-2">
            <div className="flex items-center gap-2">
              <Table2 size={13} className="text-pn-electric" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-helm-fg3">Tables</span>
            </div>
            <div className="flex items-center gap-2">
              {dbs.length > 1 && (
                <select
                  value={selectedDb}
                  onChange={e => setSelectedDb(e.target.value)}
                  className="cursor-pointer rounded border border-pulseNode-border/20 bg-pulseNode-navy px-1.5 py-0.5 text-[10px] text-helm-fg"
                >
                  {dbs.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              )}
              <span className="font-mono text-[10px] text-helm-fg3">{displayTables.length} objects</span>
            </div>
          </div>

          {/* Filter */}
          {!loading && displayTables.length > 0 && (
            <div className="border-b border-pulseNode-border/10 px-3 py-2">
              <div className="flex items-center gap-2 rounded-md border border-pulseNode-border/15 bg-pulseNode-navy px-2 py-1.5">
                <Search size={12} className="shrink-0 text-helm-fg3" />
                <input
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  placeholder="Filter tables…"
                  className="min-w-0 flex-1 bg-transparent text-xs text-helm-fg outline-hidden placeholder:text-helm-fg3/50"
                />
              </div>
            </div>
          )}

          {loading && <p className="px-3 py-4 text-xs text-helm-fg3">Loading tables…</p>}

          {!loading && visibleTables.length > 0 && (
            <div className="max-h-80 divide-y divide-pulseNode-border/5 overflow-y-auto">
              {visibleTables.map(t => (
                <button
                  key={t.name}
                  onClick={() => setOpenTable(t.name)}
                  className="group flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-pn-electric/5"
                  title={`View data · SELECT * FROM ${t.name} LIMIT 100`}
                >
                  <Table2 size={14} className="shrink-0 text-helm-fg3 group-hover:text-pn-electric" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-helm-fg">{t.name}</span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-helm-fg3">
                    {t.rows.toLocaleString()} rows
                  </span>
                  {t.totalSize && (
                    <span className="hidden shrink-0 font-mono text-[10px] text-helm-fg4 sm:inline">{t.totalSize}</span>
                  )}
                  <ChevronRight size={13} className="shrink-0 text-helm-fg4 opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>
          )}

          {!loading && displayTables.length > 0 && visibleTables.length === 0 && (
            <p className="px-3 py-4 text-xs text-helm-fg3">No tables match “{filter}”.</p>
          )}

          {!loading && displayTables.length === 0 && (
            <p className="px-3 py-4 text-xs text-helm-fg3">
              {db.engine === "redis" ? "Redis has no tables." : "No tables found in this database."}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <ConnectionStringPanel dbName={db.name} database={selectedDb} />
        <div className="rounded-lg border border-pulseNode-border/10 bg-pulseNode-navyLight">
          <div className="flex items-center justify-between border-b border-pulseNode-border/10 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-helm-fg3">Slow queries</span>
            <span className={`font-mono text-[10px] ${db.slow > 0 ? "text-amber-400" : "text-helm-fg3"}`}>
              {db.slow} flagged
            </span>
          </div>
          {db.slowQueries && db.slowQueries.length > 0 ? (
            <div className="max-h-36 overflow-y-auto">
              <table className="pn-table w-full">
                <thead>
                  <tr>
                    <th>Query</th>
                    <th className="right">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {db.slowQueries.map((query, i) => (
                    <tr key={`${query.timestamp}-${i}`}>
                      <td className="mono-cell max-w-[220px] truncate text-amber-400/90" title={query.query}>
                        {query.query}
                      </td>
                      <td className="right dim">{query.duration}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-3 py-4 text-xs text-helm-fg3">No slow queries reported.</p>
          )}
        </div>
      </div>

      {openTable && (
        <TableDataModal
          db={db}
          database={selectedDb}
          table={openTable}
          onClose={() => setOpenTable(null)}
        />
      )}
    </div>
  )
}

// ── DbExpand — tabbed expand area ─────────────────────────────────────────────

function DbExpand({ db, tab, onTabChange }: {
  db: Database
  tab: TabId
  onTabChange: (t: TabId) => void
}) {
  return (
    <div>
      {/* Tab bar */}
      <div className="flex border-b border-pulseNode-border/10 bg-pulseNode-navy/30">
        <TabBtn active={tab === "overview"} onClick={() => onTabChange("overview")} label="Overview" icon={DatabaseIcon} />
        <TabBtn active={tab === "query"}    onClick={() => onTabChange("query")}    label="Query"    icon={TerminalSquare} />
        <TabBtn active={tab === "metrics"}  onClick={() => onTabChange("metrics")}  label="Metrics"  icon={BarChart3} />
      </div>

      {/* Tab content */}
      <div className="p-3">
        {tab === "overview" && (
          <DbDetails db={db} />
        )}
        {tab === "query" && (
          <DatabaseQueryEditor
            db={db}
            initialQuery=""
            onClose={() => onTabChange("overview")}
          />
        )}
        {tab === "metrics" && (
          <DatabaseMetricsPanel db={db} onClose={() => onTabChange("overview")} />
        )}
      </div>
    </div>
  )
}

// ── DeleteDialog ──────────────────────────────────────────────────────────────

function DeleteDialog({ db, onConfirm, onClose }: {
  db: Database; onConfirm: () => void; onClose: () => void
}) {
  return (
    <AlertDialog open onOpenChange={open => { if (!open) onClose() }}>
      <AlertDialogContent className="max-w-sm p-0 overflow-hidden gap-0"
        style={{ background: "var(--card-elev)", border: "1px solid var(--border-2)", color: "var(--fg)" }}>
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-7"
          style={{ background: "var(--bad-soft)" }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: "var(--bad-soft)", border: "2px solid var(--bad)" }}>
            <AlertTriangle size={28} style={{ color: "var(--bad)" }} />
          </div>
          <AlertDialogHeader className="text-center gap-1">
            <AlertDialogTitle className="text-base font-bold" style={{ color: "var(--bad)" }}>
              Delete cluster?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[12px]" style={{ color: "var(--fg-3)" }}>
              This will permanently remove the database container and all its data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
        </div>
        <div className="flex items-center gap-3 px-5 py-3"
          style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", background: "var(--bg-2)" }}>
          <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "var(--bad-soft)", border: "1px solid var(--bad)" }}>
            <Trash2 size={13} style={{ color: "var(--bad)" }} />
          </div>
          <div className="min-w-0">
            <p className="text-[12px] font-semibold truncate" style={{ color: "var(--fg)" }}>{db.name}</p>
            <p className="text-[10px] font-mono truncate" style={{ color: "var(--fg-3)" }}>{db.engine} · {db.host}:{db.port}</p>
          </div>
        </div>
        <AlertDialogFooter className="flex-row gap-3 px-5 py-4 border-0 bg-transparent rounded-none"
          style={{ background: "var(--card-elev)" }}>
          <AlertDialogCancel className="flex-1 py-2 rounded-xl text-sm font-medium transition-colors"
            style={{ background: "var(--bg-3)", border: "1px solid var(--border-2)", color: "var(--fg-2)" }}>
            Cancel
          </AlertDialogCancel>
          <button onClick={() => { onConfirm(); onClose() }}
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-bold text-white transition-opacity hover:opacity-90"
            style={{ background: "var(--bad)" }}>
            <Trash2 size={15} /> Delete
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ── DatabaseRow ───────────────────────────────────────────────────────────────

function DatabaseRow({
  db,
  connHist,
  expanded,
  onExpand,
  onDelete,
  onBackup,
  onRestore,
}: {
  db: Database
  connHist: number[]
  expanded: boolean
  onExpand: () => void
  onDelete: (db: Database) => void
  onBackup: (db: Database) => void
  onRestore: (db: Database) => void
}) {
  const [tab, setTab] = useState<TabId>("overview")

  function openTab(t: TabId) {
    if (!expanded) onExpand()
    setTab(t)
  }

  const color = engineColor(db.engine)
  const connPct = db.maxConns > 0 ? Math.round((db.conns / db.maxConns) * 100) : 0
  const isCoolify = db.name.toLowerCase().includes("coolify")
  const tone = statusTone(db.state)

  return (
    <>
      <tr className={`gsap-enter group ${expanded ? "selected" : ""}`}>
        <td className="w-8 px-3">
          <button
            onClick={onExpand}
            className="pn-icon-btn size-7"
            aria-label={expanded ? `Collapse ${db.name}` : `Expand ${db.name}`}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </td>
        <td className="min-w-[240px]">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="grid size-8 shrink-0 place-items-center rounded-lg border"
              style={{ borderColor: "var(--border)", background: "var(--bg-2)" }}
            >
              <DbIcon engine={db.engine} size={20} />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-semibold text-helm-fg">{db.name}</span>
                {isCoolify && <span className="sev info">Coolify</span>}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-2">
                <span className="font-mono text-[10px] uppercase text-helm-fg3">{db.engine}</span>
                {db.version && <span className="truncate font-mono text-[10px] text-helm-fg4">{db.version}</span>}
              </div>
            </div>
          </div>
        </td>
        <td>
          <span className={`pill ${tone}`}>
            <span className="dot" />
            {db.state}
          </span>
        </td>
        <td className="hidden lg:table-cell">
          <div className="font-mono text-xs text-helm-fg">{db.size}</div>
        </td>
        <td className="min-w-[150px]">
          <div className="flex items-center justify-between gap-2 font-mono text-xs text-helm-fg">
            <span>{db.conns > 0 ? db.conns : "-"}</span>
            <span className="text-helm-fg3">/ {db.maxConns}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-pulseNode-border/10">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(connPct, 100)}%`,
                background: connPct > 85 ? "var(--bad)" : connPct > 65 ? "var(--warn)" : "var(--ok)",
              }}
            />
          </div>
        </td>
        <td className="hidden xl:table-cell">
          <div className="font-mono text-xs text-helm-fg">{db.qps > 0 ? db.qps.toLocaleString() : "-"}</div>
        </td>
        <td className="hidden xl:table-cell">
          {db.slow > 0 ? (
            <span className="inline-flex items-center gap-1 font-mono text-xs text-amber-400">
              <AlertTriangle size={12} />
              {db.slow}
            </span>
          ) : (
            <span className="font-mono text-xs text-helm-fg3">0</span>
          )}
        </td>
        <td className="hidden 2xl:table-cell">
          <code className="block max-w-[210px] truncate font-mono text-[11px] text-helm-fg3">
            {db.host}:{db.port}
          </code>
        </td>
        <td className="hidden md:table-cell">
          <ConnSpark data={connHist} color={color} />
        </td>
        <td className="right sticky right-0 z-10 min-w-[220px] bg-pulseNode-navyLight shadow-[-12px_0_18px_-18px_rgba(0,0,0,0.55)]">
          <div className="flex justify-end gap-1.5">
            <button
              onClick={() => openTab("query")}
              className={`pn-btn px-2.5 py-1.5 ${expanded && tab === "query" ? "border-pn-electric/40 bg-pn-electric/10 text-pn-electric" : ""}`}
            >
              <TerminalSquare size={13} />
              Query
            </button>
            <button
              onClick={() => openTab("metrics")}
              className={`pn-btn px-2.5 py-1.5 ${expanded && tab === "metrics" ? "border-pn-electric/40 bg-pn-electric/10 text-pn-electric" : ""}`}
            >
              <BarChart3 size={13} />
              Metrics
            </button>
            <button onClick={() => onBackup(db)} className="pn-icon-btn" title="Backup" aria-label={`Backup ${db.name}`}>
              <Download size={13} />
            </button>
            <button onClick={() => onRestore(db)} className="pn-icon-btn" title="Restore" aria-label={`Restore ${db.name}`}>
              <Upload size={13} />
            </button>
            <button
              onClick={() => onDelete(db)}
              className="pn-icon-btn"
              title="Delete cluster"
              aria-label={`Delete ${db.name}`}
              style={{ color: "var(--bad)" }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={10} className="bg-pulseNode-navy p-0">
            <DbExpand db={db} tab={tab} onTabChange={setTab} />
          </td>
        </tr>
      )}
    </>
  )
}

export default function DatabasesPage() {
  const container = useRef<HTMLDivElement>(null)
  const [databases, setDatabases] = useState<Database[]>([])
  const [connHist, setConnHist] = useState<Record<string, number[]>>({})
  const [totalConns, setTotalConns] = useState(0)
  const [connHistory, setConnHistory] = useState<number[]>([0])
  const [expandedDb, setExpandedDb] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Database | null>(null)
  const [backupDb,    setBackupDb]    = useState<Database | null>(null)
  const [restoreDb,   setRestoreDb]   = useState<Database | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showConnect, setShowConnect] = useState(false)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")

  useEffect(() => {
    nodeApi.get<Database[]>("/api/docker/databases")
      .then(({ data }) => {
        if (data.length === 0) return
        setDatabases(data)

        data.forEach(db => {
          nodeApi.get<DbMetrics>(`/api/database/${db.name}/metrics`)
            .then(({ data: metrics }) => {
              const get = (label: string) => metrics.metrics.find(x => x.label === label)?.value
              // Labels from Go metrics handler — must match exactly
              const size = get("DB Size") || get("Used Memory") || get("Resident Mem")
              const conns = Number(
                get("Active Connections") ||
                get("Total Connections") ||
                get("Connections") ||
                get("Clients") ||
                0
              )
              const qps = Number(get("QPS (avg)") || 0)
              setDatabases(prev => prev.map(d => {
                if (d.name !== db.name) return d
                return {
                  ...d,
                  size: d.size === "-" && size ? String(size) : d.size,
                  conns: d.conns === 0 && conns > 0 ? conns : d.conns,
                  qps:   d.qps  === 0 && qps  > 0 ? qps  : d.qps,
                }
              }))
            })
            .catch(() => {})
        })
      })
      .catch(() => {})

    function pollConnections() {
      nodeApi.get<{ name: string; conns: number }[]>("/api/database/connections")
        .then(({ data }) => {
          const total = data.reduce((s, d) => s + d.conns, 0)
          setTotalConns(total)
          setConnHistory(prev => [...prev.slice(-59), total])
          setConnHist(prev => {
            const next = { ...prev }
            for (const d of data) {
              const h = next[d.name] ?? []
              next[d.name] = [...h.slice(-19), d.conns]
            }
            setDatabases(dbs => dbs.map(db => {
              const found = data.find(d => d.name === db.name || d.name === db.host)
              return found && found.conns > 0 ? { ...db, conns: found.conns } : db
            }))
            return next
          })
        })
        .catch(() => {})
    }

    pollConnections()
    const timer = setInterval(() => { if (!document.hidden) pollConnections() }, 10000)
    return () => clearInterval(timer)
  }, [])

  useGSAP(() => {
    gsap.from(".gsap-enter", {
      y: 10,
      opacity: 0,
      duration: 0.35,
      stagger: 0.035,
      ease: "power2.out",
    })
  }, { scope: container })

  const totalQps = databases.reduce((s, d) => s + d.qps, 0)
  const totalSlow = databases.reduce((s, d) => s + d.slow, 0)
  const unhealthy = databases.filter(d => d.state !== "ok").length

  const filteredDatabases = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return databases.filter(db => {
      const matchesStatus = statusFilter === "all" || db.state === statusFilter
      const matchesSearch =
        !needle ||
        db.name.toLowerCase().includes(needle) ||
        db.engine.toLowerCase().includes(needle) ||
        db.host.toLowerCase().includes(needle)
      return matchesStatus && matchesSearch
    })
  }, [databases, search, statusFilter])

  return (
    <div ref={container} className="p-4 sm:p-6">
      <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-helm-fg">Databases</h1>
            <span className="live">Live</span>
          </div>
          <p className="mt-1 text-sm text-helm-fg3">
            {databases.length} databases · {totalConns} connections
            {totalQps > 0 && ` · ${totalQps.toLocaleString()} QPS`}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button onClick={() => setShowCreate(true)} className="pn-btn">
            <Plus size={13} />
            Create database
          </button>
          <button onClick={() => setShowConnect(true)} className="pn-btn-primary">
            <PlugZap size={13} />
            Connect database
          </button>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiTile label="Databases" value={databases.length} icon={DatabaseIcon} />
        <KpiTile label="Connections" value={totalConns} icon={Activity} detail={`${Math.max(...connHistory)} peak`} tone="var(--ok)" />
        <KpiTile label="Queries/sec" value={totalQps > 0 ? totalQps.toLocaleString() : "-"} icon={Gauge} tone="var(--info)" />
        <KpiTile label="Slow queries" value={totalSlow} icon={AlertTriangle} tone={totalSlow > 0 ? "var(--warn)" : "var(--ok)"} detail={unhealthy > 0 ? `${unhealthy} attention` : "healthy"} />
      </div>

      <div className="pn-card overflow-hidden rounded-lg">
        <div className="flex flex-col gap-3 border-b border-pulseNode-border/10 bg-pulseNode-navyLight px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <div className="pn-search">
              <Search size={13} className="text-helm-fg3" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search databases, engines, hosts"
              />
            </div>
            <div className="flex rounded-lg border border-pulseNode-border/10 bg-pulseNode-navy p-1">
              {STATUS_FILTERS.map(filter => (
                <button
                  key={filter}
                  onClick={() => setStatusFilter(filter)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                    statusFilter === filter
                      ? "bg-pulseNode-navyLight text-helm-fg shadow-xs"
                      : "text-helm-fg3 hover:text-helm-fg"
                  }`}
                >
                  {filter}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="pn-chip">
              <span className="label">Rows</span>
              <span className="value">{filteredDatabases.length}</span>
            </span>
            <span className="pn-chip">
              <span className="label">Storage</span>
              <span className="value"><HardDrive size={12} className="inline" /> tracked</span>
            </span>
          </div>
        </div>

        {databases.length === 0 ? (
          <div className="flex min-h-[280px] items-center justify-center px-4 text-center">
            <div>
              <DatabaseIcon size={28} className="mx-auto mb-3 text-helm-fg3" />
              <p className="text-sm font-medium text-helm-fg">Loading database containers</p>
              <p className="mt-1 text-xs text-helm-fg3">Detected databases and external connections will appear here.</p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="pn-table min-w-[1120px]">
              <thead>
                <tr>
                  <th className="w-8"></th>
                  <th>Database</th>
                  <th>State</th>
                  <th className="hidden lg:table-cell">Size</th>
                  <th>Connections</th>
                  <th className="hidden xl:table-cell">QPS</th>
                  <th className="hidden xl:table-cell">Slow</th>
                  <th className="hidden 2xl:table-cell">Endpoint</th>
                  <th className="hidden md:table-cell">Activity</th>
                  <th className="right sticky right-0 z-10 bg-pulseNode-navyLight shadow-[-12px_0_18px_-18px_rgba(0,0,0,0.55)]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredDatabases.map(db => (
                  <DatabaseRow
                    key={db.name}
                    db={db}
                    connHist={connHist[db.name] ?? connHist[db.host] ?? []}
                    expanded={expandedDb === db.name}
                    onExpand={() => setExpandedDb(prev => prev === db.name ? null : db.name)}
                    onDelete={setDeleteTarget}
                    onBackup={setBackupDb}
                    onRestore={setRestoreDb}
                  />
                ))}
              </tbody>
            </table>
            {filteredDatabases.length === 0 && (
              <div className="border-t border-pulseNode-border/10 px-4 py-10 text-center text-sm text-helm-fg3">
                No databases match the current filters.
              </div>
            )}
          </div>
        )}
      </div>

      {backupDb  && <BackupModal  db={backupDb}  onClose={() => setBackupDb(null)}  />}
      {restoreDb && <RestoreModal db={restoreDb} onClose={() => setRestoreDb(null)} />}

      {showCreate && (
        <CreateDatabaseModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            nodeApi.get<Database[]>("/api/docker/databases")
              .then(({ data }) => { if (data.length > 0) setDatabases(data) })
              .catch(() => {})
          }}
        />
      )}

      {showConnect && (
        <ConnectDatabaseModal
          onClose={() => setShowConnect(false)}
          onSaved={(conn: CustomConnection) => {
            setDatabases(prev => [
              ...prev.filter(d => d.name !== conn.name),
              {
                name: conn.name || `${conn.engine} @ ${conn.host}`,
                engine: conn.engine,
                version: conn.version || "",
                host: conn.host,
                port: conn.port,
                size: "-",
                conns: 0,
                maxConns: 100,
                qps: 0,
                slow: 0,
                state: "ok",
              },
            ])
            setShowConnect(false)
          }}
        />
      )}

      {deleteTarget && (
        <DeleteDialog
          db={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            const id = deleteTarget.containerId ?? deleteTarget.name
            nodeApi.delete(`/api/docker/remove/${id}`)
              .then(() => setDatabases(prev => prev.filter(d => d.name !== deleteTarget.name)))
              .catch(() => {})
          }}
        />
      )}
    </div>
  )
}
