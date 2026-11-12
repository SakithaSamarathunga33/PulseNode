"use client"

import { API_BASE } from "@/lib/api"
import { useState, useEffect, useCallback } from "react"
import { Key, KeyRound, Unlink, ExternalLink, ChevronRight, Webhook, GitBranch, Loader2, Check, Clock, Eye, EyeOff, AlertCircle, RefreshCw, Zap } from "lucide-react"
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
import { Panel } from "@/components/pn/Panel"

const GO_API = API_BASE

type Account = { login: string; avatarUrl: string; tokenType: "oauth" | "pat" }
type OAuthSettings = { clientId: string; hasSecret: boolean; configured: boolean }

const OAUTH_STEPS = [
  "Create an OAuth app in GitHub, Settings, Developer settings.",
  "Set its callback URL to the value on the left.",
  "Paste the Client ID and Client Secret and save.",
  "Click “Continue with GitHub” and approve access for your organizations.",
]

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
      <PageBody>
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

        {/* Connection: same card in both states, the header pill carries the status */}
        <Panel role="region" aria-labelledby="gh-conn" className="overflow-hidden rounded-xl">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <h2 id="gh-conn" className="inline-flex items-center gap-2 text-sm font-semibold">
              <GitHubDark size={15} className="theme-dark-surface-icon" aria-hidden />
              {account ? "Connection" : "Connect GitHub"}
            </h2>
            {account ? <Pill tone="ok" dot>Connected</Pill> : <Pill dot>Not connected</Pill>}
          </div>

          {account ? (
            <div className="flex flex-wrap items-center gap-4 p-4">
              <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border bg-muted">
                {account.avatarUrl
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={account.avatarUrl} alt={`${account.login} avatar`} className="size-full object-cover" />
                  : <GitHubDark size={20} className="theme-dark-surface-icon" />}
              </span>
              <div className="min-w-[200px] flex-1 space-y-0.5">
                <p className="font-mono text-base font-semibold break-all">{account.login}</p>
                <p className="text-ui text-muted-foreground">
                  Authenticated via{" "}
                  <span className="font-medium text-foreground">{account.tokenType === "pat" ? "Personal access token" : "OAuth app"}</span>
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" className="text-danger hover:text-danger" onClick={() => setConfirmDisconnect(true)}>
                  <Unlink /> Disconnect
                </Button>
                <Button nativeButton={false} render={<Link href="/projects/new" />}>
                  <Zap /> Deploy project
                </Button>
              </div>
            </div>
          ) : (
            <>
              <p className="px-4 pt-4 text-ui text-muted-foreground">
                PulseNode reads repositories, clones on deploy, and registers push webhooks. Choose how it authenticates.
              </p>
              <div className="grid max-md:divide-y md:grid-cols-2 md:divide-x">
                <div className="flex flex-col gap-3 p-4">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">OAuth app</h3>
                    <Pill tone="acc">Recommended</Pill>
                  </div>
                  <p className="text-ui leading-relaxed text-muted-foreground">
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

                <div className="flex flex-col gap-3 p-4">
                  <h3 className="text-sm font-semibold">Personal access token</h3>
                  <Segmented<"classic" | "fine">
                    aria-label="Token type"
                    value={patType}
                    onChange={v => { setPatType(v); setPatError("") }}
                    options={[{ value: "classic", label: "Classic" }, { value: "fine", label: "Fine-grained" }]}
                    className="w-fit"
                  />
                  <div className="space-y-2">
                    <p className="text-ui text-muted-foreground">Required permissions</p>
                    <dl className="divide-y border-y">
                      {scopes.map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-2 py-1.5 font-mono text-xs">
                          <dt>{k}</dt><dd className="text-muted-foreground">{v}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="text-xs text-muted-foreground">
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
                        aria-describedby={patError ? "pat-error" : undefined}
                      />
                      <Button type="button" variant="outline" size="icon" onClick={() => setShowPat(s => !s)}
                        aria-label={showPat ? "Hide token" : "Show token"}>
                        {showPat ? <EyeOff /> : <Eye />}
                      </Button>
                    </div>
                  </div>
                  {patError && <p id="pat-error" role="alert" className="text-xs text-danger">{patError}</p>}
                  <Button variant="outline" className="w-fit" onClick={connectPAT} disabled={patLoading || !patValue.trim()}>
                    {patLoading ? <Loader2 className="animate-spin" /> : <Key />}
                    {patLoading ? "Validating…" : "Connect"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </Panel>

        {/* Webhook (manual fallback) */}
        <Panel role="region" aria-labelledby="gh-wh" className="rounded-xl">
          <div className="space-y-0.5 border-b px-4 py-3">
            <h2 id="gh-wh" className="flex items-center gap-2 text-sm font-semibold">
              <Webhook className="size-4 text-[var(--hue)]" strokeWidth={1.75} aria-hidden /> Manual webhook
            </h2>
            <p className="text-ui text-muted-foreground">
              PulseNode installs the webhook itself when you create a project. Use this only when automatic registration is not possible,
              e.g. repositories you do not administer: <span className="font-mono text-xs">Settings, Webhooks, Add webhook</span>.
            </p>
          </div>
          <div className="space-y-3 p-4">
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
        </Panel>

        {/* OAuth App Settings */}
        <Collapsible>
          <Panel role="region" aria-labelledby="gh-oauth" className="rounded-xl">
            <h2>
              <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-2 rounded-xl px-4 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
                <KeyRound className="size-4 text-[var(--hue)]" strokeWidth={1.75} aria-hidden />
                <span id="gh-oauth" className="flex-1 text-sm font-semibold">OAuth settings</span>
                {oauthSettings?.configured ? <Pill tone="ok" dot>Configured</Pill> : <Pill dot>Not configured</Pill>}
                <span className="text-xs text-muted-foreground">Advanced</span>
              </CollapsibleTrigger>
            </h2>
            <CollapsibleContent>
              <div className="grid gap-6 border-t p-4 md:grid-cols-2">
                <div className="space-y-3">
                  <p className="text-ui text-muted-foreground">
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
                <div className="space-y-2 md:border-l md:pl-6">
                  <h3 className="text-ui font-semibold">How OAuth works</h3>
                  <ol className="space-y-2">
                    {OAUTH_STEPS.map((t, i) => (
                      <li key={t} className="flex gap-2 text-ui leading-relaxed text-muted-foreground">
                        <span className="grid size-5 shrink-0 place-items-center rounded-md border font-mono text-2xs font-semibold text-foreground tabular-nums">{i + 1}</span>
                        <span>{t}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </CollapsibleContent>
          </Panel>
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
