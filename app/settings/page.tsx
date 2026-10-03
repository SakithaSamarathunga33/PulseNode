"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertTriangle, CheckCircle2, DatabaseBackup, Download, ExternalLink, Loader2, LogOut,
  RefreshCw, RotateCcw, Settings, Shield, Undo2, Zap,
} from "lucide-react"
import { toast } from "sonner"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import { Pill } from "@/components/dashboard/Pill"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { API_BASE, nodeApi } from "@/lib/api"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"

const GO_API = API_BASE

interface VersionInfo {
  current: string
  latest: string | null
  hasUpdate: boolean
  releaseUrl: string | null
  changelog: string | null
}

interface SnapshotInfo { name: string; size: number; createdAt: string }

type UpdatePhase = "idle" | "preflight" | "snapshot" | "pulling" | "building" | "switching" | "done" | "rolled_back" | "failed"

interface UpdateStatus {
  running: boolean
  log: string[]
  error: string | null
  startedAt: string | null
  // Persisted by the backend, so they survive the container restart:
  phase?: UpdatePhase
  rolledBack?: boolean
  rollbackHealthy?: boolean
  finishedAt?: string | null
  fromVersion?: string
  toVersion?: string
  imageTag?: string
  snapshotPath?: string
  schemaChanged?: boolean
  snapshots?: SnapshotInfo[]
}

function fmtBytes(n: number) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

interface AuthStatus { enabled: boolean; loggedIn: boolean; username?: string }

function LogLine({ line }: { line: string }) {
  if (line.startsWith("::")) {
    const msg = line.replace(/^::[^:]+:: /, "")
    return <p className="pt-1 text-xs font-semibold text-primary">{msg}</p>
  }
  if (line.startsWith("✓"))  return <p className="font-mono text-xs text-success">{line}</p>
  if (line.startsWith("⚠"))  return <p className="font-mono text-xs text-warning">{line}</p>
  if (line.startsWith("✕"))  return <p className="font-mono text-xs text-danger">{line}</p>
  if (/^\[.*\]/.test(line))  return <p className="font-mono text-[11px] leading-tight text-muted-foreground">{line}</p>
  if (/^(web|go-api|caddy)\s+(Pull|Push|Build|Pulling|Pushing|Building)/.test(line))
    return <p className="font-mono text-xs text-info">{line}</p>
  return <p className="font-mono text-xs text-muted-foreground">{line}</p>
}

function Field({ id, label, ...props }: { id: string; label: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  )
}

