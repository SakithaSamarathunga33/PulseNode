"use client"

import { useEffect, useState } from "react"
import { CheckCircle2, Download, Loader2, XCircle } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { nodeApi, API_BASE } from "@/lib/api"
import type { Database, DbSchemaResult } from "@/lib/types"
import { fmtBytes } from "./shared"

type BkpPhase = "idle" | "starting" | "dumping" | "done" | "error"
type BkpState = { phase: BkpPhase; jobId: string; bytes: number; error: string; name: string }

// base-ui Select can't hold an empty string as a real option, so "all" is a sentinel.
const ALL = "__all__"

export function BackupDialog({ db, onClose }: { db: Database; onClose: () => void }) {
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
  const tableLabel = db.engine === "mongodb" ? "Collection" : "Table"

  return (
    <Dialog open onOpenChange={open => { if (!open && !running) onClose() }}>
      <DialogContent showCloseButton={!running} className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="size-4 text-[var(--hue,var(--primary))]" /> Backup
          </DialogTitle>
          <DialogDescription>
            Create a downloadable dump of <span className="font-mono text-foreground">{db.name}</span>.
          </DialogDescription>
        </DialogHeader>

        {/* Scope selectors (only when idle) */}
        {state.phase === "idle" && (
          <div className="space-y-3">
            {dbs.length > 1 && (
              <div className="space-y-1.5">
                <Label htmlFor="backup-db">Database</Label>
                <Select
                  value={selDb || ALL}
                  onValueChange={v => { setSelDb(v === ALL ? "" : (v as string)); setSelTable("") }}
                  items={[{ value: ALL, label: "All databases" }, ...dbs.map(d => ({ value: d, label: d }))]}
                >
                  <SelectTrigger id="backup-db" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All databases</SelectItem>
                    {dbs.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            {tables.length > 0 && db.engine !== "redis" && (
              <div className="space-y-1.5">
                <Label htmlFor="backup-table">
                  {tableLabel} <span className="font-normal text-muted-foreground">(optional — all if blank)</span>
                </Label>
                <Select
                  value={selTable || ALL}
                  onValueChange={v => setSelTable(v === ALL ? "" : (v as string))}
                  items={[{ value: ALL, label: "All tables" }, ...tables.map(t => ({ value: t, label: t }))]}
                >
                  <SelectTrigger id="backup-table" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All tables</SelectItem>
                    {tables.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            {dbs.length === 0 && tables.length === 0 && (
              <p className="text-sm text-muted-foreground">Full database backup will be created.</p>
            )}
          </div>
        )}

        {/* Progress panel */}
        {state.phase !== "idle" && (
          <div role="status" className="space-y-2 rounded-lg border bg-muted/40 p-4">
            <div className="flex items-center gap-2">
              {running && <Loader2 className="size-4 animate-spin text-[var(--hue,var(--primary))]" />}
              {state.phase === "done"  && <CheckCircle2 className="size-4 text-success" />}
              {state.phase === "error" && <XCircle className="size-4 text-danger" />}
              <span className={`text-sm font-medium ${state.phase === "done" ? "text-success" : state.phase === "error" ? "text-danger" : ""}`}>
                {state.phase === "starting" ? "Preparing…"
                  : state.phase === "dumping" ? "Dumping data…"
                  : state.phase === "done"    ? "Backup complete"
                  :                             "Backup failed"}
              </span>
              {state.bytes > 0 && (
                <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">{fmtBytes(state.bytes)}</span>
              )}
            </div>
            {state.name && <p className="truncate font-mono text-xs text-muted-foreground">{state.name}</p>}
            {state.error && (
              <Alert variant="destructive"><AlertDescription className="break-all font-mono text-xs">{state.error}</AlertDescription></Alert>
            )}
          </div>
        )}

        <DialogFooter>
          {state.phase === "done" ? (
            <>
              <Button variant="outline" onClick={reset}>New backup</Button>
              <Button onClick={download}><Download /> Download</Button>
            </>
          ) : state.phase === "error" ? (
            <>
              <Button variant="outline" onClick={onClose}>Close</Button>
              <Button onClick={reset}>Try again</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={running}>Cancel</Button>
              <Button onClick={start} disabled={running}>
                {running ? <><Loader2 className="animate-spin" /> Running…</> : <><Download /> Start backup</>}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
