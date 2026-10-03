"use client"

import { useEffect, useMemo, useState } from "react"
import { Activity, AlertTriangle, Database as DatabaseIcon, Gauge, PlugZap, Plus, SearchX, XCircle } from "lucide-react"
import { toast } from "sonner"
import { nodeApi } from "@/lib/api"
import type { CustomConnection, Database, DbMetrics } from "@/lib/types"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { PageBody, PageHeader } from "@/components/pn/PageHeader"
import { LiveBadge } from "@/components/pn/LiveBadge"
import { SearchInput } from "@/components/pn/SearchInput"
import { Segmented } from "@/components/pn/Segmented"
import { EmptyState } from "@/components/pn/EmptyState"
import { StatCard } from "@/components/dashboard/StatCard"
import { CreateDatabaseModal } from "@/components/dashboard/CreateDatabaseModal"
import { ConnectDatabaseModal } from "@/components/dashboard/ConnectDatabaseModal"
import { DatabaseTable } from "@/components/databases/DatabaseTable"
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
      .catch(err => setLoadError(err instanceof Error ? err.message : "Failed to load databases"))
      .finally(() => setLoaded(true))

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
    return databases.filter(db => {
      const matchesStatus = statusFilter === "all" || statusTone(db.state) === statusFilter
      const matchesSearch =
        !needle ||
        db.name.toLowerCase().includes(needle) ||
        db.engine.toLowerCase().includes(needle) ||
        db.host.toLowerCase().includes(needle)
      return matchesStatus && matchesSearch
    })
  }, [databases, search, statusFilter])

  const addActions = (
    <>
      <Button variant="secondary" onClick={() => setShowCreate(true)}>
        <Plus /> Create database
      </Button>
      <Button onClick={() => setShowConnect(true)}>
        <PlugZap /> Connect database
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
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Databases" value={databases.length} icon={DatabaseIcon} />
          <StatCard label="Connections" value={totalConns} icon={Activity} sub={`${Math.max(...connHistory)} peak`} />
          <StatCard label="Queries/sec" value={totalQps > 0 ? totalQps.toLocaleString() : "-"} icon={Gauge} />
          <StatCard
            label="Slow queries"
            value={totalSlow}
            icon={AlertTriangle}
            tone={totalSlow > 0 ? "warn" : "ok"}
            sub={unhealthy > 0 ? `${unhealthy} attention` : "healthy"}
          />
        </div>

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
              <SearchInput
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search databases, engines, hosts"
                aria-label="Search databases"
              />
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
              <div className="@container overflow-x-auto">
                <DatabaseTable
                  databases={filteredDatabases}
                  connHist={connHist}
                  expandedDb={expandedDb}
                  onExpand={name => setExpandedDb(prev => prev === name ? null : name)}
                  onDelete={setDeleteTarget}
                  onBackup={setBackupDb}
                  onRestore={setRestoreDb}
                />
              </div>
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
