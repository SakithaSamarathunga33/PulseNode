"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Field, selectCls } from "./DestinationDialog"
import { api, asArray, errMsg, isPanel, WEEKDAYS, type Destination, type Frequency, type ManagedDb, type Schedule } from "./shared"

type Form = {
  name: string; target: string; frequency: Frequency; hour: number; weekday: number; retention: number
  destinationIds: string[]; encrypt: boolean; notifyOnSuccess: boolean; enabled: boolean
}

const blank = (destinations: Destination[]): Form => ({
  name: "", target: "panel", frequency: "daily", hour: 3, weekday: 0, retention: 7,
  destinationIds: destinations.filter(d => d.enabled).slice(0, 1).map(d => d.id),
  encrypt: true, notifyOnSuccess: false, enabled: true,
})

const fromSchedule = (s: Schedule): Form => ({
  name: s.name, target: s.target, frequency: s.frequency, hour: s.hour ?? 3, weekday: s.weekday ?? 0,
  retention: s.retention || 7, destinationIds: [...(s.destinationIds ?? [])],
  encrypt: s.encrypt, notifyOnSuccess: s.notifyOnSuccess, enabled: s.enabled,
})

/** Create / edit a backup schedule. */
export function ScheduleDialog({ value, destinations, passphraseSet, onClose, onSaved, onAddDestination }: {
  value: Schedule | "new" | null
  destinations: Destination[]
  passphraseSet: boolean
  onClose: () => void
  onSaved: (s: Schedule) => void
  onAddDestination: () => void
}) {
  const editing = value && value !== "new" ? value : null
  const [form, setForm] = useState<Form>(blank(destinations))
  const [dbs, setDbs] = useState<ManagedDb[] | null>(null)
  const [dbErr, setDbErr] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!value) return
    setForm(value === "new" ? blank(destinations) : fromSchedule(value))
    setErr(null)
    let live = true
    setDbErr(false)
    api.get<ManagedDb[]>("/api/databases/managed")
      .then(d => { if (live) setDbs(asArray<ManagedDb>(d)) })
      .catch(() => { if (live) { setDbs([]); setDbErr(true) } })
    return () => { live = false }
    // destinations only seeds a NEW schedule's default; re-running on every refresh would reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }))
  const toggleDest = (id: string, on: boolean) =>
    setForm(f => ({ ...f, destinationIds: on ? [...f.destinationIds, id] : f.destinationIds.filter(x => x !== id) }))

  const targetKnown = isPanel(form.target) || (dbs ?? []).some(d => `db:${d.id}` === form.target)
  const valid = form.name.trim() !== "" && form.destinationIds.length > 0 && form.retention >= 1
    && (isPanel(form.target) || form.target.startsWith("db:"))

  async function save() {
    setSaving(true); setErr(null)
    try {
      const body = {
        name: form.name.trim(), target: form.target, frequency: form.frequency,
        hour: Number(form.hour), weekday: Number(form.weekday), retention: Number(form.retention),
        destinationIds: form.destinationIds, encrypt: form.encrypt, notifyOnSuccess: form.notifyOnSuccess, enabled: form.enabled,
      }
      const saved = editing
        ? await api.patch<Schedule>(`/api/backups/schedules/${editing.id}`, body)
        : await api.post<Schedule>("/api/backups/schedules", body)
      toast.success(editing ? "Schedule updated" : "Schedule created")
      onSaved(saved)
    } catch (e) { setErr(errMsg(e, "Could not save schedule")) } finally { setSaving(false) }
  }

  return (
    <Dialog open={!!value} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit schedule" : "New backup schedule"}</DialogTitle>
          <DialogDescription>Backs up automatically on a timer, copies the result to every destination you pick and keeps only the newest copies.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field id="s-name" label="Name">
            <Input id="s-name" value={form.name} onChange={e => set("name", e.target.value)} placeholder="Nightly panel backup" autoFocus />
          </Field>

          <Field id="s-target" label="What to back up" hint={dbErr ? "Could not load your databases. You can still back up the panel." : undefined}>
            <select id="s-target" className={selectCls} value={form.target} onChange={e => set("target", e.target.value)}>
              <option value="panel">Panel (settings, keys, database)</option>
              {!targetKnown && !isPanel(form.target) && <option value={form.target}>{editing?.targetName || form.target}</option>}
              {(dbs ?? []).map(d => <option key={d.id} value={`db:${d.id}`}>Database · {d.name} ({d.engine})</option>)}
            </select>
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field id="s-freq" label="How often">
              <select id="s-freq" className={selectCls} value={form.frequency} onChange={e => set("frequency", e.target.value as Frequency)}>
                <option value="hourly">Every hour</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </Field>
            {form.frequency === "weekly" && (
              <Field id="s-day" label="Day">
                <select id="s-day" className={selectCls} value={form.weekday} onChange={e => set("weekday", Number(e.target.value))}>
                  {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              </Field>
            )}
            {form.frequency !== "hourly" && (
              <Field id="s-hour" label="At (server time)">
                <select id="s-hour" className={selectCls} value={form.hour} onChange={e => set("hour", Number(e.target.value))}>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                </select>
              </Field>
            )}
          </div>

          <Field id="s-ret" label="Keep the newest" hint="Older copies are deleted from every destination after each successful run.">
            <div className="flex items-center gap-2">
              <Input id="s-ret" type="number" min={1} max={365} value={form.retention} onChange={e => set("retention", Number(e.target.value))} className="w-24" />
              <span className="text-sm text-muted-foreground">backups</span>
            </div>
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Store in</legend>
            {destinations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No destinations yet.{" "}
                <button type="button" className="font-medium text-primary underline underline-offset-2" onClick={() => { onClose(); onAddDestination() }}>Add one first</button>.
              </p>
            ) : destinations.map(d => (
              <label key={d.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={form.destinationIds.includes(d.id)} onCheckedChange={v => toggleDest(d.id, v === true)} aria-label={`Store in ${d.name}`} />
                <span className="font-medium">{d.name}</span>
                <span className="text-xs text-muted-foreground">{d.type === "s3" ? "S3" : "local"}{d.enabled ? "" : " · disabled"}</span>
              </label>
            ))}
          </fieldset>

          <div className="space-y-2">
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
              <span>Encrypt backups<span className="block text-xs text-muted-foreground">Uses the panel passphrase.</span></span>
              <Switch checked={form.encrypt} onCheckedChange={v => set("encrypt", v)} aria-label="Encrypt backups" />
            </label>
            {isPanel(form.target) && !form.encrypt && (
              <p role="alert" className="text-xs font-medium text-warning">A panel backup contains your encryption keys and stored secrets. Anyone who gets an unencrypted copy gets all of them.</p>
            )}
            {form.encrypt && !passphraseSet && (
              <p role="alert" className="text-xs font-medium text-warning">No passphrase is set yet. Set one on this page before this schedule can run.</p>
            )}
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
              <span>Notify on success<span className="block text-xs text-muted-foreground">Failures are always reported through your alert channels.</span></span>
              <Switch checked={form.notifyOnSuccess} onCheckedChange={v => set("notifyOnSuccess", v)} aria-label="Notify on success" />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
              Enabled
              <Switch checked={form.enabled} onCheckedChange={v => set("enabled", v)} aria-label="Schedule enabled" />
            </label>
          </div>
          {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving || !valid}>
            {saving && <Loader2 className="size-4 animate-spin" />} {editing ? "Save changes" : "Create schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
