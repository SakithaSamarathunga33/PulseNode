"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Activity, Clock, Database as DatabaseIcon, Link2, PlugZap, Plus, Search, SearchX, XCircle } from "lucide-react"
import { toast } from "sonner"
import { nodeApi } from "@/lib/api"
import type { CustomConnection, Database, DbMetrics } from "@/lib/types"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { PageBody, PageHeader } from "@/components/pn/PageHeader"
import { LiveBadge } from "@/components/pn/LiveBadge"
import { SummaryStrip } from "@/components/pn/SummaryStrip"
import { Input } from "@/components/ui/input"
import { Segmented } from "@/components/pn/Segmented"
import { EmptyState } from "@/components/pn/EmptyState"
import { CreateDatabaseModal } from "@/components/dashboard/CreateDatabaseModal"
import { ConnectDatabaseModal } from "@/components/dashboard/ConnectDatabaseModal"
import { DatabaseCards, DatabaseTable, type Sort, type SortKey } from "@/components/databases/DatabaseTable"
import { BackupDialog } from "@/components/databases/BackupDialog"
import { RestoreDialog } from "@/components/databases/RestoreDialog"
import { DeleteDialog } from "@/components/databases/DeleteDialog"
import { statusTone } from "@/components/databases/shared"

type StatusFilter = "all" | "ok" | "warn" | "bad"

