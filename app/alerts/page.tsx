"use client"

import { useState, useRef, useEffect } from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import {
  Bell, BellOff, Plus, Mail, MessageSquare, Zap,
  ExternalLink, ChevronDown, Search, CheckCheck,
  AlertTriangle, Info, CheckCircle, XCircle, Edit2, Trash2, Copy,
} from "lucide-react"
import { ALERTS, ALERT_RULES } from "@/lib/mock-data"
import { getSocket } from "@/lib/socket"
import { StatCard } from "@/components/dashboard/StatCard"
import { Pill } from "@/components/dashboard/Pill"
import { cn } from "@/lib/utils"
import type { Alert } from "@/lib/types"

// ── Helpers ────────────────────────────────────────────────────────────────────

function FilterChip({ label, value }: { label: string; value: string }) {
  return (
    <button className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-pn-navylt border border-pn-border/10 text-xs text-helm-fg3 hover:text-helm-fg transition-colors">
      <span className="text-helm-fg4 text-[10px]">{label}</span>
      <span className="text-helm-fg">{value}</span>
      <ChevronDown size={10} />
    </button>
  )
}

function SevIcon({ sev }: { sev: string }) {
  const base = "w-7 h-7 rounded-full flex items-center justify-center shrink-0"
  switch (sev) {
    case "bad":  return <div className={cn(base)} style={{ background: "var(--color-error-soft)", color: "var(--color-error)" }}><XCircle size={13} /></div>
    case "warn": return <div className={cn(base)} style={{ background: "var(--color-warning-soft)", color: "var(--color-warning)" }}><AlertTriangle size={13} /></div>
    case "info": return <div className={cn(base)} style={{ background: "var(--color-info-soft)", color: "var(--color-info-status)" }}><Info size={13} /></div>
    case "ok":   return <div className={cn(base)} style={{ background: "var(--color-ok-soft)", color: "var(--color-ok)" }}><CheckCircle size={13} /></div>
    default:     return <div className={cn(base, "bg-pn-navylt text-helm-fg3")}><Bell size={13} /></div>
  }
}

function statePill(state: string) {
  switch (state) {
    case "firing":   return <Pill tone="bad"  dot>Firing</Pill>
    case "ack":      return <Pill tone="warn" dot>Acknowledged</Pill>
    case "resolved": return <Pill tone="ok"   dot>Resolved</Pill>
    default:         return <Pill tone="outline">{state}</Pill>
  }
}

function ToggleSwitch({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={cn(
        "w-8 h-4 rounded-full relative cursor-pointer transition-colors duration-200 focus:outline-hidden",
        enabled ? "bg-pn-cyan" : "bg-pn-navylt border border-pn-border/20"
      )}
    >
      <span className={cn(
        "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform duration-200",
        enabled ? "translate-x-4" : "translate-x-0.5"
      )} />
    </button>
  )
}

const CHANNEL_CARDS = [
  { id: "email",     icon: <Mail size={18} style={{ color: "var(--pn-cyan)" }} />,        name: "Email",     desc: "Notifications to team inboxes via SMTP",          connected: true, routes: 3 },
  { id: "slack",     icon: <MessageSquare size={18} style={{ color: "var(--pn-blue)" }} />, name: "Slack",     desc: "Post alerts to #ops-alerts channel",              connected: true, routes: 5 },
  { id: "pagerduty", icon: <Zap size={18} style={{ color: "var(--color-warning)" }} />,    name: "PagerDuty", desc: "Escalation & on-call routing for critical alerts", connected: true, routes: 2 },
]

const MOCK_NEW_ALERT: Alert = {
  sev: "bad", title: "Simulated: Memory spike detected", target: "coolify-db",
  time: "just now", rule: "host.mem > 92% for 3m", state: "firing",
}

const TABS = ["history", "rules", "channels"] as const
type Tab = typeof TABS[number]

// ── Page ───────────────────────────────────────────────────────────────────────

