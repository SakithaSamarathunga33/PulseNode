"use client"

import { useEffect, useState } from "react"
import { CheckCircle2, Copy, Globe, Plus, RefreshCw, Star, Trash2, XCircle } from "lucide-react"

const GO_API = process.env.NEXT_PUBLIC_GO_API ?? ""

type SavedDomain = {
  host: string
  isPrimary: boolean
  pointed: boolean | null
  proxied: boolean
  records: string[] | null
  message?: string
  error?: string
  checkedAt?: string
}

type DomainsResponse = {
  domains: SavedDomain[]
  expectedIp: string
  aliases: string[]
}

type InUseRef = { source: string; ref: string; status?: string }
type InUseHost = { host: string; usedBy: InUseRef[] }

type CheckResult = {
  domain: string
  expectedIp: string
  records: string[] | null
  pointed: boolean
  proxied: boolean
  message?: string
  error?: string
}

function statusOf(d: SavedDomain): { label: string; color: string } {
  if (d.error) return { label: "Error", color: "var(--err)" }
  if (d.pointed === null) return { label: "Unchecked", color: "var(--fg-3)" }
  if (d.proxied) return { label: "Proxied", color: "var(--ok)" }
  if (d.pointed) return { label: "Pointed", color: "var(--ok)" }
  return { label: "Not pointed", color: "var(--err)" }
}

