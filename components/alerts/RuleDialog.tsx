"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, selectCls } from "./Field"
import { CHANNEL_META, METRICS, errMsg, metricOf, sendJSON, type Channel, type Rule } from "./shared"

export function RuleDialog({ value, channels, onClose, onSaved }: {
  value: Rule | "new" | null; channels: Channel[]; onClose: () => void; onSaved: (r: Rule) => void
}) {
  const editing = value && value !== "new" ? value : null
  const [form, setForm] = useState<Rule>(blankRule())
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (value) { setForm(value === "new" ? blankRule() : { ...value }); setErr(null) }
  }, [value])

  const metric = metricOf(form.metric)
  const set = <K extends keyof Rule>(k: K, v: Rule[K]) => setForm(f => ({ ...f, [k]: v }))

  async function save() {
    setSaving(true); setErr(null)
    try {
      const body = {
        name: form.name, metric: form.metric, operator: form.operator, threshold: Number(form.threshold),
        duration: Number(form.duration), severity: form.severity, target: form.target, channelIds: form.channelIds,
        cooldown: Number(form.cooldown), enabled: form.enabled,
      }
      const saved = editing
        ? await sendJSON<Rule>("PATCH", `/api/alerts/rules/${editing.id}`, body)
        : await sendJSON<Rule>("POST", "/api/alerts/rules", body)
      toast.success(editing ? "Rule updated" : "Rule created")
      onSaved(saved)
    } catch (e) { setErr(errMsg(e, "Could not save rule")) } finally { setSaving(false) }
  }

  return (
    <Dialog open={!!value} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit rule" : "New alert rule"}</DialogTitle>
          <DialogDescription>{metric?.hint}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field id="r-name" label="Name">
            <Input id="r-name" value={form.name} onChange={e => set("name", e.target.value)} placeholder="High CPU" autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="r-metric" label="Watch">
              <select id="r-metric" className={selectCls} value={form.metric} onChange={e => set("metric", e.target.value)}>
                {METRICS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </Field>
            <Field id="r-sev" label="Severity">
              <select id="r-sev" className={selectCls} value={form.severity} onChange={e => set("severity", e.target.value as Rule["severity"])}>
                <option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option>
              </select>
            </Field>
          </div>
          {metric?.percent ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field id="r-op" label="When">
                <select id="r-op" className={selectCls} value={form.operator} onChange={e => set("operator", e.target.value)}>
                  <option value=">">above</option><option value=">=">at least</option><option value="<">below</option><option value="<=">at most</option>
                </select>
              </Field>
              <Field id="r-th" label="Threshold (%)">
                <Input id="r-th" type="number" min={0} max={100} value={form.threshold} onChange={e => set("threshold", Number(e.target.value))} />
              </Field>
              <Field id="r-dur" label="For (seconds)">
                <Input id="r-dur" type="number" min={0} value={form.duration} onChange={e => set("duration", Number(e.target.value))} />
              </Field>
            </div>
          ) : (
            <Field id="r-target" label={form.metric === "deploy.failed" ? "Project (blank = any)" : "Container name (blank = any)"}>
              <Input id="r-target" value={form.target === "*" ? "" : form.target} onChange={e => set("target", e.target.value)} className="font-mono" />
            </Field>
          )}
          <Field id="r-cool" label="Cooldown (seconds)" hint="After an alert resolves, wait this long before it can fire again. Prevents flapping.">
            <Input id="r-cool" type="number" min={0} value={form.cooldown} onChange={e => set("cooldown", Number(e.target.value))} />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Notify</legend>
            {channels.length === 0 ? (
              <p className="text-xs text-muted-foreground">No channels yet. Add one in the Channels tab; until then alerts only appear here.</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">Leave all unchecked to notify every enabled channel.</p>
                {channels.map(c => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox" className="size-4 accent-[var(--primary)]"
                      checked={form.channelIds.includes(c.id)}
                      onChange={e => set("channelIds", e.target.checked ? [...form.channelIds, c.id] : form.channelIds.filter(x => x !== c.id))}
                    />
                    {c.name} <span className="text-xs text-muted-foreground">{CHANNEL_META[c.type]?.label}</span>
                  </label>
                ))}
              </>
            )}
          </fieldset>
          {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving || !form.name.trim()}>
            {saving && <Loader2 className="size-4 animate-spin" />} {editing ? "Save" : "Create rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function blankRule(): Rule {
  return { id: "", name: "", metric: "host.cpu", operator: ">", threshold: 90, duration: 60, severity: "warning", target: "", channelIds: [], cooldown: 300, enabled: true }
}
