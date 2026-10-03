"use client"

import { API_BASE } from "@/lib/api"
import { useTimeouts } from "@/lib/use-timeouts"
import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { GitHubDark } from "developer-icons"
import { ArrowLeft, CheckCircle2, Loader2, XCircle, Zap } from "lucide-react"

const GO_API = API_BASE

function CallbackInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const later = useTimeouts()
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
        later(() => router.push("/github"), 1500)
      })
      .catch(e => {
        setStatus("error")
        setMessage(e.message)
        later(() => router.push("/github"), 3000)
      })
  }, [searchParams, router, later])

  const view = {
    loading: { title: "Registering installation…", desc: "Exchanging the authorization code with GitHub.", tone: "bg-primary/12 text-primary" },
    ok:      { title: message || "Installation registered", desc: "Your repositories are now available for deployment.", tone: "bg-success/12 text-success" },
    error:   { title: "Could not register the installation", desc: "Check the details below, then try connecting again.", tone: "bg-danger/12 text-danger" },
  }[status]

  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <div role="status" aria-live="polite" className="flex w-full max-w-[420px] flex-col items-center gap-[18px] text-center motion-safe:animate-in fade-in-0 duration-300">
        <div className="flex items-center gap-2.5 text-muted-foreground" aria-hidden>
          <span className="grid size-9 place-items-center rounded-[9px] border bg-card text-primary"><Zap className="size-[18px]" /></span>
          <ArrowLeft className="size-3.5" />
          <span className="grid size-9 place-items-center rounded-[9px] border bg-card text-foreground"><GitHubDark size={19} className="theme-dark-surface-icon" /></span>
        </div>

        <span className={`grid size-11 place-items-center rounded-full ${view.tone}`}>
          {status === "loading" && <Loader2 className="size-[22px] animate-spin" aria-hidden />}
          {status === "ok" && <CheckCircle2 className="size-[22px]" aria-hidden />}
          {status === "error" && <XCircle className="size-[22px]" aria-hidden />}
        </span>

        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold">{view.title}</h1>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{view.desc}</p>
        </div>

        {status === "error" && message && (
          <code className="max-w-full rounded-lg border bg-muted/50 px-3 py-2 font-mono text-xs break-words text-muted-foreground">{message}</code>
        )}
        {status !== "loading" && (
          <>
            <p className="text-xs text-muted-foreground">Redirecting{status === "error" ? " to GitHub settings" : ""}…</p>
            <Link href="/github" className="text-[13px] text-primary underline underline-offset-2">Go to GitHub settings now</Link>
          </>
        )}
      </div>
    </main>
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
