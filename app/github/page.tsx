"use client"

import { API_BASE } from "@/lib/api"
import { useState, useEffect, useCallback } from "react"
import { Key, Unlink, ExternalLink, ChevronRight, Webhook, GitBranch, Loader2, Check, Clock, Eye, EyeOff, AlertCircle, RefreshCw, Zap } from "lucide-react"
import { GitHubDark } from "developer-icons"
import Link from "next/link"
import { toast } from "sonner"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import { Segmented } from "@/components/pn/Segmented"
import { CopyField } from "@/components/github/SecretField"
import { Pill } from "@/components/dashboard/Pill"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { useTimeouts } from "@/lib/use-timeouts"

const GO_API = API_BASE

type Account = { login: string; avatarUrl: string; tokenType: "oauth" | "pat" }
type OAuthSettings = { clientId: string; hasSecret: boolean; configured: boolean }

export default function GitHubPage() {
  const [account, setAccount]             = useState<Account | null>(null)
  const [oauthSettings, setOAuthSettings] = useState<OAuthSettings | null>(null)
  const [loading, setLoading]             = useState(true)
  const [loadError, setLoadError]         = useState(false)
  const later = useTimeouts()

  const [patValue, setPatValue]           = useState("")
  const [patLoading, setPatLoading]       = useState(false)
  const [patError, setPatError]           = useState("")
  const [patType, setPatType]             = useState<"classic" | "fine">("classic")

  const [clientId, setClientId]           = useState("")
  const [clientSecret, setClientSecret]   = useState("")
  const [oauthSaving, setOauthSaving]     = useState(false)
  const [oauthSaved, setOauthSaved]       = useState(false)

  const [webhookSecret, setWebhookSecret] = useState("")
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [showPat, setShowPat]             = useState(false)

  const fetchAccount = useCallback(async () => {
    try {
      const r = await fetch(`${GO_API}/api/github/account`)
      if (!r.ok) throw new Error(String(r.status))
      setAccount((await r.json()) ?? null)
      setLoadError(false)
    } catch { setAccount(null); setLoadError(true) }
  }, [])

  const fetchOAuthSettings = useCallback(async () => {
    try {
      const r = await fetch(`${GO_API}/api/github/oauth-settings`)
      if (!r.ok) throw new Error(String(r.status))
      const d: OAuthSettings = await r.json()
      setOAuthSettings(d)
      setClientId(d.clientId ?? "")
    } catch { setOAuthSettings(null); setLoadError(true) }
  }, [])

  const fetchWebhook = useCallback(async () => {
    try {
      const r = await fetch(`${GO_API}/api/github/webhook-info`)
      const d = await r.json()
      setWebhookSecret(d.secret ?? "")
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    Promise.all([
      fetchAccount(), fetchOAuthSettings(), fetchWebhook(),
    ]).finally(() => setLoading(false))

    const params = new URLSearchParams(window.location.search)
    if (params.get("connected") === "1") window.history.replaceState({}, "", "/github")
  }, [fetchAccount, fetchOAuthSettings, fetchWebhook])

  const webhookUrl = typeof window !== "undefined" ? `${window.location.origin}${GO_API}/api/github/webhook` : ""

  const connectOAuth = async () => {
    try {
      const r = await fetch(`${GO_API}/api/github/auth-url`)
      if (!r.ok) throw new Error(String(r.status))
      window.location.href = (await r.json()).url
    } catch { toast.error("Could not start the GitHub sign-in. Check that the PulseNode API is reachable.") }
  }

  const connectPAT = async () => {
    if (!patValue.trim()) return
    setPatLoading(true); setPatError("")
    try {
      const r = await fetch(`${GO_API}/api/github/pat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: patValue }),
      })
      const d = await r.json()
      if (!r.ok) { setPatError(d.error ?? "Failed"); return }
      setPatValue("")
      await fetchAccount()
    } catch { setPatError("Network error") }
    finally { setPatLoading(false) }
  }

  const disconnect = async () => {
    try {
      const r = await fetch(`${GO_API}/api/github/account`, { method: "DELETE" })
      if (!r.ok) throw new Error(String(r.status))
      setAccount(null)
    } catch { toast.error("Could not disconnect the GitHub account.") }
  }

  const saveOAuthSettings = async () => {
    setOauthSaving(true)
    try {
      const r = await fetch(`${GO_API}/api/github/oauth-settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret }),
      })
      if (!r.ok) throw new Error(String(r.status))
      setClientSecret("")
      setOauthSaved(true)
      await fetchOAuthSettings()
      later(() => setOauthSaved(false), 3000)
    } catch { toast.error("Could not save the OAuth settings.") }
    finally { setOauthSaving(false) }
  }

  const DESC = "Repository access, deploy webhooks and OAuth configuration for GitHub deployments."

  if (loading) {
    return (
      <>
        <PageHeader icon={GitBranch} title="GitHub" description={DESC} />
        <PageBody>
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </PageBody>
      </>
    )
  }

  const callbackUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/go/api/github/callback`
  const oauthDirty = clientSecret.length > 0 || clientId !== (oauthSettings?.clientId ?? "")
  const scopes = patType === "classic"
    ? [["repo", "full scope"]]
    : [["Contents", "Read"], ["Metadata", "Read"], ["Webhooks", "Read/Write"]]

  return (
    <>
      <PageHeader icon={GitBranch} title="GitHub" description={DESC} />
      <PageBody className="motion-safe:animate-in fade-in-0 duration-300">
        {loadError && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load the GitHub connection</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-3">
              The request to the PulseNode API failed, so the account state below may be wrong.
              <Button variant="outline" size="sm" onClick={() => { setLoadError(false); fetchAccount(); fetchOAuthSettings() }}>
                <RefreshCw className="size-3.5" />Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Connection */}
        {account ? (
          <section aria-label="Connection" className="overflow-hidden rounded-xl border bg-card shadow-card">
            <div className="flex flex-wrap items-center gap-4 px-5 py-[18px]">
              <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-xl border bg-muted">
                {account.avatarUrl
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={account.avatarUrl} alt={`${account.login} avatar`} className="size-full object-cover" />
                  : <GitHubDark size={24} className="theme-dark-surface-icon" />}
              </span>
              <div className="min-w-[200px] flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="font-mono text-[17px] font-semibold">{account.login}</span>
                  <Pill tone="ok" dot>Connected</Pill>
                </div>
                <p className="text-[13px] text-muted-foreground">
                  Authenticated via{" "}
                  <b className="font-medium text-foreground">{account.tokenType === "pat" ? "Personal access token" : "OAuth app"}</b>
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="destructive" onClick={() => setConfirmDisconnect(true)}>
                  <Unlink /> Disconnect
                </Button>
                <Button nativeButton={false} render={<Link href="/projects/new" />}>
                  <Zap /> Deploy project
                </Button>
              </div>
            </div>
          </section>
        ) : (
          <section aria-label="Connect GitHub" className="overflow-hidden rounded-xl border bg-card shadow-card">
            <div className="flex items-start gap-4 border-b px-[22px] pt-[22px] pb-[18px]">
              <span className="grid size-[52px] shrink-0 place-items-center rounded-xl border bg-muted">
                <GitHubDark size={26} className="theme-dark-surface-icon" />
              </span>
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">Connect GitHub</h2>
                <p className="max-w-[560px] text-[13px] text-muted-foreground">
                  PulseNode reads repositories, clones on deploy, and registers push webhooks. Choose how it authenticates.
                </p>
              </div>
            </div>

            <div className="grid gap-px bg-border md:grid-cols-2">
              <div className="flex flex-col gap-3 bg-card px-[22px] py-5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">OAuth app</span>
                  <Pill tone="info">Recommended</Pill>
                </div>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  Sign in with GitHub and grant access to selected organizations. Tokens refresh automatically.
                </p>
                <Button className="w-fit" onClick={connectOAuth} disabled={!oauthSettings?.configured}>
                  <GitHubDark size={14} /> Continue with GitHub
                </Button>
                <p className="text-xs text-muted-foreground">
                  {oauthSettings?.configured
                    ? "OAuth app is configured. You will be sent to GitHub to approve access."
                    : "Requires a Client ID and Secret under OAuth settings below."}
                </p>
              </div>

              <div className="flex flex-col gap-3 bg-card px-[22px] py-5">
                <span className="text-sm font-semibold">Personal access token</span>
                <Segmented<"classic" | "fine">
                  aria-label="Token type"
                  value={patType}
                  onChange={v => { setPatType(v); setPatError("") }}
                  options={[{ value: "classic", label: "Classic" }, { value: "fine", label: "Fine-grained" }]}
                  className="w-fit"
                />
                <div className="space-y-1.5 rounded-lg border bg-muted/40 px-3 py-2.5">
                  <p className="text-xs text-muted-foreground">Required permissions</p>
                  {scopes.map(([k, v]) => (
                    <p key={k} className="flex justify-between gap-2.5 font-mono text-xs">
                      <span>{k}</span><span className="text-success">{v}</span>
                    </p>
                  ))}
                  <p className="pt-1 text-xs text-muted-foreground">
                    Create one at{" "}
                    <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline underline-offset-2">
                      github.com/settings/tokens <ExternalLink className="size-3" />
                    </a>
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pat">Token</Label>
                  <div className="flex gap-2">
                    <Input
                      id="pat"
                      type={showPat ? "text" : "password"}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={patType === "classic" ? "ghp_••••••••••••••••••••" : "github_pat_••••••••••••••••••••"}
                      value={patValue}
                      onChange={e => setPatValue(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && connectPAT()}
                      className="font-mono"
                      aria-invalid={!!patError}
                    />
                    <Button type="button" variant="outline" size="icon" onClick={() => setShowPat(s => !s)}
                      aria-label={showPat ? "Hide token" : "Show token"}>
                      {showPat ? <EyeOff /> : <Eye />}
                    </Button>
                  </div>
                </div>
                {patError && <p role="alert" className="text-xs text-danger">{patError}</p>}
                <Button variant="outline" className="w-fit" onClick={connectPAT} disabled={patLoading || !patValue.trim()}>
                  {patLoading ? <Loader2 className="animate-spin" /> : <Key />}
                  {patLoading ? "Validating…" : "Connect"}
                </Button>
              </div>
            </div>
          </section>
        )}

        {/* Webhook (manual fallback) */}
        <section aria-labelledby="gh-wh" className="rounded-xl border bg-card shadow-card">
          <div className="space-y-0.5 border-b px-[18px] py-3.5">
            <h2 id="gh-wh" className="flex items-center gap-2 text-sm font-semibold"><Webhook className="size-[15px]" /> Manual webhook</h2>
            <p className="text-xs text-muted-foreground">
              PulseNode installs the webhook itself when you create a project. Use this only when automatic registration is not possible,
              e.g. repositories you do not administer: <span className="font-mono">Settings, Webhooks, Add webhook</span>.
            </p>
          </div>
          <div className="space-y-3 px-[18px] py-4">
            <div className="grid gap-4 md:grid-cols-2">
              <CopyField id="wh-url" label="Payload URL" value={webhookUrl} />
              <CopyField id="wh-secret" label="Secret" value={webhookSecret} secret />
            </div>
            <ul className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
              <li className="inline-flex items-center gap-1.5"><Check className="size-3" />Content type <code className="font-mono text-foreground">application/json</code></li>
              <li className="inline-flex items-center gap-1.5"><Check className="size-3" />Events: <code className="font-mono text-foreground">push</code> only</li>
              <li className="inline-flex items-center gap-1.5"><Clock className="size-3" />The poller stays on as a fallback</li>
            </ul>
          </div>
        </section>

        {/* OAuth App Settings */}
        <Collapsible>
          <section aria-label="OAuth settings" className="rounded-xl border bg-card">
            <CollapsibleTrigger className="group flex w-full items-center gap-2.5 rounded-xl px-[18px] py-3.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <ChevronRight className="size-[15px] text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
              <span className="flex-1 text-sm font-semibold">OAuth settings</span>
              {oauthSettings?.configured && <Pill tone="ok" dot>Configured</Pill>}
              <span className="text-xs text-muted-foreground">Advanced</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="grid gap-6 border-t px-[18px] py-4 md:grid-cols-2">
                <div className="space-y-3">
                  <p className="text-[13px] text-muted-foreground">
                    Create an OAuth App at{" "}
                    <a href="https://github.com/settings/developers" target="_blank" rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2">github.com/settings/developers</a>{" "}
                    and set its callback URL to:
                  </p>
                  <CopyField id="oauth-callback" label="Callback URL" value={callbackUrl} />
                  <div className="space-y-1.5">
                    <Label htmlFor="client-id">Client ID</Label>
                    <Input id="client-id" placeholder="Iv1.xxxxxxxxxxxx" spellCheck={false} value={clientId} onChange={e => setClientId(e.target.value)} className="font-mono" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="client-secret">
                      Client Secret{oauthSettings?.hasSecret && <span className="ml-1.5 font-normal text-muted-foreground">(already set)</span>}
                    </Label>
                    <Input
                      id="client-secret"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={oauthSettings?.hasSecret ? "Leave blank to keep the current secret" : "Paste client secret"}
                      value={clientSecret}
                      onChange={e => setClientSecret(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                  <Button variant="outline" onClick={saveOAuthSettings} disabled={oauthSaving || !oauthDirty}>
                    {oauthSaving ? <Loader2 className="animate-spin" /> : oauthSaved ? <Check /> : null}
                    {oauthSaved ? "Saved" : oauthSaving ? "Saving…" : "Save settings"}
                  </Button>
                </div>
                <div className="space-y-2.5">
                  <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">How OAuth works</p>
                  <ol className="space-y-2.5">
                    {[
                      "Create an OAuth app in GitHub, Settings, Developer settings.",
                      "Set its callback URL to the value on the left.",
                      "Paste the Client ID and Client Secret and save.",
                      "Click “Continue with GitHub” and approve access for your organizations.",
                    ].map((t, i) => (
                      <li key={t} className="flex gap-2.5 text-[13px] leading-relaxed text-muted-foreground">
                        <span className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-muted font-mono text-[11px] font-semibold">{i + 1}</span>
                        <span>{t}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </CollapsibleContent>
          </section>
        </Collapsible>
      </PageBody>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        icon={Unlink}
        title="Disconnect GitHub?"
        items={account ? [{ primary: account.login, secondary: account.tokenType === "pat" ? "Personal access token" : "OAuth app" }] : undefined}
        note="Auto deploys stop until you reconnect, and private repos can't be cloned. Existing deployments keep running."
        confirmLabel="Disconnect"
        onConfirm={async () => { await disconnect(); setConfirmDisconnect(false); toast.success("GitHub disconnected") }}
      />
    </>
  )
}
