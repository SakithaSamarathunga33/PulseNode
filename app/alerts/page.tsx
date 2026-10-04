"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  Bell, BellOff, Mail, MessageSquare, Send, Webhook, Siren, AlertTriangle, Info, CheckCircle2, XCircle,
  Check, BellRing, Flame, Eye, Plus, Pencil, Trash2, Loader2, AlertCircle, Hash,
} from "lucide-react"
import { nodeApi, type ApiError } from "@/lib/api"
import { getSocket } from "@/lib/socket"
import { useSlashFocus } from "@/lib/use-slash-focus"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { SearchInput } from "@/components/pn/SearchInput"
import { Segmented } from "@/components/pn/Segmented"
import { EmptyState } from "@/components/pn/EmptyState"
import { SummaryStrip } from "@/components/pn/SummaryStrip"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import { Pill } from "@/components/dashboard/Pill"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { Truncate } from "@/components/pn/Truncate"

type AlertEvent = {
  id: number; ruleId: string; rule: string; metric: string; severity: "critical" | "warning" | "info"
  sev: "bad" | "warn" | "info"; target: string; state: "firing" | "ack" | "resolved"
  message: string; value: number; firedAt: string; ackedAt: string | null; resolvedAt: string | null
}
type Rule = {
  id: string; name: string; metric: string; operator: string; threshold: number; duration: number
  severity: "critical" | "warning" | "info"; target: string; channelIds: string[]; cooldown: number; enabled: boolean
}
type Channel = {
  id: string; name: string; type: ChannelType; enabled: boolean; summary: string; config: Record<string, string>
}
type ChannelType = "webhook" | "slack" | "discord" | "telegram" | "smtp"
type Tab = "history" | "rules" | "channels"
type StateFilter = "all" | "firing" | "ack" | "resolved"
type SevFilter = "all" | "critical" | "warning" | "info"
type RangeFilter = "1h" | "24h" | "7d" | "all"

const SEV_FILTERS = [
  { value: "all", label: "All severities" }, { value: "critical", label: "Critical" },
  { value: "warning", label: "Warning" }, { value: "info", label: "Info" },
]
const RANGE_FILTERS = [
  { value: "1h", label: "Last hour" }, { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" }, { value: "all", label: "All time" },
]
const RANGE_MS: Record<RangeFilter, number> = { "1h": 3600e3, "24h": 86400e3, "7d": 7 * 86400e3, all: Infinity }
const SEV_TEXT = { critical: "text-danger", warning: "text-warning", info: "text-info" } as const
const STICKY = "sticky right-0 bg-card shadow-[-1px_0_0_var(--border)]"

function SevLabel({ severity }: { severity: AlertEvent["severity"] }) {
  const m = SEV[severity] ?? SEV.info
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold", SEV_TEXT[severity] ?? "text-info")}>
      <m.icon className="size-3.5" aria-hidden />{m.label}
    </span>
  )
}

const METRICS: { value: string; label: string; percent: boolean; hint: string }[] = [
  { value: "host.cpu", label: "Host CPU", percent: true, hint: "CPU usage of the server" },
  { value: "host.memory", label: "Host memory", percent: true, hint: "RAM usage of the server" },
  { value: "host.disk", label: "Host disk", percent: true, hint: "Disk usage of the root filesystem" },
  { value: "container.down", label: "Container down", percent: false, hint: "A container is exited, dead or restarting" },
  { value: "deploy.failed", label: "Deploy failed", percent: false, hint: "A project deployment fails" },
]
const metricOf = (v: string) => METRICS.find(m => m.value === v)

const SEV = {
  critical: { icon: XCircle, cls: "bg-danger/12 text-danger", label: "Critical", tone: "bad" },
  warning: { icon: AlertTriangle, cls: "bg-warning/14 text-warning", label: "Warning", tone: "warn" },
  info: { icon: Info, cls: "bg-info/12 text-info", label: "Info", tone: "info" },
} as const

