"use client"

import { API_BASE, nodeApi } from "@/lib/api"
import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useParams, useRouter } from "next/navigation"
import Link from "next/link"
import {
  Play, Trash2, GitBranch, ChevronLeft, Terminal, History, ExternalLink,
  Save, Zap, RotateCcw, Webhook, Server, Square, RotateCw, Box, Loader2, AlertCircle, RefreshCw, FolderGit2,
  Clock, ScrollText, Copy, Lock, MoreHorizontal, CircleCheck, CircleX, User, TriangleAlert,
} from "lucide-react"
import { toast } from "sonner"
import { getSocket } from "@/lib/socket"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { EmptyState } from "@/components/pn/EmptyState"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import { Pill } from "@/components/dashboard/Pill"
import { FormField, ChoiceGroup, BUILD_METHODS } from "@/components/projects/forms"
import { EnvEditor, envProblem, envRowsFromJson, envRowsToObject, type EnvRow } from "@/components/projects/EnvEditor"
import { DeleteProjectDialog } from "@/components/projects/DeleteProjectDialog"
import { LogPane, type LogEntry } from "@/components/projects/LogPane"
import { WildcardBadge, WildcardHint } from "@/components/domain/wildcard"
import { cn } from "@/lib/utils"
import { Truncate } from "@/components/pn/Truncate"

const GO_API = API_BASE

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
type WebhookStatus = { installed: boolean; supported: boolean; url: string; error?: string }

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "outline"> = {
  running: "ok", success: "ok", building: "info", queued: "info",
  failed: "bad", idle: "outline", exited: "outline",
}

const isBusyStatus = (s: string) => s === "building" || s === "queued"

function StatusPill({ status }: { status: string }) {
  return (
    <Pill tone={STATUS_TONE[status] ?? "outline"} dot className="capitalize">
      {status || "unknown"}
    </Pill>
  )
}

