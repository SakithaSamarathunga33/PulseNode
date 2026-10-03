"use client"

import { useState, useEffect, useMemo, useRef } from "react"
import {
  Bell, BellOff, Mail, MessageSquare, Zap, Siren,
  AlertTriangle, Info, CheckCircle2, XCircle, Check, BellRing, Flame, Eye,
} from "lucide-react"
import { ALERTS, ALERT_RULES } from "@/lib/mock-data"
import { getSocket } from "@/lib/socket"
import type { Alert as AlertT, AlertRule } from "@/lib/types"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { SearchInput } from "@/components/pn/SearchInput"
import { Segmented } from "@/components/pn/Segmented"
import { EmptyState } from "@/components/pn/EmptyState"
import { StatCard } from "@/components/dashboard/StatCard"
import { Pill } from "@/components/dashboard/Pill"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

type Row = AlertT & { uid: number; fresh?: boolean }

const SEV_META = {
  bad:  { icon: XCircle,       cls: "bg-danger/12 text-danger",   label: "Critical" },
  warn: { icon: AlertTriangle, cls: "bg-warning/14 text-warning", label: "Warning" },
  info: { icon: Info,          cls: "bg-info/12 text-info",       label: "Info" },
  ok:   { icon: CheckCircle2,  cls: "bg-success/12 text-success", label: "OK" },
} as const

function SevIcon({ sev }: { sev: AlertT["sev"] }) {
  const m = SEV_META[sev]
  if (!m) return <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><Bell className="size-4" /></span>
  const Icon = m.icon
  return (
    <span className={cn("grid size-8 shrink-0 place-items-center rounded-full", m.cls)} title={m.label}>
      <Icon className="size-4" aria-label={m.label} />
    </span>
  )
}

function StatePill({ state }: { state: string }) {
  switch (state) {
    case "firing":   return <Pill tone="bad" dot>Firing</Pill>
    case "ack":      return <Pill tone="warn" dot>Acknowledged</Pill>
    case "resolved": return <Pill tone="ok" dot>Resolved</Pill>
    default:         return <Pill tone="outline">{state}</Pill>
  }
}

const CHANNEL_CARDS = [
  { id: "email",     icon: Mail,          name: "Email",     desc: "Notifications to team inboxes via SMTP",           routes: 3 },
  { id: "slack",     icon: MessageSquare, name: "Slack",     desc: "Post alerts to #ops-alerts channel",               routes: 5 },
  { id: "pagerduty", icon: Zap,           name: "PagerDuty", desc: "Escalation & on-call routing for critical alerts", routes: 2 },
]

const MOCK_NEW_ALERT: AlertT = {
  sev: "bad", title: "Simulated: Memory spike detected", target: "coolify-db",
  time: "just now", rule: "host.mem > 92% for 3m", state: "firing",
}

type Tab = "history" | "rules" | "channels"
type StateFilter = "all" | "firing" | "ack" | "resolved"