const CHANNEL_META: Record<ChannelType, { label: string; icon: typeof Mail; desc: string }> = {
  webhook: { label: "Webhook", icon: Webhook, desc: "POST JSON to any URL, optionally HMAC-signed" },
  slack: { label: "Slack", icon: Hash, desc: "Incoming webhook into a Slack channel" },
  discord: { label: "Discord", icon: MessageSquare, desc: "Webhook into a Discord channel" },
  telegram: { label: "Telegram", icon: Send, desc: "Bot message to a chat or channel" },
  smtp: { label: "Email", icon: Mail, desc: "Send through your SMTP server" },
}

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function ruleExpr(r: Rule): string {
  const m = metricOf(r.metric)
  if (!m?.percent) return (m?.label ?? r.metric) + (r.target && r.target !== "*" ? ` · ${r.target}` : "")
  return `${r.metric} ${r.operator} ${r.threshold}%${r.duration ? ` for ${r.duration >= 60 ? `${Math.round(r.duration / 60)}m` : `${r.duration}s`}` : ""}`
}

function StatePill({ state }: { state: string }) {
  if (state === "firing") return <Pill tone="bad" dot>Firing</Pill>
  if (state === "ack") return <Pill tone="warn" dot>Acknowledged</Pill>
  if (state === "resolved") return <Pill tone="ok" dot>Resolved</Pill>
  return <Pill tone="outline">{state}</Pill>
}

const selectCls =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"

