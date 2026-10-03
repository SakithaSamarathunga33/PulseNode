"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2, CheckCircle2, XCircle } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

const GO_API = process.env.NEXT_PUBLIC_GO_API ?? ""

function CallbackInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading")
  const [message, setMessage] = useState("")

  useEffect(() => {
    const installationId = searchParams.get("installation_id")
    const action = searchParams.get("setup_action")
    const state = searchParams.get("state")

    // If state encodes a different origin (user was on a different PulseNode
    // instance when they clicked Install), relay them there so their instance
    // registers the installation — not this one.
    if (state) {
      try {
        const originFromState = atob(state)
        if (
          originFromState &&
          /^https?:\/\//.test(originFromState) &&
          originFromState !== window.location.origin
        ) {
          const relay = new URLSearchParams()
          if (installationId) relay.set("installation_id", installationId)
          if (action) relay.set("setup_action", action)
          // This instance may have the private key — resolve account details
          // and pass them so the target shows real names, not "unknown".
          const doRelay = async () => {
            try {
              const res = await fetch(`${GO_API}/api/github/app/installation-details?installation_id=${installationId}`)
              if (res.ok) {
                const d = await res.json()
                if (d.accountLogin) relay.set("account_login", d.accountLogin)
                if (d.accountType)  relay.set("account_type",  d.accountType)
              }
            } catch { /* best-effort — target will show "unknown" if this fails */ }
            window.location.href = `${originFromState}/github/app/callback?${relay}`
          }
          doRelay()
          return
        }
      } catch { /* invalid base64 — fall through to local handling */ }
    }

    if (!installationId && action !== "delete") {
      setStatus("error")
      setMessage("Missing installation_id parameter.")
      return
    }

    const params = new URLSearchParams()
    if (installationId) params.set("installation_id", installationId)
    if (action) params.set("setup_action", action)

    fetch(`${GO_API}/api/github/app/register?${params}`)
      .then(async r => {
        const d = await r.json()
        if (!r.ok) throw new Error(d.error ?? "Registration failed")
        if (action === "delete") {
          setStatus("ok")
          setMessage("App uninstalled successfully.")
        } else {
          setStatus("ok")
          setMessage(`Installation registered for ${d.accountLogin ?? "your account"}.`)
        }
        setTimeout(() => router.push("/github"), 1500)
      })
      .catch(e => {
        setStatus("error")
        setMessage(e.message)
        setTimeout(() => router.push("/github"), 3000)
      })
  }, [searchParams, router])

  return (
    <div className="grid min-h-screen place-items-center bg-background p-4">
      <Card className="w-full max-w-sm" role="status" aria-live="polite">
        <CardContent className="flex flex-col items-center gap-3 py-8 text-center motion-safe:animate-in fade-in-0 duration-300">
          {status === "loading" && (
            <>
              <Loader2 className="size-8 animate-spin text-primary" aria-hidden />
              <p className="text-sm font-medium">Registering installation…</p>
            </>
          )}
          {status === "ok" && (
            <>
              <CheckCircle2 className="size-8 text-success" aria-hidden />
              <p className="text-sm font-medium">{message}</p>
              <p className="text-xs text-muted-foreground">Redirecting…</p>
            </>
          )}
          {status === "error" && (
            <>
              <XCircle className="size-8 text-danger" aria-hidden />
              <p className="text-sm font-medium">Something went wrong</p>
              <p className="text-sm text-muted-foreground">{message}</p>
              <p className="text-xs text-muted-foreground">Redirecting to GitHub settings…</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default function GitHubAppCallbackPage() {
  return (
    <Suspense fallback={
      <div className="grid min-h-screen place-items-center bg-background">
        <Loader2 className="size-8 animate-spin text-primary" aria-label="Loading" />
      </div>
    }>
      <CallbackInner />
    </Suspense>
  )
}
