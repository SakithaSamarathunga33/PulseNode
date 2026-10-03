"use client"

import { API_BASE, nodeApi, type ApiError } from "@/lib/api"
import { useState, useEffect, useCallback, useRef, Suspense } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import {
  Rocket, GitFork, Globe, ChevronRight, ChevronLeft, Loader2, Shuffle, Check, Lock, AlertCircle,
  CircleCheck, Info, ArrowRight,
} from "lucide-react"
import { toast } from "sonner"
import { getSocket } from "@/lib/socket"
import { TerminalWindow } from "@/components/magicui/terminal"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { SearchInput } from "@/components/pn/SearchInput"
import { FormField, ChoiceGroup, BUILD_METHODS } from "@/components/projects/forms"
import { EnvEditor, envProblem, envRowsToObject, newEnvRow, type EnvRow } from "@/components/projects/EnvEditor"
import { cn } from "@/lib/utils"

const GO_API = API_BASE

type Repo = { name: string; full_name: string; private: boolean; clone_url: string; default_branch: string }
type LogLine = { stream: string; line: string; ts: string }
type Dep = { projectId: string; depId: string; status: "running" | "success" | "failed" }

const ADJECTIVES = ["swift", "bright", "calm", "bold", "noble", "crisp", "wise"]
const NOUNS      = ["wave", "node", "peak", "star", "cloud", "ridge", "flux"]
const randomName = () =>
  ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] + "-" +
  NOUNS[Math.floor(Math.random() * NOUNS.length)] + "-" +
  Math.floor(Math.random() * 900 + 100)

// nixpacks/BuildKit write normal build output to stderr, so colour by content —
// red is reserved for actual errors, not the whole stderr stream.
const isErrorLine = (line: string) =>
  line.includes("✕") || line.includes("✖") ||
  /(^|[^a-z])(error|errors|failed|failure|fatal|panic|exit status [1-9])/i.test(line)

const logColor = (stream: string, line: string) =>
  isErrorLine(line) ? "text-[var(--t-err)]" : stream === "system" ? "text-[var(--t-sys)]" : "text-[var(--t-fg)]"

const lineKey = (l: LogLine) => `${l.ts}|${l.stream}|${l.line}`

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">{title}</h2>
        {aside}
      </div>
      {children}
    </div>
  )
}

function OptionCard({ on, onClick, title, lines, note }: {
  on: boolean; onClick: () => void; title: string; lines: string[]; note: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        "flex flex-col gap-2 rounded-xl border bg-card p-3.5 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50",
        on && "border-primary bg-primary/8 ring-3 ring-primary/12",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="flex-1 text-sm font-semibold">{title}</span>
        <CircleCheck className={cn("size-4 text-primary", on ? "opacity-100" : "opacity-0")} aria-hidden />
      </span>
      <span className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
        {lines.map(l => <span key={l}>{l}</span>)}
      </span>
      <span className="text-xs leading-normal text-muted-foreground">{note}</span>
    </button>
  )
}

function NewProjectForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [step, setStep] = useState(1)

  // Step 1 — pick repo
  const [repos, setRepos]           = useState<Repo[]>([])
  const [reposLoading, setReposLoading] = useState(false)
  const [reposError, setReposError] = useState(false)
  const [repoSearch, setRepoSearch]  = useState("")
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)
  const [branches, setBranches]      = useState<string[]>([])
  const [selectedBranch, setSelectedBranch] = useState("")

  // Step 2 — configure
  const [name, setName]         = useState("")
  const [domain, setDomain]     = useState("")
  const [port, setPort]         = useState("3000")
  const [backendPort, setBackendPort] = useState("3001")
  const [rootDomain, setRootDomain] = useState("")
  const [buildMethod, setBuildMethod] = useState("auto")
  const buildCommand = ""
  const [envRows, setEnvRows]   = useState<EnvRow[]>(() => [newEnvRow("NODE_ENV", "production")])
  const [backendEnvRows, setBackendEnvRows] = useState<EnvRow[]>([]) // monorepo backend env

  // Monorepo (frontend/ + backend/) detection — null = not yet probed
  const [monorepo, setMonorepo] = useState<boolean | null>(null)
  // How to deploy a detected monorepo: one project with two routed services
  // ("combined", the default), or each folder as its own independent project
  // ("separate" — own domain, own rollback, deploy one folder at a time).
  const [deployMode, setDeployMode] = useState<"combined" | "separate">("combined")
  // Which folder this project builds when deployMode is "separate".
  const [component, setComponent] = useState<"frontend" | "backend">("frontend")

  // Step 3 — deploy
  const [creating, setCreating] = useState(false)
  const [error, setError]       = useState("")
  const [dep, setDep]           = useState<Dep | null>(null)
  const [logs, setLogs]         = useState<LogLine[]>([])
  const activeDep               = useRef<string | null>(null)

  // Prefill from the projects list's "+ Add frontend/backend" action: jump
  // straight to Step 2 for a known repo, pre-selected for separate-mode deploy
  // of the missing component. Runs once repos have loaded.
  const [prefillDone, setPrefillDone] = useState(false)
  const prefillRepo = searchParams.get("repo")
  const prefillBranch = searchParams.get("branch")
  const prefillComponent = searchParams.get("component")

  const loadRepos = useCallback(async () => {
    setReposLoading(true)
    setReposError(false)
    try {
      const { data } = await nodeApi.get<unknown>("/api/github/repos")
      setRepos(Array.isArray(data) ? (data as Repo[]) : [])
    } catch { setReposError(true) }
    finally { setReposLoading(false) }
  }, [])

  useEffect(() => { loadRepos() }, [loadRepos])

  useEffect(() => {
    nodeApi.get<{ rootDomain?: string }>("/api/domain/settings")
      .then(({ data }) => { if (data?.rootDomain) setRootDomain(data.rootDomain) })
      .catch(() => {})
  }, [])

  // Probe the repo layout whenever the repo/branch changes, so step 1 can show
  // the detection and the form mirrors what the deploy pipeline will do.
  useEffect(() => {
    if (!selectedRepo || !selectedBranch) return
    let cancelled = false
    setMonorepo(null)
    nodeApi.get<{ monorepo?: boolean }>(`/api/github/detect-layout?repo=${encodeURIComponent(selectedRepo.full_name)}&branch=${encodeURIComponent(selectedBranch)}`)
      .then(({ data }) => { if (!cancelled) setMonorepo(Boolean(data?.monorepo)) })
      .catch(() => { if (!cancelled) setMonorepo(false) })
    return () => { cancelled = true }
  }, [selectedRepo, selectedBranch])

  const selectRepo = async (repo: Repo) => {
    setSelectedRepo(repo)
    setSelectedBranch(repo.default_branch)
    setBranches([repo.default_branch])
    // Load branches
    try {
      const { data: list } = await nodeApi.get<unknown>(`/api/github/branches?repo=${encodeURIComponent(repo.full_name)}`)
      const arr = Array.isArray(list) ? (list as string[]) : []
      if (arr.length) {
        setBranches(arr)
        setSelectedBranch(arr.includes(repo.default_branch) ? repo.default_branch : arr[0])
      }
    } catch { /* use default */ }
  }

  const goToStep2 = async (repoOverride?: Repo) => {
    const repo = repoOverride ?? selectedRepo
    if (!repo) return
    setName(repo.name.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
    setDomain("")
    try {
      const { data } = await nodeApi.get<{ port: number }>("/api/projects/free-port")
      setPort(String(data.port))
    } catch { /* keep default */ }
    setStep(2)
  }

  // "+ Add frontend/backend" from the projects list lands here with ?repo=,
  // &branch=, &component= — skip straight to Step 2, separate mode, with the
  // missing component pre-selected.
  useEffect(() => {
    if (prefillDone || !prefillRepo || repos.length === 0) return
    const match = repos.find(r => r.full_name.toLowerCase() === prefillRepo.toLowerCase())
    if (!match) return
    setPrefillDone(true)
    const branch = prefillBranch || match.default_branch
    setSelectedRepo(match)
    setSelectedBranch(branch)
    setBranches([branch])
    nodeApi.get<unknown>(`/api/github/branches?repo=${encodeURIComponent(match.full_name)}`)
      .then(({ data: list }) => { if (Array.isArray(list) && list.length) setBranches(list as string[]) })
      .catch(() => {})
    setDeployMode("separate")
    if (prefillComponent === "frontend" || prefillComponent === "backend") setComponent(prefillComponent)
    goToStep2(match)
  // One-shot prefill guarded by `prefillDone`; goToStep2 is intentionally not a dep (it changes
  // every render and would re-run the prefill).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, prefillDone, prefillRepo, prefillBranch, prefillComponent])

  const combined = Boolean(monorepo) && deployMode === "combined"
  const envErr = envProblem(envRows, combined ? "Frontend environment" : "Environment")
    ?? (combined ? envProblem(backendEnvRows, "Backend environment") : null)

  const deploy = async () => {
    if (!selectedRepo) return
    setCreating(true)
    setError("")
    try {
      const envVars = JSON.stringify(envRowsToObject(envRows))
      // Combined monorepo: backend gets its own env; BACKEND_PORT tells the
      // builder which port Traefik forwards /api to. Separate mode deploys one
      // component as a normal single-service project, so no split env needed.
      let backendEnvVars = "{}"
      if (combined) {
        const beEnv = envRowsToObject(backendEnvRows)
        if (backendPort.trim()) beEnv.BACKEND_PORT = backendPort.trim()
        backendEnvVars = JSON.stringify(beEnv)
      }
      const baseDir = monorepo && deployMode === "separate" ? component : ""
      const r = await fetch(`${GO_API}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          repoUrl: selectedRepo.clone_url,
          branch: selectedBranch,
          buildMethod,
          buildCommand: buildMethod === "custom" ? buildCommand : "",
          port: parseInt(port, 10) || 3000,
          domain,
          envVars,
          backendEnvVars,
          baseDir,
        }),
      })
      if (r.status === 401) { window.location.href = "/login"; return }
      const proj = await r.json().catch(() => ({}))
      if (!r.ok) { setError(proj.error ?? "Failed to create project"); return }

      // Trigger the first deploy and follow it here (busy/full queue answers 409/503).
      try {
        const d = await nodeApi.post<{ deploymentId?: string }>(`/api/projects/${proj.ID}/deploy`)
        if (d.deploymentId) {
          activeDep.current = d.deploymentId
          setLogs([])
          setDep({ projectId: proj.ID, depId: d.deploymentId, status: "running" })
          return
        }
      } catch (e) {
        const status = (e as ApiError).status
        toast.error(status === 503
          ? "Project created, but the deploy queue is full. Redeploy from the project page in a moment."
          : `Project created, but the first deploy did not start: ${e instanceof Error ? e.message : "unknown error"}`)
      }
      router.push(`/projects/${proj.ID}`)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error")
    } finally { setCreating(false) }
  }

  // Follow the first deployment: history from the API, then live lines from the
  // realtime stream (de-duplicated, since the two can overlap), plus a status poll.
  const depId = dep?.depId
  const depProject = dep?.projectId
  useEffect(() => {
    if (!depId || !depProject) return
    let stopped = false
    const merge = (prev: LogLine[], incoming: LogLine[]) => {
      const seen = new Set(prev.map(lineKey))
      const add = incoming.filter(l => !seen.has(lineKey(l)))
      return add.length ? [...prev, ...add] : prev
    }
    const socket = getSocket()
    const onLog = (payload: unknown) => {
      const p = payload as { deploymentId: string; stream: string; line: string; ts: string }
      if (p.deploymentId !== activeDep.current) return
      setLogs(prev => merge(prev, [{ stream: p.stream, line: p.line, ts: p.ts }]))
    }
    socket.on("deploy:log", onLog)
    nodeApi.get<unknown>(`/api/projects/${depProject}/deployments/${depId}/logs`)
      .then(({ data }) => { if (!stopped && Array.isArray(data)) setLogs(prev => merge(data as LogLine[], prev)) })
      .catch(() => {})

    let timer: ReturnType<typeof setTimeout>
    let inFlight = false
    const poll = async () => {
      if (!inFlight && !document.hidden) {
        inFlight = true
        try {
          const { data } = await nodeApi.get<unknown>(`/api/projects/${depProject}/deployments`)
          const row = Array.isArray(data) ? (data as { ID: string; Status: string }[]).find(d => d.ID === depId) : undefined
          if (row && (row.Status === "success" || row.Status === "failed")) {
            if (!stopped) setDep(d => (d && d.depId === depId ? { ...d, status: row.Status as "success" | "failed" } : d))
            return
          }
        } catch { /* keep polling */ }
        finally { inFlight = false }
      }
      if (!stopped) timer = setTimeout(poll, 3000)
    }
    timer = setTimeout(poll, 1500)
    return () => { stopped = true; clearTimeout(timer); socket.off("deploy:log", onLog) }
  }, [depId, depProject])

  const filteredRepos = repos.filter(r => r.full_name.toLowerCase().includes(repoSearch.toLowerCase()))
  const STEPS = ["Repository", "Configure", "Deploy"]
  const started = dep !== null
  const finished = dep !== null && dep.status !== "running"

  const summary: { label: string; value: string }[] = [
    { label: "Repository", value: selectedRepo ? `${selectedRepo.full_name}@${selectedBranch}` : "" },
    { label: "Structure", value: combined ? "One project (/ + /api)" : monorepo ? `Separate (${component}/ only)` : "Single service" },
    { label: "Name", value: name },
    { label: "Domain", value: domain },
    { label: "Build", value: BUILD_METHODS.find(b => b.value === buildMethod)?.label ?? buildMethod },
    { label: combined ? "Ports" : "Port", value: combined ? `${port} (frontend) · ${backendPort} (backend)` : port },
    { label: "Variables", value: `${envRows.filter(r => r.key.trim()).length + (combined ? backendEnvRows.filter(r => r.key.trim()).length : 0)} set` },
  ]

  const canContinue2 = Boolean(name) && Boolean(domain) && Boolean(port) && !envErr

  return (
    <>
      <PageHeader
        icon={Rocket}
        title="New project"
        description={<>Import a repository from GitHub and deploy it to this server.</>}
        actions={
          <Button variant="outline" nativeButton={false} render={<Link href="/projects" />}>Cancel</Button>
        }
      />
      <PageBody className="max-w-[960px] space-y-5">
        {/* Step indicator */}
        <ol className="flex items-center gap-2.5" aria-label="Progress">
          {STEPS.map((label, i) => {
            const n = i + 1
            const done = step > n || (n === 3 && finished && dep?.status === "success")
            const active = step === n
            return (
              <li key={label} className={cn("flex items-center gap-2.5", i < STEPS.length - 1 ? "flex-1" : "flex-none")} aria-current={active ? "step" : undefined}>
                <span
                  className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-md border text-xs font-bold tabular-nums",
                    done && "border-primary bg-primary text-primary-foreground",
                    active && !done && "border-primary bg-primary/12 text-primary",
                    !done && !active && "text-muted-foreground",
                  )}
                >
                  {done ? <Check className="size-3.5" aria-hidden /> : n}
                </span>
                <span className={cn("text-[13px] whitespace-nowrap", active ? "font-semibold" : "text-muted-foreground")}>
                  {label}
                  <span className="sr-only">{done ? " (completed)" : active ? " (current step)" : ""}</span>
                </span>
                {i < STEPS.length - 1 && <span className={cn("h-px min-w-5 flex-1", step > n ? "bg-primary" : "bg-border")} aria-hidden />}
              </li>
            )
          })}
        </ol>

        {/* Step 1 — Select repository */}
        {step === 1 && (
          <section aria-label="Choose repository" className="overflow-hidden rounded-xl border bg-card shadow-card motion-safe:animate-in fade-in-0 duration-300">
            <div className="flex items-center gap-2.5 border-b p-3">
              <SearchInput
                aria-label="Search repositories"
                placeholder="Search repositories"
                value={repoSearch}
                onChange={e => setRepoSearch(e.target.value)}
                className="max-w-none flex-1"
              />
              <span className="text-xs whitespace-nowrap text-muted-foreground">
                <span className="tabular-nums">{repos.length}</span> repositories
              </span>
            </div>
            <div role="radiogroup" aria-label="Repositories" className="max-h-96 overflow-y-auto">
              {reposLoading ? (
                <div className="space-y-2 p-3" aria-busy="true">
                  {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-12" />)}
                </div>
              ) : reposError ? (
                <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                  <p className="text-sm text-muted-foreground">Could not load repositories. Is GitHub connected?</p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={loadRepos}>Retry</Button>
                    <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/github" />}>Connect GitHub</Button>
                  </div>
                </div>
              ) : filteredRepos.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">No repositories found</p>
              ) : (
                filteredRepos.map(repo => {
                  const on = selectedRepo?.full_name === repo.full_name
                  return (
                    <button
                      key={repo.full_name}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => selectRepo(repo)}
                      className={cn(
                        "flex min-h-14 w-full items-center gap-3 border-b px-3.5 py-2 text-left outline-none transition-colors last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
                        on && "bg-primary/8",
                      )}
                    >
                      <GitFork className="size-[17px] shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[13px] font-medium">{repo.full_name}</span>
                        <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          {repo.private ? <Lock className="size-3" aria-hidden /> : <Globe className="size-3" aria-hidden />}
                          {repo.private ? "Private" : "Public"} · default <span className="font-mono">{repo.default_branch}</span>
                        </span>
                      </span>
                      <span className={cn("grid size-5 shrink-0 place-items-center rounded-full border", on ? "border-primary bg-primary text-primary-foreground" : "border-input")}>
                        {on && <Check className="size-3" aria-label="Selected" />}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
            {selectedRepo && (
              <div className="flex flex-wrap items-center gap-3 border-t bg-muted/30 px-3.5 py-3">
                <span className="text-[13px] text-muted-foreground">Branch</span>
                <Select
                  value={selectedBranch}
                  onValueChange={v => setSelectedBranch(v as string)}
                  items={branches.map(b => ({ value: b, label: b }))}
                >
                  <SelectTrigger id="branch-select" aria-label="Branch" size="sm" className="w-48 font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map(b => <SelectItem key={b} value={b} className="font-mono">{b}</SelectItem>)}
                  </SelectContent>
                </Select>
                {monorepo === null ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />Checking layout…
                  </span>
                ) : monorepo ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-info" role="status">
                    <Info className="size-3.5" aria-hidden />
                    Monorepo — detected <span className="font-mono">frontend/</span> and <span className="font-mono">backend/</span>
                  </span>
                ) : null}
              </div>
            )}
          </section>
        )}

        {/* Step 2 — Configure */}
        {step === 2 && (
          <section aria-label="Configure" className="space-y-5 motion-safe:animate-in fade-in-0 duration-300">
            {monorepo && (
              <Section title="Project structure">
                <div role="radiogroup" aria-label="Project structure" className="grid gap-2.5 sm:grid-cols-2">
                  <OptionCard
                    on={deployMode === "combined"}
                    onClick={() => setDeployMode("combined")}
                    title="One project"
                    lines={["frontend/  →  /", "backend/   →  /api"]}
                    note="One domain and one deployment: two containers routed by path. Your frontend should call /api/…. Frontend and backend always redeploy together."
                  />
                  <OptionCard
                    on={deployMode === "separate"}
                    onClick={() => setDeployMode("separate")}
                    title="Separate projects"
                    lines={["one folder per project", "own domain, env and rollback"]}
                    note="Deploys only one folder now; add the other later from the Projects page. Independent deploys, but it needs its own domain."
                  />
                </div>
                {deployMode === "separate" && (
                  <ChoiceGroup
                    label="Folder to deploy"
                    value={component}
                    onChange={setComponent}
                    options={[
                      { value: "frontend", label: "frontend/" },
                      { value: "backend", label: "backend/" },
                    ]}
                  />
                )}
              </Section>
            )}

            <div className="grid gap-3.5 sm:grid-cols-2">
              <FormField label="Project name" htmlFor="np-name">
                <Input id="np-name" value={name} onChange={e => setName(e.target.value)} spellCheck={false} className="h-9 font-mono" />
              </FormField>
              <div className={cn("grid gap-3.5", combined && "grid-cols-2")}>
                <FormField label={combined ? "Frontend port" : "Container port"} htmlFor="np-port">
                  <Input id="np-port" type="number" inputMode="numeric" value={port} onChange={e => setPort(e.target.value)} className="h-9 font-mono tabular-nums" />
                </FormField>
                {combined && (
                  <FormField label="Backend port" htmlFor="np-bport">
                    <Input id="np-bport" type="number" inputMode="numeric" value={backendPort} onChange={e => setBackendPort(e.target.value)} className="h-9 font-mono tabular-nums" />
                  </FormField>
                )}
              </div>
            </div>

            <Section title="Domain">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Globe className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    id="np-domain"
                    aria-label="Domain"
                    value={domain}
                    onChange={e => setDomain(e.target.value)}
                    placeholder="app.yourdomain.com"
                    spellCheck={false}
                    className="h-9 pl-8 font-mono"
                  />
                </div>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9"
                        aria-label="Generate random subdomain"
                        onClick={() => setDomain(randomName() + "." + (rootDomain || "example.com"))}
                      />
                    }
                  >
                    <Shuffle className="size-3.5" />Random
                  </TooltipTrigger>
                  <TooltipContent>Random subdomain{rootDomain ? ` on ${rootDomain}` : ""}</TooltipContent>
                </Tooltip>
              </div>
              <p className="text-xs text-muted-foreground">Must point to this server via DNS. Caddy issues a TLS certificate automatically once it does.</p>
            </Section>

            <Section title="Build method">
              <ChoiceGroup label="Build method" value={buildMethod} onChange={setBuildMethod} options={[...BUILD_METHODS]} columns={3} />
            </Section>

            <Section
              title="Environment"
              aside={combined && (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Lock className="size-3.5 text-success" aria-hidden />Backend secrets are never exposed to the frontend environment.
                </span>
              )}
            >
              <div className={cn("grid gap-3", combined && "md:grid-cols-2")}>
                <EnvEditor
                  title={combined ? "Frontend env" : "Environment variables"}
                  description={combined ? "Frontend container only" : undefined}
                  rows={envRows}
                  onChange={setEnvRows}
                  idPrefix="np-env"
                />
                {combined && (
                  <EnvEditor
                    title="Backend env"
                    description="Backend container only"
                    rows={backendEnvRows}
                    onChange={setBackendEnvRows}
                    idPrefix="np-benv"
                  />
                )}
              </div>
              {envErr && (
                <p role="alert" className="flex items-center gap-1.5 text-xs text-danger">
                  <AlertCircle className="size-3.5" aria-hidden />{envErr}
                </p>
              )}
            </Section>
          </section>
        )}

        {/* Step 3 — Review & deploy */}
        {step === 3 && (
          <section aria-label="Deploy" className="space-y-3.5 motion-safe:animate-in fade-in-0 duration-300">
            <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 lg:grid-cols-3">
              {summary.map(row => (
                <div key={row.label} className="bg-card px-3.5 py-3">
                  <dt className="text-[11px] text-muted-foreground">{row.label}</dt>
                  <dd className="mt-0.5 font-mono text-xs break-all">{row.value || "—"}</dd>
                </div>
              ))}
            </dl>

            {error && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {started && (
              <TerminalWindow
                className="max-h-80 min-h-56"
                title={`${dep.depId.slice(0, 14)} — pulsenode build · ${dep.status === "running" ? "Live" : dep.status === "success" ? "Completed" : "Failed"}`}
              >
                {logs.length === 0 ? (
                  <p className="text-[var(--t-muted)]">Waiting for logs…</p>
                ) : (
                  logs.map((entry, i) => (
                    <div key={`${lineKey(entry)}#${i}`} className="flex items-start gap-3">
                      <span className="shrink-0 text-[var(--t-dim)] tabular-nums select-none">{new Date(entry.ts).toLocaleTimeString()}</span>
                      <span className={cn("min-w-0 flex-1", logColor(entry.stream, entry.line))}>{entry.line}</span>
                    </div>
                  ))
                )}
              </TerminalWindow>
            )}

            {finished && dep.status === "success" && (
              <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-success/30 bg-success/10 px-4 py-3.5">
                <CircleCheck className="size-[18px] text-success" aria-hidden />
                <span className="flex-1 text-[13px]">
                  <b className="font-semibold">{name}</b> is live at{" "}
                  <a href={`https://${domain}`} target="_blank" rel="noopener noreferrer" className="font-mono hover:underline">{domain}<span className="sr-only"> (opens in a new tab)</span></a>
                </span>
              </div>
            )}
            {finished && dep.status === "failed" && (
              <Alert variant="destructive" role="status">
                <AlertCircle />
                <AlertDescription>The deployment failed. Open the project to read the log, fix the settings and redeploy.</AlertDescription>
              </Alert>
            )}
          </section>
        )}

        {/* Navigation */}
        <div className="flex justify-between gap-2.5 border-t pt-4">
          <Button
            variant="ghost"
            onClick={() => setStep(s => s - 1)}
            disabled={step === 1 || started || creating}
          >
            <ChevronLeft className="size-4" />Back
          </Button>
          {step === 1 && (
            <Button onClick={() => goToStep2()} disabled={!selectedRepo}>
              Continue<ChevronRight className="size-4" />
            </Button>
          )}
          {step === 2 && (
            <Button onClick={() => setStep(3)} disabled={!canContinue2}>
              Continue<ChevronRight className="size-4" />
            </Button>
          )}
          {step === 3 && !started && (
            <Button onClick={deploy} disabled={creating}>
              {creating ? <><Loader2 className="size-4 animate-spin" />Deploying…</> : <><Rocket className="size-4" />Deploy project</>}
            </Button>
          )}
          {step === 3 && started && (
            <Button onClick={() => router.push(`/projects/${dep.projectId}`)}>
              {finished ? "Open project" : "Open project (keeps deploying)"}<ArrowRight className="size-4" />
            </Button>
          )}
        </div>
      </PageBody>
    </>
  )
}

export default function NewProjectPage() {
  return (
    <Suspense fallback={null}>
      <NewProjectForm />
    </Suspense>
  )
}