export default function AlertsPage() {
  const [tab, setTab] = useState<Tab>("history")
  const [events, setEvents] = useState<AlertEvent[] | null>(null)
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [muteUntil, setMuteUntil] = useState(0)
  const [stateFilter, setStateFilter] = useState<StateFilter>("all")
  const [search, setSearch] = useState("")
  const [sevFilter, setSevFilter] = useState<SevFilter>("all")
  const [rangeFilter, setRangeFilter] = useState<RangeFilter>("7d")
  const searchRef = useRef<HTMLInputElement>(null)
  const loadingRef = useRef(false)
  useSlashFocus(searchRef)
  const [ruleDialog, setRuleDialog] = useState<Rule | "new" | null>(null)
  const [channelDialog, setChannelDialog] = useState<Channel | "new" | null>(null)
  const [confirm, setConfirm] = useState<{ kind: "rule" | "channel"; id: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const [ev, ru, ch, mu] = await Promise.all([
        nodeApi.get<AlertEvent[]>("/api/alerts/history?limit=300"),
        nodeApi.get<Rule[]>("/api/alerts/rules"),
        nodeApi.get<Channel[]>("/api/alerts/channels"),
        nodeApi.get<{ until: number }>("/api/alerts/mute"),
      ])
      setEvents(Array.isArray(ev.data) ? ev.data : [])
      setRules(Array.isArray(ru.data) ? ru.data : [])
      setChannels(Array.isArray(ch.data) ? ch.data : [])
      setMuteUntil(mu.data?.until ?? 0)
      setError(null)
    } catch (e) {
      setError(errMsg(e, "Could not load alerts"))
    } finally {
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 30000)
    return () => clearInterval(id)
  }, [load])

  useEffect(() => {
    const socket = getSocket()
    const upsert = (ev: AlertEvent) =>
      setEvents(prev => {
        if (!prev) return prev
        return prev.some(e => e.id === ev.id) ? prev.map(e => (e.id === ev.id ? ev : e)) : [ev, ...prev]
      })
    socket.on("alert:new", upsert)
    socket.on("alert:update", upsert)
    return () => { socket.off("alert:new", upsert); socket.off("alert:update", upsert) }
  }, [])

  const muted = muteUntil * 1000 > Date.now()
  const list = useMemo(() => events ?? [], [events])
  const firing = list.filter(a => a.state === "firing").length
  const ack = list.filter(a => a.state === "ack").length
  const resolved = list.filter(a => a.state === "resolved").length

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const limit = RANGE_MS[rangeFilter]
    return list.filter(a =>
      (stateFilter === "all" || a.state === stateFilter) &&
      (sevFilter === "all" || a.severity === sevFilter) &&
      (limit === Infinity || Date.now() - new Date(a.firedAt).getTime() <= limit) &&
      (!q || a.rule.toLowerCase().includes(q) || a.target.toLowerCase().includes(q) || a.message.toLowerCase().includes(q)))
  }, [list, stateFilter, sevFilter, rangeFilter, search])
  const resetFilters = () => { setSearch(""); setStateFilter("all"); setSevFilter("all"); setRangeFilter("7d") }

  async function act(id: number, action: "ack" | "resolve") {
    try {
      const ev = await nodeApi.post<AlertEvent>(`/api/alerts/history/${id}/${action}`)
      setEvents(prev => prev && prev.map(e => (e.id === ev.id ? ev : e)))
    } catch (e) { toast.error(errMsg(e, "Action failed")) }
  }

  async function ackAll() {
    try {
      await nodeApi.post("/api/alerts/ack-all")
      setEvents(prev => prev && prev.map(a => (a.state === "firing" ? { ...a, state: "ack" } : a)))
      toast.success("All firing alerts acknowledged")
    } catch (e) { toast.error(errMsg(e, "Could not acknowledge")) }
  }

  async function toggleMute() {
    try {
      const r = await nodeApi.post<{ until: number }>("/api/alerts/mute", { minutes: muted ? 0 : 60 })
      setMuteUntil(r.until)
      toast.success(muted ? "Notifications resumed" : "Notifications muted for 1 hour")
    } catch (e) { toast.error(errMsg(e, "Could not change mute")) }
  }

  async function toggleRule(rule: Rule, enabled: boolean) {
    setRules(prev => prev && prev.map(r => (r.id === rule.id ? { ...r, enabled } : r)))
    try {
      await patch(`/api/alerts/rules/${rule.id}`, { enabled })
    } catch (e) {
      setRules(prev => prev && prev.map(r => (r.id === rule.id ? { ...r, enabled: !enabled } : r)))
      toast.error(errMsg(e, "Could not update rule"))
    }
  }

  async function toggleChannel(ch: Channel, enabled: boolean) {
    setChannels(prev => prev && prev.map(c => (c.id === ch.id ? { ...c, enabled } : c)))
    try {
      await patch(`/api/alerts/channels/${ch.id}`, { enabled })
    } catch (e) {
      setChannels(prev => prev && prev.map(c => (c.id === ch.id ? { ...c, enabled: !enabled } : c)))
      toast.error(errMsg(e, "Could not update channel"))
    }
  }

  async function testChannel(ch: Channel) {
    try {
      await nodeApi.post(`/api/alerts/channels/${ch.id}/test`)
      toast.success(`Test sent to ${ch.name}`)
    } catch (e) { toast.error(errMsg(e, "Test failed")) }
  }

  async function doDelete() {
    if (!confirm) return
    setBusy(true)
    try {
      await nodeApi.delete(`/api/alerts/${confirm.kind === "rule" ? "rules" : "channels"}/${confirm.id}`)
      if (confirm.kind === "rule") setRules(prev => prev && prev.filter(r => r.id !== confirm.id))
      else setChannels(prev => prev && prev.filter(c => c.id !== confirm.id))
      toast.success(`${confirm.kind === "rule" ? "Rule" : "Channel"} deleted`)
      setConfirm(null)
    } catch (e) { toast.error(errMsg(e, "Delete failed")) } finally { setBusy(false) }
  }

  const loading = events === null && !error
  const channelName = (id: string) => channels?.find(c => c.id === id)?.name ?? "deleted channel"

  return (
    <>
      <PageHeader
        icon={Siren}
        title="Alerts"
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span><b className={cn("font-semibold tabular-nums", firing ? "text-danger" : "text-foreground")}>{firing}</b> firing</span>
            <span aria-hidden className="text-border">·</span>
            <span><b className={cn("font-semibold tabular-nums", ack ? "text-warning" : "text-foreground")}>{ack}</b> acknowledged</span>
            <span aria-hidden className="text-border">·</span>
            <span><b className="font-semibold text-foreground tabular-nums">{resolved}</b> resolved</span>
            <span aria-hidden className="text-border">·</span>
            <span><b className="font-semibold text-foreground tabular-nums">{rules?.length ?? 0}</b> rules</span>
          </span>
        }
        actions={
          <>
            <Button variant="outline" onClick={toggleMute}>
              <BellOff className="size-4" /> {muted ? "Unmute notifications" : "Mute 1h"}
            </Button>
            <Button variant="outline" onClick={ackAll} disabled={firing === 0}>
              <Check className="size-4" /> Acknowledge all
            </Button>
          </>
        }
      >
        <Segmented<Tab>
          aria-label="Alerts view"
          value={tab}
          onChange={setTab}
          size="default"
          options={[
            { value: "history", label: "History", count: events ? list.length : undefined },
            { value: "rules", label: "Rules", count: rules?.length },
            { value: "channels", label: "Channels", count: channels?.length },
          ]}
        />
      </PageHeader>

      <PageBody className="motion-safe:animate-in fade-in-0 duration-300">
        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load alerts</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {error} <Button size="xs" variant="outline" onClick={load}>Retry</Button>
            </AlertDescription>
          </Alert>
        )}
        {muted && (
          <Alert>
            <BellOff />
            <AlertTitle>Notifications are muted</AlertTitle>
            <AlertDescription>Alerts are still recorded; nothing is sent until {new Date(muteUntil * 1000).toLocaleTimeString()}.</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <Skeleton className="h-[112px] rounded-xl" />
        ) : events && (
          <SummaryStrip
            items={[
              { label: "Firing", icon: Flame, value: firing, meta: "active alerts", tone: firing ? "bad" : undefined },
              { label: "Acknowledged", icon: Eye, value: ack, meta: "under review", tone: ack ? "warn" : undefined },
              { label: "Resolved", icon: CheckCircle2, value: resolved, meta: "cleared alerts" },
              { label: "Rules enabled", icon: BellRing, value: rules?.filter(r => r.enabled).length ?? 0, unit: `of ${rules?.length ?? 0}`, meta: `${channels?.filter(c => c.enabled).length ?? 0} channels active` },
            ]}
          />
        )}

        {tab === "history" && (
          <section aria-label="Alert history" className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full max-w-[280px]">
                <SearchInput
                  ref={searchRef}
                  className="max-w-none"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search title or target"
                  aria-label="Search alerts"
                />
                <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground sm:block">/</kbd>
              </div>
              <Segmented<StateFilter>
                aria-label="Filter by state"
                value={stateFilter}
                onChange={setStateFilter}
                options={[
                  { value: "all", label: "All" }, { value: "firing", label: "Firing" },
                  { value: "ack", label: "Ack" }, { value: "resolved", label: "Resolved" },
                ]}
              />
              <Select value={sevFilter} onValueChange={v => setSevFilter(v as SevFilter)} items={SEV_FILTERS}>
                <SelectTrigger size="sm" aria-label="Severity" className="w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>{SEV_FILTERS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={rangeFilter} onValueChange={v => setRangeFilter(v as RangeFilter)} items={RANGE_FILTERS}>
                <SelectTrigger size="sm" aria-label="Time range" className="w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>{RANGE_FILTERS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}</SelectContent>
              </Select>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">{filtered.length} of {list.length}</span>
            </div>

            {loading ? (
              <Card className="gap-0 divide-y p-0">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="m-3 h-10" />)}</Card>
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={Bell}
                title={list.length === 0 ? "No alerts yet" : "No alerts match your filter."}
                description={list.length === 0
                  ? (rules?.length ? "Nothing has triggered. Alerts appear here the moment a rule fires." : "Create a rule to start watching your server.")
                  : "Try a different search, state, severity or time range."}
                action={list.length === 0
                  ? (!rules?.length ? <Button onClick={() => { setTab("rules"); setRuleDialog("new") }}><Plus className="size-4" /> New rule</Button> : undefined)
                  : <Button variant="outline" size="sm" onClick={resetFilters}>Clear filters</Button>}
              />
            ) : (
              <>
                <ul className="space-y-3 md:hidden" aria-label="Alerts">
                  {filtered.map(alert => (
                    <li key={alert.id} className={cn("space-y-2.5 rounded-xl border bg-card p-3.5 shadow-card", alert.state === "firing" && "bg-danger/5")}>
                      <div className="flex items-center gap-2">
                        <SevLabel severity={alert.severity} />
                        <span className="ml-auto"><StatePill state={alert.state} /></span>
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium break-words">
                          {alert.rule}{alert.target && alert.target !== "host" && <span className="font-normal text-muted-foreground"> — {alert.target}</span>}
                        </p>
                        <p className="mt-0.5 text-xs break-words text-muted-foreground">{alert.message}</p>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground" title={new Date(alert.firedAt).toLocaleString()}>{ago(alert.firedAt)}</span>
                        <div className="flex items-center gap-1">
                          <Button variant="outline" size="xs" disabled={alert.state !== "firing"} onClick={() => act(alert.id, "ack")} aria-label={`Acknowledge ${alert.rule}`}>Ack</Button>
                          <Button variant="outline" size="xs" disabled={alert.state === "resolved"} onClick={() => act(alert.id, "resolve")} aria-label={`Resolve ${alert.rule}`}>
                            <Check className="size-3" /> Resolve
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>

                <Card className="hidden gap-0 overflow-hidden py-0 md:block">
                  <div className="overflow-x-auto">
                    <Table className="min-w-[1000px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Severity</TableHead>
                          <TableHead>Alert</TableHead>
                          <TableHead>Target</TableHead>
                          <TableHead>Detail</TableHead>
                          <TableHead>Time</TableHead>
                          <TableHead>State</TableHead>
                          <TableHead className={cn(STICKY, "text-right")}>Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filtered.map(alert => (
                          <TableRow key={alert.id} className={cn("h-[52px]", alert.state === "firing" && "bg-danger/5")}>
                            <TableCell><SevLabel severity={alert.severity} /></TableCell>
                            <TableCell className="max-w-[260px]"><Truncate text={alert.rule} className="font-medium" /></TableCell>
                            <TableCell className="max-w-[12rem] text-xs text-muted-foreground"><Truncate mono text={alert.target} /></TableCell>
                            <TableCell className="max-w-[300px]">
                              <Truncate text={alert.message} className="text-xs text-muted-foreground" />
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-muted-foreground" title={new Date(alert.firedAt).toLocaleString()}>{ago(alert.firedAt)}</TableCell>
                            <TableCell><StatePill state={alert.state} /></TableCell>
                            <TableCell className={STICKY}>
                              <div className="flex justify-end gap-1">
                                <Button variant="ghost" size="xs" disabled={alert.state !== "firing"} onClick={() => act(alert.id, "ack")} aria-label={`Acknowledge ${alert.rule}`}>Ack</Button>
                                <Button variant="outline" size="xs" disabled={alert.state === "resolved"} onClick={() => act(alert.id, "resolve")} aria-label={`Resolve ${alert.rule}`}>Resolve</Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </Card>
              </>
            )}
          </section>
        )}

        {tab === "rules" && (
          <>
            <div className="flex justify-end">
              <Button onClick={() => setRuleDialog("new")}><Plus className="size-4" /> New rule</Button>
            </div>
            {rules === null ? (
              <Skeleton className="h-40 rounded-xl" />
            ) : rules.length === 0 ? (
              <EmptyState
                icon={BellRing} title="No rules yet"
                description="Rules watch CPU, memory, disk, containers and deployments, and raise an alert when something is wrong."
                action={<Button onClick={() => setRuleDialog("new")}><Plus className="size-4" /> New rule</Button>}
              />
            ) : (
              <>
              <ul className="space-y-3 md:hidden" aria-label="Rules">
                {rules.map(rule => (
                  <li key={rule.id} className="space-y-2.5 rounded-xl border bg-card p-3.5 shadow-card">
                    <div className="flex items-center gap-2">
                      <Truncate text={rule.name} className="flex-1 text-sm font-medium" />
                      <Pill tone={SEV[rule.severity]?.tone ?? "info"}>{SEV[rule.severity]?.label ?? rule.severity}</Pill>
                    </div>
                    <code className="block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">{ruleExpr(rule)}</code>
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="mr-1 text-xs text-muted-foreground">Notifies</span>
                      {rule.channelIds.length === 0
                        ? <Pill tone="outline">all channels</Pill>
                        : rule.channelIds.map(id => <Pill key={id} tone="outline">{channelName(id)}</Pill>)}
                    </div>
                    <div className="flex items-center justify-between">
                      <Switch checked={rule.enabled} onCheckedChange={v => toggleRule(rule, v)} aria-label={`Enable rule ${rule.name}`} />
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${rule.name}`} onClick={() => setRuleDialog(rule)}><Pencil className="size-4" /></Button>
                        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${rule.name}`} onClick={() => setConfirm({ kind: "rule", id: rule.id, name: rule.name })}><Trash2 className="size-4 text-danger" /></Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              <Card className="hidden gap-0 overflow-x-auto py-0 md:block">
                <Table className="min-w-[860px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">On</TableHead>
                      <TableHead>Rule</TableHead>
                      <TableHead>Condition</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead>Notifies</TableHead>
                      <TableHead className="w-24"><span className="sr-only">Actions</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rules.map(rule => (
                      <TableRow key={rule.id}>
                        <TableCell><Switch checked={rule.enabled} onCheckedChange={v => toggleRule(rule, v)} aria-label={`Enable rule ${rule.name}`} /></TableCell>
                        <TableCell className="max-w-[16rem]">
                          <Truncate text={rule.name} className="font-medium" />
                          {metricOf(rule.metric)?.percent && rule.duration > 0 && (
                            <span className="text-[11px] text-muted-foreground">for {rule.duration >= 60 ? `${Math.round(rule.duration / 60)}m` : `${rule.duration}s`}</span>
                          )}
                        </TableCell>
                        <TableCell className="max-w-[18rem]"><Truncate mono text={ruleExpr(rule)} className="w-fit max-w-full rounded bg-muted px-2 py-0.5 text-xs" /></TableCell>
                        <TableCell><Pill tone={SEV[rule.severity]?.tone ?? "info"}>{SEV[rule.severity]?.label ?? rule.severity}</Pill></TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            {rule.channelIds.length === 0
                              ? <Pill tone="outline">all channels</Pill>
                              : rule.channelIds.map(id => <Pill key={id} tone="outline">{channelName(id)}</Pill>)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${rule.name}`} onClick={() => setRuleDialog(rule)}><Pencil className="size-4" /></Button>
                            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${rule.name}`} onClick={() => setConfirm({ kind: "rule", id: rule.id, name: rule.name })}><Trash2 className="size-4 text-danger" /></Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
              </>
            )}
          </>
        )}

        {tab === "channels" && (
          <>
            <div className="flex justify-end">
              <Button onClick={() => setChannelDialog("new")}><Plus className="size-4" /> Add channel</Button>
            </div>
            {channels === null ? (
              <Skeleton className="h-40 rounded-xl" />
            ) : channels.length === 0 ? (
              <EmptyState
                icon={Send} title="No notification channels"
                description="Add Slack, Discord, Telegram, email or a webhook so alerts reach you when you are not looking at the panel."
                action={<Button onClick={() => setChannelDialog("new")}><Plus className="size-4" /> Add channel</Button>}
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {channels.map(ch => {
                  const meta = CHANNEL_META[ch.type] ?? CHANNEL_META.webhook
                  return (
                    <Card key={ch.id}>
                      <CardContent className="space-y-3">
                        <div className="flex items-start justify-between">
                          <span className="grid size-9 place-items-center rounded-lg bg-[color-mix(in_srgb,var(--hue)_14%,transparent)] text-[var(--hue)]">
                            <meta.icon className="size-[18px]" />
                          </span>
                          <Switch checked={ch.enabled} onCheckedChange={v => toggleChannel(ch, v)} aria-label={`Enable channel ${ch.name}`} />
                        </div>
                        <div className="min-w-0">
                          <Truncate text={ch.name} className="text-sm font-medium" />
                          <Truncate text={`${meta.label}${ch.summary ? ` · ${ch.summary}` : ""}`} className="mt-0.5 text-xs text-muted-foreground" />
                        </div>
                        <div className="flex gap-1 border-t pt-2">
                          <Button variant="outline" size="xs" onClick={() => testChannel(ch)}><Send className="size-3" /> Test</Button>
                          <Button variant="ghost" size="xs" onClick={() => setChannelDialog(ch)}><Pencil className="size-3" /> Edit</Button>
                          <Button variant="ghost" size="xs" className="ml-auto text-danger" onClick={() => setConfirm({ kind: "channel", id: ch.id, name: ch.name })}><Trash2 className="size-3" /> Delete</Button>
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            )}
          </>
        )}
      </PageBody>

      <RuleDialog
        value={ruleDialog} channels={channels ?? []}
        onClose={() => setRuleDialog(null)}
        onSaved={r => { setRules(prev => { const p = prev ?? []; return p.some(x => x.id === r.id) ? p.map(x => (x.id === r.id ? r : x)) : [r, ...p] }); setRuleDialog(null) }}
      />
      <ChannelDialog
        value={channelDialog}
        onClose={() => setChannelDialog(null)}
        onSaved={c => { setChannels(prev => { const p = prev ?? []; return p.some(x => x.id === c.id) ? p.map(x => (x.id === c.id ? c : x)) : [c, ...p] }); setChannelDialog(null) }}
      />
      <ConfirmDialog
        open={!!confirm} onOpenChange={o => { if (!o) setConfirm(null) }}
        title={`Delete ${confirm?.kind ?? ""}?`} items={confirm ? [{ primary: confirm.name }] : undefined}
        note="This cannot be undone." confirmLabel="Delete" loading={busy} onConfirm={doDelete}
      />
    </>
  )
}

/** PATCH helper (lib/api exposes get/post/delete only). */
async function patch(path: string, body: unknown) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_GO_API ?? ""}${path}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
  if (!res.ok) {
    if (res.status === 401 && window.location.pathname !== "/login") window.location.href = "/login"
    const b = await res.json().catch(() => ({})) as { error?: string }
    const err = new Error(b.error ?? `${res.status} request failed`)
    ;(err as ApiError).status = res.status
    throw err
  }
  return res.json()
}

async function sendJSON<T>(method: "POST" | "PATCH", path: string, body: unknown): Promise<T> {
  if (method === "POST") return nodeApi.post<T>(path, body)
  return patch(path, body) as Promise<T>
}

function Field({ id, label, children, hint }: { id: string; label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function RuleDialog({ value, channels, onClose, onSaved }: {
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

function ChannelDialog({ value, onClose, onSaved }: {
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
