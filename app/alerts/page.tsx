"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  Bell, BellOff, Send, Siren, CheckCircle2, Check, BellRing, Flame, Eye, Plus, Pencil, Trash2, AlertCircle,
} from "lucide-react"
import { nodeApi } from "@/lib/api"
import { getSocket } from "@/lib/socket"
import { useSlashFocus } from "@/lib/use-slash-focus"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { SearchInput } from "@/components/pn/SearchInput"
import { Segmented } from "@/components/pn/Segmented"
import { ViewNav } from "@/components/pn/ViewNav"
import { EmptyState } from "@/components/pn/EmptyState"
import { SummaryStrip } from "@/components/pn/SummaryStrip"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import { Pill } from "@/components/dashboard/Pill"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { Truncate } from "@/components/pn/Truncate"
import { RuleDialog } from "@/components/alerts/RuleDialog"
import { ChannelDialog } from "@/components/alerts/ChannelDialog"
import { AlertsChart } from "@/components/alerts/AlertsChart"
import {
  CHANNEL_META, HISTORY_LIMIT, SEV, errMsg, metricOf, patch, type AlertEvent, type Channel, type Rule,
} from "@/components/alerts/shared"

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
        nodeApi.get<AlertEvent[]>(`/api/alerts/history?limit=${HISTORY_LIMIT}`),
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
        <ViewNav<Tab>
          aria-label="Alerts view"
          value={tab}
          onChange={setTab}
          options={[
            { value: "history", label: events ? `History · ${list.length}` : "History" },
            { value: "rules", label: rules ? `Rules · ${rules.length}` : "Rules" },
            { value: "channels", label: channels ? `Channels · ${channels.length}` : "Channels" },
          ]}
        />
      </PageHeader>

      <PageBody>
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
            {events && events.length > 0 && <AlertsChart events={events} />}
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
                <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-2xs text-muted-foreground sm:block">/</kbd>
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
                <SelectTrigger aria-label="Severity" className="w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>{SEV_FILTERS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={rangeFilter} onValueChange={v => setRangeFilter(v as RangeFilter)} items={RANGE_FILTERS}>
                <SelectTrigger aria-label="Time range" className="w-[150px]"><SelectValue /></SelectTrigger>
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
                <Card className="gap-0 py-0 md:hidden">
                <ul className="divide-y" aria-label="Alerts">
                  {filtered.map(alert => (
                    <li key={alert.id} className={cn("space-y-2 p-4", alert.state === "firing" && "bg-danger/5")}>
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
                </Card>

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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Rules</h2>
              {rules?.length !== 0 && <Button onClick={() => setRuleDialog("new")}><Plus className="size-4" /> New rule</Button>}
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
              <Card className="gap-0 py-0 md:hidden">
              <ul className="divide-y" aria-label="Rules">
                {rules.map(rule => (
                  <li key={rule.id} className="space-y-2 p-4">
                    <div className="flex items-center gap-2">
                      <Truncate text={rule.name} className="flex-1 text-sm font-medium" />
                      <Pill tone={SEV[rule.severity]?.tone ?? "info"}>{SEV[rule.severity]?.label ?? rule.severity}</Pill>
                    </div>
                    <code className="block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">{ruleExpr(rule)}</code>
                    <p className="text-xs text-muted-foreground">
                      Notifies {rule.channelIds.length === 0 ? "all channels" : rule.channelIds.map(channelName).join(", ")}
                    </p>
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
              </Card>
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
                            <span className="text-2xs text-muted-foreground">for {rule.duration >= 60 ? `${Math.round(rule.duration / 60)}m` : `${rule.duration}s`}</span>
                          )}
                        </TableCell>
                        <TableCell className="max-w-[18rem]"><Truncate mono text={ruleExpr(rule)} className="w-fit max-w-full rounded bg-muted px-2 py-0.5 text-xs" /></TableCell>
                        <TableCell><Pill tone={SEV[rule.severity]?.tone ?? "info"}>{SEV[rule.severity]?.label ?? rule.severity}</Pill></TableCell>
                        <TableCell>
                          <span className="text-ui text-muted-foreground">
                            {rule.channelIds.length === 0 ? "all channels" : rule.channelIds.map(channelName).join(", ")}
                          </span>
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Notification channels</h2>
              {channels?.length !== 0 && <Button onClick={() => setChannelDialog("new")}><Plus className="size-4" /> Add channel</Button>}
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
              <Card className="gap-0 py-0">
                <ul className="divide-y" aria-label="Notification channels">
                  {channels.map(ch => {
                    const meta = CHANNEL_META[ch.type] ?? CHANNEL_META.webhook
                    return (
                      <li key={ch.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                        <Switch checked={ch.enabled} onCheckedChange={v => toggleChannel(ch, v)} aria-label={`Enable channel ${ch.name}`} />
                        <meta.icon className="size-4 shrink-0 text-[var(--hue)]" aria-hidden />
                        <div className="min-w-0 flex-1 basis-48">
                          <Truncate text={ch.name} className="text-sm font-medium" />
                          <Truncate text={`${meta.label}${ch.summary ? ` · ${ch.summary}` : ""}`} className="text-xs text-muted-foreground" />
                        </div>
                        <div className="flex items-center gap-1">
                          <Button variant="outline" size="xs" onClick={() => testChannel(ch)}><Send className="size-3" /> Test</Button>
                          <Button variant="ghost" size="xs" onClick={() => setChannelDialog(ch)}><Pencil className="size-3" /> Edit</Button>
                          <Button variant="ghost" size="xs" className="text-danger" onClick={() => setConfirm({ kind: "channel", id: ch.id, name: ch.name })}><Trash2 className="size-3" /> Delete</Button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </Card>
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
