"use client"

import { useState, useEffect, useRef, useCallback, type ReactNode } from "react"
import { useParams, useRouter } from "next/navigation"
import {
  RefreshCw, Play, Trash2, Globe, GitBranch, Circle, Clock,
  ChevronLeft, Terminal, History, Settings2, ExternalLink, Check, Save, Zap, RotateCcw, Webhook,
  Server, Square, RotateCw, Box,
} from "lucide-react"
import Link from "next/link"
import { getSocket } from "@/lib/socket"
import { TerminalWindow } from "@/components/magicui/terminal"

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

const STATUS_COLOR: Record<string, string> = {
  running: "var(--ok)", building: "var(--acc)",
  failed: "var(--err)", idle: "var(--fg-4)", queued: "var(--acc)",
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="text-xs mb-1.5 block font-medium" style={{ color: "var(--fg-3)" }}>{label}</label>
      {children}
      {hint && <p className="text-[10px] mt-1" style={{ color: "var(--fg-4)" }}>{hint}</p>}
    </div>
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
  const logsRef = useRef<HTMLDivElement>(null)

  const fetchLogs = useCallback(async () => {
    setLoadingLogs(true)
    try {
      const r = await fetch(`${GO_API}/api/docker/logs/${containerID}?tail=300`)
      if (r.ok) setLogs((await r.json()).logs ?? "")
    } catch { /* ignore */ }
    finally { setLoadingLogs(false) }
  }, [containerID])

  useEffect(() => { fetchLogs() }, [fetchLogs])
  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight
  }, [logs])

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
    <div className="flex flex-col h-screen overflow-hidden">
      <div className="shrink-0 px-6 pt-5 pb-4 space-y-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <Link href="/projects" className="text-xs flex items-center gap-1 w-fit" style={{ color: "var(--fg-3)" }}>
          <ChevronLeft size={13} /> Projects
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-lg font-semibold flex items-center gap-2" style={{ color: "var(--fg)" }}>
              <Server size={16} style={{ color: "var(--acc)" }} />
              {project.Name}
              <span
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full capitalize"
                style={{
                  background: (STATUS_COLOR[status] ?? "var(--fg-4)") + "20",
                  color: STATUS_COLOR[status] ?? "var(--fg-4)",
                }}
              >
                <Circle size={6} fill="currentColor" />
                {status}
              </span>
            </h1>
            <div className="flex items-center gap-3 text-xs mt-1" style={{ color: "var(--fg-3)" }}>
              <a
                href={`https://${project.Domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 hover:underline"
                style={{ color: "var(--acc)" }}
              >
                <Globe size={11} />
                {project.Domain}
                <ExternalLink size={9} />
              </a>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => runAction("restart")}
              disabled={acting !== null}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-60"
              style={{ background: "var(--bg-2)", color: "var(--fg)", border: "1px solid var(--border)" }}
            >
              <RotateCw size={13} className={acting === "restart" ? "animate-spin" : ""} />
              Restart
            </button>
            {status === "running" ? (
              <button
                onClick={() => runAction("stop")}
                disabled={acting !== null}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-60"
                style={{ background: "var(--bg-2)", color: "var(--err)", border: "1px solid var(--border)" }}
              >
                <Square size={13} />
                Stop
              </button>
            ) : (
              <button
                onClick={() => runAction("start")}
                disabled={acting !== null}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-60"
                style={{ background: "var(--acc)", color: "#fff" }}
              >
                <Play size={13} />
                Start
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="shrink-0 p-6 pb-0">
          <div className="rounded-xl p-5" style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
            <p className="text-[11px] mb-3" style={{ color: "var(--fg-4)" }}>
              Hosted on this VPS behind a domain, but not deployed through PulseNode — read-only details, pulled live from Docker.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              {[
                { label: "Image", value: project.Image || "—" },
                { label: "Ports", value: project.Ports || "—" },
                { label: "Container", value: containerID || "—" },
                { label: "Created", value: project.CreatedAt || "—" },
              ].map(row => (
                <div key={row.label}>
                  <p className="text-[10px] mb-0.5" style={{ color: "var(--fg-4)" }}>{row.label}</p>
                  <p className="font-mono text-xs truncate flex items-center gap-1" style={{ color: "var(--fg)" }}>
                    {row.label === "Container" && <Box size={11} style={{ color: "var(--fg-4)" }} />}
                    {row.value}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 p-6">
          <TerminalWindow className="h-full" bodyRef={logsRef} title={`${project.Name} — container logs`}>
            {loadingLogs ? (
              <p style={{ color: "#6b7280" }}>Loading logs…</p>
            ) : logs ? (
              logs.split("\n").map((line, i) => (
                <div key={i} style={{ color: "#e2e8f0", wordBreak: "break-all" }}>{line}</div>
              ))
            ) : (
              <p style={{ color: "#6b7280" }}>No logs.</p>
            )}
          </TerminalWindow>
        </div>
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
  const logsRef                         = useRef<HTMLDivElement>(null)
  const activeDepRef                    = useRef<string | null>(null)

  // Editable settings form
  const [form, setForm] = useState({
    name: "", branch: "", domain: "", port: "3000",
    buildMethod: "auto", buildCommand: "", envText: "", backendEnvText: "", autoDeploy: true,
  })
  // Whether this project's repo is a frontend/+backend/ monorepo (null = unknown).
  const [monorepo, setMonorepo] = useState<boolean | null>(null)
  const [saving, setSaving]     = useState(false)
  const [savedAt, setSavedAt]   = useState(0)
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

  // Auto-scroll logs
  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight
    }
  }, [logs])

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
        alert(d.error ?? "Redeploy failed")
      }
    } finally { setDeploying(false) }
  }

  const installHook = async () => {
    setInstallingHook(true)
    try {
      const r = await fetch(`${GO_API}/api/projects/${id}/webhook`, { method: "POST" })
      const d = await r.json()
      if (d.error && !d.installed) alert(d.error)
      await fetchWebhook()
    } finally { setInstallingHook(false) }
  }

  const rollback = async (dep: Deployment) => {
    const label = dep.CommitSHA ? dep.CommitSHA.slice(0, 7) : dep.ID.slice(0, 10)
    if (!confirm(`Roll back to ${label}? This redeploys that build's image with zero downtime.`)) return
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
        alert(d.error ?? "Rollback failed")
      }
    } finally { setRolling(null) }
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
      setSavedAt(Date.now())
      if (redeploy) await triggerDeploy()
      return true
    } catch (e) {
      setSettingsErr(e instanceof Error ? e.message : "Network error")
      return false
    } finally { setSaving(false) }
  }

  const deleteProject = async () => {
    if (!confirm(`Delete project "${project?.Name}"? This cannot be undone.`)) return
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
    if (isErrorLine(line)) return "#f87171"
    if (stream === "system") return "#a78bfa"
    return "#e2e8f0"
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw size={20} className="animate-spin" style={{ color: "var(--fg-3)" }} />
      </div>
    )
  }
  if (!project) {
    return (
      <div className="p-6">
        <p style={{ color: "var(--fg-3)" }}>Project not found.</p>
        <Link href="/projects" className="text-sm underline mt-2 block" style={{ color: "var(--acc)" }}>
          ← Back to projects
        </Link>
      </div>
    )
  }

  if (project.External) {
    return <ExternalProjectView project={project} />
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 pt-5 pb-4 space-y-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2">
          <Link href="/projects" className="text-xs flex items-center gap-1" style={{ color: "var(--fg-3)" }}>
            <ChevronLeft size={13} /> Projects
          </Link>
        </div>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-lg font-semibold flex items-center gap-2" style={{ color: "var(--fg)" }}>
              {project.Name}
              <span
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full capitalize"
                style={{
                  background: (STATUS_COLOR[project.Status] ?? "var(--fg-4)") + "20",
                  color: STATUS_COLOR[project.Status] ?? "var(--fg-4)",
                }}
              >
                <Circle size={6} fill="currentColor" />
                {project.Status}
              </span>
            </h1>
            <div className="flex items-center gap-3 text-xs mt-1" style={{ color: "var(--fg-3)" }}>
              <span className="flex items-center gap-1">
                <GitBranch size={11} />
                {project.Branch}
              </span>
              <a
                href={`https://${project.Domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 hover:underline"
                style={{ color: "var(--acc)" }}
              >
                <Globe size={11} />
                {project.Domain}
                <ExternalLink size={9} />
              </a>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={triggerDeploy}
              disabled={deploying}
              title={`Redeploy the latest commit on ${project.Branch || "the deploy branch"}`}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60"
              style={{ background: "var(--acc)", color: "#fff" }}
            >
              {deploying ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}
              {deploying ? "Deploying…" : "Redeploy"}
            </button>
            <button
              onClick={deleteProject}
              disabled={deleting}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm"
              style={{ background: "var(--bg-2)", color: "var(--err)", border: "1px solid var(--border)" }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="shrink-0 px-6 flex gap-1 pt-3 pb-0" style={{ borderBottom: "1px solid var(--border)" }}>
        {([
          { key: "settings", label: "Settings", icon: Settings2 },
          { key: "logs",     label: "Logs",     icon: Terminal  },
          { key: "history",  label: "History",  icon: History   },
        ] as const).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="flex items-center gap-1.5 px-3 pb-2 text-xs font-medium border-b-2 transition-colors"
            style={{
              borderColor: tab === key ? "var(--acc)" : "transparent",
              color: tab === key ? "var(--acc)" : "var(--fg-3)",
            }}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {/* Logs tab */}
        {tab === "logs" && (
          <div className="h-full flex flex-col">
            {/* Deployment selector */}
            {deployments.length > 0 && (
              <div className="shrink-0 px-6 py-2 flex items-center gap-2" style={{ borderBottom: "1px solid var(--border)" }}>
                <span className="text-xs" style={{ color: "var(--fg-3)" }}>Deployment:</span>
                <select
                  value={activeDep ?? ""}
                  onChange={e => setActiveDep(e.target.value)}
                  className="text-xs rounded px-2 py-1 outline-hidden"
                  style={{ background: "var(--bg-2)", color: "var(--fg)", border: "1px solid var(--border)" }}
                >
                  {deployments.map(d => (
                    <option key={d.ID} value={d.ID}>
                      {d.ID.slice(0, 14)} — {d.Status} — {age(d.CreatedAt)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex-1 min-h-0 p-4">
              <TerminalWindow
                className="h-full"
                bodyRef={logsRef}
                title={`${activeDep ? activeDep.slice(0, 14) + " — " : ""}pulsenode build`}
              >
                {logs.length === 0 ? (
                  <p style={{ color: "#6b7280" }}>Waiting for logs…</p>
                ) : (
                  logs.map((entry, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <span className="select-none shrink-0" style={{ color: "#374151" }}>
                        {new Date(entry.ts).toLocaleTimeString()}
                      </span>
                      <span style={{ color: logColor(entry.stream, entry.line), wordBreak: "break-all" }}>
                        {entry.line}
                      </span>
                    </div>
                  ))
                )}
              </TerminalWindow>
            </div>
          </div>
        )}

        {/* History tab */}
        {tab === "history" && (
          <div className="h-full overflow-y-auto p-6 space-y-2">
            {deployments.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--fg-3)" }}>No deployments yet.</p>
            ) : deployments.map(dep => (
              <div
                key={dep.ID}
                onClick={() => { setActiveDep(dep.ID); setTab("logs") }}
                className="w-full rounded-xl p-4 text-left transition-colors hover:opacity-80 cursor-pointer"
                style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full capitalize"
                    style={{
                      background: (STATUS_COLOR[dep.Status] ?? "var(--fg-4)") + "20",
                      color: STATUS_COLOR[dep.Status] ?? "var(--fg-4)",
                    }}
                  >
                    <Circle size={6} fill="currentColor" />
                    {dep.Status}
                  </span>
                  <div className="flex items-center gap-3">
                    {dep.Status === "success" && dep.ImageTag && (
                      <button
                        onClick={e => { e.stopPropagation(); rollback(dep) }}
                        disabled={rolling !== null}
                        title="Redeploy this build's image (zero-downtime)"
                        className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md font-medium disabled:opacity-50"
                        style={{ background: "var(--bg-3)", color: "var(--acc)", border: "1px solid var(--border)" }}
                      >
                        <RotateCcw size={11} className={rolling === dep.ID ? "animate-spin" : ""} />
                        {rolling === dep.ID ? "Rolling…" : "Rollback"}
                      </button>
                    )}
                    <span className="text-xs whitespace-nowrap" style={{ color: "var(--fg-4)" }}>
                      <Clock size={10} className="inline mr-1" />
                      {age(dep.CreatedAt)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded font-medium capitalize"
                    style={{ background: "var(--bg-3)", color: dep.Trigger === "auto" ? "var(--acc)" : "var(--fg-3)" }}
                  >
                    {dep.Trigger === "auto" ? "⚡ auto" : dep.Trigger === "rollback" ? "⟲ rollback" : dep.Trigger}
                  </span>
                  {dep.CommitSHA && (
                    <span className="text-xs font-mono" style={{ color: "var(--fg-3)" }}>
                      {dep.CommitSHA.slice(0, 7)}
                    </span>
                  )}
                </div>
                {dep.CommitMsg && (
                  <p className="text-xs mt-1 truncate" style={{ color: "var(--fg)" }}>{dep.CommitMsg}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Settings tab */}
        {tab === "settings" && (
          <div className="h-full overflow-y-auto p-6">
            <div className="max-w-lg space-y-4">
              {/* Read-only identity */}
              <div className="rounded-xl p-5 space-y-3" style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
                {[
                  { label: "Project ID", value: project.ID },
                  { label: "Repository", value: project.RepoURL },
                  ...(project.BaseDir ? [{ label: "Deploys from", value: `${project.BaseDir}/ (separate from this repo's other component)` }] : []),
                  { label: "Last deployed commit", value: project.LastCommitSHA ? project.LastCommitSHA.slice(0, 7) : "—" },
                ].map(row => (
                  <div key={row.label} className="flex items-center justify-between text-sm gap-3">
                    <span style={{ color: "var(--fg-3)" }}>{row.label}</span>
                    <span className="font-mono text-xs truncate" style={{ color: "var(--fg)" }}>{row.value}</span>
                  </div>
                ))}
              </div>

              {/* Auto-deploy webhook */}
              <div className="rounded-xl p-5 space-y-3" style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Webhook size={15} style={{ color: "var(--acc)" }} />
                    <p className="text-sm font-medium" style={{ color: "var(--fg)" }}>Auto-deploy webhook</p>
                  </div>
                  {webhook?.supported && (
                    <span className="flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full"
                      style={{
                        background: (webhook.installed ? "var(--ok)" : "var(--warn)") + "20",
                        color: webhook.installed ? "var(--ok)" : "var(--warn)",
                      }}>
                      <Circle size={6} fill="currentColor" />
                      {webhook.installed ? "Installed" : "Not installed"}
                    </span>
                  )}
                </div>
                <p className="text-[11px]" style={{ color: "var(--fg-4)" }}>
                  {webhook?.supported
                    ? "Installed automatically on your repo so pushes deploy instantly. The branch poller stays on as a fallback."
                    : "Connect GitHub (and set NEXT_PUBLIC_ORIGIN) to auto-install a push webhook for instant deploys."}
                </p>
                {webhook?.error && <p className="text-[11px]" style={{ color: "var(--err)" }}>{webhook.error}</p>}
                {webhook?.supported && (
                  <button
                    onClick={installHook}
                    disabled={installingHook}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-60"
                    style={webhook.installed
                      ? { background: "var(--bg-3)", color: "var(--fg-3)", border: "1px solid var(--border)" }
                      : { background: "var(--acc)", color: "#fff" }}
                  >
                    {installingHook
                      ? <RefreshCw size={13} className="animate-spin" />
                      : <Webhook size={13} />}
                    {installingHook ? "Working…" : webhook.installed ? "Re-check / repair" : "Install webhook"}
                  </button>
                )}
              </div>

              {/* Editable config */}
              <div className="rounded-xl p-5 space-y-4" style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
                {/* Auto-deploy toggle */}
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium flex items-center gap-1.5" style={{ color: "var(--fg)" }}>
                      <Zap size={13} style={{ color: "var(--acc)" }} /> Auto-deploy
                    </p>
                    <p className="text-[11px] mt-0.5" style={{ color: "var(--fg-4)" }}>
                      Rebuild &amp; redeploy automatically when <span className="font-mono">{form.branch || "the branch"}</span> gets new commits.
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={form.autoDeploy}
                    onClick={() => setForm(f => ({ ...f, autoDeploy: !f.autoDeploy }))}
                    className="relative w-10 h-6 rounded-full shrink-0 transition-colors"
                    style={{ background: form.autoDeploy ? "var(--acc)" : "var(--bg-3)", border: "1px solid var(--border)" }}
                  >
                    <span
                      className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                      style={{ left: form.autoDeploy ? "1.25rem" : "0.15rem", background: "#fff" }}
                    />
                  </button>
                </div>

                {/* Name */}
                <Field label="Project Name">
                  <input
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg text-sm outline-hidden"
                    style={{ background: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)" }}
                  />
                </Field>

                {/* Branch */}
                <Field label="Branch">
                  <input
                    value={form.branch}
                    onChange={e => setForm(f => ({ ...f, branch: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg text-sm outline-hidden font-mono"
                    style={{ background: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)" }}
                  />
                </Field>

                {/* Domain */}
                <Field label="Domain">
                  <input
                    value={form.domain}
                    onChange={e => setForm(f => ({ ...f, domain: e.target.value }))}
                    placeholder="app.yourdomain.com"
                    className="w-full px-3 py-2 rounded-lg text-sm outline-hidden font-mono"
                    style={{ background: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)" }}
                  />
                </Field>

                {/* Port */}
                <Field label="Container Port">
                  <input
                    type="number"
                    value={form.port}
                    onChange={e => setForm(f => ({ ...f, port: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg text-sm outline-hidden"
                    style={{ background: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)" }}
                  />
                </Field>

                {/* Build method */}
                <Field label="Build Method">
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { value: "auto",       label: "Auto-detect" },
                      { value: "compose",    label: "Docker Compose" },
                      { value: "dockerfile", label: "Dockerfile" },
                      { value: "nixpacks",   label: "Nixpacks" },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setForm(f => ({ ...f, buildMethod: opt.value }))}
                        className="p-2.5 rounded-lg text-left transition-colors text-xs font-medium"
                        style={{
                          background: form.buildMethod === opt.value ? "var(--acc)/10" : "var(--bg-3)",
                          border: `1px solid ${form.buildMethod === opt.value ? "var(--acc)" : "var(--border)"}`,
                          color: form.buildMethod === opt.value ? "var(--acc)" : "var(--fg)",
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </Field>

                {/* Env vars */}
                <Field
                  label={monorepo ? "Frontend Environment Variables" : "Environment Variables"}
                  hint={monorepo ? "Frontend container only · one KEY=VALUE per line" : "One KEY=VALUE per line"}
                >
                  <textarea
                    value={form.envText}
                    onChange={e => setForm(f => ({ ...f, envText: e.target.value }))}
                    placeholder={"NODE_ENV=production\nPORT=3000"}
                    rows={4}
                    className="w-full px-3 py-2 rounded-lg text-sm outline-hidden font-mono resize-y"
                    style={{ background: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)" }}
                  />
                </Field>

                {/* Backend env vars (monorepo) */}
                {monorepo && (
                  <Field label="Backend Environment Variables" hint="Backend container only — set BACKEND_PORT here for the /api service">
                    <textarea
                      value={form.backendEnvText}
                      onChange={e => setForm(f => ({ ...f, backendEnvText: e.target.value }))}
                      placeholder={"NODE_ENV=production\nDATABASE_URL=postgres://…\nBACKEND_PORT=3001"}
                      rows={4}
                      className="w-full px-3 py-2 rounded-lg text-sm outline-hidden font-mono resize-y"
                      style={{ background: "var(--bg-3)", color: "var(--fg)", border: "1px solid var(--border)" }}
                    />
                  </Field>
                )}
              </div>

              {settingsErr && (
                <p className="text-sm px-3 py-2 rounded-lg" style={{ background: "var(--err)/10", color: "var(--err)" }}>
                  {settingsErr}
                </p>
              )}

              {/* Save actions */}
              <div className="flex gap-2">
                <button
                  onClick={() => saveSettings(false)}
                  disabled={saving || deploying}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium disabled:opacity-60"
                  style={{ background: "var(--bg-2)", color: "var(--fg)", border: "1px solid var(--border)" }}
                >
                  {savedAt && !saving ? <Check size={14} style={{ color: "var(--ok)" }} /> : <Save size={14} />}
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => saveSettings(true)}
                  disabled={saving || deploying}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium disabled:opacity-60"
                  style={{ background: "var(--acc)", color: "#fff" }}
                >
                  {saving || deploying
                    ? <><RefreshCw size={14} className="animate-spin" /> Working…</>
                    : <><Play size={14} /> Save &amp; Redeploy</>}
                </button>
              </div>

              <button
                onClick={deleteProject}
                disabled={deleting}
                className="w-full py-2.5 rounded-lg text-sm font-medium disabled:opacity-60 flex items-center justify-center gap-2"
                style={{ border: "1px solid var(--err)", color: "var(--err)" }}
              >
                <Trash2 size={13} />
                Delete Project
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
