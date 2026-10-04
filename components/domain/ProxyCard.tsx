"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, AlertTriangle, Loader2, Network, Power, PowerOff, RefreshCw, Save } from "lucide-react"
import { toast } from "sonner"
import { Pill } from "@/components/dashboard/Pill"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { API_BASE, nodeApi, type ApiError } from "@/lib/api"
import { Truncate } from "@/components/pn/Truncate"

type ProxyMode = "managed" | "external" | "none"

type ProxyStatus = {
  mode: ProxyMode
  running: boolean
  container: string
  network: string
  httpPort: number
  httpsPort: number
  acmeEmail: string
  enabled: boolean
  error: string
  conflict: string
}

const POLL_MS = 10_000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalize(d: Record<string, unknown> | null): ProxyStatus {
  const mode = d?.mode === "managed" || d?.mode === "external" ? d.mode : "none"
  // `conflict` is documented as a message; tolerate a bare boolean too.
  const conflict = typeof d?.conflict === "string" ? d.conflict : d?.conflict === true ? "A port needed by the proxy is already in use." : ""
  return {
    mode,
    running: Boolean(d?.running),
    container: typeof d?.container === "string" ? d.container : "",
    network: typeof d?.network === "string" ? d.network : "",
    httpPort: typeof d?.httpPort === "number" && d.httpPort > 0 ? d.httpPort : 80,
    httpsPort: typeof d?.httpsPort === "number" && d.httpsPort > 0 ? d.httpsPort : 443,
    acmeEmail: typeof d?.acmeEmail === "string" ? d.acmeEmail : "",
    enabled: Boolean(d?.enabled),
    error: typeof d?.error === "string" ? d.error : "",
    conflict,
  }
}

/** Mutation helper: surfaces the backend's message (error or message field) on non-2xx. */
async function send(method: "POST" | "PATCH", path: string, body?: unknown): Promise<{ ok: boolean; status: number; message: string }> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.ok) return { ok: true, status: res.status, message: "" }
    if (res.status === 401 && window.location.pathname !== "/login") window.location.href = "/login"
    const d = await res.json().catch(() => null)
    const message = (typeof d?.error === "string" && d.error) || (typeof d?.message === "string" && d.message) || `Request failed (${res.status})`
    return { ok: false, status: res.status, message }
  } catch {
    return { ok: false, status: 0, message: "Could not reach the PulseNode API" }
  }
}

function describe(s: ProxyStatus) {
  if (s.mode === "external") return { label: "External Traefik detected", tone: "info" as const }
  if (s.mode === "managed" && s.running) return { label: "Running via PulseNode", tone: "ok" as const }
  if (s.mode === "managed" && s.enabled) return { label: "Not running", tone: "warn" as const }
  return { label: "Not running", tone: "bad" as const }
}