export default function AlertsPage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [activeTab, setActiveTab]     = useState<Tab>("history")
  const [alerts, setAlerts]           = useState<Alert[]>(ALERTS)
  const [rules, setRules]             = useState(ALERT_RULES)
  const [stateFilter, setStateFilter] = useState("all")
  const [search, setSearch]           = useState("")

  const firing   = alerts.filter(a => a.state === "firing").length
  const ack      = alerts.filter(a => a.state === "ack").length
  const resolved = alerts.filter(a => a.state === "resolved").length

  useEffect(() => {
    const socket = getSocket()
    const handler = (alert: Alert) => {
      setAlerts(prev => [{ ...alert, time: "just now" }, ...prev])
      requestAnimationFrame(() =>
        gsap.fromTo(".alert-row-new",
          { opacity: 0, y: -40 },
          { opacity: 1, y: 0, duration: 0.5, ease: "back.out(1.4)" }
        )
      )
    }
    socket.on("alert:new", handler)
    return () => { socket.off("alert:new", handler) }
  }, [])

  useGSAP(() => {
    gsap.fromTo(
      containerRef.current?.querySelectorAll(".gsap-enter") ?? [],
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5, stagger: 0.08, ease: "power2.out" }
    )
  }, { scope: containerRef })

  function simulateAlert() {
    setAlerts(prev => [{ ...MOCK_NEW_ALERT, time: "just now" }, ...prev])
    requestAnimationFrame(() =>
      gsap.fromTo(".alert-row-new",
        { opacity: 0, y: -40 },
        { opacity: 1, y: 0, duration: 0.5, ease: "back.out(1.4)" }
      )
    )
  }

  function toggleRule(idx: number) {
    setRules(prev => prev.map((r, i) => i === idx ? { ...r, enabled: !r.enabled } : r))
  }

  const filteredAlerts = alerts.filter(a => {
    const matchState  = stateFilter === "all" || a.state === stateFilter
    const matchSearch = !search || a.title.toLowerCase().includes(search.toLowerCase()) || a.target.toLowerCase().includes(search.toLowerCase())
    return matchState && matchSearch
  })

  return (
    <div ref={containerRef} className="p-6 space-y-5">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="gsap-enter flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-helm-fg flex items-center gap-2">
            <Bell size={18} style={{ color: "var(--pn-cyan)" }} />
            Alerts
          </h1>
          <p className="text-sm text-helm-fg3 mt-1">
            <span className="font-medium" style={{ color: "var(--color-error)" }}>{firing} firing</span>
            {" · "}
            <span className="font-medium" style={{ color: "var(--color-warning)" }}>{ack} ack</span>
            {" · "}
            <span className="font-medium" style={{ color: "var(--color-ok)" }}>{resolved} resolved</span>
            {" · "}
            <span className="text-helm-fg3">{rules.length} rules configured</span>
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {process.env.NODE_ENV !== "production" && (
            <button onClick={simulateAlert} className="border border-amber-500/30 text-amber-400 hover:text-amber-300 px-3 py-1.5 rounded-lg text-xs transition-colors">
              Simulate Alert
            </button>
          )}
          <button
            onClick={() => setAlerts(prev => prev.map(a => a.state === "firing" ? { ...a, state: "ack" } : a))}
            className="flex items-center gap-1 border border-pn-border/10 text-helm-fg3 hover:text-helm-fg px-3 py-1.5 rounded-lg text-xs transition-colors"
          >
            <BellOff size={12} /> Mute all
          </button>
          <button
            onClick={() => setActiveTab("rules")}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white text-xs font-medium transition-colors"
            style={{ background: "var(--pn-cyan)" }}
          >
            <Plus size={12} /> New rule
          </button>
        </div>
      </div>

      {/* ── Stat Cards ──────────────────────────────────────────────────────── */}
      <div className="gsap-enter grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Firing"        value={firing}   tone="bad"  sub="active alerts" />
        <StatCard label="Acknowledged"  value={ack}      tone="warn" sub="under review" />
        <StatCard label="Resolved 24h"  value={resolved} tone="ok"   sub="auto-cleared" />
        <StatCard label="MTTR 7d"       value="14m"      tone="info" animate={false} sub="mean time to resolve" />
      </div>

      {/* ── Tab Bar ─────────────────────────────────────────────────────────── */}
      <div className="gsap-enter">

        {/* Tab triggers */}
        <div className="flex border-b border-pn-border/8">
          {TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "px-4 py-2.5 text-sm capitalize transition-colors border-b-2 -mb-px",
                activeTab === tab
                  ? "text-helm-fg border-pn-cyan font-medium"
                  : "text-helm-fg3 border-transparent hover:text-helm-fg2"
              )}
            >
              {tab === "history" ? "History" : tab === "rules" ? "Rules" : "Channels"}
            </button>
          ))}
        </div>

        {/* ── History ─────────────────────────────────────────────────────── */}
        {activeTab === "history" && (
          <div className="mt-4 rounded-xl border border-pn-border/8 overflow-hidden shadow-card" style={{ background: "var(--pn-navy-light)" }}>

            {/* Filter row */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-pn-border/8 flex-wrap">
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-helm-fg3" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search alerts…"
                  className="pl-8 pr-3 py-1.5 rounded-lg text-xs text-helm-fg placeholder:text-helm-fg4 focus:outline-hidden"
                  style={{ background: "var(--helm-bg-2)", border: "1px solid rgb(var(--pn-border-rgb)/0.08)" }}
                />
              </div>

              {/* State filter */}
              <div className="flex items-center rounded-lg overflow-hidden" style={{ border: "1px solid rgb(var(--pn-border-rgb)/0.08)" }}>
                {["all","firing","ack","resolved"].map(s => (
                  <button
                    key={s}
                    onClick={() => setStateFilter(s)}
                    className={cn(
                      "px-3 py-1.5 text-xs capitalize transition-colors",
                      stateFilter === s ? "text-pn-cyan" : "text-helm-fg3 hover:text-helm-fg"
                    )}
                    style={stateFilter === s ? { background: "var(--pn-accent-soft)" } : {}}
                  >
                    {s === "ack" ? "Ack" : s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>

              <FilterChip label="Severity" value="All" />
              <FilterChip label="Range"    value="7d" />

              <button className="ml-auto flex items-center gap-1 text-xs transition-colors" style={{ color: "var(--pn-cyan)" }}>
                <CheckCheck size={12} /> Mark all read
              </button>
            </div>

            {/* Alert rows */}
            <div>
              {filteredAlerts.map((alert, i) => {
                const isNew = i === 0 && alert.time === "just now"
                return (
                  <div
                    key={`${alert.title}-${i}`}
                    className={cn(
                      "grid items-center gap-4 px-4 py-3 transition-colors",
                      isNew && "alert-row-new"
                    )}
                    style={{
                      gridTemplateColumns: "32px 1fr 120px 130px 130px",
                      borderBottom: "1px solid rgb(var(--pn-border-rgb)/0.06)",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.025)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "")}
                  >
                    <SevIcon sev={alert.sev} />
                    <div className="min-w-0">
                      <p className="text-sm text-helm-fg font-medium truncate">{alert.title}</p>
                      <p className="text-[11px] text-helm-fg3 mt-0.5 truncate font-mono">
                        {alert.target}{alert.rule && ` · ${alert.rule}`}
                      </p>
                    </div>
                    <span className="text-xs text-helm-fg3 text-right">{alert.time}</span>
                    {statePill(alert.state)}
                    <div className="flex items-center gap-1 justify-end">
                      <button className="px-2 py-1 rounded-lg text-xs text-helm-fg3 hover:text-helm-fg transition-colors" style={{ border: "1px solid rgb(var(--pn-border-rgb)/0.10)" }}>Ack</button>
                      <button className="px-2 py-1 rounded-lg text-xs text-helm-fg3 hover:text-helm-fg transition-colors" style={{ border: "1px solid rgb(var(--pn-border-rgb)/0.10)" }}>Resolve</button>
                    </div>
                  </div>
                )
              })}
              {filteredAlerts.length === 0 && (
                <div className="py-12 text-center text-helm-fg3 text-sm">No alerts match your filter</div>
              )}
            </div>
          </div>
        )}

        {/* ── Rules ───────────────────────────────────────────────────────── */}
        {activeTab === "rules" && (
          <div className="mt-4 rounded-xl border border-pn-border/8 overflow-hidden shadow-card" style={{ background: "var(--pn-navy-light)" }}>
            <table className="pn-table w-full">
              <thead>
                <tr>
                  <th>On</th>
                  <th>Rule</th>
                  <th>Expression</th>
                  <th>Severity</th>
                  <th>Channels</th>
                  <th className="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule, i) => (
                  <tr key={rule.name}>
                    <td><ToggleSwitch enabled={rule.enabled} onChange={() => toggleRule(i)} /></td>
                    <td><span className="text-sm font-medium text-helm-fg">{rule.name}</span></td>
                    <td>
                      <code className="text-[11px] font-mono text-helm-fg3 px-2 py-0.5 rounded" style={{ background: "var(--helm-bg-2)" }}>
                        {rule.expr}
                      </code>
                    </td>
                    <td>
                      <Pill tone={rule.sev === "bad" ? "bad" : rule.sev === "warn" ? "warn" : "info"}>
                        {rule.sev === "bad" ? "Critical" : rule.sev === "warn" ? "Warning" : "Info"}
                      </Pill>
                    </td>
                    <td>
                      <div className="flex items-center gap-1 flex-wrap">
                        {rule.channels.map(ch => <Pill key={ch} tone="outline">{ch}</Pill>)}
                      </div>
                    </td>
                    <td className="right">
                      <div className="flex items-center gap-1 justify-end">
                        <button className="p-1.5 rounded-lg text-helm-fg3 hover:text-helm-fg transition-colors" style={{ border: "1px solid rgb(var(--pn-border-rgb)/0.10)" }}><Edit2 size={11} /></button>
                        <button className="p-1.5 rounded-lg text-helm-fg3 hover:text-helm-fg transition-colors" style={{ border: "1px solid rgb(var(--pn-border-rgb)/0.10)" }}><Copy size={11} /></button>
                        <button className="p-1.5 rounded-lg text-red-400 hover:text-red-300 transition-colors" style={{ border: "1px solid rgba(239,68,68,0.2)" }}><Trash2 size={11} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Channels ────────────────────────────────────────────────────── */}
        {activeTab === "channels" && (
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {CHANNEL_CARDS.map(ch => (
              <div key={ch.id} className="rounded-xl border border-pn-border/8 shadow-card p-4 space-y-3" style={{ background: "var(--pn-navy-light)" }}>
                <div className="flex items-start justify-between">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: "var(--helm-bg-2)", border: "1px solid rgb(var(--pn-border-rgb)/0.08)" }}>
                    {ch.icon}
                  </div>
                  {ch.connected && <Pill tone="ok" dot>Connected</Pill>}
                </div>
                <div>
                  <p className="text-sm font-medium text-helm-fg">{ch.name}</p>
                  <p className="text-xs text-helm-fg3 mt-0.5">{ch.desc}</p>
                </div>
                <div className="flex items-center justify-between pt-2" style={{ borderTop: "1px solid rgb(var(--pn-border-rgb)/0.08)" }}>
                  <span className="text-xs text-helm-fg3">{ch.routes} routes</span>
                  <button className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-helm-fg3 hover:text-helm-fg transition-colors" style={{ border: "1px solid rgb(var(--pn-border-rgb)/0.10)" }}>
                    Configure <ExternalLink size={10} />
                  </button>
                </div>
              </div>
            ))}

            {/* Add channel */}
            <button
              className="rounded-xl border-2 border-dashed border-pn-border/10 hover:border-pn-cyan/30 p-4 flex flex-col items-center justify-center gap-2 text-helm-fg3 hover:text-helm-fg transition-colors min-h-[140px]"
            >
              <div className="w-9 h-9 rounded-lg border border-pn-border/10 flex items-center justify-center">
                <Plus size={16} />
              </div>
              <span className="text-xs">Add channel</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