export default function SettingsPage() {
  const [version,      setVersion]      = useState<VersionInfo | null>(null)
  const [status,       setStatus]       = useState<UpdateStatus | null>(null)
  const [checking,     setChecking]     = useState(false)
  const [loadError,    setLoadError]    = useState(false)
  const [updating,     setUpdating]     = useState(false)
  const [countdown,    setCountdown]    = useState(0)
  const [reconnecting, setReconnecting] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<SnapshotInfo | null>(null)
  const [restoring,     setRestoring]     = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)
  // Boot id of the backend we are currently talking to. After an update we reload
  // only once this changes, which proves the container restarted with new code.
  const bootIdRef = useRef<number | null>(null)
  const HEALTH_URL = `${GO_API.replace(/\/go$/, "")}/health`

  // ── Security state ─────────────────────────────────────────────────────────
  const [authStatus,  setAuthStatus]  = useState<AuthStatus | null>(null)
  const [secLoading,  setSecLoading]  = useState(false)
  const [secError,    setSecError]    = useState("")
  const [secSuccess,  setSecSuccess]  = useState("")
  const [newUsername, setNewUsername] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPwd,  setConfirmPwd]  = useState("")
  const [curPassword, setCurPassword] = useState("")
  const [chgPassword, setChgPassword] = useState("")
  const [chgConfirm,  setChgConfirm]  = useState("")

  const fetchVersion = useCallback(async () => {
    setChecking(true)
    try {
      const { data } = await nodeApi.get<VersionInfo>("/api/system/version")
      setVersion(data)
      setLoadError(false)
    } catch { setLoadError(true) }
    finally { setChecking(false) }
  }, [])

  const fetchStatus = useCallback(async () => {
    try {
      const { data } = await nodeApi.get<UpdateStatus>("/api/system/update/status")
      setStatus(data)
    } catch { /* go-api temporarily offline during update */ }
  }, [])

  const fetchAuthStatus = useCallback(async () => {
    try {
      const { data } = await nodeApi.get<AuthStatus>("/api/auth/status")
      setAuthStatus(data)
    } catch { setLoadError(true) }
  }, [])

  useEffect(() => { fetchVersion() }, [fetchVersion])
  // The last update's outcome is persisted server-side: show it after the restart.
  useEffect(() => { fetchStatus() }, [fetchStatus])
  useEffect(() => { fetchAuthStatus() }, [fetchAuthStatus])

  useEffect(() => {
    if (!updating) return
    // Self-scheduling (not setInterval) so a slow or restarting backend never
    // stacks overlapping requests or lets an older response overwrite a newer one.
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      await fetchStatus()
      if (!cancelled) timer = setTimeout(tick, 1500)
    }
    timer = setTimeout(tick, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [updating, fetchStatus])

  // The updater keeps verifying the new version (up to ~2 min) after the page has
  // reloaded onto it; keep asking until it has recorded its verdict.
  const verifying = !updating && status?.phase === "switching"
  useEffect(() => {
    if (!verifying) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      await fetchStatus()
      if (!cancelled) timer = setTimeout(tick, 4000)
    }
    timer = setTimeout(tick, 4000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [verifying, fetchStatus])

  // Auto-scroll log to bottom whenever new lines arrive
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [status?.log.length])

  // Capture the backend's boot id on mount so we have a baseline to compare against
  // once an update restarts the container.
  useEffect(() => {
    fetch(HEALTH_URL, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then((d: { startedAt?: number } | null) => { if (d?.startedAt != null) bootIdRef.current = d.startedAt })
      .catch(() => { /* ignore */ })
  }, [HEALTH_URL])

  // Cosmetic "restart expected in ~Ns" countdown shown in the progress UI. It does
  // NOT trigger the reload — the reload is driven purely by detecting a real restart.
  useEffect(() => {
    if (!updating) return
    setCountdown(180)
    const tick = setInterval(() => setCountdown(c => (c <= 1 ? 0 : c - 1)), 1000)
    return () => clearInterval(tick)
  }, [updating])

  // Reload only once the backend has actually restarted with the new code. Docker
  // builds the new image while the OLD container keeps serving, so /health stays up
  // the whole time — waiting for the boot id to CHANGE avoids reloading the old
  // version. A failed probe means the container is mid-restart (reconnecting UI).
  const watching = updating || restoring
  useEffect(() => {
    if (!watching) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let sawOutage = false // backend went unreachable at least once → it is restarting
    const startedProbingAt = Date.now()
    const MAX_WAIT = 8 * 60 * 1000 // hard cap — source builds on small VPSes can be slow

    const probe = async () => {
      if (cancelled) return
      try {
        const res = await fetch(HEALTH_URL, { cache: "no-store" })
        if (res.ok) {
          const d = await res.json().catch(() => null) as { startedAt?: number } | null
          const boot = d?.startedAt ?? null
          if (boot != null) {
            if (bootIdRef.current == null) bootIdRef.current = boot        // establish baseline
            else if (boot !== bootIdRef.current) { window.location.reload(); return } // new code live
          } else if (sawOutage) {
            // Backend doesn't report a boot id (pre-update version) but we saw it go
            // down and come back — that recovery is itself proof of a restart.
            window.location.reload(); return
          }
          setReconnecting(false)
        }
      } catch {
        sawOutage = true
        setReconnecting(true) // backend unreachable → container is restarting
      }
      if (Date.now() - startedProbingAt > MAX_WAIT) { window.location.reload(); return }
      if (!cancelled) timer = setTimeout(probe, 2500)
    }
    timer = setTimeout(probe, 5000) // brief grace before the first probe
    return () => { cancelled = true; clearTimeout(timer) }
  }, [watching, HEALTH_URL])

  async function handleUpdate() {
    setUpdating(true)
    setStatus({ running: true, log: ["Sending update command..."], error: null, startedAt: new Date().toISOString() })
    try {
      const res = await fetch(`${GO_API}/api/system/update`, { method: "POST" })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setStatus(s => ({ ...s!, error: b.error || "Failed to start update", running: false }))
        setUpdating(false)
      }
    } catch { /* Node-api going down is expected during update */ }
  }

  async function handleRestore() {
    if (!restoreTarget) return
    try {
      const res = await fetch(`${GO_API}/api/system/update/restore-snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot: restoreTarget.name, confirm: "restore" }),
      })
      const b = await res.json().catch(() => ({})) as { error?: string; restarting?: boolean }
      if (!res.ok) { toast.error(b.error || "Could not restore the snapshot"); return }
      setRestoreTarget(null)
      setRestoring(true)
      toast.success(b.restarting === false
        ? "Snapshot staged — restart the go-api container to apply it."
        : "Snapshot staged — PulseNode is restarting to apply it.")
    } catch { toast.error("Could not reach the server") }
  }

  async function handleEnableLogin(e: React.FormEvent) {
    e.preventDefault()
    setSecError(""); setSecSuccess(""); setSecLoading(true)
    if (newPassword !== confirmPwd) { setSecError("Passwords do not match"); setSecLoading(false); return }
    try {
      const res = await fetch(`${GO_API}/api/auth/setup`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newUsername, password: newPassword }),
      })
      if (!res.ok) { const b = await res.json().catch(() => ({})) as { error?: string }; setSecError(b.error ?? "Failed"); return }
      setSecSuccess("Login protection enabled!")
      setNewUsername(""); setNewPassword(""); setConfirmPwd("")
      await fetchAuthStatus()
    } catch { setSecError("Request failed") } finally { setSecLoading(false) }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setSecError(""); setSecSuccess(""); setSecLoading(true)
    if (chgPassword !== chgConfirm) { setSecError("Passwords do not match"); setSecLoading(false); return }
    try {
      const res = await fetch(`${GO_API}/api/auth/setup`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: authStatus?.username ?? "", password: chgPassword, current_password: curPassword }),
      })
      if (!res.ok) { const b = await res.json().catch(() => ({})) as { error?: string }; setSecError(b.error ?? "Failed"); return }
      setSecSuccess("Password updated!")
      setCurPassword(""); setChgPassword(""); setChgConfirm("")
    } catch { setSecError("Request failed") } finally { setSecLoading(false) }
  }

  async function handleLogout() {
    await fetch(`${GO_API}/api/auth/logout`, { method: "POST" }).catch(() => {})
    window.location.href = "/login"
  }

  return (
    <>
      <PageHeader icon={Settings} title="Settings" description="System configuration and updates" />
      <PageBody className="max-w-6xl">
        {loadError && !updating && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Could not reach the PulseNode API</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-3">
              Version and account details may be missing or out of date.
              <Button variant="outline" size="sm" onClick={() => { setLoadError(false); fetchVersion(); fetchAuthStatus() }}>
                <RefreshCw className="size-3.5" />Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
          {/* Left column: Version + Updates */}
          <div className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Zap className="size-4 text-[var(--hue)]" /> Version</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border bg-muted/40 p-3">
                    <div className="mb-1 text-xs text-muted-foreground">Installed</div>
                    <code className="font-mono text-sm tabular-nums">{version ? `v${version.current}` : "—"}</code>
                  </div>
                  <div className="rounded-lg border bg-muted/40 p-3">
                    <div className="mb-1 text-xs text-muted-foreground">Latest release</div>
                    <code className="font-mono text-sm tabular-nums">
                      {version?.latest ? `v${version.latest}` : checking ? "checking…" : "—"}
                    </code>
                  </div>
                </div>

                {version && !updating && (
                  version.hasUpdate ? (
                    <Alert>
                      <AlertTriangle className="text-warning" />
                      <AlertDescription className="font-medium text-foreground">Update available: v{version.latest}</AlertDescription>
                    </Alert>
                  ) : (
                    <Alert>
                      <CheckCircle2 className="text-success" />
                      <AlertDescription className="font-medium text-foreground">You are on the latest version</AlertDescription>
                    </Alert>
                  )
                )}

                {version?.hasUpdate && version.changelog && (
                  <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
                    <div className="text-xs font-medium text-muted-foreground">What&apos;s new</div>
                    <pre className="max-h-40 overflow-y-auto font-sans text-sm leading-relaxed whitespace-pre-wrap">
                      {version.changelog}
                    </pre>
                    {version.releaseUrl && (
                      <a href={version.releaseUrl} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2">
                        View full release notes <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                )}

                {!updating && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={fetchVersion} disabled={checking}>
                      <RefreshCw className={checking ? "animate-spin" : ""} />
                      {checking ? "Checking…" : "Check for updates"}
                    </Button>
                    {version?.hasUpdate && (
                      <Button onClick={handleUpdate}>
                        <Download /> Update to v{version.latest}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {updating && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin text-[var(--hue)]" />
                    {reconnecting ? "Reconnecting…" : "Updating PulseNode"}
                  </CardTitle>
                  {!reconnecting && countdown > 0 && (
                    <CardDescription className="tabular-nums">Restart expected in ~{countdown}s</CardDescription>
                  )}
                </CardHeader>
                <CardContent className="space-y-3" aria-live="polite">
                  {status && status.log.length > 0 && (
                    <div className="max-h-96 space-y-0.5 overflow-y-auto rounded-lg border bg-muted/50 p-3" role="log" aria-label="Update log">
                      {status.log.map((l, i) => <LogLine key={i} line={l} />)}
                      <div ref={logEndRef} />
                    </div>
                  )}
                  {status?.error && (
                    <Alert variant="destructive"><AlertTriangle /><AlertDescription>{status.error}</AlertDescription></Alert>
                  )}
                  {reconnecting && (
                    <p className="text-sm text-muted-foreground">
                      Waiting for the dashboard to come back online… This may take up to 2 minutes while Docker rebuilds images.
                    </p>
                  )}
                  {!reconnecting && !status?.error && (
                    <div className="space-y-2">
                      <p className={countdown < 60 ? "text-sm text-warning" : "text-sm text-muted-foreground"}>
                        The dashboard is restarting. Do not close this tab.
                      </p>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-all duration-1000"
                          style={{ width: `${Math.max(5, ((90 - countdown) / 90) * 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {verifying && (
              <Alert>
                <Loader2 className="animate-spin" />
                <AlertTitle>Verifying the new version…</AlertTitle>
                <AlertDescription>
                  PulseNode is checking that the update is healthy and will roll back by itself if it is not.
                </AlertDescription>
              </Alert>
            )}

            {restoring && (
              <Alert>
                <Loader2 className="animate-spin" />
                <AlertTitle>Restoring the database snapshot…</AlertTitle>
                <AlertDescription>PulseNode is restarting to apply it. This page reloads when it is back.</AlertDescription>
              </Alert>
            )}

            {!updating && status && (status.phase === "done" || status.phase === "rolled_back" || status.phase === "failed") && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Undo2 className="size-4 text-[var(--hue)]" /> Last update</CardTitle>
                  {status.finishedAt && (
                    <CardDescription>{new Date(status.finishedAt).toLocaleString()}</CardDescription>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  {status.phase === "done" && (
                    <Alert>
                      <CheckCircle2 className="text-success" />
                      <AlertTitle>
                        Updated{status.fromVersion ? ` from v${status.fromVersion}` : ""}{status.toVersion ? ` to v${status.toVersion}` : ""}
                      </AlertTitle>
                      <AlertDescription>
                        The new version passed its health check
                        {status.imageTag ? <> and is pinned to <code className="font-mono">{status.imageTag}</code></> : null}.
                      </AlertDescription>
                    </Alert>
                  )}
                  {status.phase === "rolled_back" && (
                    <Alert variant="destructive">
                      <AlertTriangle />
                      <AlertTitle>
                        {status.rollbackHealthy
                          ? `The update${status.toVersion ? ` to v${status.toVersion}` : ""} failed and was rolled back`
                          : "The update failed and the rollback is not healthy either"}
                      </AlertTitle>
                      <AlertDescription>
                        {status.error}
                        {status.rollbackHealthy
                          ? " The previous version is running again with your data untouched."
                          : " Check the containers on the server (docker compose ps / logs)."}
                      </AlertDescription>
                    </Alert>
                  )}
                  {status.phase === "failed" && (
                    <Alert variant="destructive">
                      <AlertTriangle />
                      <AlertTitle>The update did not start</AlertTitle>
                      <AlertDescription>{status.error} Nothing was changed.</AlertDescription>
                    </Alert>
                  )}
                  {status.phase === "rolled_back" && status.schemaChanged && (
                    <p className="text-sm text-muted-foreground">
                      The failed version changed the database layout. The previous version still ran against the live
                      database; restore a snapshot below only if it misbehaves.
                    </p>
                  )}
                  {status.log && status.log.length > 0 && (
                    <details className="rounded-lg border bg-muted/40 p-3">
                      <summary className="cursor-pointer text-sm font-medium">Updater log</summary>
                      <div className="mt-2 max-h-72 space-y-0.5 overflow-y-auto" role="log" aria-label="Updater log">
                        {status.log.map((l, i) => <LogLine key={i} line={l} />)}
                      </div>
                    </details>
                  )}
                </CardContent>
              </Card>
            )}

            {!updating && status?.snapshots && status.snapshots.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><DatabaseBackup className="size-4 text-[var(--hue)]" /> Database snapshots</CardTitle>
                  <CardDescription>Taken automatically before every update; the newest {status.snapshots.length} are kept.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y rounded-lg border">
                    {status.snapshots.map(sn => (
                      <li key={sn.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{new Date(sn.createdAt).toLocaleString()}</p>
                          <p className="truncate font-mono text-xs text-muted-foreground">{sn.name} · {fmtBytes(sn.size)}</p>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => setRestoreTarget(sn)} disabled={restoring}>
                          <RotateCcw /> Restore…
                        </Button>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {!updating && (
              <Card>
                <CardHeader><CardTitle>How updates work</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                    <li>Checks that the new release&apos;s images are published, and saves a snapshot of the database</li>
                    <li>Pulls the latest code (<code className="font-mono text-xs text-foreground">git pull</code>) and the pinned images, or builds from source</li>
                    <li>Swaps the containers from a separate helper, so the swap survives the dashboard restarting</li>
                    <li>Waits for the new version to pass its health check — if it does not, the previous version is put back automatically</li>
                    <li>The dashboard reconnects automatically when ready</li>
                  </ol>
                  <p className="text-xs text-muted-foreground">
                    Only available when installed via <code className="font-mono">install.sh</code> (git clone required).
                  </p>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right column: Security */}
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <Shield className="size-4 text-[var(--hue)]" /> Security
                {authStatus?.enabled && <Pill tone="ok" dot className="ml-auto">Protected · {authStatus.username}</Pill>}
                {authStatus && !authStatus.enabled && <Pill tone="outline" dot className="ml-auto">Off</Pill>}
              </CardTitle>
            </CardHeader>

            <CardContent className="space-y-5">
              {secError && (
                <Alert variant="destructive"><AlertTriangle /><AlertDescription>{secError}</AlertDescription></Alert>
              )}
              {secSuccess && (
                <Alert><CheckCircle2 className="text-success" /><AlertDescription className="text-foreground">{secSuccess}</AlertDescription></Alert>
              )}

              {authStatus && !authStatus.enabled && (
                <form onSubmit={handleEnableLogin} className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Login protection is <strong className="text-foreground">off</strong>. Anyone who can reach this URL
                    can access the dashboard. Set a username and password to lock it down.
                  </p>
                  <Field id="new-username" label="Username" autoComplete="username" value={newUsername} onChange={e => setNewUsername(e.target.value)} required />
                  <Field id="new-password" label="Password" type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={8} />
                  <Field id="confirm-password" label="Confirm password" type="password" autoComplete="new-password" value={confirmPwd} onChange={e => setConfirmPwd(e.target.value)} required minLength={8} />
                  <Button type="submit" disabled={secLoading || !newUsername || !newPassword || !confirmPwd}>
                    {secLoading ? <Loader2 className="animate-spin" /> : <Shield />}
                    {secLoading ? "Enabling…" : "Enable login protection"}
                  </Button>
                </form>
              )}

              {authStatus?.enabled && (
                <div className="space-y-5">
                  <form onSubmit={handleChangePassword} className="space-y-4">
                    <h2 className="text-sm font-semibold">Change password</h2>
                    <Field id="cur-password" label="Current password" type="password" autoComplete="current-password" value={curPassword} onChange={e => setCurPassword(e.target.value)} required />
                    <Field id="chg-password" label="New password" type="password" autoComplete="new-password" value={chgPassword} onChange={e => setChgPassword(e.target.value)} required minLength={8} />
                    <Field id="chg-confirm" label="Confirm new password" type="password" autoComplete="new-password" value={chgConfirm} onChange={e => setChgConfirm(e.target.value)} required minLength={8} />
                    <Button type="submit" variant="outline" disabled={secLoading || !curPassword || !chgPassword || !chgConfirm}>
                      {secLoading ? "Updating…" : "Update password"}
                    </Button>
                  </form>

                  <Separator />

                  <Button variant="outline" onClick={handleLogout}>
                    <LogOut /> Sign out
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </PageBody>

      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={o => { if (!o) setRestoreTarget(null) }}
        title="Restore this database snapshot?"
        icon={DatabaseBackup}
        items={restoreTarget ? [{ primary: new Date(restoreTarget.createdAt).toLocaleString(), secondary: restoreTarget.name }] : undefined}
        note="Everything written since this snapshot is replaced. The current database is saved first as a new snapshot, and PulseNode restarts to apply the restore."
        confirmLabel="Restore snapshot"
        onConfirm={handleRestore}
      />
    </>
  )
}
