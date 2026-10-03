"use client"

import { useState, useEffect, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertCircle, Loader2 } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
      <div className="grid min-h-screen place-items-center bg-background text-foreground">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    )
  }

  return (
    <main
      className="relative flex min-h-screen items-center justify-center bg-background p-4 text-foreground"
      style={{
        backgroundImage: "url('/file_0000000053ac720b95e22d8410d1da4d.png')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
    >
      <div className="pointer-events-none absolute inset-0 bg-black/55" />
      <Card className="relative z-10 w-full max-w-sm overflow-hidden motion-safe:animate-in fade-in-0 duration-300">
        <BorderBeam size={120} duration={8} borderWidth={2} colorFrom="var(--primary)" colorTo="var(--chart-5)" />
        <CardHeader className="items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logodark-removebg-preview.png" alt="PulseNode" className="mx-auto h-16 w-auto" />
          <h1 className="sr-only">{setup ? "Create your PulseNode admin account" : "Sign in to PulseNode"}</h1>
          <CardDescription className="pt-2">
            {setup ? "Create your admin account" : "Sign in to your dashboard"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {setup && (
              <div className="space-y-1.5">
                <Label htmlFor="setup-token">Setup token</Label>
                <Input
                  id="setup-token"
                  value={token}
                  onChange={e => setToken(e.target.value)}
                  autoFocus
                  autoComplete="off"
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
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete={setup ? "new-password" : "current-password"}
                minLength={setup ? 8 : undefined}
                required
              />
              {setup && <p className="text-xs text-muted-foreground">At least 8 characters.</p>}
            </div>

            {setup && (
              <div className="space-y-1.5">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>
            )}

            {error && (
              <Alert variant="destructive" role="alert">
                <AlertCircle />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" size="lg" className="w-full" disabled={loading}>
              {loading && <Loader2 className="animate-spin" />}
              {setup ? "Create account & sign in" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="grid min-h-screen place-items-center bg-background text-foreground">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    }>
      <LoginForm />
    </Suspense>
  )
}
