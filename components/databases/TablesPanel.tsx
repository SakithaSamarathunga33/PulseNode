"use client"

import { useTimeouts } from "@/lib/use-timeouts"
import { useEffect, useState } from "react"
import { Check, ChevronRight, Copy, PlugZap, Table2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SearchInput } from "@/components/pn/SearchInput"
import { Pill } from "@/components/dashboard/Pill"
import { nodeApi, API_BASE } from "@/lib/api"
import { copyText } from "@/lib/utils"
import type { Database, DbSchemaResult } from "@/lib/types"
import { TableDataDialog } from "./TableDataDialog"

function ConnectionStringPanel({ dbName, database }: { dbName: string; database?: string }) {
  const [uri, setUri] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const later = useTimeouts()

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
      later(() => setCopied(false), 1600)
    } else {
      setCopyFailed(true)
      later(() => setCopyFailed(false), 2600)
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <PlugZap className="size-4 text-[var(--hue)]" /> Connection string
        </CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-2">
        {loading && <Skeleton className="h-8 w-full" />}
        {!loading && uri && (
          <>
            <div className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/40">
              <code className="block whitespace-nowrap px-2 py-1.5 font-mono text-xs">{uri}</code>
            </div>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={copy}
              aria-label="Copy connection string"
              title={copyFailed ? "Copy failed — select the text and copy manually" : "Copy"}
              className={copyFailed ? "text-danger" : copied ? "text-success" : undefined}
            >
              {copied ? <Check /> : copyFailed ? <X /> : <Copy />}
            </Button>
          </>
        )}
        {!loading && !uri && <span className="text-sm text-danger">Could not build connection string.</span>}
      </CardContent>
    </Card>
  )
}

/** Overview tab: browse all tables (click to view data), connection string and slow queries. */
export function TablesPanel({ db }: { db: Database }) {
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
        else if (!first) setLoading(false)
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
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(260px,380px)]">
      <Card size="sm" className="min-w-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Table2 className="size-4 text-[var(--hue)]" /> Tables
            <span className="font-mono text-xs font-normal tabular-nums text-muted-foreground">{displayTables.length} objects</span>
          </CardTitle>
          {dbs.length > 1 && (
            <CardAction>
              <Select
                value={selectedDb}
                onValueChange={v => setSelectedDb(v as string)}
                items={dbs.map(d => ({ value: d, label: d }))}
              >
                <SelectTrigger size="sm" aria-label="Database" className="min-w-[120px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {dbs.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {!loading && displayTables.length > 0 && (
            <SearchInput
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter tables…"
              aria-label="Filter tables"
              className="max-w-none"
            />
          )}

          {loading && (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          )}

          {!loading && visibleTables.length > 0 && (
            <div className="max-h-80 overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Size</TableHead>
                    <TableHead className="w-8"><span className="sr-only">Open</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleTables.map(t => (
                    <TableRow key={t.name} className="cursor-pointer" onClick={() => setOpenTable(t.name)}>
                      <TableCell className="max-w-[260px]">
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setOpenTable(t.name) }}
                          title={`View data · SELECT * FROM ${t.name} LIMIT 100`}
                          className="block max-w-full truncate rounded-sm text-left font-mono text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          {t.name}
                        </button>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{t.rows.toLocaleString()}</TableCell>
                      <TableCell className="hidden text-right font-mono text-xs tabular-nums text-muted-foreground sm:table-cell">{t.totalSize ?? "-"}</TableCell>
                      <TableCell><ChevronRight className="size-3.5 text-muted-foreground" aria-hidden /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {!loading && displayTables.length > 0 && visibleTables.length === 0 && (
            <p className="py-3 text-sm text-muted-foreground">No tables match “{filter}”.</p>
          )}

          {!loading && displayTables.length === 0 && (
            <p className="py-3 text-sm text-muted-foreground">
              {db.engine === "redis" ? "Redis has no tables." : "No tables found in this database."}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="min-w-0 space-y-3">
        <ConnectionStringPanel dbName={db.name} database={selectedDb} />
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Slow queries</CardTitle>
            <CardAction>
              <Pill tone={db.slow > 0 ? "warn" : "outline"}>{db.slow} flagged</Pill>
            </CardAction>
          </CardHeader>
          <CardContent>
            {db.slowQueries && db.slowQueries.length > 0 ? (
              <div className="max-h-40 overflow-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Query</TableHead>
                      <TableHead className="text-right">Duration</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {db.slowQueries.map((query, i) => (
                      <TableRow key={`${query.timestamp}-${i}`}>
                        <TableCell className="max-w-[220px] truncate font-mono text-xs" title={query.query}>
                          {query.query}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">{query.duration}ms</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No slow queries reported.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {openTable && (
        <TableDataDialog
          db={db}
          database={selectedDb}
          table={openTable}
          onClose={() => setOpenTable(null)}
        />
      )}
    </div>
  )
}
