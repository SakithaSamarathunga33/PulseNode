"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Loader2, Send } from "lucide-react"
import { nodeApi } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, selectCls } from "./Field"
import { CHANNEL_META, errMsg, sendJSON, type Channel, type ChannelType } from "./shared"

// secret: stored encrypted and never returned (blank on edit = keep). plain: show the box as readable text while typing.
type FieldSpec = { key: string; label: string; secret?: boolean; plain?: boolean; placeholder?: string; type?: string; optional?: boolean; hint?: string }
const CHANNEL_FIELDS: Record<ChannelType, FieldSpec[]> = {
  webhook: [
    { key: "url", label: "URL", secret: true, plain: true, placeholder: "https://example.com/hooks/pulsenode", hint: "Stored encrypted — URLs often embed tokens, so only the host is shown after saving." },
    { key: "secret", label: "Signing secret", secret: true, optional: true, hint: "If set, requests carry X-PulseNode-Signature: sha256=HMAC of the body." },
  ],
  slack: [{ key: "webhookUrl", label: "Incoming webhook URL", secret: true, placeholder: "https://hooks.slack.com/services/…" }],
  discord: [{ key: "webhookUrl", label: "Webhook URL", secret: true, placeholder: "https://discord.com/api/webhooks/…" }],
  telegram: [
    { key: "botToken", label: "Bot token", secret: true, placeholder: "123456:ABC…", hint: "Create a bot with @BotFather." },
    { key: "chatId", label: "Chat ID", placeholder: "-1001234567890 or @channelname" },
  ],
  smtp: [
    { key: "host", label: "SMTP host", placeholder: "smtp.example.com" },
    { key: "port", label: "Port", placeholder: "587", type: "number" },
    { key: "username", label: "Username", optional: true },
    { key: "password", label: "Password", secret: true, optional: true },
    { key: "from", label: "From", placeholder: "PulseNode <alerts@example.com>" },
    { key: "to", label: "To", placeholder: "you@example.com, team@example.com" },
  ],
}

export function ChannelDialog({ value, onClose, onSaved }: {
  value: Channel | "new" | null; onClose: () => void; onSaved: (c: Channel) => void
}) {
  const editing = value && value !== "new" ? value : null
  const [type, setType] = useState<ChannelType>("slack")
  const [name, setName] = useState("")
  const [cfg, setCfg] = useState<Record<string, string>>({})
  const [security, setSecurity] = useState("starttls")
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!value) return
    setErr(null)
    if (value === "new") { setType("slack"); setName(""); setCfg({}); setSecurity("starttls") }
    else {
      setType(value.type); setName(value.name); setSecurity(value.config.security || "starttls")
      setCfg(Object.fromEntries(Object.entries(value.config).filter(([k]) => !k.endsWith("Set") && !k.endsWith("Hint"))))
    }
  }, [value])

  const fields = CHANNEL_FIELDS[type]
  const body = () => ({ name, type, config: { ...cfg, ...(type === "smtp" ? { security } : {}) } })

  async function save() {
    setSaving(true); setErr(null)
    try {
      const saved = editing
        ? await sendJSON<Channel>("PATCH", `/api/alerts/channels/${editing.id}`, body())
        : await sendJSON<Channel>("POST", "/api/alerts/channels", body())
      toast.success(editing ? "Channel updated" : "Channel added")
      onSaved(saved)
    } catch (e) { setErr(errMsg(e, "Could not save channel")) } finally { setSaving(false) }
  }

  async function test() {
    setTesting(true); setErr(null)
    try {
      await nodeApi.post("/api/alerts/channels/test", { ...body(), id: editing?.id })
      toast.success("Test notification sent")
    } catch (e) { setErr(errMsg(e, "Test failed")) } finally { setTesting(false) }
  }

  return (
    <Dialog open={!!value} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit channel" : "Add notification channel"}</DialogTitle>
          <DialogDescription>{CHANNEL_META[type].desc}. Secrets are encrypted at rest and never shown again.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!editing && (
            <Field id="c-type" label="Type">
              <select id="c-type" className={selectCls} value={type} onChange={e => { setType(e.target.value as ChannelType); setCfg({}); setErr(null) }}>
                {(Object.keys(CHANNEL_META) as ChannelType[]).map(t => <option key={t} value={t}>{CHANNEL_META[t].label}</option>)}
              </select>
            </Field>
          )}
          <Field id="c-name" label="Name">
            <Input id="c-name" value={name} onChange={e => setName(e.target.value)} placeholder={`${CHANNEL_META[type].label} alerts`} />
          </Field>
          {fields.map(f => {
            const stored = !!editing && f.secret && editing.config[`${f.key}Set`] === "true"
            const savedHint = stored ? editing?.config[`${f.key}Hint`] : undefined
            return (
              <Field
                key={f.key} id={`c-${f.key}`} label={f.label}
                hint={stored ? `Saved${savedHint ? ` for ${savedHint}` : ""}. Leave blank to keep it.${f.hint && !f.plain ? ` ${f.hint}` : ""}` : f.hint}
              >
                <Input
                  id={`c-${f.key}`} type={f.secret && !f.plain ? "password" : f.type ?? "text"} autoComplete="off"
                  value={cfg[f.key] ?? ""} onChange={e => setCfg(c => ({ ...c, [f.key]: e.target.value }))}
                  placeholder={stored ? (savedHint ? `${savedHint} (saved — leave blank to keep)` : "•••••••• (saved — leave blank to keep)") : f.placeholder}
                  className={f.type === "number" ? undefined : "font-mono text-xs"}
                />
              </Field>
            )
          })}
          {type === "smtp" && (
            <Field id="c-sec" label="Encryption">
              <select id="c-sec" className={selectCls} value={security} onChange={e => setSecurity(e.target.value)}>
                <option value="starttls">STARTTLS (port 587)</option><option value="tls">TLS (port 465)</option><option value="none">None (not recommended)</option>
              </select>
            </Field>
          )}
          {err && (
            <Alert variant="destructive">
              <AlertDescription>
                {err}
                {/entered again/i.test(err) && (
                  <span className="mt-1 block text-xs">
                    You changed where this channel sends to. Saved secrets are never reused for a new destination — type the secret
                    again, or put the original host back to leave it blank.
                  </span>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={test} disabled={testing || saving}>
            {testing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send test
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={saving || !name.trim()}>
              {saving && <Loader2 className="size-4 animate-spin" />} {editing ? "Save" : "Add channel"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
