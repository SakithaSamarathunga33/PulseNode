"use client"

import { API_BASE } from "@/lib/api"
import { useState, useEffect, useCallback } from "react"
import { Key, Unlink, ExternalLink, ChevronRight, Shield, Webhook, GitBranch, Loader2, Check, Eye, EyeOff, AlertCircle, RefreshCw } from "lucide-react"
import { GitHubDark } from "developer-icons"
import Link from "next/link"
import { toast } from "sonner"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import { CopyField } from "@/components/github/SecretField"
import { Pill } from "@/components/dashboard/Pill"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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

  if (loading) {
    return (
      <>
        <PageHeader icon={GitBranch} title="GitHub" description="Connect your GitHub account to deploy projects from private and public repositories." />
        <PageBody>
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </PageBody>
      </>
    )
  }

  const callbackUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/go/api/github/callback`

  return (
    <>
      <PageHeader
        icon={GitBranch}
        title="GitHub"
        description="Connect your GitHub account to deploy projects from private and public repositories."
        actions={account && <Pill tone="ok" dot>Connected</Pill>}
      />
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
        {/* Account */}
        {account ? (
          <Card>
            <CardContent className="flex flex-wrap items-center gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={account.avatarUrl} alt={`${account.login} avatar`} className="size-12 rounded-full border" />
              <div className="min-w-0 flex-1 basis-40">
                <p className="truncate font-medium">{account.login}</p>
                <p className="text-sm text-muted-foreground">
                  Connected via {account.tokenType === "pat" ? "Personal Access Token" : "GitHub OAuth"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button nativeButton={false} render={<Link href="/projects/new" />}>
                  Deploy a project <ChevronRight />
                </Button>
                <Button variant="outline" onClick={() => setConfirmDisconnect(true)}>
                  <Unlink /> Disconnect
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {oauthSettings?.configured && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><GitHubDark size={16} className="theme-dark-surface-icon" /> Connect with GitHub OAuth</CardTitle>
                  <CardDescription>Authorize PulseNode to access your GitHub repositories.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button className="w-full" onClick={connectOAuth}>
                    <GitHubDark size={15} /> Continue with GitHub
                  </Button>
                </CardContent>
              </Card>
            )}

            <Card className={oauthSettings?.configured ? "" : "lg:col-span-2"}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Key className="size-4" /> Personal Access Token</CardTitle>
                <CardDescription>
                  Create a token at{" "}
                  <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary underline underline-offset-2">
                    github.com/settings/tokens <ExternalLink className="size-3" />
                  </a>.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Alert>
                  <AlertCircle />
                  <AlertDescription className="space-y-2">
                    <p>
                      <span className="font-medium text-foreground">Classic token</span> (recommended, simplest): enable the{" "}
                      <code className="rounded bg-muted px-1 font-mono text-xs">repo</code> scope. It covers reading and cloning
                      private repos and auto-installing the deploy webhook.
                    </p>
                    <p className="font-medium text-foreground">Fine-grained token (per-repo access)</p>
                    <ul className="list-disc space-y-0.5 pl-4">
                      <li><span className="text-foreground">Contents</span>: Read-only (clone the repo)</li>
                      <li><span className="text-foreground">Metadata</span>: Read-only (mandatory, auto-selected)</li>
                      <li><span className="text-foreground">Webhooks</span>: Read and write (auto-install push deploys)</li>
                    </ul>
                  </AlertDescription>
                </Alert>
                <div className="space-y-1.5">
                  <Label htmlFor="pat">Token</Label>
                  <div className="flex gap-2">
                    <Input
                      id="pat"
                      type={showPat ? "text" : "password"}
                      autoComplete="off"
                      placeholder="ghp_xxxxxxxxxxxx"
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
                {patError && (
                  <Alert variant="destructive"><AlertCircle /><AlertDescription>{patError}</AlertDescription></Alert>
                )}
                <Button className="w-full" onClick={connectPAT} disabled={patLoading || !patValue.trim()}>
                  {patLoading && <Loader2 className="animate-spin" />}
                  {patLoading ? "Validating…" : "Connect"}
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {/* OAuth App Settings */}
        <Collapsible>
          <Card>
            <CardHeader>
              <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                <Shield className="size-4" />
                <CardTitle>OAuth App Settings</CardTitle>
                {oauthSettings?.configured && <Pill tone="ok">Configured</Pill>}
                <ChevronRight className="ml-auto size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
              </CollapsibleTrigger>
            </CardHeader>
            <CollapsibleContent>
              <CardContent className="grid gap-6 md:grid-cols-[1fr_16rem]">
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Create an OAuth App at{" "}
                    <a href="https://github.com/settings/developers" target="_blank" rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2">github.com/settings/developers</a>{" "}
                    and set the callback URL to
                  </p>
                  <CopyField id="oauth-callback" label="Callback URL" value={callbackUrl} />
                  <div className="space-y-1.5">
                    <Label htmlFor="client-id">Client ID</Label>
                    <Input id="client-id" placeholder="Iv1.xxxxxxxxxxxx" value={clientId} onChange={e => setClientId(e.target.value)} className="font-mono" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="client-secret">
                      Client Secret{oauthSettings?.hasSecret && <Pill tone="ok" className="ml-2">Already set</Pill>}
                    </Label>
                    <Input
                      id="client-secret"
                      type="password"
                      autoComplete="off"
                      placeholder={oauthSettings?.hasSecret ? "Leave blank to keep existing" : "xxxxxxxxxxxxxxxxxxxx"}
                      value={clientSecret}
                      onChange={e => setClientSecret(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                  <Button onClick={saveOAuthSettings} disabled={oauthSaving}>
                    {oauthSaving ? <Loader2 className="animate-spin" /> : oauthSaved ? <Check /> : null}
                    {oauthSaved ? "Saved" : oauthSaving ? "Saving…" : "Save OAuth Settings"}
                  </Button>
                </div>
                <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
                  <p className="text-sm font-medium">How OAuth works</p>
                  <ol className="list-decimal space-y-1 pl-4 text-sm text-muted-foreground">
                    <li>Save your Client ID &amp; Secret</li>
                    <li>Click &quot;Continue with GitHub&quot; in the Account section</li>
                    <li>Authorize PulseNode on GitHub</li>
                    <li>You&apos;re redirected back and connected</li>
                  </ol>
                </div>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        {/* Webhook (manual fallback) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Webhook className="size-4" /> Deploy webhook (manual)</CardTitle>
            <CardDescription>
              PulseNode installs this webhook automatically on a repo when you create a project from it. Use the details below
              only to add it by hand (e.g. if the token lacked admin rights): <span className="font-mono">Settings, Webhooks, Add webhook</span>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <CopyField id="wh-url" label="Payload URL" value={webhookUrl} />
              <CopyField id="wh-secret" label="Secret" value={webhookSecret} secret />
            </div>
            <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
              <li>Content type: <code className="rounded bg-muted px-1 font-mono text-xs">application/json</code></li>
              <li>Events: just the push event</li>
              <li>The poller stays on as a fallback, so webhooks are optional but faster.</li>
            </ul>
          </CardContent>
        </Card>
      </PageBody>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        icon={Unlink}
        title="Disconnect GitHub?"
        description="PulseNode will no longer be able to clone private repos or install webhooks until you reconnect."
        target={account?.login}
        confirmLabel="Disconnect"
        onConfirm={async () => { await disconnect(); setConfirmDisconnect(false); toast.success("GitHub disconnected") }}
      />
    </>
  )
}