function DomainLink({ domain }: { domain: string }) {
  if (!domain) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={`https://${domain}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 max-w-[16rem] items-center gap-1 rounded-sm font-mono text-[var(--hue-fg)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        }
      >
        <span className="truncate">{domain}</span>
        <ExternalLink className="size-3 shrink-0" aria-hidden />
        <span className="sr-only">(opens in a new tab)</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-all font-mono">{domain}</TooltipContent>
    </Tooltip>
  )
}

function BackLink() {
  return (
    <Link href="/projects" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ChevronLeft className="size-3.5" aria-hidden /> Projects
    </Link>
  )
}

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch { toast.error("Could not copy — clipboard unavailable") }
}

function age(ts: string) {
  const d = Date.now() - new Date(ts).getTime()
  if (d < 60_000) return "just now"
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`
  const days = Math.floor(d / 86_400_000)
  return days === 1 ? "yesterday" : `${days} days ago`
}

function duration(dep: Deployment): string {
  if (!dep.StartedAt) return ""
  const end = dep.FinishedAt ? new Date(dep.FinishedAt).getTime() : Date.now()
  const s = Math.max(0, Math.round((end - new Date(dep.StartedAt).getTime()) / 1000))
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}

function Panel({ title, description, aside, children, className }: {
  title: string; description?: string; aside?: React.ReactNode; children: React.ReactNode; className?: string
}) {
  return (
    <section aria-label={title} className={cn("overflow-hidden rounded-xl border bg-card shadow-card", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4.5 py-3.5">
        <div className="space-y-0.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
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
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [acting, setActing] = useState<string | null>(null)
  const fetching = useRef(false)

  const fetchLogs = useCallback(async () => {
    if (fetching.current) return
    fetching.current = true
    try {
      const { data } = await nodeApi.get<{ logs?: string }>(`/api/docker/logs/${containerID}?tail=300`)
      setLogs((data.logs ?? "").split("\n").filter(Boolean).map(line => ({ stream: "stdout", line, ts: "" })))
    } catch { /* keep the last lines */ }
    finally { fetching.current = false }
  }, [containerID])

  // Same cadence the design shows: the last 300 lines, refreshed every 2.5s while running.
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (!document.hidden) await fetchLogs()
      if (!stopped) timer = setTimeout(tick, 2500)
    }
    tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, [fetchLogs])

  const runAction = async (action: "start" | "stop" | "restart") => {
    setActing(action)
    try {
      const r = await fetch(`${GO_API}/api/docker/${action}/${containerID}`, { method: "POST" })
      if (r.status === 401) { window.location.href = "/login"; return }
      if (r.ok) {
        setStatus(action === "stop" ? "exited" : "running")
        toast.success(`${project.Name} ${action === "stop" ? "stopped" : action === "start" ? "started" : "restarted"}`)
        await fetchLogs()
      } else {
        toast.error(`Could not ${action} ${project.Name}`)
      }
    } finally { setActing(null) }
  }

  const info = [
    { label: "Image", value: project.Image },
    { label: "Ports", value: project.Ports },
    { label: "Container", value: containerID },
    { label: "Created", value: project.CreatedAt },
  ]

  return (
    <>
      <PageHeader
        icon={Server}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {project.Name}<StatusPill status={status} />
            <span className="rounded border px-1.5 py-0.5 text-[11px] font-semibold tracking-wider text-muted-foreground">EXTERNAL · READ-ONLY</span>
          </span>
        }
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
      <PageBody className="max-w-[1200px]">
        <p className="text-xs text-muted-foreground">
          Hosted on this VPS behind a domain, but not deployed through PulseNode — read-only details, pulled live from Docker.
        </p>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border shadow-card lg:grid-cols-4">
          {info.map(row => (
            <div key={row.label} className="min-w-0 bg-card px-4.5 py-3">
              <dt className="text-[11px] text-muted-foreground">{row.label}</dt>
              <dd className="mt-0.5 flex items-center gap-1 text-xs">
                {row.label === "Container" && <Box className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
                <Truncate mono text={row.value ?? ""} />
              </dd>
            </div>
          ))}
        </dl>
        <LogPane
          title={`${project.Name} · docker logs --tail 300`}
          lines={logs}
          state={status === "running" ? "live" : "stopped"}
          transport="Last 300 lines · refreshed every 2.5s"
          emptyText="No logs."
        />
      </PageBody>
    </>
  )
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  const [project, setProject]           = useState<Project | null>(null)
  const [deployments, setDeployments]   = useState<Deployment[]>([])
  const [logs, setLogs]                 = useState<LogEntry[]>([])
  const [activeDep, setActiveDep]       = useState<string | null>(null)
  const [tab, setTab]                   = useState<"logs" | "history">("logs")
  const [loading, setLoading]           = useState(true)
  const [deploying, setDeploying]       = useState(false)
  const [rolling, setRolling]           = useState<string | null>(null)
  const [deleting, setDeleting]         = useState(false)
  const [webhook, setWebhook]           = useState<WebhookStatus | null>(null)
  const [installingHook, setInstallingHook] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [rollbackTarget, setRollbackTarget] = useState<Deployment | null>(null)
  const activeDepRef                    = useRef<string | null>(null)
  const pollBusy                        = useRef(false)

  // Editable settings form
  const [form, setForm] = useState({
    name: "", branch: "", domain: "", port: "3000",
    buildMethod: "auto", buildCommand: "", autoDeploy: true,
  })
  const [envRows, setEnvRows] = useState<EnvRow[]>([])
  const [backendEnvRows, setBackendEnvRows] = useState<EnvRow[]>([])
  // Serialized form as last loaded/saved — the Save bar shows only while the form differs from it.
  const [baseline, setBaseline] = useState<string | null>(null)
  // Whether this project's repo is a frontend/+backend/ monorepo (null = unknown).
  const [monorepo, setMonorepo] = useState<boolean | null>(null)
  const [saving, setSaving]     = useState(false)
  const [settingsErr, setSettingsErr] = useState("")

  // "notfound" = the API answered 404; "error" = the request itself failed.
  // Only consulted while no project is loaded, so a failed background refresh
  // never replaces a page that already rendered.
  const [loadErr, setLoadErr] = useState<"notfound" | "error" | null>(null)

  const fetchProject = useCallback(async () => {
    try {
      const r = await fetch(`${GO_API}/api/projects/${id}`)
      if (r.status === 401) { window.location.href = "/login"; return }
      if (r.status === 404) { setLoadErr("notfound"); return }
      if (!r.ok) throw new Error(String(r.status))
      setProject(await r.json())
      setLoadErr(null)
    } catch { setLoadErr(prev => prev ?? "error") }
  }, [id])

  // keepActive: background refreshes must not yank the log view away from the deployment being read.
  const fetchDeployments = useCallback(async (keepActive = false) => {
    try {
      const r = await fetch(`${GO_API}/api/projects/${id}/deployments`)
      if (!r.ok) return
      const data: unknown = await r.json()
      const deps: Deployment[] = Array.isArray(data) ? (data as Deployment[]) : []
      setDeployments(deps)
      if (deps[0] && !keepActive) setActiveDep(deps[0].ID)
    } catch { /* deployments stay empty; the page shows its empty state */ }
  }, [id])

  // Load historical logs from JSON endpoint
  const loadLogs = useCallback(async (depID: string) => {
    setLogs([])
    try {
      const { data } = await nodeApi.get<LogEntry[]>(`/api/projects/${id}/deployments/${depID}/logs`)
      setLogs(Array.isArray(data) ? data : [])
    } catch { /* ignore */ }
  }, [id])

  const fetchWebhook = useCallback(async () => {
    try {
      const { data } = await nodeApi.get<WebhookStatus>(`/api/projects/${id}/webhook`)
      setWebhook(data)
    } catch { /* ignore */ }
  }, [id])

  useEffect(() => {
    Promise.all([fetchProject(), fetchDeployments(), fetchWebhook()]).finally(() => setLoading(false))
  }, [fetchProject, fetchDeployments, fetchWebhook])

  // Serialized form for dirty tracking (env rows compare by their resulting map).
  const signature = useMemo(() => JSON.stringify({
    form, env: envRowsToObject(envRows), backendEnv: envRowsToObject(backendEnvRows),
  }), [form, envRows, backendEnvRows])
  const dirty = baseline !== null && signature !== baseline

  // Populate the settings form once the project (by ID) is loaded — keyed on ID
  // so background status refreshes don't clobber in-progress edits.
  useEffect(() => {
    if (!project || project.External) return
    const next = {
      name: project.Name,
      branch: project.Branch,
      domain: project.Domain,
      port: String(project.Port),
      buildMethod: project.BuildMethod,
      buildCommand: project.BuildCommand ?? "",
      autoDeploy: project.AutoDeploy,
    }
    const env = envRowsFromJson(project.EnvVars)
    const benv = envRowsFromJson(project.BackendEnvVars)
    setForm(next)
    setEnvRows(env)
    setBackendEnvRows(benv)
    setBaseline(JSON.stringify({ form: next, env: envRowsToObject(env), backendEnv: envRowsToObject(benv) }))
    // Probe whether this repo is a monorepo so we can show the backend env box
    // — but only for a combined-mode project (BaseDir empty). A project with
    // BaseDir set is a single component deployed separately (its own project),
    // so it never gets the second env box even if the repo still has both
    // frontend/ and backend/ folders.
    if (project.BaseDir) {
      setMonorepo(false)
    } else {
      setMonorepo(null)
      nodeApi.get<{ monorepo?: boolean }>(`/api/github/detect-layout?repo=${encodeURIComponent(project.RepoURL)}&branch=${encodeURIComponent(project.Branch)}`)
        .then(({ data }) => setMonorepo(Boolean(data?.monorepo)))
        .catch(() => setMonorepo(false))
    }
  // Probe the repo layout once per project; later edits to branch/base dir are re-probed on save,
  // and keying on the whole `project` object would refire on every status poll.
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
        fetchDeployments(true)
      }
    }
    socket.on("deploy:log", handler)
    return () => socket.off("deploy:log", handler)
  }, [fetchProject, fetchDeployments])

  // While anything is building, refresh status + history so the pills flip without a reload
  // (a failed build emits no "Successful" line). One request at a time; stops when idle.
  const busyNow = (project ? isBusyStatus(project.Status) : false) || deployments.some(d => isBusyStatus(d.Status))
  useEffect(() => {
    if (!busyNow) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (!pollBusy.current && !document.hidden) {
        pollBusy.current = true
        try { await Promise.all([fetchProject(), fetchDeployments(true)]) } finally { pollBusy.current = false }
      }
      if (!stopped) timer = setTimeout(tick, 4000)
    }
    timer = setTimeout(tick, 4000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [busyNow, fetchProject, fetchDeployments])

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
        // 409 = already building; 503 = queue full or shutting down — the server message says which.
        toast.error(d.error ?? "Redeploy failed")
      }
    } finally { setDeploying(false) }
  }

  const installHook = async () => {
    setInstallingHook(true)
    try {
      const r = await fetch(`${GO_API}/api/projects/${id}/webhook`, { method: "POST" })
      const d = await r.json().catch(() => ({}))
      if (d.error && !d.installed) toast.error(d.error)
      else toast.success("Webhook checked")
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

  const envErr = envProblem(envRows, monorepo ? "Frontend environment" : "Environment")
    ?? (monorepo ? envProblem(backendEnvRows, "Backend environment") : null)

  // Persist settings. Returns true on success. If redeploy is true, kicks off
  // a fresh deployment with the saved config afterwards.
  const saveSettings = async (redeploy: boolean) => {
    if (envErr) { setSettingsErr(envErr); return false }
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
          envVars: JSON.stringify(envRowsToObject(envRows)),
          backendEnvVars: JSON.stringify(envRowsToObject(backendEnvRows)),
          autoDeploy: form.autoDeploy,
        }),
      })
      if (handledAuthFailure(r)) return false
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        setSettingsErr(d.error ?? "Failed to save settings")
        return false
      }
      setBaseline(signature)
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
    try {
      const r = await fetch(`${GO_API}/api/projects/${id}`, { method: "DELETE" })
      if (handledAuthFailure(r)) return
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        toast.error(d.error ?? "Could not delete the project")
        return
      }
      toast.success(`${project?.Name ?? "Project"} deleted`)
      router.push("/projects")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error")
    } finally { setDeleting(false) }
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
  if (!project && loadErr === "error") {
    return (
      <>
        <PageHeader icon={FolderGit2} title="Could not load project" description={<BackLink />} />
        <PageBody>
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load this project</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-3">
              The request to the PulseNode API failed.
              <Button variant="outline" size="sm" onClick={() => { setLoading(true); setLoadErr(null); Promise.all([fetchProject(), fetchDeployments()]).finally(() => setLoading(false)) }}>
                <RefreshCw className="size-3.5" />Retry
              </Button>
            </AlertDescription>
          </Alert>
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
  const repoName = project.RepoURL.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "")
  const currentDep = deployments.find(d => d.Status === "success")
  const activeRow = deployments.find(d => d.ID === activeDep)
  const logState = !activeRow ? "completed" : isBusyStatus(activeRow.Status) ? "live" : activeRow.Status === "failed" ? "failed" : "completed"

  const identity = [
    { label: "Project ID", value: project.ID },
    { label: "Repository", value: project.RepoURL },
    ...(project.BaseDir ? [{ label: "Deploys from", value: `${project.BaseDir}/ (separate from this repo's other component)` }] : []),
    { label: "Commit SHA", value: project.LastCommitSHA || "—" },
  ]

  return (
    <div className="flex min-h-0 flex-col xl:h-full">
      <Tabs
        value={tab}
        onValueChange={v => setTab(v as typeof tab)}
        className="min-h-0 flex-1 gap-0"
      >
        <PageHeader
          icon={FolderGit2}
          title={
            <span className="flex min-w-0 items-center gap-2">
              <Truncate text={project.Name} className="max-w-[22rem]" />
              <span className="shrink-0"><StatusPill status={project.Status} /></span>
            </span>
          }
          description={
            <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
              <BackLink />
              <span className="inline-flex min-w-0 max-w-[18rem] items-center gap-1 text-xs">
                <FolderGit2 className="size-3.5 shrink-0" aria-hidden /><Truncate mono text={repoName} />
              </span>
              <span className="inline-flex min-w-0 max-w-[10rem] items-center gap-1 text-xs">
                <GitBranch className="size-3.5 shrink-0" aria-hidden /><Truncate mono text={project.Branch} />
              </span>
              <DomainLink domain={project.Domain} />
              <WildcardBadge domain={project.Domain} />
            </span>
          }
          actions={
            <>
              <Button
                onClick={triggerDeploy}
                disabled={deploying || isBusyStatus(project.Status)}
                title={`Redeploy the latest commit on ${project.Branch || "the deploy branch"}`}
              >
                {deploying || isBusyStatus(project.Status) ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                {deploying ? "Deploying…" : isBusyStatus(project.Status) ? "Building…" : "Redeploy"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="More actions" />}>
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => copyText(project.ID, "Project ID")}>
                      <Copy />Copy project ID
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => window.open(project.RepoURL, "_blank", "noopener,noreferrer")}>
                      <ExternalLink />Open repository
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                      <Trash2 />Delete project
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        />

        {/* Left: live logs + history. Right: settings, always visible. */}
        <div className="grid min-h-0 flex-1 gap-4 p-4 sm:p-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:overflow-hidden">
        <section aria-label="Logs and history" className="flex min-h-[30rem] min-w-0 flex-col gap-3 xl:min-h-0">

        {/* Logs tab */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {tab === "logs" && deployments.length > 0 && (
            <div className="flex min-w-0 flex-1 items-center gap-2">
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
          <TabsList className="ml-auto shrink-0" aria-label="Logs and history">
            <TabsTrigger value="logs">
              <Terminal className="size-4" />Logs
              {busyNow && <span className="size-1.5 rounded-full bg-success motion-safe:animate-pulse" aria-label="live" />}
            </TabsTrigger>
            <TabsTrigger value="history"><History className="size-4" />History</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="logs" className="flex min-h-0 flex-1 flex-col gap-3">
          <LogPane
            className="flex-1"
            title={`${activeDep ? activeDep.slice(0, 14) + " · " : ""}pulsenode build`}
            lines={logs}
            state={logState}
            transport={logState === "live" ? "Streaming over WebSocket" : "Stored deployment log"}
          />
        </TabsContent>

        {/* History tab */}
        <TabsContent value="history" className="min-h-0 flex-1 overflow-auto">
          <div className="space-y-2.5">
            {deployments.length === 0 ? (
              <EmptyState icon={History} title="No deployments yet" description="Deployments appear here after the first deploy." />
            ) : deployments.map(dep => {
              const ok = dep.Status === "success"
              const failed = dep.Status === "failed"
              const live = isBusyStatus(dep.Status)
              const isCurrent = currentDep?.ID === dep.ID
              const sha = dep.CommitSHA ? dep.CommitSHA.slice(0, 7) : ""
              const canRollback = ok && !isCurrent && Boolean(dep.ImageTag)
              const dur = duration(dep)
              return (
                <article
                  key={dep.ID}
                  className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3.5 gap-y-3 rounded-xl border bg-card px-4 py-3.5 shadow-card sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                >
                  <span className={cn(
                    "grid size-8 place-items-center rounded-lg",
                    ok ? "bg-success/12 text-success" : failed ? "bg-danger/12 text-danger" : "bg-info/12 text-info",
                  )}>
                    {ok ? <CircleCheck className="size-4" aria-hidden /> : failed ? <CircleX className="size-4" aria-hidden /> : <Loader2 className="size-4 animate-spin" aria-hidden />}
                  </span>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn("text-[13px] font-semibold", ok ? "text-success" : failed ? "text-danger" : "text-info")}>
                        {ok ? "Succeeded" : failed ? "Failed" : dep.Status === "queued" ? "Queued" : "Building"}
                      </span>
                      <span className={cn(
                        "inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-semibold capitalize",
                        dep.Trigger === "auto" ? "bg-primary/12 text-primary" : dep.Trigger === "rollback" ? "bg-warning/14 text-warning" : "bg-muted text-muted-foreground",
                      )}>
                        {dep.Trigger === "auto" ? <Zap className="size-3" aria-hidden /> : dep.Trigger === "rollback" ? <RotateCcw className="size-3" aria-hidden /> : <User className="size-3" aria-hidden />}
                        {dep.Trigger || "manual"}
                      </span>
                      {isCurrent && <span className="rounded bg-primary/12 px-1.5 py-px text-[11px] font-semibold text-primary">Current</span>}
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                        <Clock className="size-3" aria-hidden />{age(dep.CreatedAt)}{dur && ` · ${dur}`}
                      </span>
                    </div>
                    <div className="flex min-w-0 gap-2 text-[13px]">
                      {sha && <span className="shrink-0 font-mono text-xs text-primary">{sha}</span>}
                      <Truncate text={dep.CommitMsg || (live ? "Deployment in progress" : "")} className="text-muted-foreground" />
                    </div>
                  </div>
                  <div className="col-span-2 flex flex-wrap items-center gap-2 sm:col-span-1 sm:justify-end">
                    <Button variant="ghost" size="sm" onClick={() => { setActiveDep(dep.ID); setTab("logs") }}>
                      <ScrollText className="size-3.5" />View logs
                    </Button>
                    {canRollback && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={rolling !== null}
                        title="Redeploy this build's image (zero-downtime)"
                        onClick={() => setRollbackTarget(dep)}
                      >
                        <RotateCcw className={cn("size-3.5", rolling === dep.ID && "animate-spin")} />
                        {rolling === dep.ID ? "Rolling…" : `Rollback to ${sha || dep.ID.slice(0, 7)}`}
                      </Button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        </TabsContent>
        </section>

        {/* Settings: always visible on the right */}
        <div aria-label="Project settings" className="min-w-0 space-y-4 xl:min-h-0 xl:overflow-y-auto xl:pr-1">
            {/* Identity + webhook */}
            <Panel
              title="Project identity"
              aside={webhook?.supported ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={webhook.installed ? "ok" : "warn"}>
                    <Webhook className="size-3" aria-hidden />Webhook {webhook.installed ? "installed" : "not installed"}
                  </Pill>
                  {webhook.installed && (
                    <Button variant="ghost" size="xs" onClick={installHook} disabled={installingHook}>
                      {installingHook ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                      Re-check / repair
                    </Button>
                  )}
                </div>
              ) : undefined}
            >
              <dl className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2">
                {identity.map(row => (
                  <div key={row.label} className="flex min-w-0 items-center gap-2.5 bg-card px-4.5 py-3">
                    <div className="min-w-0 flex-1">
                      <dt className="text-[11px] text-muted-foreground">{row.label}</dt>
                      <dd className="mt-0.5 text-xs"><Truncate mono text={row.value === "—" ? "" : row.value} /></dd>
                    </div>
                    {row.value !== "—" && (
                      <Button variant="ghost" size="icon-sm" aria-label={`Copy ${row.label}`} title="Copy" onClick={() => copyText(row.value, row.label)}>
                        <Copy className="size-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </dl>
              {webhook?.error && (
                <div className="border-t p-3">
                  <Alert variant="destructive">
                    <AlertCircle />
                    <AlertDescription>{webhook.error}</AlertDescription>
                  </Alert>
                </div>
              )}
              {webhook?.supported && !webhook.installed && (
                <div className="flex flex-wrap items-center gap-2.5 border-t px-4.5 py-3 text-[13px] text-muted-foreground">
                  <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
                  <span className="min-w-0 flex-1">Push events are picked up by the 60s branch poller until the webhook is installed.</span>
                  <Button variant="outline" size="sm" onClick={installHook} disabled={installingHook}>
                    {installingHook ? <Loader2 className="size-3.5 animate-spin" /> : <Webhook className="size-3.5" />}
                    {installingHook ? "Working…" : "Install webhook"}
                  </Button>
                </div>
              )}
              {webhook && !webhook.supported && !webhook.error && (
                <p className="border-t px-4.5 py-3 text-xs text-muted-foreground">
                  Connect GitHub (and set NEXT_PUBLIC_ORIGIN) to auto-install a push webhook for instant deploys.
                </p>
              )}
            </Panel>

            {/* Deployment configuration */}
            <Panel
              title="Deployment configuration"
              description="Changes apply on the next deployment."
              aside={
                <div className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
                  <Label htmlFor="auto-deploy" className="flex items-center gap-1.5 font-normal">
                    <Zap className="size-3.5 text-[var(--hue)]" aria-hidden />Auto deploy on push
                  </Label>
                  <Switch id="auto-deploy" checked={form.autoDeploy} onCheckedChange={v => setF("autoDeploy", v)} />
                </div>
              }
            >
              <div className="space-y-5 p-4.5">
                <div className="grid gap-3.5 sm:grid-cols-2">
                  <FormField label="Project name" htmlFor="ps-name">
                    <Input id="ps-name" value={form.name} onChange={e => setF("name", e.target.value)} spellCheck={false} className="h-9 font-mono text-xs" />
                  </FormField>
                  <FormField label="Branch" htmlFor="ps-branch">
                    <Input id="ps-branch" value={form.branch} onChange={e => setF("branch", e.target.value)} spellCheck={false} className="h-9 font-mono text-xs" />
                  </FormField>
                  <FormField label="Domain" htmlFor="ps-domain">
                    <Input id="ps-domain" value={form.domain} onChange={e => setF("domain", e.target.value)} placeholder="app.yourdomain.com" spellCheck={false} className="h-9 font-mono text-xs" />
                    <WildcardHint domain={form.domain} className="mt-1.5" />
                  </FormField>
                  <FormField label="Container port" htmlFor="ps-port">
                    <Input id="ps-port" type="number" inputMode="numeric" value={form.port} onChange={e => setF("port", e.target.value)} className="h-9 font-mono text-xs tabular-nums" />
                  </FormField>
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs leading-none font-medium text-muted-foreground">Build method</p>
                  <ChoiceGroup label="Build method" value={form.buildMethod} onChange={v => setF("buildMethod", v)} options={[...BUILD_METHODS]} columns={3} />
                </div>
              </div>
            </Panel>

            {/* Environment */}
            <Panel
              title="Environment"
              aside={monorepo ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Lock className="size-3.5 text-success" aria-hidden />Backend secrets are never exposed to the frontend environment.
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Lock className="size-3.5 text-success" aria-hidden />Values are encrypted at rest.
                </span>
              )}
            >
              <div className={cn("grid gap-3.5 p-4.5")}>
                <EnvEditor
                  title={monorepo ? "Frontend env" : "Environment variables"}
                  description={monorepo ? "Frontend container only" : undefined}
                  rows={envRows}
                  onChange={setEnvRows}
                  idPrefix="ps-env"
                />
                {monorepo && (
                  <EnvEditor
                    title="Backend env"
                    description="Backend container only — set BACKEND_PORT here for the /api service"
                    rows={backendEnvRows}
                    onChange={setBackendEnvRows}
                    idPrefix="ps-benv"
                  />
                )}
              </div>
              {envErr && (
                <p role="alert" className="flex items-center gap-1.5 border-t px-4.5 py-3 text-xs text-danger">
                  <AlertCircle className="size-3.5" aria-hidden />{envErr}
                </p>
              )}
            </Panel>

            {settingsErr && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertDescription>{settingsErr}</AlertDescription>
              </Alert>
            )}

            {/* Save bar: sticks to the bottom while there are unsaved changes */}
            <div
              className={cn(
                "z-10 flex flex-wrap items-center justify-end gap-2.5 rounded-xl border bg-popover px-3 py-2.5",
                dirty ? "sticky bottom-3 shadow-pop" : "shadow-none",
              )}
            >
              <span role="status" className="mr-auto text-xs text-muted-foreground">
                {dirty ? "Unsaved changes" : "All changes saved"}
              </span>
              <Button variant="outline" onClick={() => saveSettings(false)} disabled={busy || !dirty}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button onClick={() => saveSettings(true)} disabled={busy || !dirty}>
                {busy ? <><Loader2 className="size-4 animate-spin" />Working…</> : <><Play className="size-4" />Save &amp; redeploy</>}
              </Button>
            </div>

            {/* Danger zone */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-danger/30 bg-card px-4.5 py-3.5">
              <div className="space-y-0.5">
                <p className="text-[13px] font-semibold text-danger">Delete project</p>
                <p className="text-xs text-muted-foreground">Stops containers, removes images and routes. The repository is untouched.</p>
              </div>
              <Button variant="destructive" onClick={() => setConfirmDelete(true)} disabled={deleting}>
                <Trash2 className="size-4" />
                Delete project
              </Button>
            </div>
        </div>
        </div>
      </Tabs>

      {confirmDelete && (
        <DeleteProjectDialog
          name={project.Name}
          detail={[repoName, project.Domain].filter(Boolean).join(" · ")}
          loading={deleting}
          onConfirm={deleteProject}
          onClose={() => setConfirmDelete(false)}
        />
      )}
      <ConfirmDialog
        open={rollbackTarget !== null}
        onOpenChange={o => { if (!o) setRollbackTarget(null) }}
        icon={RotateCcw}
        tone="warning"
        title={`Roll back to ${rollbackTarget ? (rollbackTarget.CommitSHA ? rollbackTarget.CommitSHA.slice(0, 7) : rollbackTarget.ID.slice(0, 10)) : "this build"}?`}
        description="Zero downtime: traffic switches once the previous image passes its health check."
        items={rollbackTarget ? [{
          primary: `${rollbackTarget.CommitSHA ? rollbackTarget.CommitSHA.slice(0, 7) : rollbackTarget.ID.slice(0, 10)}${rollbackTarget.CommitMsg ? ` · ${rollbackTarget.CommitMsg}` : ""}`,
          secondary: rollbackTarget.ImageTag || undefined,
        }] : undefined}
        confirmLabel="Roll back"
        loading={rolling !== null}
        onConfirm={() => rollbackTarget ? rollback(rollbackTarget) : undefined}
      />
    </div>
  )
}
