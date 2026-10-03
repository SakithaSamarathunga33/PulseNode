"use client"

import { API_BASE } from "@/lib/api"
import { useEffect, useState } from "react"
import { AlertCircle, CheckCircle2, Copy, Globe, Loader2, Plus, RefreshCw, Star, Trash2, XCircle } from "lucide-react"
import { toast } from "sonner"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import { EmptyState } from "@/components/pn/EmptyState"
import { Pill } from "@/components/dashboard/Pill"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { copyText } from "@/lib/utils"

const GO_API = API_BASE

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

type PillTone = "ok" | "bad" | "warn" | "info" | "acc" | "outline"

function statusOf(d: SavedDomain): { label: string; tone: PillTone } {
  if (d.error) return { label: "Error", tone: "bad" }
  if (d.pointed === null) return { label: "Unchecked", tone: "outline" }
  if (d.proxied) return { label: "Proxied", tone: "ok" }
  if (d.pointed) return { label: "Pointed", tone: "ok" }
  return { label: "Not pointed", tone: "bad" }
}

function IconTip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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

  const loadDomains = async () => {
    try {
      const r = await fetch(`${GO_API}/api/domains`, { cache: "no-store" })
      if (!r.ok) throw new Error(String(r.status))
      const d: Partial<DomainsResponse> | null = await r.json()
      setData({
        domains: Array.isArray(d?.domains) ? d.domains : [],
        expectedIp: d?.expectedIp ?? "",
        aliases: Array.isArray(d?.aliases) ? d.aliases : [],
      })
      setLoadError(false)
    } catch { setLoadError(true) }
  }

  const loadInUse = async () => {
    try {
      const r = await fetch(`${GO_API}/api/domains/in-use`, { cache: "no-store" })
      if (!r.ok) throw new Error(String(r.status))
      const d = await r.json()
      setInUse(Array.isArray(d?.hosts) ? d.hosts : [])
    } catch { setLoadError(true) }
  }

  const reload = () => { setLoadError(false); Promise.all([loadDomains(), loadInUse()]) }

  useEffect(() => {
    Promise.all([loadDomains(), loadInUse()]).finally(() => setLoading(false))
    // loaders only touch state setters and a module constant
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const copy = async (value: string) => {
    if (await copyText(value)) toast.success("Copied")
  }

  const expectedIp = data?.expectedIp || ""
  const aliases = data?.aliases || []
  const domains = data?.domains || []
  const savedHosts = new Set(domains.map(d => d.host))

  return (
    <>
      <PageHeader
        icon={Globe}
        title="Domain"
        description="Save the domains you use, verify their DNS, and see what each container is serving."
      />
      <PageBody>
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

        {/* Saved domains */}
        <Card>
          <CardHeader>
            <CardTitle>Saved domains</CardTitle>
            <CardDescription>Domains you plan to point at this server.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-domain">Add a domain</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="new-domain"
                  value={newDomain}
                  onChange={e => setNewDomain(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") save(newDomain) }}
                  placeholder="example.com or app.example.com"
                  className="font-mono"
                />
                <Button onClick={() => save(newDomain)} disabled={saving || !newDomain.trim()}>
                  {saving ? <Loader2 className="animate-spin" /> : <Plus />} Save
                </Button>
              </div>
            </div>

            {loading ? (
              <div className="space-y-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
            ) : domains.length === 0 ? (
              <EmptyState icon={Globe} title="No saved domains yet" description="Add one above to verify its DNS." className="py-8" />
            ) : (
              <ul className="divide-y rounded-lg border">
                {domains.map(d => {
                  const st = statusOf(d)
                  const busy = busyHost === d.host
                  return (
                    <li key={d.host} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                      <div className="min-w-0 flex-1 basis-56 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="font-mono text-sm font-medium break-all">{d.host}</code>
                          {d.isPrimary && <Badge>Primary</Badge>}
                          <Pill tone={st.tone} dot>{st.label}</Pill>
                        </div>
                        <p className="font-mono text-xs text-muted-foreground break-all">
                          {d.records?.length ? d.records.join(", ") : (d.error || "No A/AAAA records found")}
                        </p>
                      </div>
                      <div className="flex items-center gap-0.5">
                        <IconTip label="Re-check DNS">
                          <Button variant="ghost" size="icon-sm" onClick={() => act(d.host, "recheck")} disabled={busy} aria-label={`Re-check DNS for ${d.host}`}>
                            <RefreshCw className={busy ? "animate-spin" : ""} />
                          </Button>
                        </IconTip>
                        {!d.isPrimary && (
                          <IconTip label="Make primary">
                            <Button variant="ghost" size="icon-sm" onClick={() => act(d.host, "primary")} disabled={busy} aria-label={`Make ${d.host} primary`}>
                              <Star />
                            </Button>
                          </IconTip>
                        )}
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
          </CardContent>
        </Card>

        {/* DNS records */}
        <Card>
          <CardHeader>
            <CardTitle>DNS records</CardTitle>
            <CardDescription>Point these records to this VPS IP.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-lg border bg-muted/40 px-3 py-2">
              <p className="text-xs text-muted-foreground">Expected IP</p>
              <p className="font-mono text-sm tabular-nums">{expectedIp || "Unknown"}</p>
            </div>
            {aliases.length > 0 && (
              <>
              <ul className="divide-y rounded-lg border md:hidden" aria-label="DNS records">
                {aliases.map(alias => (
                  <li key={alias} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="font-mono text-xs break-all">{alias}</p>
                      <p className="font-mono text-xs text-muted-foreground tabular-nums">A · {expectedIp || "Unknown"}</p>
                    </div>
                    <IconTip label="Copy IP">
                      <Button variant="ghost" size="icon-sm" onClick={() => copy(expectedIp)} disabled={!expectedIp} aria-label={`Copy IP for ${alias}`}><Copy /></Button>
                    </IconTip>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto rounded-lg border md:block">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Value</TableHead><TableHead className="w-10"><span className="sr-only">Copy</span></TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {aliases.map(alias => (
                      <TableRow key={alias}>
                        <TableCell className="font-mono text-xs">{alias}</TableCell>
                        <TableCell className="font-mono text-xs">A</TableCell>
                        <TableCell className="font-mono text-xs tabular-nums">{expectedIp || "Unknown"}</TableCell>
                        <TableCell>
                          <IconTip label="Copy IP">
                            <Button variant="ghost" size="icon-sm" onClick={() => copy(expectedIp)} disabled={!expectedIp} aria-label={`Copy IP for ${alias}`}><Copy /></Button>
                          </IconTip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* In use */}
        <Card>
          <CardHeader>
            <CardTitle>In use on this server</CardTitle>
            <CardDescription>Discovered from containers, projects, and Caddy.</CardDescription>
            <div className="col-start-2 row-span-2 row-start-1 self-start justify-self-end">
              <IconTip label="Refresh">
                <Button variant="ghost" size="icon-sm" onClick={loadInUse} aria-label="Refresh in-use domains"><RefreshCw /></Button>
              </IconTip>
            </div>
          </CardHeader>
          <CardContent>
            {inUse.length === 0 ? (
              <p className="text-sm text-muted-foreground">No domains discovered from containers, projects, or Caddy.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {inUse.map(h => (
                  <li key={h.host} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                    <div className="min-w-0 flex-1 basis-56">
                      <code className="font-mono text-sm break-all">{h.host}</code>
                      <p className="font-mono text-xs text-muted-foreground break-all">
                        {h.usedBy.map(u => `${u.source}:${u.ref}${u.status ? ` (${u.status})` : ""}`).join(", ")}
                      </p>
                    </div>
                    {savedHosts.has(h.host) ? (
                      <Pill tone="ok" dot>Saved</Pill>
                    ) : (
                      <Button size="xs" variant="outline" onClick={() => save(h.host)}><Plus /> Save</Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Ad-hoc check */}
        <Card>
          <CardHeader>
            <CardTitle>Check DNS</CardTitle>
            <CardDescription>Look up any domain without saving it.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="check-domain">Domain</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="check-domain"
                  value={checkDomain}
                  onChange={e => setCheckDomain(e.target.value)}
                  placeholder="example.com or app.example.com"
                  className="font-mono"
                />
                <Button variant="outline" onClick={check} disabled={checking || !checkDomain.trim()}>
                  {checking ? <Loader2 className="animate-spin" /> : <Globe />} Check
                </Button>
              </div>
            </div>

            {result && (
              <div className="space-y-3 rounded-lg border bg-muted/30 p-4 motion-safe:animate-in fade-in-0 duration-300">
                <div className="flex items-center gap-2">
                  {result.pointed ? <CheckCircle2 className="size-5 text-success" /> : <XCircle className="size-5 text-danger" />}
                  <p className="text-sm font-medium">
                    {result.pointed ? (result.proxied ? "Domain is proxied through Cloudflare" : "Domain is pointed correctly") : "Domain is not pointed to this VPS"}
                  </p>
                </div>
                {result.message && <p className="text-sm text-muted-foreground">{result.message}</p>}
                <div className="grid gap-2 sm:grid-cols-2">
                  <Info label="Expected IP" value={result.expectedIp || "Unknown"} />
                  <Info label="Resolved IPs" value={result.records?.length ? result.records.join(", ") : "No A/AAAA records found"} />
                </div>
                {result.error && (
                  <Alert variant="destructive"><AlertCircle /><AlertDescription>{result.error}</AlertDescription></Alert>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </PageBody>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={o => { if (!o) setPendingDelete(null) }}
        icon={Trash2}
        title="Delete saved domain?"
        description="This only removes it from PulseNode's saved list; DNS and running projects are not changed."
        target={pendingDelete}
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

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-xs break-all tabular-nums">{value}</p>
    </div>
  )
}