export default function DatabasesPage() {
  const [databases, setDatabases] = useState<Database[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
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
  const [sort, setSort] = useState<Sort>({ key: "name", dir: 1 })
  const searchRef = useRef<HTMLInputElement>(null)

  // "/" focuses the search box (unless you are already typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    nodeApi.get<Database[]>("/api/docker/databases")
      .then(({ data: raw }) => {
        const data = Array.isArray(raw) ? raw : []
        // An empty list must clear stale rows, not leave them on screen.
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
      .catch(err => setLoadError(err instanceof Error ? err.message : "Failed to load databases"))
      .finally(() => setLoaded(true))

    let inFlight = false
    function pollConnections() {
      if (inFlight) return // a slow backend must not stack overlapping polls
      inFlight = true
      nodeApi.get<{ name: string; conns: number }[]>("/api/database/connections")
        .then(({ data: raw }) => {
          const data = Array.isArray(raw) ? raw : []
          const total = data.reduce((s, d) => s + d.conns, 0)
          setTotalConns(total)
          setConnHistory(prev => [...prev.slice(-59), total])
          setConnHist(prev => {
            const next = { ...prev }
            for (const d of data) {
              const h = next[d.name] ?? []
              next[d.name] = [...h.slice(-19), d.conns]
            }
            return next
          })
          // Separate, pure update — never call a setter inside another updater.
          setDatabases(dbs => dbs.map(db => {
            const found = data.find(d => d.name === db.name || d.name === db.host)
            return found && found.conns > 0 ? { ...db, conns: found.conns } : db
          }))
        })
        .catch(() => {})
        .finally(() => { inFlight = false })
    }

    pollConnections()
    const timer = setInterval(() => { if (!document.hidden) pollConnections() }, 10000)
    return () => clearInterval(timer)
  }, [])

  const totalQps = databases.reduce((s, d) => s + d.qps, 0)
  const totalSlow = databases.reduce((s, d) => s + d.slow, 0)
  const unhealthy = databases.filter(d => d.state !== "ok").length

  const counts = useMemo(() => ({
    all: databases.length,
    ok: databases.filter(d => statusTone(d.state) === "ok").length,
    warn: databases.filter(d => statusTone(d.state) === "warn").length,
    bad: databases.filter(d => statusTone(d.state) === "bad").length,
  }), [databases])

  const filteredDatabases = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const list = databases.filter(db => {
      const matchesStatus = statusFilter === "all" || statusTone(db.state) === statusFilter
      const matchesSearch =
        !needle ||
        db.name.toLowerCase().includes(needle) ||
        db.engine.toLowerCase().includes(needle) ||
        db.host.toLowerCase().includes(needle)
      return matchesStatus && matchesSearch
    })
    const rank = { ok: 0, warn: 1, bad: 2 } as const
    const val: Record<SortKey, (d: Database) => string | number> = {
      name: d => d.name.toLowerCase(), engine: d => d.engine, state: d => rank[statusTone(d.state)],
      conns: d => d.conns, qps: d => d.qps, slow: d => d.slow,
    }
    return list.sort((a, b) => {
      const x = val[sort.key](a), y = val[sort.key](b)
      return (x > y ? 1 : x < y ? -1 : 0) * sort.dir
    })
  }, [databases, search, statusFilter, sort])

  const onSort = (key: SortKey) =>
    setSort(prev => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: key === "name" || key === "engine" ? 1 : -1 }))


  const handlers = { onDelete: setDeleteTarget, onBackup: setBackupDb, onRestore: setRestoreDb }

  const addActions = (
    <>
      <Button variant="outline" onClick={() => setShowConnect(true)}>
        <PlugZap /> Connect database
      </Button>
      <Button onClick={() => setShowCreate(true)}>
        <Plus /> Create database
      </Button>
    </>
  )

  return (
    <>
      <PageHeader
        icon={DatabaseIcon}
        title={<span className="flex items-center gap-3">Databases <LiveBadge>Live · 10s</LiveBadge></span>}
        description={`${databases.length} databases · ${totalConns} connections${totalQps > 0 ? ` · ${totalQps.toLocaleString()} QPS` : ""}`}
        actions={addActions}
      />
      <PageBody className="motion-safe:animate-in motion-safe:fade-in-0 duration-300">
        <SummaryStrip
          items={[
            { label: "Databases", icon: DatabaseIcon, value: databases.length, meta: `${databases.length - unhealthy} healthy${unhealthy > 0 ? ` · ${unhealthy} need attention` : ""}`, tone: unhealthy > 0 ? "warn" : undefined },
            { label: "Connections", icon: Link2, value: totalConns, unit: "open", meta: `${Math.max(...connHistory)} peak this session` },
            { label: "Queries/sec", icon: Activity, value: totalQps > 0 ? totalQps.toLocaleString() : "—", meta: "across all engines" },
            { label: "Slow queries", icon: Clock, value: totalSlow, meta: totalSlow === 0 ? "none reported" : "flagged by engines", tone: totalSlow > 0 ? "warn" : "ok" },
          ]}
        />

        {!loaded ? (
          <Card className="gap-3 p-4">
            <Skeleton className="h-8 w-64" />
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
          </Card>
        ) : databases.length === 0 ? (
          loadError ? (
            <Alert variant="destructive">
              <XCircle />
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          ) : (
            <EmptyState
              icon={DatabaseIcon}
              title="No databases yet"
              description="Detected database containers and external connections will appear here. Create a new database or connect an existing one."
              action={addActions}
            />
          )
        ) : (
          <Card className="gap-0 overflow-hidden py-0">
            <div className="flex flex-wrap items-center gap-2 border-b p-3">
              <label className="relative flex w-[min(300px,100%)] items-center">
                <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
                <Input
                  ref={searchRef}
                  type="search"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  aria-label="Search databases by name, engine or host"
                  placeholder="Search name, engine or host"
                  className="pr-8 pl-8"
                />
                <kbd className="pointer-events-none absolute right-2 hidden sm:inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border bg-muted px-1 font-mono text-[11px] text-muted-foreground">/</kbd>
              </label>
              <Segmented
                aria-label="Filter by state"
                value={statusFilter}
                onChange={setStatusFilter}
                options={[
                  { value: "all", label: "All", count: counts.all },
                  { value: "ok", label: "OK", count: counts.ok },
                  { value: "warn", label: "Warn", count: counts.warn },
                  { value: "bad", label: "Error", count: counts.bad },
                ]}
              />
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                {filteredDatabases.length} of {databases.length}
              </span>
            </div>

            {filteredDatabases.length === 0 ? (
              <EmptyState
                icon={SearchX}
                title="No databases match"
                description="Try a different search term or state filter."
                className="rounded-none border-0"
                action={
                  <Button variant="outline" size="sm" onClick={() => { setSearch(""); setStatusFilter("all") }}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <>
                <div className="@container hidden overflow-x-auto min-[900px]:block">
                  <DatabaseTable
                    databases={filteredDatabases}
                    sort={sort}
                    onSort={onSort}
                    connHist={connHist}
                    expandedDb={expandedDb}
                    onExpand={name => setExpandedDb(prev => prev === name ? null : name)}
                    handlers={handlers}
                  />
                </div>
                <div className="min-[900px]:hidden">
                  <DatabaseCards
                    databases={filteredDatabases}
                    connHist={connHist}
                    expandedDb={expandedDb}
                    onExpand={name => setExpandedDb(prev => prev === name ? null : name)}
                    handlers={handlers}
                  />
                </div>
              </>
            )}
          </Card>
        )}
      </PageBody>

      {backupDb  && <BackupDialog  db={backupDb}  onClose={() => setBackupDb(null)}  />}
      {restoreDb && <RestoreDialog db={restoreDb} onClose={() => setRestoreDb(null)} />}

      {showCreate && (
        <CreateDatabaseModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            nodeApi.get<Database[]>("/api/docker/databases")
              .then(({ data }) => setDatabases(Array.isArray(data) ? data : []))
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
            const name = deleteTarget.name
            nodeApi.delete(`/api/docker/remove/${id}`)
              .then(() => { setDatabases(prev => prev.filter(d => d.name !== name)); toast.success(`Deleted ${name}`) })
              .catch(() => { toast.error(`Could not delete ${name}`) })
          }}
        />
      )}
    </>
  )
}