export function ProxyCard() {
  const [status, setStatus] = useState<ProxyStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [action, setAction] = useState<"" | "enable" | "disable" | "save">("")
  const [actionError, setActionError] = useState("")
  const [confirmDisable, setConfirmDisable] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const { data } = await nodeApi.get<Record<string, unknown> | null>("/api/proxy/status")
      if (!mounted.current) return
      setStatus(normalize(data))
      setLoadError(null)
    } catch (e) {
      if (!mounted.current) return
      setLoadError((e as ApiError).status === 404
        ? "The proxy API is not available on this PulseNode version yet."
        : e instanceof Error ? e.message : "Could not load proxy status")
    } finally {
      inFlight.current = false
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    const id = setInterval(() => { void load() }, POLL_MS)
    return () => { mounted.current = false; clearInterval(id) }
  }, [load])

  const retry = () => { setLoading(true); void load() }

  const email = draft ?? status?.acmeEmail ?? ""
  const emailTrim = email.trim()
  const emailInvalid = emailTrim !== "" && !EMAIL_RE.test(emailTrim)
  const dirty = status !== null && emailTrim !== status.acmeEmail

  const run = async (kind: "enable" | "disable" | "save", fn: () => ReturnType<typeof send>, okMsg: string) => {
    setAction(kind)
    setActionError("")
    const r = await fn()
    if (!mounted.current) return
    setAction("")
    if (!r.ok) { setActionError(r.message); return }
    toast.success(okMsg)
    if (kind === "save") setDraft(null)
    await load()
  }

  const saveEmail = () => run("save", () => send("PATCH", "/api/proxy/settings", { acmeEmail: emailTrim }), "ACME email saved")
  const enable = () => run("enable", () => send("POST", "/api/proxy/enable", emailTrim && !emailInvalid ? { acmeEmail: emailTrim } : {}), "Built-in proxy enabled")
  const disable = () => run("disable", () => send("POST", "/api/proxy/disable"), "Built-in proxy disabled")

  const busy = action !== ""
  const d = status ? describe(status) : null
  const external = status?.mode === "external"
  const managedOn = status?.mode === "managed" && (status.enabled || status.running)

  return (
    <section aria-labelledby="dm-proxy">
      <Card>
        <CardHeader>
          <CardTitle id="dm-proxy" className="flex flex-wrap items-center gap-2 text-[15px]">
            <Network className="size-4 text-muted-foreground" aria-hidden />Built-in proxy
            {d && <Pill tone={d.tone} dot>{d.label}</Pill>}
          </CardTitle>
          <CardDescription>
            PulseNode runs its own Traefik to route and secure your apps when none is installed. Needs ports 80 and 443 free on this server.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading && !status ? (
            <div className="space-y-2" aria-busy="true" aria-label="Loading proxy status">
              <Skeleton className="h-6 w-48" /><Skeleton className="h-9 w-full max-w-md" />
            </div>
          ) : (
            <>
              {loadError && (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>Could not load proxy status</AlertTitle>
                  <AlertDescription className="flex flex-wrap items-center gap-3">
                    {loadError}
                    <Button variant="outline" size="sm" onClick={retry}><RefreshCw className="size-3.5" />Retry</Button>
                  </AlertDescription>
                </Alert>
              )}
              {status && (
                <>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                    <div><dt className="text-xs text-muted-foreground">Ports</dt><dd className="font-mono tabular-nums">{status.httpPort} / {status.httpsPort}</dd></div>
                    <div className="min-w-0"><dt className="text-xs text-muted-foreground">Container</dt><dd><Truncate mono text={status.container} /></dd></div>
                    <div className="min-w-0"><dt className="text-xs text-muted-foreground">Network</dt><dd><Truncate mono text={status.network} /></dd></div>
                    <div><dt className="text-xs text-muted-foreground">Auto-start</dt><dd>{status.mode === "managed" ? (status.enabled ? "On" : "Off") : "—"}</dd></div>
                  </dl>

                  {external && (
                    <Alert>
                      <AlertTriangle />
                      <AlertDescription>
                        An external Traefik is already routing this server, so PulseNode&apos;s built-in proxy stays off. Apps are exposed through that Traefik.
                      </AlertDescription>
                    </Alert>
                  )}
                  {status.conflict && (
                    <Alert variant="destructive">
                      <AlertTriangle />
                      <AlertTitle>Port conflict</AlertTitle>
                      <AlertDescription>{status.conflict}</AlertDescription>
                    </Alert>
                  )}
                  {status.error && (
                    <Alert variant="destructive">
                      <AlertCircle />
                      <AlertDescription>{status.error}</AlertDescription>
                    </Alert>
                  )}
                  {actionError && (
                    <Alert variant="destructive" role="alert">
                      <AlertCircle />
                      <AlertDescription>{actionError}</AlertDescription>
                    </Alert>
                  )}

                  <form
                    onSubmit={e => { e.preventDefault(); if (dirty && !emailInvalid && !busy) void saveEmail() }}
                    className="space-y-1.5"
                  >
                    <Label htmlFor="proxy-acme-email">ACME email (Let&apos;s Encrypt)</Label>
                    <div className="flex max-w-md flex-wrap gap-2">
                      <Input
                        id="proxy-acme-email"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        spellCheck={false}
                        value={email}
                        onChange={e => setDraft(e.target.value)}
                        placeholder="you@example.com"
                        disabled={external}
                        aria-invalid={emailInvalid}
                        aria-describedby="proxy-acme-help"
                        className="h-9 min-w-0 flex-1 basis-48"
                      />
                      <Button type="submit" variant="outline" className="h-9" disabled={external || busy || !dirty || emailInvalid}>
                        {action === "save" ? <Loader2 className="animate-spin" /> : <Save />}Save
                      </Button>
                    </div>
                    <p id="proxy-acme-help" className={emailInvalid ? "text-xs text-danger" : "text-xs text-muted-foreground"}>
                      {emailInvalid ? "Enter a valid email address." : "Used for certificate expiry notices. Optional, but recommended."}
                    </p>
                  </form>

                  {!external && (
                    <div className="flex flex-wrap gap-2">
                      {(!managedOn || !status.running) && (
                        <Button onClick={() => void enable()} disabled={busy || emailInvalid}>
                          {action === "enable" ? <Loader2 className="animate-spin" /> : <Power />}
                          {status.mode === "managed" ? "Start proxy" : "Enable built-in proxy"}
                        </Button>
                      )}
                      {managedOn && (
                        <Button variant="outline" onClick={() => setConfirmDisable(true)} disabled={busy} className="text-danger hover:text-danger">
                          {action === "disable" ? <Loader2 className="animate-spin" /> : <PowerOff />}Disable
                        </Button>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        icon={PowerOff}
        title="Disable the built-in proxy?"
        description="PulseNode will stop its Traefik container."
        note="Deployed apps will become unreachable from outside until a proxy is running again."
        tone="warning"
        confirmLabel="Disable proxy"
        onConfirm={async () => { setConfirmDisable(false); await disable() }}
      />
    </section>
  )
}