export default function DomainPage() {
  const [data, setData] = useState<DomainsResponse | null>(null)
  const [inUse, setInUse] = useState<InUseHost[]>([])
  const [newDomain, setNewDomain] = useState("")
  const [checkDomain, setCheckDomain] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [busyHost, setBusyHost] = useState("")
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState("")
  const [result, setResult] = useState<CheckResult | null>(null)

  const loadDomains = async () => {
    const r = await fetch(`${GO_API}/api/domains`, { cache: "no-store" })
    if (r.ok) setData(await r.json())
  }

  const loadInUse = async () => {
    const r = await fetch(`${GO_API}/api/domains/in-use`, { cache: "no-store" })
    if (r.ok) {
      const d = await r.json()
      setInUse(d.hosts ?? [])
    }
  }

  useEffect(() => {
    Promise.all([loadDomains(), loadInUse()]).finally(() => setLoading(false))
  }, [])

  const save = async (host: string) => {
    const value = host.trim()
    if (!value) return
    setSaving(true)
    setMessage("")
    try {
      const r = await fetch(`${GO_API}/api/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: value }),
      })
      const d = await r.json()
      if (!r.ok) {
        setMessage(d.error || "Failed to save domain")
        return
      }
      setData(d)
      setNewDomain("")
      await loadInUse()
    } finally {
      setSaving(false)
    }
  }

  const act = async (host: string, action: "recheck" | "primary") => {
    setBusyHost(host)
    try {
      const r = await fetch(`${GO_API}/api/domains/${encodeURIComponent(host)}/${action}`, { method: "POST" })
      if (r.ok) setData(await r.json())
    } finally {
      setBusyHost("")
    }
  }

  const remove = async (host: string) => {
    setBusyHost(host)
    try {
      const r = await fetch(`${GO_API}/api/domains/${encodeURIComponent(host)}`, { method: "DELETE" })
      if (r.ok) setData(await r.json())
    } finally {
      setBusyHost("")
    }
  }

  const check = async () => {
    setChecking(true)
    setMessage("")
    setResult(null)
    try {
      const q = encodeURIComponent(checkDomain)
      const r = await fetch(`${GO_API}/api/domain/check?domain=${q}`, { cache: "no-store" })
      const d = await r.json()
      if (!r.ok) {
        setMessage(d.error || "Failed to check DNS")
        return
      }
      setResult(d)
    } finally {
      setChecking(false)
    }
  }

  const copy = (value: string) => {
    navigator.clipboard.writeText(value).catch(() => {})
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw size={20} className="animate-spin" style={{ color: "var(--fg-3)" }} />
      </div>
    )
  }

  const expectedIp = data?.expectedIp || ""
  const aliases = data?.aliases || []
  const savedHosts = new Set((data?.domains || []).map(d => d.host))

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold" style={{ color: "var(--fg)" }}>Domain</h1>
        <p className="text-sm mt-0.5" style={{ color: "var(--fg-3)" }}>
          Save the domains you use, verify their DNS, and see what each container is serving.
        </p>
      </div>

      {/* Saved domains */}
      <section className="rounded-xl p-5 space-y-4" style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2">
          <Globe size={16} style={{ color: "var(--acc)" }} />
          <h2 className="text-sm font-semibold" style={{ color: "var(--fg)" }}>Saved domains</h2>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={newDomain}
            onChange={e => setNewDomain(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") save(newDomain) }}
            placeholder="example.com or app.example.com"
            className="flex-1 px-3 py-2 rounded-lg text-sm outline-hidden font-mono"
            style={{ background: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)" }}
          />
          <button
            onClick={() => save(newDomain)}
            disabled={saving || !newDomain.trim()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
            style={{ background: "var(--acc)", color: "#fff" }}
          >
            {saving ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
            Save
          </button>
        </div>

        {message && (
          <p className="text-xs" style={{ color: message.includes("Failed") ? "var(--err)" : "var(--ok)" }}>{message}</p>
        )}

        <div className="space-y-2">
          {(data?.domains || []).length === 0 && (
            <p className="text-xs" style={{ color: "var(--fg-3)" }}>No saved domains yet.</p>
          )}
          {(data?.domains || []).map(d => {
            const st = statusOf(d)
            const busy = busyHost === d.host
            return (
              <div key={d.host} className="rounded-lg px-3 py-2.5 space-y-1" style={{ background: "var(--bg-3)" }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-xs font-medium" style={{ color: "var(--fg)" }}>{d.host}</code>
                  {d.isPrimary && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: "var(--acc)", color: "#fff" }}>Primary</span>
                  )}
                  <span className="text-[11px] font-medium" style={{ color: st.color }}>{st.label}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <button onClick={() => act(d.host, "recheck")} disabled={busy} title="Re-check DNS" className="p-1 rounded hover:opacity-80">
                      <RefreshCw size={13} className={busy ? "animate-spin" : ""} style={{ color: "var(--fg-3)" }} />
                    </button>
                    {!d.isPrimary && (
                      <button onClick={() => act(d.host, "primary")} disabled={busy} title="Make primary" className="p-1 rounded hover:opacity-80">
                        <Star size={13} style={{ color: "var(--fg-3)" }} />
                      </button>
                    )}
                    <button onClick={() => remove(d.host)} disabled={busy} title="Delete" className="p-1 rounded hover:opacity-80">
                      <Trash2 size={13} style={{ color: "var(--err)" }} />
                    </button>
                  </div>
                </div>
                <p className="text-[11px] font-mono" style={{ color: "var(--fg-3)" }}>
                  {d.records?.length ? d.records.join(", ") : (d.error || "No A/AAAA records found")}
                </p>
              </div>
            )
          })}
        </div>
      </section>

      {/* DNS records */}
      <section className="rounded-xl p-5 space-y-3" style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
        <h2 className="text-sm font-semibold" style={{ color: "var(--fg)" }}>DNS records</h2>
        <p className="text-xs" style={{ color: "var(--fg-3)" }}>Point these records to this VPS IP.</p>
        <div className="space-y-2">
          {aliases.map(alias => (
            <div key={alias} className="flex items-center gap-2 rounded-lg px-3 py-2" style={{ background: "var(--bg-3)" }}>
              <code className="text-xs flex-1" style={{ color: "var(--fg)" }}>{alias}</code>
              <span className="text-xs font-mono" style={{ color: "var(--fg-3)" }}>A</span>
              <button onClick={() => copy(expectedIp)} className="p-1 rounded hover:opacity-80" title="Copy IP">
                <Copy size={13} style={{ color: "var(--fg-3)" }} />
              </button>
            </div>
          ))}
        </div>
        <div className="rounded-lg px-3 py-2" style={{ background: "var(--bg-3)" }}>
          <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--fg-4)" }}>Expected IP</p>
          <p className="text-sm font-mono mt-0.5" style={{ color: "var(--fg)" }}>{expectedIp || "Unknown"}</p>
        </div>
      </section>

      {/* In use */}
      <section className="rounded-xl p-5 space-y-3" style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold" style={{ color: "var(--fg)" }}>In use on this server</h2>
          <button onClick={loadInUse} className="p-1 rounded hover:opacity-80" title="Refresh">
            <RefreshCw size={13} style={{ color: "var(--fg-3)" }} />
          </button>
        </div>
        {inUse.length === 0 && <p className="text-xs" style={{ color: "var(--fg-3)" }}>No domains discovered from containers, projects, or Caddy.</p>}
        <div className="space-y-2">
          {inUse.map(h => (
            <div key={h.host} className="flex items-center gap-2 rounded-lg px-3 py-2 flex-wrap" style={{ background: "var(--bg-3)" }}>
              <code className="text-xs" style={{ color: "var(--fg)" }}>{h.host}</code>
              <span className="text-[11px]" style={{ color: "var(--fg-3)" }}>
                {h.usedBy.map(u => `${u.source}:${u.ref}${u.status ? ` (${u.status})` : ""}`).join(", ")}
              </span>
              <div className="ml-auto">
                {savedHosts.has(h.host) ? (
                  <span className="text-[11px]" style={{ color: "var(--ok)" }}>Saved</span>
                ) : (
                  <button onClick={() => save(h.host)} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded hover:opacity-80" style={{ background: "var(--acc)", color: "#fff" }}>
                    <Plus size={11} /> Save
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Ad-hoc check */}
      <section className="rounded-xl p-5 space-y-4" style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
        <h2 className="text-sm font-semibold" style={{ color: "var(--fg)" }}>Check DNS</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={checkDomain}
            onChange={e => setCheckDomain(e.target.value)}
            placeholder="example.com or app.example.com"
            className="flex-1 px-3 py-2 rounded-lg text-sm outline-hidden font-mono"
            style={{ background: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)" }}
          />
          <button
            onClick={check}
            disabled={checking || !checkDomain.trim()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
            style={{ background: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)" }}
          >
            {checking ? <RefreshCw size={14} className="animate-spin" /> : <Globe size={14} />}
            Check
          </button>
        </div>

        {result && (
          <div className="rounded-xl p-4 space-y-3" style={{ background: "var(--bg-1)", border: "1px solid var(--border)" }}>
            <div className="flex items-center gap-2">
              {result.pointed ? (
                <CheckCircle2 size={18} style={{ color: "var(--ok)" }} />
              ) : (
                <XCircle size={18} style={{ color: "var(--err)" }} />
              )}
              <p className="text-sm font-medium" style={{ color: "var(--fg)" }}>
                {result.pointed ? (result.proxied ? "Domain is proxied through Cloudflare" : "Domain is pointed correctly") : "Domain is not pointed to this VPS"}
              </p>
            </div>
            {result.message && <p className="text-xs" style={{ color: "var(--fg-3)" }}>{result.message}</p>}
            <div className="grid gap-2 sm:grid-cols-2">
              <Info label="Expected IP" value={result.expectedIp || "Unknown"} />
              <Info label="Resolved IPs" value={result.records?.length ? result.records.join(", ") : "No A/AAAA records found"} />
            </div>
            {result.error && <p className="text-xs" style={{ color: "var(--err)" }}>{result.error}</p>}
          </div>
        )}
      </section>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: "var(--bg-3)" }}>
      <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--fg-4)" }}>{label}</p>
      <p className="text-xs font-mono mt-0.5 break-all" style={{ color: "var(--fg)" }}>{value}</p>
    </div>
  )
}