export default function AlertsPage() {
  const uidRef = useRef(0)
  const nextUid = () => ++uidRef.current
  const [activeTab, setActiveTab] = useState<Tab>("history")
  const [alerts, setAlerts] = useState<Row[]>(() => ALERTS.map(a => ({ ...a, uid: ++uidRef.current })))
  const [rules, setRules] = useState<AlertRule[]>(ALERT_RULES)
  const [stateFilter, setStateFilter] = useState<StateFilter>("all")
  const [search, setSearch] = useState("")

  const firing   = alerts.filter(a => a.state === "firing").length
  const ack      = alerts.filter(a => a.state === "ack").length
  const resolved = alerts.filter(a => a.state === "resolved").length

  useEffect(() => {
    const socket = getSocket()
    const handler = (alert: AlertT) => {
      setAlerts(prev => [{ ...alert, time: "just now", uid: nextUid(), fresh: true }, ...prev])
    }
    socket.on("alert:new", handler)
    return () => { socket.off("alert:new", handler) }
  }, [])

  function simulateAlert() {
    setAlerts(prev => [{ ...MOCK_NEW_ALERT, time: "just now", uid: nextUid(), fresh: true }, ...prev])
  }

  function setState(uid: number, state: AlertT["state"]) {
    setAlerts(prev => prev.map(a => a.uid === uid ? { ...a, state } : a))
  }

  function toggleRule(idx: number, enabled: boolean) {
    setRules(prev => prev.map((r, i) => i === idx ? { ...r, enabled } : r))
  }

  const filteredAlerts = useMemo(() => alerts.filter(a => {
    const matchState = stateFilter === "all" || a.state === stateFilter
    const q = search.toLowerCase()
    const matchSearch = !q || a.title.toLowerCase().includes(q) || a.target.toLowerCase().includes(q)
    return matchState && matchSearch
  }), [alerts, stateFilter, search])

  return (
    <>
      <PageHeader
        icon={Siren}
        title="Alerts"
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Pill tone={firing > 0 ? "bad" : "outline"} dot={firing > 0}>{firing} firing</Pill>
            <Pill tone={ack > 0 ? "warn" : "outline"} dot={ack > 0}>{ack} ack</Pill>
            <Pill tone="ok" dot>{resolved} resolved</Pill>
            <span className="tabular-nums">{rules.length} rules configured</span>
          </span>
        }
        actions={
          <>
            {process.env.NODE_ENV !== "production" && (
              <Button variant="outline" onClick={simulateAlert}>Simulate alert</Button>
            )}
            <Button
              variant="outline"
              onClick={() => setAlerts(prev => prev.map(a => a.state === "firing" ? { ...a, state: "ack" } : a))}
            >
              <BellOff className="size-4" /> Mute all
            </Button>
          </>
        }
      >
        <Tabs value={activeTab} onValueChange={v => setActiveTab(v as Tab)}>
          <TabsList variant="line">
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="rules">Rules</TabsTrigger>
            <TabsTrigger value="channels">Channels</TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>

      <PageBody className="motion-safe:animate-in fade-in-0 duration-300">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard icon={Flame} label="Firing" value={firing} tone="bad" sub="active alerts" />
          <StatCard icon={Eye} label="Acknowledged" value={ack} tone="warn" sub="under review" />
          <StatCard icon={CheckCircle2} label="Resolved" value={resolved} tone="ok" sub="cleared alerts" />
          <StatCard icon={BellRing} label="Rules enabled" value={rules.filter(r => r.enabled).length} tone="acc" sub={`of ${rules.length}`} />
        </div>

        {activeTab === "history" && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search alerts…"
                aria-label="Search alerts"
              />
              <Segmented<StateFilter>
                aria-label="Filter by state"
                value={stateFilter}
                onChange={setStateFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "firing", label: "Firing" },
                  { value: "ack", label: "Ack" },
                  { value: "resolved", label: "Resolved" },
                ]}
              />
            </div>

            {filteredAlerts.length === 0 ? (
              <EmptyState icon={Bell} title="No alerts match your filter" description="Try a different search or state." />
            ) : (
              <Card className="gap-0 divide-y overflow-hidden p-0">
                {filteredAlerts.map(alert => (
                  <div
                    key={alert.uid}
                    className={cn(
                      "flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-muted/40",
                      alert.fresh && "motion-safe:animate-in fade-in-0 slide-in-from-top-2 duration-300",
                    )}
                  >
                    <SevIcon sev={alert.sev} />
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="truncate text-sm font-medium">{alert.title}</p>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        {alert.target}{alert.rule && ` · ${alert.rule}`}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">{alert.time}</span>
                    <StatePill state={alert.state} />
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={alert.state !== "firing"}
                        onClick={() => setState(alert.uid, "ack")}
                      >
                        Ack
                      </Button>
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={alert.state === "resolved"}
                        onClick={() => setState(alert.uid, "resolved")}
                      >
                        <Check className="size-3" /> Resolve
                      </Button>
                    </div>
                  </div>
                ))}
              </Card>
            )}
          </>
        )}

        {activeTab === "rules" && (
          <Card className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">On</TableHead>
                  <TableHead>Rule</TableHead>
                  <TableHead>Expression</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Channels</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule, i) => (
                  <TableRow key={rule.name}>
                    <TableCell>
                      <Switch
                        checked={rule.enabled}
                        onCheckedChange={v => toggleRule(i, v)}
                        aria-label={`Enable rule ${rule.name}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{rule.name}</TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{rule.expr}</code>
                    </TableCell>
                    <TableCell>
                      <Pill tone={rule.sev === "bad" ? "bad" : rule.sev === "warn" ? "warn" : "info"}>
                        {rule.sev === "bad" ? "Critical" : rule.sev === "warn" ? "Warning" : "Info"}
                      </Pill>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        {rule.channels.map(ch => <Pill key={ch} tone="outline">{ch}</Pill>)}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}

        {activeTab === "channels" && (
          <>
            <Alert>
              <Info className="size-4" />
              <AlertDescription>Sample data — notification channels are not configurable yet.</AlertDescription>
            </Alert>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {CHANNEL_CARDS.map(ch => {
                const Icon = ch.icon
                return (
                  <Card key={ch.id}>
                    <CardContent className="space-y-3">
                      <div className="flex items-start justify-between">
                        <span className="grid size-9 place-items-center rounded-lg bg-[color-mix(in_srgb,var(--hue)_14%,transparent)] text-[var(--hue)]">
                          <Icon className="size-[18px]" />
                        </span>
                        <Pill tone="ok" dot>Connected</Pill>
                      </div>
                      <div>
                        <p className="text-sm font-medium">{ch.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{ch.desc}</p>
                      </div>
                      <p className="border-t pt-2 text-xs text-muted-foreground tabular-nums">{ch.routes} routes</p>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </>
        )}
      </PageBody>
    </>
  )
}
