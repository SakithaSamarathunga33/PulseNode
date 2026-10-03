"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { useParams, useRouter } from "next/navigation"
import Link from "next/link"
import {
  Play, Trash2, Globe, GitBranch, ChevronLeft, Terminal, History, Settings2, ExternalLink,
  Save, Zap, RotateCcw, Webhook, Server, Square, RotateCw, Box, Loader2, AlertCircle, FolderGit2,
  Clock, ScrollText,
} from "lucide-react"
import { toast } from "sonner"
import { getSocket } from "@/lib/socket"
import { TerminalWindow } from "@/components/magicui/terminal"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { EmptyState } from "@/components/pn/EmptyState"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import { Pill } from "@/components/dashboard/Pill"
import { FormField, ChoiceGroup, BUILD_METHODS } from "@/components/projects/forms"
import { cn } from "@/lib/utils"

const GO_API = process.env.NEXT_PUBLIC_GO_API ?? ""

type Project = {
  ID: string; Name: string; RepoURL: string; Branch: string
  Domain: string; Status: string; BuildMethod: string; Port: number
  BuildCommand: string; EnvVars: string; BackendEnvVars: string; BaseDir: string; CreatedAt: string
  AutoDeploy: boolean; LastCommitSHA: string
  // Set for apps already hosted on the VPS (behind a domain) that weren't
  // deployed through PulseNode — see ExternalProjectView below.
  External?: boolean; Image?: string; Ports?: string; ContainerID?: string
}
type Deployment = {
  ID: string; Status: string; Trigger: string
  CommitSHA: string; CommitMsg: string; ImageTag: string
  StartedAt: string | null; FinishedAt: string | null; CreatedAt: string
}
type LogLine = { stream: string; line: string; ts: string }
type WebhookStatus = { installed: boolean; supported: boolean; url: string; error?: string }

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "outline"> = {
  running: "ok", success: "ok", building: "info", queued: "info",
  failed: "bad", idle: "outline",
}

function StatusPill({ status }: { status: string }) {
  return (
    <Pill tone={STATUS_TONE[status] ?? "outline"} dot className="capitalize">
      {status || "unknown"}
    </Pill>
  )
}

