"use client"

import { API_BASE } from "@/lib/api"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertCircle, AlertTriangle, CircleCheck, CircleX, Copy, Globe, Info as InfoIcon, Loader2, Plus, RefreshCw,
  Shield, Star, Trash2,
} from "lucide-react"
import { toast } from "sonner"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import { EmptyState } from "@/components/pn/EmptyState"
import {
  STATUS, StatusChip, StatusLegend, statusOf, type SavedDomain,
} from "@/components/domain/DomainParts"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn, copyText } from "@/lib/utils"

const GO_API = API_BASE

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

function IconTip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** A card with a header band (title + optional right-hand control) and flush content. */
function Panel({ id, title, subtitle, right, children }: {
  id: string; title: React.ReactNode; subtitle?: string; right?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <section aria-labelledby={id}>
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center justify-between gap-2.5 border-b px-[18px] py-3.5">
          <div className="space-y-0.5">
            <h2 id={id} className="text-[15px] font-semibold">{title}</h2>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          {right}
        </div>
        {children}
      </Card>
    </section>
  )
}

export default function DomainPage() {
  const [data, setData] = useState<DomainsResponse | null>(null)
  const [inUse, setInUse] = useState<InUseHost[]>([])
  const [newDomain, setNewDomain] = useState("")
  const [checkDomain, setCheckDomain] = useState("")
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyHost, setBusyHost] = useState("")
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState("")
  const [result, setResult] = useState<CheckResult | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const checkRef = useRef<HTMLInputElement>(null)

  const loadDomains = useCallback(async () => {
    try {
      const r = await fetch(`${GO_API}/api/domains`, { cache: "no-store" })
      if (!r.ok) throw new Error(String(r.status))
      const d: Partial<DomainsResponse> | null = await r.json()
      setData({
        domains: Array.isArray(d?.domains) ? d.domains : [],
        expectedIp: d?.expectedIp ?? "",
        aliases: Array.isArray(d?.aliases) ? d.aliases : [],
      })
      return true
    } catch { setLoadError(true); return false }
  }, [])

  const loadInUse = useCallback(async () => {
    try {
      const r = await fetch(`${GO_API}/api/domains/in-use`, { cache: "no-store" })
      if (!r.ok) throw new Error(String(r.status))
      const d = await r.json()
      setInUse(Array.isArray(d?.hosts) ? d.hosts : [])
      return true
    } catch { setLoadError(true); return false }
  }, [])

  const reload = useCallback(() => {
    setLoadError(false)
    setLoading(true)
    Promise.all([loadDomains(), loadInUse()]).finally(() => setLoading(false))
  }, [loadDomains, loadInUse])

  useEffect(() => { reload() }, [reload])

  // "/" focuses the DNS-check input (unless you are already typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      e.preventDefault()
      checkRef.current?.focus()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  // The API returns the full domains payload for every mutation; keep it null-safe like loadDomains.
  const applyResponse = (d: Partial<DomainsResponse> | null) =>
    setData({
      domains: Array.isArray(d?.domains) ? d.domains : [],
      expectedIp: d?.expectedIp ?? "",
      aliases: Array.isArray(d?.aliases) ? d.aliases : [],
    })

  const save = async (host: string) => {
    const value = host.trim().toLowerCase()
    if (!value) return
    setSaving(true)
    setMessage("")
    try {
      const r = await fetch(`${GO_API}/api/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: value }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setMessage(d.error || "Failed to save domain")
        return
      }
      applyResponse(d)
      setNewDomain("")
      toast.success(`${value} saved`)
      await loadInUse()
    } catch {
      setMessage("Could not reach the PulseNode API")
    } finally {
      setSaving(false)
    }
  }

  const act = async (host: string, action: "recheck" | "primary") => {
    setBusyHost(host)
    try {
      const r = await fetch(`${GO_API}/api/domains/${encodeURIComponent(host)}/${action}`, { method: "POST" })
      if (r.ok) {
        applyResponse(await r.json())
        if (action === "primary") toast.success(`${host} is now primary`)
      } else {
        toast.error(action === "recheck" ? `DNS check failed for ${host}` : "Could not change the primary domain")
      }
    } catch {
      toast.error("Could not reach the PulseNode API")
    } finally {
      setBusyHost("")
    }
  }

  const remove = async (host: string) => {
    setBusyHost(host)
    try {
      const r = await fetch(`${GO_API}/api/domains/${encodeURIComponent(host)}`, { method: "DELETE" })
      if (r.ok) {
        applyResponse(await r.json())
        toast.success(`${host} removed`)
      } else {
        toast.error(`Could not delete ${host}`)
      }
    } catch {
      toast.error("Could not reach the PulseNode API")
    } finally {
      setBusyHost("")
    }
  }

  const check = async () => {
    setChecking(true)
    setMessage("")
    setResult(null)
    try {
      const q = encodeURIComponent(checkDomain.trim())
      const r = await fetch(`${GO_API}/api/domain/check?domain=${q}`, { cache: "no-store" })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setMessage(d.error || "Failed to check DNS")
        return
      }
      setResult({ ...d, records: Array.isArray(d?.records) ? d.records : null })
    } catch {
      setMessage("Could not reach the PulseNode API")
    } finally {
      setChecking(false)
    }
  }

  const copy = async (value: string, what = "Copied") => {
    if (await copyText(value)) toast.success(what)
  }

  const expectedIp = data?.expectedIp || ""
  const aliases = data?.aliases || []
  const domains = data?.domains || []
  const savedHosts = new Set(domains.map(d => d.host))

  const resultStatus = result
    ? result.error ? "error" : result.proxied ? "proxied" : result.pointed ? "pointed" : "not"
    : null
  const RESULT = {
    pointed: { title: "Pointed correctly", Icon: CircleCheck, tone: "text-success", box: "border-success/30 bg-success/8" },
    proxied: { title: "Proxied through Cloudflare", Icon: Shield, tone: "text-info", box: "border-info/30 bg-info/8" },
    not:     { title: "Not pointed to this VPS", Icon: CircleX, tone: "text-danger", box: "border-danger/30 bg-danger/8" },
    error:   { title: "Lookup failed", Icon: AlertTriangle, tone: "text-warning", box: "border-warning/30 bg-warning/8" },
  } as const

  return (
    <>
      <PageHeader
        icon={Globe}
        title="Domains"
        description="Save the domains you use, verify their DNS, and see what each container is serving."
        actions={
          <span className="inline-flex h-[30px] items-center gap-2 rounded-lg border bg-card px-3 text-xs text-muted-foreground">
            VPS IP
            <code className="font-mono font-medium text-foreground">{expectedIp || "unknown"}</code>
            {expectedIp && (
              <IconTip label="Copy IP">
                <button type="button" onClick={() => copy(expectedIp, "IP copied")} aria-label="Copy VPS IP" className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2">
                  <Copy className="size-3" />
                </button>
              </IconTip>
            )}
          </span>
        }
      />
      <PageBody className="motion-safe:animate-in fade-in-0 duration-300">
        {loadError && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load your domains</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-3">
              The request to the PulseNode API failed.
              <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="size-3.5" />Retry</Button>
            </AlertDescription>
          </Alert>
        )}
        {message && (
          <Alert variant="destructive"><AlertCircle /><AlertDescription>{message}</AlertDescription></Alert>
        )}

        <div className="grid items-start gap-5 min-[1200px]:grid-cols-2">
          <div className="min-w-0 space-y-5">
            {/* Saved domains */}
            <Panel
              id="dm-saved"
              title={<>Saved domains <span className="ml-1 text-[13px] font-medium text-muted-foreground">{domains.length}</span></>}
              right={
                <form
                  onSubmit={e => { e.preventDefault(); void save(newDomain) }}
                  className="flex gap-1.5"
                >
                  <Input
                    value={newDomain}
                    onChange={e => setNewDomain(e.target.value)}
                    aria-label="Domain to save"
                    placeholder="example.com"
                    spellCheck={false}
                    className="h-8 w-[200px] font-mono text-xs"
                  />
                  <Button type="submit" size="sm" disabled={saving || !newDomain.trim()}>
                    {saving ? <Loader2 className="animate-spin" /> : <Plus />}Save
                  </Button>
                </form>
              }
            >
              {loading ? (
                <div className="space-y-2 p-4"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
              ) : domains.length === 0 ? (
                <EmptyState icon={Globe} title="No saved domains yet" description="Add one above to verify its DNS." className="m-4 py-8" />
              ) : (
                <ul className="divide-y">
                  {domains.map(d => {
                    const status = statusOf(d)
                    const busy = busyHost === d.host
                    const ips = d.records?.length ? d.records.join(", ") : d.error ? "SERVFAIL" : "—"
                    return (
                      <li key={d.host} className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 py-2 pr-2.5 pl-[18px]">
                        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <code className="font-mono text-[13px] font-medium break-all">{d.host}</code>
                            {d.isPrimary && (
                              <span className="inline-flex items-center gap-1 rounded bg-primary/12 px-1.5 py-px text-[11px] font-semibold text-primary">
                                <Star className="size-2.5" />Primary
                              </span>
                            )}
                          </div>
                          <p className="font-mono text-xs break-all text-muted-foreground" title={d.error || ips}>{d.error || ips}</p>
                        </div>
                        <StatusChip status={status} checking={busy} />
                        <div className="flex items-center gap-0.5">
                          <IconTip label="Re-check DNS">
                            <Button variant="ghost" size="icon-sm" onClick={() => act(d.host, "recheck")} disabled={busy} aria-label={`Re-check DNS for ${d.host}`}>
                              <RefreshCw className={busy ? "animate-spin" : ""} />
                            </Button>
                          </IconTip>
                          <IconTip label={d.isPrimary ? "Primary domain" : "Make primary"}>
                            <Button variant="ghost" size="icon-sm" onClick={() => act(d.host, "primary")} disabled={busy || d.isPrimary} aria-label={`Make ${d.host} primary`}>
                              <Star />
                            </Button>
                          </IconTip>
                          <IconTip label="Delete">
                            <Button variant="ghost" size="icon-sm" className="text-danger hover:text-danger" onClick={() => setPendingDelete(d.host)} disabled={busy} aria-label={`Delete ${d.host}`}>
                              <Trash2 />
                            </Button>
                          </IconTip>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
              <StatusLegend />
            </Panel>

            {/* In use */}
            <Panel
              id="dm-use"
              title="In use"
              subtitle="Hostnames found in container labels, projects and the Caddyfile"
              right={
                <IconTip label="Refresh">
                  <Button variant="ghost" size="icon-sm" onClick={() => void loadInUse()} aria-label="Refresh in-use domains"><RefreshCw /></Button>
                </IconTip>
              }
            >
              {loading ? (
                <div className="space-y-2 p-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
              ) : inUse.length === 0 ? (
                <p className="px-[18px] py-4 text-sm text-muted-foreground">No domains discovered from containers, projects, or Caddy.</p>
              ) : (
                <ul className="divide-y">
                  {inUse.map(h => (
                    <li key={h.host} className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 py-2 pr-3.5 pl-[18px]">
                      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
                        <code className="font-mono text-[13px] break-all">{h.host}</code>
                        <p className="text-xs break-all text-muted-foreground">
                          source:{" "}
                          <span className="font-mono text-foreground/80">
                            {(Array.isArray(h.usedBy) ? h.usedBy : []).map(u => `${u.source}:${u.ref}${u.status ? ` (${u.status})` : ""}`).join(", ") || "—"}
                          </span>
                        </p>
                      </div>
                      {savedHosts.has(h.host) ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><CircleCheck className="size-3.5 text-success" />Saved</span>
                      ) : (
                        <Button size="xs" variant="outline" onClick={() => save(h.host)} disabled={saving}><Plus />Save</Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="min-w-0 space-y-5">
            {/* DNS check */}
            <Panel id="dm-check" title="DNS check">
              <form
                onSubmit={e => { e.preventDefault(); if (checkDomain.trim()) void check() }}
                className="flex gap-2 px-[18px] py-3.5"
              >
                <div className="relative flex-1">
                  <Globe className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={checkRef}
                    value={checkDomain}
                    onChange={e => setCheckDomain(e.target.value)}
                    aria-label="Hostname to check"
                    placeholder="api.example.com"
                    spellCheck={false}
                    className="h-9 pl-8 font-mono text-[13px]"
                  />
                </div>
                <Button type="submit" disabled={checking || !checkDomain.trim()} className="h-9">
                  {checking ? <Loader2 className="animate-spin" /> : <Globe />}Check
                </Button>
              </form>
              {result && resultStatus && (() => {
                const R = RESULT[resultStatus]
                const ips = result.records?.length ? result.records : []
                return (
                  <div role="status" className={cn("mx-[18px] mb-[18px] overflow-hidden rounded-xl border motion-safe:animate-in fade-in-0 duration-200", R.box)}>
                    <div className="flex items-center gap-2.5 px-4 py-3.5">
                      <span className={cn("grid size-[30px] place-items-center rounded-lg bg-card", R.tone)}><R.Icon className="size-[17px]" /></span>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-[15px] font-semibold">{R.title}</span>
                        <span className="font-mono text-xs break-all text-muted-foreground">{result.domain}</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2">
                      <div className="bg-card px-4 py-3">
                        <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Expected IP</div>
                        <div className="mt-1 font-mono text-sm font-medium tabular-nums">{result.expectedIp || "Unknown"}</div>
                      </div>
                      <div className="bg-card px-4 py-3">
                        <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Resolved IPs</div>
                        {ips.length ? ips.map(ip => (
                          <div key={ip} className={cn("mt-1 font-mono text-sm font-medium tabular-nums", ip === result.expectedIp ? "text-success" : resultStatus === "not" ? "text-danger" : "")}>{ip}</div>
                        )) : <div className="mt-1 font-mono text-sm text-muted-foreground">—</div>}
                      </div>
                    </div>
                    {(result.message || result.error) && (
                      <div className="border-t bg-card px-4 py-2.5 text-xs text-muted-foreground">{result.error || result.message}</div>
                    )}
                  </div>
                )
              })()}
            </Panel>

            {/* DNS records */}
            <Panel id="dm-rec" title="DNS records" subtitle="Point these records to this VPS IP at your DNS provider.">
              {loading ? (
                <div className="p-4"><Skeleton className="h-10 w-full" /></div>
              ) : aliases.length === 0 ? (
                <p className="px-[18px] py-4 text-sm text-muted-foreground">Save a domain to see the records to create for it.</p>
              ) : (
                <>
                  <ul className="divide-y md:hidden" aria-label="DNS records">
                    {aliases.map(alias => (
                      <li key={alias} className="flex items-center gap-3 px-[18px] py-2.5">
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <p className="font-mono text-xs break-all">{alias}</p>
                          <p className="font-mono text-xs text-muted-foreground tabular-nums">A · {expectedIp || "Unknown"} · TTL Auto</p>
                        </div>
                        <IconTip label="Copy IP">
                          <Button variant="ghost" size="icon-sm" onClick={() => copy(expectedIp, "IP copied")} disabled={!expectedIp} aria-label={`Copy IP for ${alias}`}><Copy /></Button>
                        </IconTip>
                      </li>
                    ))}
                  </ul>
                  <div className="hidden overflow-x-auto md:block">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="pl-[18px]">Type</TableHead>
                          <TableHead>Name</TableHead>
                          <TableHead>Value</TableHead>
                          <TableHead className="pr-[18px]">TTL</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {aliases.map(alias => (
                          <TableRow key={alias} className="h-[46px]">
                            <TableCell className="pl-[18px]"><span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold">A</span></TableCell>
                            <TableCell>
                              <button type="button" onClick={() => copy(alias, "Record name copied")} aria-label={`Copy record name ${alias}`} className="inline-flex items-center gap-1.5 rounded-sm font-mono text-xs hover:text-primary focus-visible:outline-2">
                                {alias}<Copy className="size-3" />
                              </button>
                            </TableCell>
                            <TableCell>
                              <button type="button" onClick={() => copy(expectedIp, "IP copied")} disabled={!expectedIp} aria-label={`Copy IP ${expectedIp}`} className="inline-flex items-center gap-1.5 rounded-sm font-mono text-xs tabular-nums hover:text-primary focus-visible:outline-2 disabled:opacity-60">
                                {expectedIp || "Unknown"}<Copy className="size-3" />
                              </button>
                            </TableCell>
                            <TableCell className="pr-[18px] text-xs text-muted-foreground">Auto</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
              <p className="flex items-start gap-2 px-[18px] py-2.5 text-xs text-muted-foreground">
                <InfoIcon className="mt-px size-3.5 shrink-0" />
                <span>
                  Using a Cloudflare proxy? Keep the record orange-clouded; the status shows{" "}
                  <b className="font-semibold text-foreground/80">{STATUS.proxied.label}</b> because the resolved IPs belong to Cloudflare.
                </span>
              </p>
            </Panel>
          </div>
        </div>
      </PageBody>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={o => { if (!o) setPendingDelete(null) }}
        icon={Trash2}
        title="Delete saved domain?"
        items={pendingDelete ? [{
          primary: pendingDelete,
          secondary: (() => {
            const d = domains.find(x => x.host === pendingDelete)
            return d ? `${STATUS[statusOf(d)].label}${d.records?.length ? ` · ${d.records.join(", ")}` : ""}` : undefined
          })(),
        }] : undefined}
        note="Only removes it from this list. DNS and Caddy routes are not changed."
        tone="warning"
        confirmLabel="Delete"
        onConfirm={async () => {
          const h = pendingDelete
          setPendingDelete(null)
          if (h) await remove(h)
        }}
      />
    </>
  )
}
