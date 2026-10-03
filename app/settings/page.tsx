"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertTriangle, CheckCircle2, Download, LogOut,
  RefreshCw, Settings, Shield, Zap,
} from "lucide-react"

const GO_API = process.env.NEXT_PUBLIC_GO_API ?? ""

interface VersionInfo {
  current: string
  latest: string | null
  hasUpdate: boolean
  releaseUrl: string | null
  changelog: string | null
}

interface UpdateStatus {
  running: boolean
  log: string[]
  error: string | null
  startedAt: string | null
}

interface AuthStatus { enabled: boolean; loggedIn: boolean; username?: string }

function LogLine({ line }: { line: string }) {
  if (line.startsWith("::")) {
    const msg = line.replace(/^::[^:]+:: /, "")
    return <p className="text-xs text-pn-electric font-semibold pt-1">{msg}</p>
  }
  if (line.startsWith("✓"))  return <p className="text-xs text-emerald-400 font-mono">{line}</p>
  if (line.startsWith("⚠"))  return <p className="text-xs text-amber-400 font-mono">{line}</p>
  if (line.startsWith("✕"))  return <p className="text-xs text-red-400 font-mono">{line}</p>
  if (/^\[.*\]/.test(line))  return <p className="text-[10px] text-helm-fg3/70 font-mono leading-tight">{line}</p>
  if (/^(web|go-api|caddy)\s+(Pull|Push|Build|Pulling|Pushing|Building)/.test(line))
    return <p className="text-xs text-indigo-300 font-mono">{line}</p>
  return <p className="text-xs text-helm-fg3 font-mono">{line}</p>
}

