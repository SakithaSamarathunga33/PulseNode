"use client"

import { API_BASE, nodeApi } from "@/lib/api"
import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useParams, useRouter } from "next/navigation"
import Link from "next/link"
import {
  Play, Trash2, GitBranch, Terminal, History, ExternalLink, Save, Zap, RotateCcw, Webhook, Loader2,
  AlertCircle, RefreshCw, FolderGit2, Copy, Lock, MoreHorizontal, TriangleAlert,
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
import { ExternalProjectView } from "@/components/projects/ExternalProjectView"
import { DeploymentHistory } from "@/components/projects/DeploymentHistory"
import {
  BackLink, DomainLink, Panel, StatusPill, copyText, age, isBusyStatus, type Deployment, type Project,
} from "@/components/projects/project-ui"
import { WildcardBadge, WildcardHint } from "@/components/domain/wildcard"
import { cn } from "@/lib/utils"
import { Truncate } from "@/components/pn/Truncate"
import { LoadingButton } from "@/components/interior/loading-button"

const GO_API = API_BASE

type WebhookStatus = { installed: boolean; supported: boolean; url: string; error?: string }


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

  /** Returns whether the deploy was queued (failures are already toasted). */
  const triggerDeploy = async (): Promise<boolean> => {
    setDeploying(true)
    try {
      const r = await fetch(`${GO_API}/api/projects/${id}/deploy`, { method: "POST" })
      if (handledAuthFailure(r)) return false
      const d = await r.json().catch(() => ({}))
      if (r.ok) {
        await fetchDeployments()
        setActiveDep(d.deploymentId)
        setTab("logs")
        fetchProject()
        return true
      }
      // 409 = already building; 503 = queue full or shutting down — the server message says which.
      toast.error(d.error ?? "Redeploy failed")
      return false
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
              {isBusyStatus(project.Status) ? (
                <Button disabled title="A build is already running">
                  <Loader2 className="size-4 animate-spin" /> Building…
                </Button>
              ) : (
                // interior.dev LoadingButton: Redeploy → Deploying… → Queued / Failed, in place.
                <span title={`Redeploy the latest commit on ${project.Branch || "the deploy branch"}`}>
                  <LoadingButton
                    onAction={async () => { if (!(await triggerDeploy())) throw new Error("Redeploy failed") }}
                    pendingLabel="Deploying…"
                    successLabel="Queued"
                    errorLabel="Failed"
                    disabled={deploying}
                  >
                    Redeploy
                  </LoadingButton>
                </span>
              )}
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
              {busyNow && <><span className="size-1.5 rounded-full bg-success motion-safe:animate-pulse" aria-hidden /><span className="sr-only">(live)</span></>}
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
          <DeploymentHistory
            deployments={deployments}
            rolling={rolling}
            onViewLogs={depID => { setActiveDep(depID); setTab("logs") }}
            onRollback={setRollbackTarget}
          />
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
                  <div key={row.label} className="flex min-w-0 items-center gap-2 bg-card px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <dt className="text-xs text-muted-foreground">{row.label}</dt>
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
                <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3 text-ui text-muted-foreground">
                  <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
                  <span className="min-w-0 flex-1">Push events are picked up by the 60s branch poller until the webhook is installed.</span>
                  <Button variant="outline" size="sm" onClick={installHook} disabled={installingHook}>
                    {installingHook ? <Loader2 className="size-3.5 animate-spin" /> : <Webhook className="size-3.5" />}
                    {installingHook ? "Working…" : "Install webhook"}
                  </Button>
                </div>
              )}
              {webhook && !webhook.supported && !webhook.error && (
                <p className="border-t px-4 py-3 text-xs text-muted-foreground">
                  Connect GitHub (and set NEXT_PUBLIC_ORIGIN) to auto-install a push webhook for instant deploys.
                </p>
              )}
            </Panel>

            {/* Deployment configuration */}
            <Panel
              title="Deployment configuration"
              description="Changes apply on the next deployment."
              aside={
                <div className="flex items-center gap-2 text-ui text-muted-foreground">
                  <Label htmlFor="auto-deploy" className="flex items-center gap-1.5 font-normal">
                    <Zap className="size-3.5" aria-hidden />Auto deploy on push
                  </Label>
                  <Switch id="auto-deploy" checked={form.autoDeploy} onCheckedChange={v => setF("autoDeploy", v)} />
                </div>
              }
            >
              <div className="space-y-5 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
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
                  <p className="text-sm leading-none font-medium">Build method</p>
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
              <div className={cn("grid gap-3 p-4")}>
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
                <p role="alert" className="flex items-center gap-1.5 border-t px-4 py-3 text-xs text-danger">
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
                "z-10 flex flex-wrap items-center justify-end gap-2 rounded-xl border bg-popover px-3 py-3",
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
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/30 bg-card px-4 py-4 shadow-card">
              <div className="space-y-0.5">
                <p className="text-ui font-semibold text-danger">Delete project</p>
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
