"use client"

import { useEffect, useState } from "react"
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { api, errMsg, type DestType, type Destination, type TestResult } from "./shared"

export const selectCls =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"

export function Field({ id, label, children, hint }: { id: string; label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

type Form = {
  name: string; type: DestType; enabled: boolean
  dir: string
  endpoint: string; region: string; bucket: string; prefix: string
  accessKey: string; secretKey: string
  useSSL: boolean; pathStyle: boolean
}

const blank = (): Form => ({
  name: "", type: "local", enabled: true, dir: "",
  endpoint: "", region: "", bucket: "", prefix: "", accessKey: "", secretKey: "", useSSL: true, pathStyle: false,
})

const fromDest = (d: Destination): Form => ({
  name: d.name, type: d.type, enabled: d.enabled, dir: d.dir ?? "",
  endpoint: d.endpoint ?? "", region: d.region ?? "", bucket: d.bucket ?? "", prefix: d.prefix ?? "",
  accessKey: "", secretKey: "", useSSL: d.useSSL ?? true, pathStyle: d.pathStyle ?? false,
})

/** Create / edit a backup destination (local folder or S3-compatible bucket). */
export function DestinationDialog({ value, onClose, onSaved }: {
  value: Destination | "new" | null
  onClose: () => void
  onSaved: (d: Destination) => void
}) {
  const editing = value && value !== "new" ? value : null
  const [form, setForm] = useState<Form>(blank())
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (value) { setForm(value === "new" ? blank() : fromDest(value)); setErr(null); setTest(null) }
  }, [value])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }))

  // Blank credentials on edit mean "keep the stored ones": never send them.
  function body() {
    const b: Record<string, unknown> = { name: form.name.trim(), type: form.type, enabled: form.enabled }
    if (form.type === "local") b.dir = form.dir.trim()
    else {
      Object.assign(b, {
        endpoint: form.endpoint.trim(), region: form.region.trim(), bucket: form.bucket.trim(), prefix: form.prefix.trim(),
        useSSL: form.useSSL, pathStyle: form.pathStyle,
      })
      if (form.accessKey) b.accessKey = form.accessKey
      if (form.secretKey) b.secretKey = form.secretKey
    }
    return b
  }

  async function save() {
    setSaving(true); setErr(null)
    try {
      const saved = editing
        ? await api.patch<Destination>(`/api/backups/destinations/${editing.id}`, body())
        : await api.post<Destination>("/api/backups/destinations", body())
      toast.success(editing ? "Destination updated" : "Destination added")
      onSaved(saved)
    } catch (e) { setErr(errMsg(e, "Could not save destination")) } finally { setSaving(false) }
  }

  async function runTest() {
    setTesting(true); setTest(null); setErr(null)
    try {
      // For an existing destination the id lets the server reuse stored credentials.
      const r = await api.post<TestResult>("/api/backups/destinations/test", editing ? { ...body(), id: editing.id } : body())
      const ok = r.ok !== false
      setTest({ ok, text: (ok ? r.message : r.error ?? r.message) || (ok ? "Connection works." : "The test failed.") })
    } catch (e) { setTest({ ok: false, text: errMsg(e, "The test failed.") }) } finally { setTesting(false) }
  }

  const s3 = form.type === "s3"
  const valid = form.name.trim() !== "" && (s3 ? form.endpoint.trim() !== "" && form.bucket.trim() !== "" : form.dir.trim() !== "")

  return (
    <Dialog open={!!value} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit destination" : "Add backup destination"}</DialogTitle>
          <DialogDescription>
            Where finished backups are stored. A local folder lives on this server, so it does not protect you if the server is lost. Add an S3-compatible bucket for off-site copies.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id="d-name" label="Name">
              <Input id="d-name" value={form.name} onChange={e => set("name", e.target.value)} placeholder="Off-site bucket" autoFocus />
            </Field>
            <Field id="d-type" label="Type">
              <select id="d-type" className={selectCls} value={form.type} onChange={e => { set("type", e.target.value as DestType); setTest(null) }}>
                <option value="local">Local folder</option>
                <option value="s3">S3-compatible (S3, R2, B2, MinIO…)</option>
              </select>
            </Field>
          </div>

          {!s3 && (
            <Field id="d-dir" label="Folder on the server" hint="Absolute path inside the PulseNode data volume, for example /var/lib/pulsenode/backups.">
              <Input id="d-dir" value={form.dir} onChange={e => set("dir", e.target.value)} placeholder="/var/lib/pulsenode/backups" className="font-mono" />
            </Field>
          )}

          {s3 && (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field id="d-endpoint" label="Endpoint" hint="Host only, for example s3.eu-central-1.amazonaws.com">
                  <Input id="d-endpoint" value={form.endpoint} onChange={e => set("endpoint", e.target.value)} placeholder="s3.amazonaws.com" className="font-mono" />
                </Field>
                <Field id="d-region" label="Region (optional)">
                  <Input id="d-region" value={form.region} onChange={e => set("region", e.target.value)} placeholder="eu-central-1" className="font-mono" />
                </Field>
                <Field id="d-bucket" label="Bucket">
                  <Input id="d-bucket" value={form.bucket} onChange={e => set("bucket", e.target.value)} className="font-mono" />
                </Field>
                <Field id="d-prefix" label="Folder prefix (optional)">
                  <Input id="d-prefix" value={form.prefix} onChange={e => set("prefix", e.target.value)} placeholder="pulsenode/" className="font-mono" />
                </Field>
                <Field id="d-ak" label="Access key" hint={editing?.accessKeyHint ? `Saved: ${editing.accessKeyHint}. Leave blank to keep it.` : undefined}>
                  <Input id="d-ak" value={form.accessKey} onChange={e => set("accessKey", e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
                </Field>
                <Field id="d-sk" label="Secret key" hint={editing?.secretSet ? "Leave blank to keep the saved secret." : undefined}>
                  <Input
                    id="d-sk" type="password" value={form.secretKey} onChange={e => set("secretKey", e.target.value)}
                    autoComplete="new-password" placeholder={editing?.secretSet ? "•••••••• (saved)" : ""} className="font-mono"
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
                  Use HTTPS
                  <Switch checked={form.useSSL} onCheckedChange={v => set("useSSL", v)} aria-label="Use HTTPS" />
                </label>
                <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
                  Path-style addressing
                  <Switch checked={form.pathStyle} onCheckedChange={v => set("pathStyle", v)} aria-label="Path-style addressing" />
                </label>
              </div>
              {editing && (
                <p className="text-xs text-muted-foreground">
                  If you change the endpoint or bucket you must enter the secret key again, so a saved secret is never sent to a new place.
                </p>
              )}
            </>
          )}

          <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
            Enabled
            <Switch checked={form.enabled} onCheckedChange={v => set("enabled", v)} aria-label="Destination enabled" />
          </label>

          {test && (
            <div role="status" className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${test.ok ? "text-success" : "text-danger"}`}>
              {test.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <CircleAlert className="mt-0.5 size-4 shrink-0" />}
              <span className="min-w-0 break-words">{test.text}</span>
            </div>
          )}
          {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={runTest} disabled={testing || saving || !valid}>
            {testing && <Loader2 className="size-4 animate-spin" />} Test connection
          </Button>
          <Button onClick={save} disabled={saving || !valid}>
            {saving && <Loader2 className="size-4 animate-spin" />} {editing ? "Save changes" : "Add destination"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