export default function SettingsPage() {
  const [version,      setVersion]      = useState<VersionInfo | null>(null)
  const [status,       setStatus]       = useState<UpdateStatus | null>(null)
  const [checking,     setChecking]     = useState(false)
  const [updating,     setUpdating]     = useState(false)
  const [countdown,    setCountdown]    = useState(0)
  const [reconnecting, setReconnecting] = useState(false)
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
      const res = await fetch(`${GO_API}/api/system/version`)
      if (res.ok) setVersion(await res.json())
    } catch { /* ignore */ }
    finally { setChecking(false) }
  }, [])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${GO_API}/api/system/update/status`)
      if (res.ok) setStatus(await res.json())
    } catch { /* go-api temporarily offline during update */ }
  }, [])

  const fetchAuthStatus = useCallback(async () => {
    try {
      const res = await fetch(`${GO_API}/api/auth/status`, { cache: "no-store" })
      if (res.ok) setAuthStatus(await res.json() as AuthStatus)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { fetchVersion() }, [fetchVersion])
  useEffect(() => { fetchAuthStatus() }, [fetchAuthStatus])

  useEffect(() => {
    if (!updating) return
    const timer = setInterval(fetchStatus, 1500)
    return () => clearInterval(timer)
  }, [updating, fetchStatus])

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
  useEffect(() => {
    if (!updating) return
    let cancelled = false
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
      if (!cancelled) setTimeout(probe, 2500)
    }
    const t = setTimeout(probe, 5000) // brief grace before the first probe
    return () => { cancelled = true; clearTimeout(t) }
  }, [updating, HEALTH_URL])

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
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Settings size={22} className="text-helm-fg3" />
        <div>
          <h1 className="text-xl font-semibold text-helm-fg">Settings</h1>
          <p className="text-sm text-helm-fg3 mt-0.5">System configuration and updates</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_400px] items-start">
        {/* ── Left column: Version + Updates ──────────────────────────────── */}
        <div className="space-y-6">
          {/* Version card */}
          <div className="rounded-xl border border-pulseNode-border/20 bg-pulseNode-navyLight overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-pulseNode-border/10 bg-pulseNode-navy">
              <Zap size={14} className="text-pn-electric" />
              <span className="text-sm font-semibold text-helm-fg">Version</span>
            </div>

            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg bg-pulseNode-navy p-3">
                  <div className="text-[10px] uppercase tracking-wider text-helm-fg3 mb-1">Installed</div>
                  <code className="text-sm font-mono text-helm-fg">
                    {version ? `v${version.current}` : "—"}
                  </code>
                </div>
                <div className="rounded-lg bg-pulseNode-navy p-3">
                  <div className="text-[10px] uppercase tracking-wider text-helm-fg3 mb-1">Latest release</div>
                  <code className="text-sm font-mono text-helm-fg">
                    {version?.latest ? `v${version.latest}` : checking ? "checking…" : "—"}
                  </code>
                </div>
              </div>

              {version && !updating && (
                <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ${
                  version.hasUpdate
                    ? "bg-amber-500/10 border border-amber-500/20 text-amber-400"
                    : "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                }`}>
                  {version.hasUpdate
                    ? <><AlertTriangle size={13} /> Update available — v{version.latest}</>
                    : <><CheckCircle2 size={13} /> You are on the latest version</>
                  }
                </div>
              )}

              {version?.hasUpdate && version.changelog && (
                <div className="rounded-lg bg-pulseNode-navy p-3 space-y-1">
                  <div className="text-[10px] uppercase tracking-wider text-helm-fg3 mb-2">What&apos;s new</div>
                  <pre className="text-[11px] text-helm-fg3 whitespace-pre-wrap font-sans leading-relaxed max-h-40 overflow-y-auto">
                    {version.changelog}
                  </pre>
                  {version.releaseUrl && (
                    <a href={version.releaseUrl} target="_blank" rel="noopener noreferrer"
                      className="text-[11px] text-pn-electric hover:underline">
                      View full release notes →
                    </a>
                  )}
                </div>
              )}

              {!updating && (
                <div className="flex gap-2">
                  <button
                    onClick={fetchVersion} disabled={checking}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg text-xs transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={12} className={checking ? "animate-spin" : ""} />
                    {checking ? "Checking…" : "Check for updates"}
                  </button>
                  {version?.hasUpdate && (
                    <button onClick={handleUpdate}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors">
                      <Download size={12} />
                      Update to v{version.latest}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Update progress */}
          {updating && (
            <div className="rounded-xl border border-pulseNode-border/20 bg-pulseNode-navyLight overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-pulseNode-border/10 bg-pulseNode-navy">
                <RefreshCw size={14} className="text-pn-electric animate-spin" />
                <span className="text-sm font-semibold text-helm-fg">
                  {reconnecting ? "Reconnecting…" : "Updating PulseNode"}
                </span>
                {!reconnecting && countdown > 0 && (
                  <span className="ml-auto text-xs text-helm-fg3">Restart expected in ~{countdown}s</span>
                )}
              </div>
              <div className="p-4 space-y-3">
                {status && status.log.length > 0 && (
                  <div className="rounded-lg bg-pulseNode-navy p-3 space-y-0.5 max-h-96 overflow-y-auto">
                    {status.log.map((l, i) => <LogLine key={i} line={l} />)}
                    <div ref={logEndRef} />
                  </div>
                )}
                {status?.error && (
                  <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
                    {status.error}
                  </div>
                )}
                {reconnecting && (
                  <p className="text-xs text-helm-fg3">
                    Waiting for the dashboard to come back online… This may take up to 2 minutes while Docker rebuilds images.
                  </p>
                )}
                {!reconnecting && !status?.error && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-[11px] text-helm-fg3">
                      <span className={countdown < 60 ? "text-amber-400" : ""}>
                        The dashboard is restarting. Do not close this tab.
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-pulseNode-border/20 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-indigo-500 transition-all duration-1000"
                        style={{ width: `${Math.max(5, ((90 - countdown) / 90) * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* How update works */}
          {!updating && (
            <div className="rounded-xl border border-pulseNode-border/10 bg-pulseNode-navyLight p-4 space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-helm-fg3 font-semibold">How updates work</div>
              <ol className="space-y-1 text-xs text-helm-fg3 list-decimal list-inside">
                <li>Pulls the latest code from GitHub (<code className="font-mono text-helm-fg">git pull</code>)</li>
                <li>Stops all running containers (<code className="font-mono text-helm-fg">docker compose down</code>)</li>
                <li>Rebuilds and restarts with the new code (<code className="font-mono text-helm-fg">docker compose up --build -d</code>)</li>
                <li>The dashboard reconnects automatically when ready</li>
              </ol>
              <p className="text-[10px] text-helm-fg3 pt-1">
                Only available when installed via <code className="font-mono">install.sh</code> (git clone required).
              </p>
            </div>
          )}
        </div>

        {/* ── Right column: Security ───────────────────────────────────────── */}
        <div className="rounded-xl border border-pulseNode-border/20 bg-pulseNode-navyLight overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-pulseNode-border/10 bg-pulseNode-navy">
            <Shield size={14} className="text-pn-electric" />
            <span className="text-sm font-semibold text-helm-fg">Security</span>
            {authStatus?.enabled && (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] font-semibold text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                Protected · {authStatus.username}
              </span>
            )}
            {authStatus && !authStatus.enabled && (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] font-semibold text-helm-fg3">
                <span className="w-1.5 h-1.5 rounded-full bg-helm-fg3 inline-block" />
                Off
              </span>
            )}
          </div>

          <div className="p-4 space-y-5">
            {secError && (
              <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">{secError}</div>
            )}
            {secSuccess && (
              <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-xs text-emerald-400">{secSuccess}</div>
            )}

            {/* No login configured — enable form */}
            {authStatus && !authStatus.enabled && (
              <form onSubmit={handleEnableLogin} className="space-y-3">
                <p className="text-xs text-helm-fg3">
                  Login protection is <strong className="text-helm-fg">off</strong>. Anyone who can reach this URL
                  can access the dashboard. Set a username and password to lock it down.
                </p>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase tracking-wider text-helm-fg3 font-semibold">Username</label>
                    <input value={newUsername} onChange={e => setNewUsername(e.target.value)} required
                      className="w-full px-3 py-2 rounded-lg text-sm bg-pulseNode-navy border border-pulseNode-border/20 text-helm-fg focus:outline-hidden focus:border-pn-cyan/40" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase tracking-wider text-helm-fg3 font-semibold">Password</label>
                    <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={8}
                      className="w-full px-3 py-2 rounded-lg text-sm bg-pulseNode-navy border border-pulseNode-border/20 text-helm-fg focus:outline-hidden focus:border-pn-cyan/40" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase tracking-wider text-helm-fg3 font-semibold">Confirm password</label>
                    <input type="password" value={confirmPwd} onChange={e => setConfirmPwd(e.target.value)} required minLength={8}
                      className="w-full px-3 py-2 rounded-lg text-sm bg-pulseNode-navy border border-pulseNode-border/20 text-helm-fg focus:outline-hidden focus:border-pn-cyan/40" />
                  </div>
                </div>
                <button type="submit" disabled={secLoading || !newUsername || !newPassword || !confirmPwd}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors">
                  <Shield size={12} />
                  {secLoading ? "Enabling…" : "Enable login protection"}
                </button>
              </form>
            )}

            {/* Login active — change password + disable */}
            {authStatus?.enabled && (
              <div className="space-y-5">
                <form onSubmit={handleChangePassword} className="space-y-3">
                  <p className="text-[10px] uppercase tracking-wider text-helm-fg3 font-semibold">Change password</p>
                  <div className="space-y-1">
                    <label className="text-[10px] text-helm-fg3">Current password</label>
                    <input type="password" value={curPassword} onChange={e => setCurPassword(e.target.value)} required
                      className="w-full px-3 py-2 rounded-lg text-sm bg-pulseNode-navy border border-pulseNode-border/20 text-helm-fg focus:outline-hidden focus:border-pn-cyan/40" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] text-helm-fg3">New password</label>
                    <input type="password" value={chgPassword} onChange={e => setChgPassword(e.target.value)} required minLength={8}
                      className="w-full px-3 py-2 rounded-lg text-sm bg-pulseNode-navy border border-pulseNode-border/20 text-helm-fg focus:outline-hidden focus:border-pn-cyan/40" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] text-helm-fg3">Confirm new password</label>
                    <input type="password" value={chgConfirm} onChange={e => setChgConfirm(e.target.value)} required minLength={8}
                      className="w-full px-3 py-2 rounded-lg text-sm bg-pulseNode-navy border border-pulseNode-border/20 text-helm-fg focus:outline-hidden focus:border-pn-cyan/40" />
                  </div>
                  <button type="submit" disabled={secLoading || !curPassword || !chgPassword || !chgConfirm}
                    className="px-4 py-1.5 rounded-lg border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg disabled:opacity-50 text-xs transition-colors">
                    {secLoading ? "Updating…" : "Update password"}
                  </button>
                </form>

                <div className="border-t border-pulseNode-border/10" />

                <div className="flex flex-wrap gap-2">
                  <button onClick={handleLogout}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg text-xs transition-colors">
                    <LogOut size={12} />
                    Sign out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
