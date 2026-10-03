"use client"

import { API_BASE } from "@/lib/api"
import { useState, useEffect, useCallback, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertCircle, ArrowRight, Eye, EyeOff, Loader2, Lock, RefreshCw } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const GO_API = API_BASE

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
  const [unreachable, setUnreachable] = useState(false)
  const [showPw,   setShowPw]   = useState(false)

  const checkStatus = useCallback(() => {
    setChecking(true)
    setUnreachable(false)
    fetch(`${GO_API}/api/auth/status`, { cache: "no-store" })
      .then(r => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json() as Promise<AuthStatus>
      })
      .then(d => {
        if (!d.enabled || d.loggedIn) {
          router.replace(safeNext(params.get("next")))
        } else {
          setSetup(!!d.setupRequired)
          setChecking(false)
        }
      })
      .catch(() => { setUnreachable(true); setChecking(false) })
  }, [router, params])

  useEffect(() => { checkStatus() }, [checkStatus])

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
      <div className="grid min-h-screen place-items-center bg-background text-foreground">
        <div role="status"><Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden /><span className="sr-only">Loading</span></div>
      </div>
    )
  }

  return (
    <main className="login-bg relative flex min-h-screen flex-col items-center justify-center gap-7 p-4 text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-background/70" />

      <div className="relative z-10 flex flex-col items-center gap-1.5 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logodark-removebg-preview.png" alt="PulseNode" className="theme-logo-dark mx-auto h-14 w-auto" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-removebg-preview.png" alt="PulseNode" className="theme-logo-light mx-auto h-14 w-auto" />
        <span className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground">VPS · CONSOLE</span>
      </div>

      <div className="relative z-10 w-full max-w-[380px] overflow-hidden rounded-xl border bg-card shadow-pop motion-safe:animate-in fade-in-0 duration-300">
        <div className="space-y-1 px-[22px] pt-[22px] pb-1.5">
          <h1 className="text-lg font-semibold">{setup ? "Create your admin account" : "Sign in"}</h1>
          <p className="text-[13px] text-muted-foreground">
            {setup ? "First-run setup. This account becomes the administrator." : "Sign in to your PulseNode dashboard."}
          </p>
        </div>

        {unreachable ? (
          <div className="space-y-4 px-[22px] pt-3.5 pb-5">
            <Alert variant="destructive" role="alert">
              <AlertCircle />
              <AlertDescription>Server unreachable. Check that PulseNode is running, then try again.</AlertDescription>
            </Alert>
            <Button type="button" size="lg" variant="outline" className="w-full" onClick={checkStatus}>
              <RefreshCw /> Retry
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3 px-[22px] pt-3.5 pb-5">
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertCircle />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {setup && (
              <div className="space-y-1.5">
                <Label htmlFor="setup-token">Setup token</Label>
                <Input
                  id="setup-token"
                  value={token}
                  onChange={e => setToken(e.target.value)}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  required
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Find it on the server: <code className="font-mono">docker compose logs go-api | grep setup_token</code>
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoFocus={!setup}
                autoComplete="username"
                spellCheck={false}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete={setup ? "new-password" : "current-password"}
                  minLength={setup ? 8 : undefined}
                  required
                  className="pr-10"
                />
                <Button
                  type="button" variant="ghost" size="icon-sm"
                  onClick={() => setShowPw(v => !v)}
                  aria-label={showPw ? "Hide password" : "Show password"}
                  aria-pressed={showPw}
                  className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
                >
                  {showPw ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              {setup && <p className="text-xs text-muted-foreground">At least 8 characters.</p>}
            </div>

            {setup && (
              <div className="space-y-1.5">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  type={showPw ? "text" : "password"}
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>
            )}

            <Button type="submit" size="lg" className="mt-1 w-full" disabled={loading}>
              {loading ? <Loader2 className="animate-spin" /> : <ArrowRight />}
              {loading ? (setup ? "Creating…" : "Signing in…") : setup ? "Create account & sign in" : "Sign in"}
            </Button>
          </form>
        )}

        <div className="flex items-center gap-1.5 border-t bg-muted/40 px-[22px] py-2.5 text-xs text-muted-foreground">
          <Lock className="size-3" aria-hidden />
          {setup ? "Login protection turns on as soon as the account exists." : "Login protection is enabled on this dashboard."}
        </div>
      </div>

      <p className="relative z-10 text-xs text-muted-foreground italic">Infrastructure at a glance.</p>
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="grid min-h-screen place-items-center bg-background text-foreground">
        <div role="status"><Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden /><span className="sr-only">Loading</span></div>
      </div>
    }>
      <LoginForm />
    </Suspense>
  )
}
