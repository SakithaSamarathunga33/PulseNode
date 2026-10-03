"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, XCircle } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { nodeApi, API_BASE } from "@/lib/api"
import type { Database, DbSchemaResult } from "@/lib/types"

const DEFAULT = "__default__"

export function RestoreDialog({ db, onClose }: { db: Database; onClose: () => void }) {
  const [dbs,     setDbs]     = useState<string[]>([])
  const [selDb,   setSelDb]   = useState("")
  const [file,    setFile]    = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState("")
  const [output,  setOutput]  = useState("")
  const [done,    setDone]    = useState(false)
  const [confirming, setConfirming] = useState(false)
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
    <Dialog open onOpenChange={open => { if (!open && !loading) onClose() }}>
      <DialogContent showCloseButton={!loading} className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="size-4 text-[var(--hue,var(--primary))]" /> Restore
          </DialogTitle>
          <DialogDescription>
            Restore a backup file into <span className="font-mono text-foreground">{db.name}</span>. Existing data may be overwritten.
          </DialogDescription>
        </DialogHeader>

        {isRedis && (
          <Alert className="border-warning/40 bg-warning/10 text-warning">
            <AlertTriangle />
            <AlertDescription className="text-warning">
              Redis restore will stop the container, replace dump.rdb, then restart it.
            </AlertDescription>
          </Alert>
        )}

        {!done && (
          <div className="space-y-3">
            {dbs.length > 1 && !isRedis && (
              <div className="space-y-1.5">
                <Label htmlFor="restore-db">Target database</Label>
                <Select
                  value={selDb || DEFAULT}
                  onValueChange={v => setSelDb(v === DEFAULT ? "" : (v as string))}
                  items={[{ value: DEFAULT, label: "Default database" }, ...dbs.map(d => ({ value: d, label: d }))]}
                >
                  <SelectTrigger id="restore-db" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT}>Default database</SelectItem>
                    {dbs.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="restore-file">
                Backup file <span className="font-normal text-muted-foreground">(.sql · .archive · .rdb)</span>
              </Label>
              <Input
                id="restore-file"
                type="file"
                accept=".sql,.archive,.rdb,.dump,.gz"
                onChange={e => setFile(e.target.files?.[0] ?? null)}
                className="h-auto py-1.5 text-xs"
              />
              {file && (
                <p className="font-mono text-xs tabular-nums text-muted-foreground">
                  {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
              )}
            </div>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <XCircle />
            <AlertDescription><pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre></AlertDescription>
          </Alert>
        )}

        {done && (
          <Alert className="border-success/40 bg-success/10 text-success">
            <CheckCircle2 />
            <AlertDescription className="space-y-1 text-success">
              <p className="font-medium">Restore complete</p>
              {output && <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-xs opacity-80">{output.slice(0, 400)}</pre>}
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          {done ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
              <Button onClick={() => setConfirming(true)} disabled={!file || loading}>
                {loading ? <><Loader2 className="animate-spin" /> Restoring…</> : <><RotateCcw /> Restore</>}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        icon={RotateCcw}
        tone="warning"
        title={`Restore ${db.name}?`}
        items={[{ primary: `${db.name}${selDb ? ` · ${selDb}` : ""}`, secondary: file ? `from ${file.name}` : undefined }]}
        note="Existing data in the target is replaced. This action cannot be undone."
        confirmLabel="Restore"
        onConfirm={() => { setConfirming(false); void restore() }}
      />
    </Dialog>
  )
}