function DomainLink({ domain }: { domain: string }) {
  return (
    <a
      href={`https://${domain}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-sm font-mono text-[var(--hue-fg)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <Globe className="size-3.5" aria-hidden />
      {domain}
      <ExternalLink className="size-3" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}

function BackLink() {
  return (
    <Link href="/projects" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ChevronLeft className="size-3.5" aria-hidden /> Projects
    </Link>
  )
}

// Read-only(ish) detail view for an app already hosted on the VPS behind a
// domain but not deployed through PulseNode (discovered from a running
// container, not the projects table — see backend discoverExternalProjects).
// No settings/redeploy/rollback, since there's no repo or build config for
// it here; container start/stop/restart and logs reuse the generic docker
// endpoints the Containers page uses.
function ExternalProjectView({ project }: { project: Project }) {
  const containerID = project.ContainerID ?? ""
  const [status, setStatus] = useState(project.Status)
  const [logs, setLogs] = useState("")
  const [loadingLogs, setLoadingLogs] = useState(true)
  const [acting, setActing] = useState<string | null>(null)

  const fetchLogs = useCallback(async () => {
    setLoadingLogs(true)
    try {
      const r = await fetch(`${GO_API}/api/docker/logs/${containerID}?tail=300`)
      if (r.ok) setLogs((await r.json()).logs ?? "")
    } catch { /* ignore */ }
    finally { setLoadingLogs(false) }
  }, [containerID])

  useEffect(() => { fetchLogs() }, [fetchLogs])

  const runAction = async (action: "start" | "stop" | "restart") => {
    setActing(action)
    try {
      const r = await fetch(`${GO_API}/api/docker/${action}/${containerID}`, { method: "POST" })
      if (r.ok) {
        setStatus(action === "stop" ? "exited" : "running")
        await fetchLogs()
      }
    } finally { setActing(null) }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        icon={Server}
        title={<span className="flex items-center gap-2">{project.Name}<StatusPill status={status} /></span>}
        description={<span className="flex flex-wrap items-center gap-x-3 gap-y-1"><BackLink /><DomainLink domain={project.Domain} /></span>}
        actions={
          <>
            <Button variant="outline" onClick={() => runAction("restart")} disabled={acting !== null}>
              <RotateCw className={cn("size-4", acting === "restart" && "animate-spin")} />
              Restart
            </Button>
            {status === "running" ? (
              <Button variant="outline" className="text-danger hover:text-danger" onClick={() => runAction("stop")} disabled={acting !== null}>
                <Square className="size-4" />
                Stop
              </Button>
            ) : (
              <Button onClick={() => runAction("start")} disabled={acting !== null}>
                <Play className="size-4" />
                Start
              </Button>
            )}
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-6">
        <Card className="shrink-0">
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Hosted on this VPS behind a domain, but not deployed through PulseNode — read-only details, pulled live from Docker.
            </p>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                { label: "Image", value: project.Image || "—" },
                { label: "Ports", value: project.Ports || "—" },
                { label: "Container", value: containerID || "—" },
                { label: "Created", value: project.CreatedAt || "—" },
              ].map(row => (
                <div key={row.label} className="min-w-0">
                  <dt className="mb-0.5 text-xs text-muted-foreground">{row.label}</dt>
                  <dd className="flex items-center gap-1 truncate font-mono text-xs" title={row.value}>
                    {row.label === "Container" && <Box className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
                    <span className="truncate">{row.value}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <TerminalWindow className="min-h-64 flex-1" title={`${project.Name} — container logs`}>
          {loadingLogs ? (
            <p className="text-[var(--t-muted)]">Loading logs…</p>
          ) : logs ? (
            logs.split("\n").map((line, i) => (
              <div key={i}>{line}</div>
            ))
          ) : (
            <p className="text-[var(--t-muted)]">No logs.</p>
          )}
        </TerminalWindow>
      </div>
    </div>
  )
}

function age(ts: string) {
  const d = Date.now() - new Date(ts).getTime()
  if (d < 60_000) return "just now"
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  return `${Math.floor(d / 86_400_000)}d ago`
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  const [project, setProject]           = useState<Project | null>(null)
  const [deployments, setDeployments]   = useState<Deployment[]>([])
  const [logs, setLogs]                 = useState<LogLine[]>([])
  const [activeDep, setActiveDep]       = useState<string | null>(null)
  const [tab, setTab]                   = useState<"logs" | "history" | "settings">("settings")
  const [loading, setLoading]           = useState(true)
  const [deploying, setDeploying]       = useState(false)
  const [rolling, setRolling]           = useState<string | null>(null)
  const [deleting, setDeleting]         = useState(false)
  const [webhook, setWebhook]           = useState<WebhookStatus | null>(null)
  const [installingHook, setInstallingHook] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [rollbackTarget, setRollbackTarget] = useState<Deployment | null>(null)
  const activeDepRef                    = useRef<string | null>(null)

  // Editable settings form
  const [form, setForm] = useState({
    name: "", branch: "", domain: "", port: "3000",
    buildMethod: "auto", buildCommand: "", envText: "", backendEnvText: "", autoDeploy: true,
  })
  // Whether this project's repo is a frontend/+backend/ monorepo (null = unknown).
  const [monorepo, setMonorepo] = useState<boolean | null>(null)
  const [saving, setSaving]     = useState(false)
  const [settingsErr, setSettingsErr] = useState("")

  const fetchProject = useCallback(async () => {
    const r = await fetch(`${GO_API}/api/projects/${id}`)
    if (r.ok) setProject(await r.json())
  }, [id])

  const fetchDeployments = useCallback(async () => {
    const r = await fetch(`${GO_API}/api/projects/${id}/deployments`)
    if (r.ok) {
      const deps: Deployment[] = await r.json()
      setDeployments(deps)
      if (deps[0]) setActiveDep(deps[0].ID)
    }
  }, [id])

  // Load historical logs from JSON endpoint
  const loadLogs = useCallback(async (depID: string) => {
    setLogs([])
    try {
      const r = await fetch(`${GO_API}/api/projects/${id}/deployments/${depID}/logs`)
      if (r.ok) setLogs(await r.json())
    } catch { /* ignore */ }
  }, [id])

  const fetchWebhook = useCallback(async () => {
    try {
      const r = await fetch(`${GO_API}/api/projects/${id}/webhook`)
      if (r.ok) setWebhook(await r.json())
    } catch { /* ignore */ }
  }, [id])

  useEffect(() => {
    Promise.all([fetchProject(), fetchDeployments(), fetchWebhook()]).finally(() => setLoading(false))
  }, [fetchProject, fetchDeployments, fetchWebhook])

  // Populate the settings form once the project (by ID) is loaded — keyed on ID
  // so background status refreshes don't clobber in-progress edits.
  useEffect(() => {
    if (!project || project.External) return
    const toEnvText = (json: string) => {
      try {
        const obj = JSON.parse(json || "{}")
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n")
        }
      } catch { /* leave blank */ }
      return ""
    }
    setForm({
      name: project.Name,
      branch: project.Branch,
      domain: project.Domain,
      port: String(project.Port),
      buildMethod: project.BuildMethod,
      buildCommand: project.BuildCommand ?? "",
      envText: toEnvText(project.EnvVars),
      backendEnvText: toEnvText(project.BackendEnvVars),
      autoDeploy: project.AutoDeploy,
    })
    // Probe whether this repo is a monorepo so we can show the backend env box
    // — but only for a combined-mode project (BaseDir empty). A project with
    // BaseDir set is a single component deployed separately (its own project),
    // so it never gets the second env box even if the repo still has both
    // frontend/ and backend/ folders.
    if (project.BaseDir) {
      setMonorepo(false)
    } else {
      setMonorepo(null)
      fetch(`${GO_API}/api/github/detect-layout?repo=${encodeURIComponent(project.RepoURL)}&branch=${encodeURIComponent(project.Branch)}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => setMonorepo(Boolean(d?.monorepo)))
        .catch(() => setMonorepo(false))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.ID])

  // Keep ref in sync so the realtime handler always sees the current dep
  useEffect(() => { activeDepRef.current = activeDep }, [activeDep])

  useEffect(() => {
    if (activeDep) loadLogs(activeDep)
  }, [activeDep, loadLogs])

  // Listen on the realtime stream for live deploy:log events
  useEffect(() => {
    const socket = getSocket()
    const handler = (payload: unknown) => {
      const p = payload as { deploymentId: string; stream: string; line: string; ts: string }
      if (p.deploymentId !== activeDepRef.current) return
      setLogs(prev => [...prev, { stream: p.stream, line: p.line, ts: p.ts }])
      // Refresh project status when a build completes
      if (p.stream === "system" && p.line.includes("Deployment Successful")) {
        fetchProject()
        fetchDeployments()
      }
    }
    socket.on("deploy:log", handler)
    return () => socket.off("deploy:log", handler)
  }, [fetchProject, fetchDeployments])

  // On a 401 the browser session has expired — bounce to login so the user can
  // re-authenticate instead of hitting a silent failure. Returns true if it
  // handled an auth failure (caller should stop).
  const handledAuthFailure = (res: Response): boolean => {
    if (res.status === 401) {
      if (typeof window !== "undefined") window.location.href = "/login"
      return true
    }
    return false
  }

  const triggerDeploy = async () => {
    setDeploying(true)
    try {
      const r = await fetch(`${GO_API}/api/projects/${id}/deploy`, { method: "POST" })
      if (handledAuthFailure(r)) return
      const d = await r.json().catch(() => ({}))
      if (r.ok) {
        await fetchDeployments()
        setActiveDep(d.deploymentId)
        setTab("logs")
        fetchProject()
      } else {
        toast.error(d.error ?? "Redeploy failed")
      }
    } finally { setDeploying(false) }
  }

  const installHook = async () => {
    setInstallingHook(true)
    try {
      const r = await fetch(`${GO_API}/api/projects/${id}/webhook`, { method: "POST" })
      const d = await r.json()
      if (d.error && !d.installed) toast.error(d.error)
      await fetchWebhook()
    } finally { setInstallingHook(false) }
  }

  const rollback = async (dep: Deployment) => {
    setRolling(dep.ID)
    try {
      const r = await fetch(`${GO_API}/api/projects/${id}/deployments/${dep.ID}/rollback`, { method: "POST" })
      if (handledAuthFailure(r)) return
      const d = await r.json().catch(() => ({}))
      if (r.ok) {
        await fetchDeployments()
        setActiveDep(d.deploymentId)
        setTab("logs")
        fetchProject()
      } else {
        toast.error(d.error ?? "Rollback failed")
      }
    } finally { setRolling(null); setRollbackTarget(null) }
  }

  const parseEnvVars = (text: string): Record<string, string> => {
    const map: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const idx = line.indexOf("=")
      if (idx > 0) {
        const k = line.slice(0, idx).trim()
        if (k) map[k] = line.slice(idx + 1).trim()
      }
    }
    return map
  }

  // Persist settings. Returns true on success. If redeploy is true, kicks off
  // a fresh deployment with the saved config afterwards.
  const saveSettings = async (redeploy: boolean) => {
    setSaving(true)
    setSettingsErr("")
    try {
      const r = await fetch(`${GO_API}/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          branch: form.branch,
          buildMethod: form.buildMethod,
          buildCommand: form.buildMethod === "custom" ? form.buildCommand : "",
          port: parseInt(form.port, 10) || 3000,
          domain: form.domain,
          envVars: JSON.stringify(parseEnvVars(form.envText)),
          backendEnvVars: JSON.stringify(parseEnvVars(form.backendEnvText)),
          autoDeploy: form.autoDeploy,
        }),
      })
      if (handledAuthFailure(r)) return false
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        setSettingsErr(d.error ?? "Failed to save settings")
        return false
      }
      await fetchProject()
      toast.success("Settings saved")
      if (redeploy) await triggerDeploy()
      return true
    } catch (e) {
      setSettingsErr(e instanceof Error ? e.message : "Network error")
      return false
    } finally { setSaving(false) }
  }

  const deleteProject = async () => {
    setDeleting(true)
    await fetch(`${GO_API}/api/projects/${id}`, { method: "DELETE" })
    router.push("/projects")
  }


  // nixpacks/BuildKit write normal build output to stderr, so colour by content
  // — red is reserved for actual errors, not the whole stderr stream.
  const isErrorLine = (line: string) =>
    line.includes("✕") || line.includes("✖") ||
    /(^|[^a-z])(error|errors|failed|failure|fatal|panic|exit status [1-9])/i.test(line)

  const logColor = (stream: string, line: string) => {
    if (isErrorLine(line)) return "text-[var(--t-err)]"
    if (stream === "system") return "text-[var(--t-sys)]"
    return "text-[var(--t-fg)]"
  }

  if (loading) {
    return (
      <>
        <PageHeader icon={FolderGit2} title="Loading project…" />
        <PageBody>
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-10 w-72" />
            <Skeleton className="h-40" />
            <Skeleton className="h-64" />
          </div>
        </PageBody>
      </>
    )
  }
  if (!project) {
    return (
      <>
        <PageHeader icon={FolderGit2} title="Project not found" description={<BackLink />} />
        <PageBody>
          <EmptyState
            icon={FolderGit2}
            title="Project not found"
            description="It may have been deleted."
            action={<Button nativeButton={false} render={<Link href="/projects" />}>Back to projects</Button>}
          />
        </PageBody>
      </>
    )
  }

  if (project.External) {
    return <ExternalProjectView project={project} />
  }

  const setF = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm(f => ({ ...f, [k]: v }))
  const busy = saving || deploying

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs
        value={tab}
        onValueChange={v => setTab(v as typeof tab)}
        className="h-full min-h-0 gap-0"
      >
        <PageHeader
          icon={FolderGit2}
          title={<span className="flex items-center gap-2">{project.Name}<StatusPill status={project.Status} /></span>}
          description={
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <BackLink />
              <span className="inline-flex items-center gap-1 font-mono"><GitBranch className="size-3.5" aria-hidden />{project.Branch}</span>
              <DomainLink domain={project.Domain} />
            </span>
          }
          actions={
            <>
              <Button
                onClick={triggerDeploy}
                disabled={deploying}
                title={`Redeploy the latest commit on ${project.Branch || "the deploy branch"}`}
              >
                {deploying ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                {deploying ? "Deploying…" : "Redeploy"}
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="Delete project"
                      className="text-danger hover:text-danger"
                      disabled={deleting}
                      onClick={() => setConfirmDelete(true)}
                    />
                  }
                >
                  <Trash2 className="size-4" />
                </TooltipTrigger>
                <TooltipContent>Delete project</TooltipContent>
              </Tooltip>
            </>
          }
        >
          <TabsList variant="line">
            <TabsTrigger value="settings"><Settings2 className="size-4" />Settings</TabsTrigger>
            <TabsTrigger value="logs"><Terminal className="size-4" />Logs</TabsTrigger>
            <TabsTrigger value="history"><History className="size-4" />History</TabsTrigger>
          </TabsList>
        </PageHeader>

        {/* Logs tab */}
        <TabsContent value="logs" className="flex min-h-0 flex-1 flex-col gap-3 p-4 sm:p-6">
          {deployments.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Label htmlFor="dep-select" className="text-xs text-muted-foreground">Deployment</Label>
              <Select
                value={activeDep ?? ""}
                onValueChange={v => setActiveDep(v as string)}
                items={deployments.map(d => ({ value: d.ID, label: `${d.ID.slice(0, 14)} — ${d.Status} — ${age(d.CreatedAt)}` }))}
              >
                <SelectTrigger id="dep-select" size="sm" className="w-full max-w-sm font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {deployments.map(d => (
                    <SelectItem key={d.ID} value={d.ID} className="font-mono text-xs">
                      {d.ID.slice(0, 14)} — {d.Status} — {age(d.CreatedAt)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <TerminalWindow
            className="min-h-64 flex-1"
            title={`${activeDep ? activeDep.slice(0, 14) + " — " : ""}pulsenode build`}
          >
            {logs.length === 0 ? (
              <p className="text-[var(--t-muted)]">Waiting for logs…</p>
            ) : (
              logs.map((entry, i) => (
                <div key={i} className="flex items-start gap-3">
                  <span className="shrink-0 text-[var(--t-dim)] tabular-nums select-none">
                    {new Date(entry.ts).toLocaleTimeString()}
                  </span>
                  <span className={cn("min-w-0 flex-1", logColor(entry.stream, entry.line))}>
                    {entry.line}
                  </span>
                </div>
              ))
            )}
          </TerminalWindow>
        </TabsContent>

        {/* History tab */}
        <TabsContent value="history" className="min-h-0 flex-1 overflow-auto">
          <PageBody className="max-w-4xl space-y-2">
            {deployments.length === 0 ? (
              <EmptyState icon={History} title="No deployments yet" description="Deployments appear here after the first deploy." />
            ) : deployments.map(dep => (
              <Card
                key={dep.ID}
                onClick={() => { setActiveDep(dep.ID); setTab("logs") }}
                className="cursor-pointer gap-2 py-4 transition-colors hover:border-[color-mix(in_srgb,var(--hue)_45%,var(--border))]"
              >
                <CardContent className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status={dep.Status} />
                    <Badge variant="secondary" className="gap-1 text-[11px] capitalize">
                      {dep.Trigger === "auto" ? <Zap className="size-3" aria-hidden /> : dep.Trigger === "rollback" ? <RotateCcw className="size-3" aria-hidden /> : null}
                      {dep.Trigger}
                    </Badge>
                    {dep.CommitSHA && (
                      <span className="font-mono text-xs text-muted-foreground">{dep.CommitSHA.slice(0, 7)}</span>
                    )}
                    <span className="ml-auto flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                      <Clock className="size-3" aria-hidden />
                      {age(dep.CreatedAt)}
                    </span>
                  </div>
                  {dep.CommitMsg && <p className="truncate text-sm">{dep.CommitMsg}</p>}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={e => { e.stopPropagation(); setActiveDep(dep.ID); setTab("logs") }}
                    >
                      <ScrollText className="size-3.5" />
                      View logs
                    </Button>
                    {dep.Status === "success" && dep.ImageTag && (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={rolling !== null}
                        title="Redeploy this build's image (zero-downtime)"
                        onClick={e => { e.stopPropagation(); setRollbackTarget(dep) }}
                      >
                        <RotateCcw className={cn("size-3.5", rolling === dep.ID && "animate-spin")} />
                        {rolling === dep.ID ? "Rolling…" : "Rollback"}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </PageBody>
        </TabsContent>

        {/* Settings tab */}
        <TabsContent value="settings" className="min-h-0 flex-1 overflow-auto">
          <PageBody className="max-w-3xl space-y-4">
            {/* Read-only identity */}
            <Card>
              <CardHeader>
                <CardTitle>Project</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="divide-y">
                  {[
                    { label: "Project ID", value: project.ID },
                    { label: "Repository", value: project.RepoURL },
                    ...(project.BaseDir ? [{ label: "Deploys from", value: `${project.BaseDir}/ (separate from this repo's other component)` }] : []),
                    { label: "Last deployed commit", value: project.LastCommitSHA ? project.LastCommitSHA.slice(0, 7) : "—" },
                  ].map(row => (
                    <div key={row.label} className="flex items-center justify-between gap-4 py-2 text-sm">
                      <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
                      <dd className="min-w-0 truncate font-mono text-xs" title={row.value}>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>

            {/* Auto-deploy webhook */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Webhook className="size-4 text-[var(--hue)]" aria-hidden />Auto-deploy webhook</CardTitle>
                <CardDescription>
                  {webhook?.supported
                    ? "Installed automatically on your repo so pushes deploy instantly. The branch poller stays on as a fallback."
                    : "Connect GitHub (and set NEXT_PUBLIC_ORIGIN) to auto-install a push webhook for instant deploys."}
                </CardDescription>
              </CardHeader>
              {(webhook?.supported || webhook?.error) && (
                <CardContent className="space-y-3">
                  {webhook?.error && (
                    <Alert variant="destructive">
                      <AlertCircle />
                      <AlertDescription>{webhook.error}</AlertDescription>
                    </Alert>
                  )}
                  {webhook?.supported && (
                    <div className="flex flex-wrap items-center gap-3">
                      <Pill tone={webhook.installed ? "ok" : "warn"} dot>
                        {webhook.installed ? "Installed" : "Not installed"}
                      </Pill>
                      <Button
                        variant={webhook.installed ? "outline" : "default"}
                        size="sm"
                        onClick={installHook}
                        disabled={installingHook}
                      >
                        {installingHook ? <Loader2 className="size-4 animate-spin" /> : <Webhook className="size-4" />}
                        {installingHook ? "Working…" : webhook.installed ? "Re-check / repair" : "Install webhook"}
                      </Button>
                    </div>
                  )}
                </CardContent>
              )}
            </Card>

            {/* Editable config */}
            <Card>
              <CardHeader>
                <CardTitle>Configuration</CardTitle>
                <CardDescription>Changes apply on the next deploy.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <Label htmlFor="auto-deploy" className="flex items-center gap-1.5">
                      <Zap className="size-3.5 text-[var(--hue)]" aria-hidden /> Auto-deploy
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Rebuild &amp; redeploy automatically when <span className="font-mono">{form.branch || "the branch"}</span> gets new commits.
                    </p>
                  </div>
                  <Switch id="auto-deploy" checked={form.autoDeploy} onCheckedChange={v => setF("autoDeploy", v)} />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label="Project name" htmlFor="ps-name">
                    <Input id="ps-name" value={form.name} onChange={e => setF("name", e.target.value)} />
                  </FormField>
                  <FormField label="Branch" htmlFor="ps-branch">
                    <Input id="ps-branch" value={form.branch} onChange={e => setF("branch", e.target.value)} className="font-mono" />
                  </FormField>
                  <FormField label="Domain" htmlFor="ps-domain">
                    <Input id="ps-domain" value={form.domain} onChange={e => setF("domain", e.target.value)} placeholder="app.yourdomain.com" className="font-mono" />
                  </FormField>
                  <FormField label="Container port" htmlFor="ps-port">
                    <Input id="ps-port" type="number" inputMode="numeric" value={form.port} onChange={e => setF("port", e.target.value)} className="tabular-nums" />
                  </FormField>
                </div>

                <div className="space-y-1.5">
                  <p className="text-sm leading-none font-medium">Build method</p>
                  <ChoiceGroup label="Build method" value={form.buildMethod} onChange={v => setF("buildMethod", v)} options={[...BUILD_METHODS]} />
                </div>

                <FormField
                  label={monorepo ? "Frontend environment variables" : "Environment variables"}
                  htmlFor="ps-env"
                  hint={monorepo ? "Frontend container only · one KEY=VALUE per line" : "One KEY=VALUE per line"}
                >
                  <Textarea
                    id="ps-env"
                    value={form.envText}
                    onChange={e => setF("envText", e.target.value)}
                    placeholder={"NODE_ENV=production\nPORT=3000"}
                    rows={4}
                    spellCheck={false}
                    className="resize-y font-mono"
                  />
                </FormField>

                {monorepo && (
                  <FormField label="Backend environment variables" htmlFor="ps-benv" hint="Backend container only — set BACKEND_PORT here for the /api service">
                    <Textarea
                      id="ps-benv"
                      value={form.backendEnvText}
                      onChange={e => setF("backendEnvText", e.target.value)}
                      placeholder={"NODE_ENV=production\nDATABASE_URL=postgres://…\nBACKEND_PORT=3001"}
                      rows={4}
                      spellCheck={false}
                      className="resize-y font-mono"
                    />
                  </FormField>
                )}

                {settingsErr && (
                  <Alert variant="destructive">
                    <AlertCircle />
                    <AlertDescription>{settingsErr}</AlertDescription>
                  </Alert>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => saveSettings(false)} disabled={busy}>
                    {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button onClick={() => saveSettings(true)} disabled={busy}>
                    {busy ? <><Loader2 className="size-4 animate-spin" /> Working…</> : <><Play className="size-4" /> Save &amp; redeploy</>}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Danger zone */}
            <Card className="border-danger/40">
              <CardHeader>
                <CardTitle className="text-danger">Danger zone</CardTitle>
                <CardDescription>Deleting a project removes it and its deployments. This cannot be undone.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="destructive" onClick={() => setConfirmDelete(true)} disabled={deleting}>
                  <Trash2 className="size-4" />
                  Delete project
                </Button>
              </CardContent>
            </Card>
          </PageBody>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        icon={Trash2}
        title="Delete project?"
        description="This cannot be undone."
        target={project.Name}
        confirmLabel="Delete project"
        loading={deleting}
        onConfirm={deleteProject}
      />
      <ConfirmDialog
        open={rollbackTarget !== null}
        onOpenChange={o => { if (!o) setRollbackTarget(null) }}
        icon={RotateCcw}
        tone="warning"
        title="Roll back to this build?"
        description="This redeploys that build's image with zero downtime."
        target={rollbackTarget ? (rollbackTarget.CommitSHA ? rollbackTarget.CommitSHA.slice(0, 7) : rollbackTarget.ID.slice(0, 10)) : undefined}
        confirmLabel="Roll back"
        loading={rolling !== null}
        onConfirm={() => rollbackTarget ? rollback(rollbackTarget) : undefined}
      />
    </div>
  )
}
