"use client"

import { useState, useEffect, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2 } from "lucide-react"
import { BorderBeam } from "@/components/magicui/border-beam"

const GO_API = process.env.NEXT_PUBLIC_GO_API ?? ""

interface AuthStatus {
  enabled: boolean
  loggedIn: boolean
  setupRequired?: boolean
}

// Only follow same-origin paths after login. A raw `next` would allow
// `javascript:` URLs (XSS in the panel origin) or `//evil.com` (open redirect).
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/"
  return next
}

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [confirm,  setConfirm]  = useState("")
  const [token,    setToken]    = useState("")
  const [setup,    setSetup]    = useState(false)
  const [error,    setError]    = useState("")
  const [loading,  setLoading]  = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    fetch(`${GO_API}/api/auth/status`, { cache: "no-store" })
      .then(r => r.json() as Promise<AuthStatus>)
      .then(d => {
        if (!d.enabled || d.loggedIn) {
          router.replace(safeNext(params.get("next")))
        } else {
          setSetup(!!d.setupRequired)
          setChecking(false)
        }
      })
      .catch(() => setChecking(false))
  }, [router, params])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    if (setup && password !== confirm) {
      setError("Passwords do not match")
      return
    }
    setLoading(true)
    try {
      if (setup) {
        const res = await fetch(`${GO_API}/api/auth/setup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password, setup_token: token.trim() }),
        })
        if (!res.ok) {
          const b = await res.json().catch(() => ({})) as { error?: string }
          setError(b.error ?? "Could not create the admin account")
          return
        }
      }
      const res = await fetch(`${GO_API}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string }
        setError(b.error ?? "Login failed")
        return
      }
      // Hard navigation so middleware re-runs server-side with the freshly-set
      // session cookie. A client-side router.replace can race the new cookie and
      // bounce straight back to /login.
      window.location.href = safeNext(params.get("next"))
    } catch {
      setError("Could not reach server")
    } finally {
      setLoading(false)
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-pulseNode-navy">
        <Loader2 className="animate-spin text-helm-fg3" size={24} />
      </div>
    )
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-pulseNode-navy p-4 relative"
      style={{
        backgroundImage: "url('/file_0000000053ac720b95e22d8410d1da4d.png')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
    >
      <div className="absolute inset-0 pointer-events-none" style={{ background: "rgba(8,8,11,0.55)" }} />
      <div className="w-full max-w-sm relative z-10">
        <div className="text-center mb-8">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logodark-removebg-preview.png"
            alt="PulseNode"
            className="mx-auto h-20 w-auto"
          />
          <p className="text-sm text-helm-fg3 mt-3">
            {setup ? "Create your admin account" : "Sign in to your dashboard"}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="relative overflow-hidden rounded-xl border border-pulseNode-border/20 bg-pulseNode-navyLight p-6 space-y-4"
        >
          <BorderBeam size={120} duration={8} borderWidth={2} />
          {setup && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-helm-fg3">
                Setup token
              </label>
              <input
                value={token}
                onChange={e => setToken(e.target.value)}
                autoFocus
                autoComplete="off"
                required
                className="w-full px-3 py-2 rounded-lg text-sm font-mono bg-pulseNode-navy border border-pulseNode-border/20 text-helm-fg placeholder:text-helm-fg3 focus:outline-none focus:border-pn-cyan/40"
              />
              <p className="text-[11px] text-helm-fg3">
                Find it on the server: <code className="font-mono">docker compose logs go-api | grep setup_token</code>
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-helm-fg3">
              Username
            </label>
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus={!setup}
              autoComplete="username"
              required
              className="w-full px-3 py-2 rounded-lg text-sm bg-pulseNode-navy border border-pulseNode-border/20 text-helm-fg placeholder:text-helm-fg3 focus:outline-none focus:border-pn-cyan/40"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-helm-fg3">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete={setup ? "new-password" : "current-password"}
              minLength={setup ? 8 : undefined}
              required
              className="w-full px-3 py-2 rounded-lg text-sm bg-pulseNode-navy border border-pulseNode-border/20 text-helm-fg placeholder:text-helm-fg3 focus:outline-none focus:border-pn-cyan/40"
            />
          </div>

          {setup && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-helm-fg3">
                Confirm password
              </label>
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                className="w-full px-3 py-2 rounded-lg text-sm bg-pulseNode-navy border border-pulseNode-border/20 text-helm-fg placeholder:text-helm-fg3 focus:outline-none focus:border-pn-cyan/40"
              />
            </div>
          )}

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 bg-[var(--acc)] hover:bg-[var(--acc-2)] disabled:opacity-60 text-white rounded-lg py-2.5 text-sm font-semibold shadow-[0_1px_0_rgba(255,255,255,0.16)_inset,0_10px_24px_-14px_rgba(139,124,255,0.9)] transition-colors"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {setup ? "Create account & sign in" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-pulseNode-navy">
        <Loader2 className="animate-spin text-helm-fg3" size={24} />
      </div>
    }>
      <LoginForm />
    </Suspense>
  )
}
