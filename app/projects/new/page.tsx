"use client"

import { API_BASE, nodeApi } from "@/lib/api"
import { useState, useEffect, useCallback, Suspense } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Rocket, GitFork, GitBranch, Globe, ChevronRight, ChevronLeft, Loader2, Shuffle, Check, Layers, Boxes, Lock, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { SearchInput } from "@/components/pn/SearchInput"
import { FormField, ChoiceGroup, BUILD_METHODS } from "@/components/projects/forms"
import { cn } from "@/lib/utils"

const GO_API = API_BASE

type Repo = { name: string; full_name: string; private: boolean; clone_url: string; default_branch: string }

const ADJECTIVES = ["swift", "bright", "calm", "bold", "noble", "crisp", "wise"]
const NOUNS      = ["wave", "node", "peak", "star", "cloud", "ridge", "flux"]
const randomName = () =>
  ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] + "-" +
  NOUNS[Math.floor(Math.random() * NOUNS.length)] + "-" +
  Math.floor(Math.random() * 900 + 100)

function NewProjectForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [step, setStep] = useState(1)

  // Step 1 — pick repo
  const [repos, setRepos]           = useState<Repo[]>([])
  const [reposLoading, setReposLoading] = useState(false)
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
  const [envText, setEnvText]   = useState("") // KEY=VALUE lines
  const [backendEnvText, setBackendEnvText] = useState("") // monorepo backend env

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

  // Prefill from the projects list's "+ Add frontend/backend" action: jump
  // straight to Step 2 for a known repo, pre-selected for separate-mode deploy
  // of the missing component. Runs once repos have loaded.
  const [prefillDone, setPrefillDone] = useState(false)
  const prefillRepo = searchParams.get("repo")
  const prefillBranch = searchParams.get("branch")
  const prefillComponent = searchParams.get("component")

  const loadRepos = useCallback(async () => {
    setReposLoading(true)
    try {
      const { data } = await nodeApi.get<Repo[]>("/api/github/repos")
      setRepos(data)
    } catch { /* ignore */ }
    finally { setReposLoading(false) }
  }, [])

  useEffect(() => { loadRepos() }, [loadRepos])

  useEffect(() => {
    nodeApi.get<{ rootDomain?: string }>("/api/domain/settings")
      .then(({ data }) => { if (data?.rootDomain) setRootDomain(data.rootDomain) })
      .catch(() => {})
  }, [])

  const selectRepo = async (repo: Repo) => {
    setSelectedRepo(repo)
    setSelectedBranch(repo.default_branch)
    setBranches([repo.default_branch])
    // Load branches
    try {
      const { data: list } = await nodeApi.get<string[]>(`/api/github/branches?repo=${encodeURIComponent(repo.full_name)}`)
      setBranches(list)
      if (list.includes(repo.default_branch)) setSelectedBranch(repo.default_branch)
      else if (list[0]) setSelectedBranch(list[0])
    } catch { /* use default */ }
  }

  const goToStep2 = async (repoOverride?: Repo, branchOverride?: string) => {
    const repo = repoOverride ?? selectedRepo
    if (!repo) return
    const branch = branchOverride ?? selectedBranch
    setName(repo.name.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
    setDomain("")
    setMonorepo(null)
    try {
      const { data } = await nodeApi.get<{ port: number }>("/api/projects/free-port")
      setPort(String(data.port))
    } catch { /* keep default */ }
    // Probe layout so the form can mirror what the deploy pipeline will do.
    nodeApi.get<{ monorepo?: boolean }>(`/api/github/detect-layout?repo=${encodeURIComponent(repo.full_name)}&branch=${encodeURIComponent(branch)}`)
      .then(({ data }) => setMonorepo(Boolean(data?.monorepo)))
      .catch(() => setMonorepo(false))
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
    nodeApi.get<string[]>(`/api/github/branches?repo=${encodeURIComponent(match.full_name)}`)
      .then(({ data: list }) => { if (list) setBranches(list) })
      .catch(() => {})
    setDeployMode("separate")
    if (prefillComponent === "frontend" || prefillComponent === "backend") setComponent(prefillComponent)
    goToStep2(match, branch)
  // One-shot prefill guarded by `prefillDone`; the step handlers are intentionally not deps (they change
  // every render and would re-run the prefill).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, prefillDone, prefillRepo, prefillBranch, prefillComponent])

  const parseEnvVars = (text: string): Record<string, string> => {
    const map: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const idx = line.indexOf("=")
      if (idx > 0) {
        const k = line.slice(0, idx).trim()
        const v = line.slice(idx + 1).trim()
        if (k) map[k] = v
      }
    }
    return map
  }

  const deploy = async () => {
    if (!selectedRepo) return
    setCreating(true)
    setError("")
    try {
      const combinedMonorepo = monorepo && deployMode === "combined"
      const envVars = JSON.stringify(parseEnvVars(envText))
      // Combined monorepo: backend gets its own env; BACKEND_PORT tells the
      // builder which port Traefik forwards /api to. Separate mode deploys one
      // component as a normal single-service project, so no split env needed.
      let backendEnvVars = "{}"
      if (combinedMonorepo) {
        const beEnv = parseEnvVars(backendEnvText)
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
      const proj = await r.json()
      if (!r.ok) { setError(proj.error ?? "Failed to create project"); return }

      // Trigger first deploy
      await fetch(`${GO_API}/api/projects/${proj.ID}/deploy`, { method: "POST" })
      router.push(`/projects/${proj.ID}`)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error")
    } finally { setCreating(false) }
  }

  const filteredRepos = repos.filter(r =>
    r.full_name.toLowerCase().includes(repoSearch.toLowerCase())
  )

  const combined = monorepo && deployMode === "combined"
  const STEPS = ["Repository", "Configure", "Deploy"]

  const summary: { label: string; value: string }[] = [
    { label: "Repository", value: selectedRepo?.full_name ?? "" },
    { label: "Branch", value: selectedBranch },
    { label: "Name", value: name },
    { label: "Domain", value: domain },
    ...(combined
      ? [
          { label: "Layout", value: "monorepo (/ + /api)" },
          { label: "Frontend port", value: port },
          { label: "Backend port", value: backendPort },
        ]
      : monorepo && deployMode === "separate"
      ? [
          { label: "Layout", value: `separate (${component}/ only)` },
          { label: "Port", value: port },
        ]
      : [{ label: "Port", value: port }]),
    { label: "Build", value: buildMethod },
  ]

  return (
    <>
      <PageHeader
        icon={Rocket}
        title="New project"
        description="Deploy from a GitHub repository"
        actions={
          <Button variant="outline" nativeButton={false} render={<Link href="/projects" />}>Cancel</Button>
        }
      />
      <PageBody className="max-w-3xl">
        {/* Step indicator */}
        <ol className="flex items-center gap-2" aria-label="Progress">
          {STEPS.map((label, i) => {
            const n = i + 1
            const done = step > n
            const active = step === n
            return (
              <li key={label} className="flex flex-1 items-center gap-2 last:flex-none" aria-current={active ? "step" : undefined}>
                <span
                  className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums",
                    done && "border-success bg-success text-background",
                    active && "border-[var(--hue)] bg-[var(--hue)] text-background",
                    !done && !active && "bg-muted text-muted-foreground",
                  )}
                >
                  {done ? <Check className="size-3.5" aria-hidden /> : n}
                </span>
                <span className={cn("text-sm", active ? "font-medium" : "text-muted-foreground")}>
                  {label}
                  <span className="sr-only">{done ? " (completed)" : active ? " (current step)" : ""}</span>
                </span>
                {i < STEPS.length - 1 && <span className={cn("mx-1 h-px flex-1", done ? "bg-success" : "bg-border")} aria-hidden />}
              </li>
            )
          })}
        </ol>

        {/* Step 1 — Select repository */}
        {step === 1 && (
          <div className="space-y-4 motion-safe:animate-in fade-in-0 duration-300">
            <Card className="gap-0 overflow-hidden p-0">
              <div className="border-b p-3">
                <SearchInput
                  aria-label="Search repositories"
                  placeholder="Search repositories…"
                  value={repoSearch}
                  onChange={e => setRepoSearch(e.target.value)}
                  className="max-w-none"
                />
              </div>
              <div role="radiogroup" aria-label="Repositories" className="max-h-80 overflow-y-auto">
                {reposLoading ? (
                  <div className="space-y-2 p-3" aria-busy="true">
                    {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-12" />)}
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
                          "flex w-full items-center gap-3 border-b px-4 py-3 text-left outline-none transition-colors last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
                          on && "bg-[color-mix(in_srgb,var(--hue)_10%,transparent)]",
                        )}
                      >
                        <GitFork className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-sm font-medium">{repo.full_name}</p>
                          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                            {repo.private && <Lock className="size-3" aria-hidden />}
                            {repo.private ? "Private" : "Public"} · <span className="font-mono">{repo.default_branch}</span>
                          </p>
                        </div>
                        {on && <Check className="size-4 shrink-0 text-[var(--hue-fg)]" aria-label="Selected" />}
                      </button>
                    )
                  })
                )}
              </div>
            </Card>

            {selectedRepo && (
              <Card>
                <CardContent>
                  <FormField label="Branch" htmlFor="branch-select">
                    <Select
                      value={selectedBranch}
                      onValueChange={v => setSelectedBranch(v as string)}
                      items={branches.map(b => ({ value: b, label: b }))}
                    >
                      <SelectTrigger id="branch-select" className="w-full font-mono">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {branches.map(b => <SelectItem key={b} value={b} className="font-mono">{b}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormField>
                </CardContent>
              </Card>
            )}

            <Button size="lg" className="w-full" onClick={() => goToStep2()} disabled={!selectedRepo}>
              Continue
              <ChevronRight className="size-4" />
            </Button>
          </div>
        )}

        {/* Step 2 — Configure */}
        {step === 2 && (
          <div className="space-y-4 motion-safe:animate-in fade-in-0 duration-300">
            <Card>
              <CardContent className="space-y-5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b pb-3 text-sm text-muted-foreground">
                  <span className="flex min-w-0 items-center gap-1.5"><GitFork className="size-4 shrink-0" /><span className="truncate font-mono">{selectedRepo?.full_name}</span></span>
                  <span className="flex items-center gap-1.5"><GitBranch className="size-4 shrink-0" /><span className="font-mono">{selectedBranch}</span></span>
                </div>

                {/* Monorepo: choose combined vs separate deploy */}
                {monorepo && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">
                      <span className="font-mono">frontend/</span> + <span className="font-mono">backend/</span> detected — deploy as…
                    </p>
                    <ChoiceGroup
                      label="Monorepo deploy mode"
                      value={deployMode}
                      onChange={setDeployMode}
                      options={[
                        { value: "combined", label: "One project", desc: "Shared domain · / and /api" },
                        { value: "separate", label: "Separate projects", desc: "Own domain · one at a time" },
                      ]}
                    />
                  </div>
                )}

                {monorepo && deployMode === "combined" && (
                  <Alert>
                    <Layers />
                    <AlertDescription>
                      <span className="font-medium text-foreground">One project, two services.</span>{" "}
                      Two containers will deploy on this domain: <span className="font-mono">frontend → /</span> and{" "}
                      <span className="font-mono">backend → /api</span>. Keep build method on <span className="font-medium">Auto-detect</span>.
                      Your frontend should call <span className="font-mono">/api/…</span>.
                    </AlertDescription>
                  </Alert>
                )}

                {monorepo && deployMode === "separate" && (
                  <div className="space-y-3">
                    <Alert>
                      <Boxes />
                      <AlertDescription>
                        Deploys only one folder as its own independent project — its own domain, build, env vars, and rollback history.
                        Add the other folder later from the Projects page.
                      </AlertDescription>
                    </Alert>
                    <ChoiceGroup
                      label="Folder to deploy"
                      value={component}
                      onChange={setComponent}
                      options={[
                        { value: "frontend", label: "frontend/" },
                        { value: "backend", label: "backend/" },
                      ]}
                    />
                  </div>
                )}

                <FormField label="Project name" htmlFor="np-name">
                  <Input id="np-name" value={name} onChange={e => setName(e.target.value)} />
                </FormField>

                <FormField
                  label="Domain"
                  htmlFor="np-domain"
                  hint={<span className="flex items-center gap-1"><Globe className="size-3" aria-hidden />Must point to this server via DNS</span>}
                >
                  <div className="flex gap-2">
                    <Input
                      id="np-domain"
                      value={domain}
                      onChange={e => setDomain(e.target.value)}
                      placeholder="app.yourdomain.com"
                      className="font-mono"
                    />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            aria-label="Generate random subdomain"
                            onClick={() => setDomain(randomName() + "." + (rootDomain || "example.com"))}
                          />
                        }
                      >
                        <Shuffle className="size-4" />
                      </TooltipTrigger>
                      <TooltipContent>Generate subdomain</TooltipContent>
                    </Tooltip>
                  </div>
                </FormField>

                <div className={cn("grid gap-3", combined && "sm:grid-cols-2")}>
                  <FormField label={combined ? "Frontend port" : "Container port"} htmlFor="np-port">
                    <Input id="np-port" type="number" inputMode="numeric" value={port} onChange={e => setPort(e.target.value)} className="tabular-nums" />
                  </FormField>
                  {combined && (
                    <FormField label="Backend port" htmlFor="np-bport" hint="Port your backend listens on">
                      <Input id="np-bport" type="number" inputMode="numeric" value={backendPort} onChange={e => setBackendPort(e.target.value)} className="tabular-nums" />
                    </FormField>
                  )}
                </div>

                <div className="space-y-1.5">
                  <p className="text-sm leading-none font-medium">Build method</p>
                  <ChoiceGroup label="Build method" value={buildMethod} onChange={setBuildMethod} options={[...BUILD_METHODS]} />
                </div>

                <FormField
                  label={combined ? "Frontend environment variables" : "Environment variables"}
                  htmlFor="np-env"
                  hint={combined ? "Goes to the frontend container only · one KEY=VALUE per line" : "One KEY=VALUE per line"}
                >
                  <Textarea
                    id="np-env"
                    value={envText}
                    onChange={e => setEnvText(e.target.value)}
                    placeholder={"NODE_ENV=production\nPORT=3000\nDATABASE_URL=postgres://…"}
                    rows={4}
                    spellCheck={false}
                    className="resize-y font-mono"
                  />
                </FormField>

                {combined && (
                  <FormField
                    label="Backend environment variables"
                    htmlFor="np-benv"
                    hint="Goes to the backend container only — your backend secrets stay out of the frontend"
                  >
                    <Textarea
                      id="np-benv"
                      value={backendEnvText}
                      onChange={e => setBackendEnvText(e.target.value)}
                      placeholder={"NODE_ENV=production\nDATABASE_URL=postgres://…\nJWT_SECRET=…"}
                      rows={4}
                      spellCheck={false}
                      className="resize-y font-mono"
                    />
                  </FormField>
                )}
              </CardContent>
            </Card>

            <div className="flex gap-2">
              <Button variant="outline" size="lg" onClick={() => setStep(1)}>
                <ChevronLeft className="size-4" />
                Back
              </Button>
              <Button size="lg" className="flex-1" onClick={() => setStep(3)} disabled={!name || !domain}>
                Review &amp; deploy
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 3 — Review & deploy */}
        {step === 3 && (
          <div className="space-y-4 motion-safe:animate-in fade-in-0 duration-300">
            <Card>
              <CardContent>
                <h2 className="mb-3 text-sm font-semibold">Summary</h2>
                <dl className="divide-y">
                  {summary.map(row => (
                    <div key={row.label} className="flex items-center justify-between gap-4 py-2 text-sm">
                      <dt className="text-muted-foreground">{row.label}</dt>
                      <dd className="min-w-0 truncate font-mono text-xs tabular-nums">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>

            {error && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="flex gap-2">
              <Button variant="outline" size="lg" onClick={() => setStep(2)} disabled={creating}>
                <ChevronLeft className="size-4" />
                Back
              </Button>
              <Button size="lg" className="flex-1" onClick={deploy} disabled={creating}>
                {creating ? <><Loader2 className="size-4 animate-spin" /> Deploying…</> : <><Rocket className="size-4" /> Deploy project</>}
              </Button>
            </div>
          </div>
        )}
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
