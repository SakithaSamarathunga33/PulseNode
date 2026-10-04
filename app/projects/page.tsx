"use client"

import { nodeApi, type ApiError } from "@/lib/api"
import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import Link from "next/link"
import {
  Plus, FolderGit2, GitBranch, Boxes, Server, AlertCircle, RefreshCw, RotateCcw, ArrowRight, Loader2, CircleX,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { EmptyState } from "@/components/pn/EmptyState"
import { Segmented } from "@/components/pn/Segmented"
import { SearchInput } from "@/components/pn/SearchInput"
import { Pill } from "@/components/dashboard/Pill"
import { cn } from "@/lib/utils"
import { Truncate } from "@/components/pn/Truncate"

type Project = {
  ID: string
  Name: string
  RepoURL: string
  Branch: string
  Domain: string
  Status: string
  BuildMethod: string
  BaseDir: string
  CreatedAt: string
  UpdatedAt?: string
  LastCommitSHA?: string
  // Set for apps already hosted on the VPS (behind a domain) that weren't
  // deployed through PulseNode — discovered from running containers rather
  // than the projects table, so RepoURL/Branch/BuildMethod are "".
  External?: boolean
  Image?: string
}

type Filter = "all" | "running" | "building" | "failed" | "idle"

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "outline"> = {
  running: "ok",
  building: "info",
  queued: "info",
  failed: "bad",
  idle: "outline",
}

const STATUS_LABEL: Record<string, string> = {
  running: "Running", building: "Building", queued: "Queued", failed: "Failed", idle: "Idle",
}

const BUILD_LABEL: Record<string, string> = {
  auto: "Auto-detect", compose: "Docker Compose", dockerfile: "Dockerfile", nixpacks: "Nixpacks", custom: "Custom",
}

// Normalizes a repo URL to owner/repo so projects deployed separately from the
// same repo (one for frontend/, one for backend/) can be grouped together.
function repoSlug(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").toLowerCase()
}

function ago(ts?: string): string {
  if (!ts) return ""
  const t = new Date(ts).getTime()
  if (Number.isNaN(t)) return ""
  const d = Date.now() - t
  if (d < 60_000) return "just now"
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`
  const days = Math.floor(d / 86_400_000)
  return days === 1 ? "yesterday" : `${days} days ago`
}

/** Overall state of one entry: a repo group is failed/building/queued if any member is. */
function overall(members: Project[]): string {
  if (members.some(m => m.Status === "failed")) return "failed"
  if (members.some(m => m.Status === "building")) return "building"
  if (members.some(m => m.Status === "queued")) return "queued"
  if (members.every(m => m.Status === "idle")) return "idle"
  return members[0]?.Status === "running" || members.some(m => m.Status === "running") ? "running" : members[0]?.Status ?? "idle"
}

const isBusy = (s: string) => s === "building" || s === "queued"

function StatusPill({ status }: { status: string }) {
  return (
    <Pill tone={STATUS_TONE[status] ?? "outline"} dot>
      {STATUS_LABEL[status] ?? (status || "Unknown")}
    </Pill>
  )
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 flex min-w-0 items-center gap-1 truncate font-mono text-xs">{children}</dd>
    </div>
  )
}

function CardFooter({ sha, note, when, status, busy, redeployLabel, onRedeploy, href, openLabel }: {
  sha?: string
  note: string
  when: string
  status: string
  busy: boolean
  redeployLabel: string | null
  onRedeploy: (() => void) | null
  href: string
  openLabel: string
}) {
  return (
    <div className="mt-auto flex items-center gap-2 border-t bg-muted/30 py-2 pr-2 pl-4">
      <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
        {sha && <span className="shrink-0 font-mono text-primary">{sha}</span>}
        <span className="truncate">{note}</span>
        {when && <span className="shrink-0">· {when}</span>}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={redeployLabel ?? "Redeploy unavailable"}
        title={redeployLabel ?? "External apps are not deployed by PulseNode"}
        disabled={!onRedeploy || isBusy(status) || busy}
        onClick={onRedeploy ?? undefined}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
      </Button>
      <Link
        href={href}
        aria-label={openLabel}
        title="Open project"
        className="grid size-7 place-items-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ArrowRight className="size-3.5" />
      </Link>
    </div>
  )
}

function ProjectCard({ proj, busy, onRedeploy }: { proj: Project; busy: boolean; onRedeploy: (members: Project[]) => void }) {
  const status = proj.Status
  const sha = proj.LastCommitSHA ? proj.LastCommitSHA.slice(0, 7) : ""
  const source = proj.External ? proj.Image : proj.RepoURL.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "")
  const note = proj.External ? "External app · read-only" : sha ? "Last deployed commit" : "Never deployed"
  const when = proj.External ? "" : status === "idle" && !sha ? `created ${ago(proj.CreatedAt)}` : ago(proj.UpdatedAt)

  return (
    <Card className="relative gap-0 overflow-hidden py-0">
      {status === "building" && (
        <div aria-hidden className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-muted">
          <div className="h-full w-1/3 rounded-full bg-primary motion-safe:animate-pulse" />
        </div>
      )}
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <span className="grid size-[34px] shrink-0 place-items-center rounded-lg border bg-muted text-muted-foreground">
          {proj.External ? <Server className="size-4" /> : <FolderGit2 className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <Link
            href={`/projects/${proj.ID}`}
            className="flex items-center gap-1.5 rounded-sm text-[15px] font-semibold outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="truncate">{proj.Name}</span>
            {proj.External && <Badge variant="secondary" className="shrink-0 text-[11px]">Hosted on VPS</Badge>}
          </Link>
          <Truncate mono text={source ?? ""} className="mt-0.5 text-xs text-muted-foreground" />
        </div>
        <StatusPill status={status} />
      </div>
      <dl className="grid grid-cols-3 gap-2.5 px-4 pb-3.5">
        <Meta label="Branch">
          {proj.External ? "image" : <><GitBranch className="size-3 shrink-0" aria-hidden /><Truncate text={proj.Branch} /></>}
        </Meta>
        <Meta label="Domain">
          {proj.Domain ? (
            <Tooltip>
              <TooltipTrigger render={<a href={`https://${proj.Domain}`} target="_blank" rel="noopener noreferrer" className="truncate hover:underline" />}>
                {proj.Domain}<span className="sr-only"> (opens in a new tab)</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm break-all font-mono">{proj.Domain}</TooltipContent>
            </Tooltip>
          ) : "—"}
        </Meta>
        <Meta label="Build">
          <span className="truncate font-sans">{proj.External ? "External" : BUILD_LABEL[proj.BuildMethod] ?? proj.BuildMethod}</span>
        </Meta>
      </dl>
      {status === "failed" && (
        <p className="mx-4 mb-3 flex items-center gap-2 rounded-md bg-danger/10 px-2.5 py-2 text-xs">
          <CircleX className="size-3.5 shrink-0 text-danger" aria-hidden />
          The last deployment failed. Open the project to read its log.
        </p>
      )}
      {status === "building" && (
        <p className="mx-4 mb-3 flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
          Deployment in progress…
        </p>
      )}
      <CardFooter
        sha={sha}
        note={note}
        when={when}
        status={status}
        busy={busy}
        redeployLabel={proj.External ? null : `Redeploy ${proj.Name}`}
        onRedeploy={proj.External ? null : () => onRedeploy([proj])}
        href={`/projects/${proj.ID}`}
        openLabel={`Open ${proj.Name}`}
      />
    </Card>
  )
}

// A repo deployed in "separate" mode (one independent project per
// frontend/backend folder, see app/projects/new) renders as one wide card with
// a tile per service and a dashed "Add …" tile for the component not deployed yet.
function RepoGroup({ repoUrl, members, busy, onRedeploy }: {
  repoUrl: string; members: Project[]; busy: boolean; onRedeploy: (members: Project[]) => void
}) {
  const hasFrontend = members.some(m => m.BaseDir === "frontend")
  const hasBackend = members.some(m => m.BaseDir === "backend")
  const missing = !hasFrontend ? "frontend" : !hasBackend ? "backend" : null
  const branch = members[0]?.Branch ?? "main"
  const repoName = repoUrl.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "")
  const status = overall(members)
  const newest = members.reduce<Project | undefined>((a, m) => (!a || (m.UpdatedAt ?? "") > (a.UpdatedAt ?? "") ? m : a), undefined)
  const sha = newest?.LastCommitSHA ? newest.LastCommitSHA.slice(0, 7) : ""
  const sorted = [...members].sort((a, b) => (a.BaseDir === "frontend" ? -1 : b.BaseDir === "frontend" ? 1 : 0))

  return (
    <Card className="relative gap-0 overflow-hidden py-0">
      {status === "building" && (
        <div aria-hidden className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-muted">
          <div className="h-full w-1/3 rounded-full bg-primary motion-safe:animate-pulse" />
        </div>
      )}
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <span className="grid size-[34px] shrink-0 place-items-center rounded-lg border bg-muted text-muted-foreground">
          <Boxes className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">{repoName.split("/").pop() ?? repoName}</p>
          <Truncate mono text={repoName} className="mt-0.5 text-xs text-muted-foreground" />
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          Deployed separately · <span className="tabular-nums">{members.length}</span> of 2 services
        </span>
      </div>
      <div className="grid gap-2 px-4 pb-3.5 sm:grid-cols-2">
        {sorted.map(m => (
          <Link
            key={m.ID}
            href={`/projects/${m.ID}`}
            className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 outline-none transition-colors hover:border-input focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span className="flex items-center gap-2">
              <span className="flex-1 truncate text-[13px] font-semibold capitalize">{m.BaseDir || m.Name}</span>
              <StatusPill status={m.Status} />
            </span>
            <span className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs text-muted-foreground">
              <span>{m.BaseDir ? `${m.BaseDir}/` : "/"}</span>
              <span className="truncate">{m.Domain || "—"}</span>
              <span>{BUILD_LABEL[m.BuildMethod] ?? m.BuildMethod}</span>
            </span>
          </Link>
        ))}
        {missing && (
          <Link
            href={`/projects/new?repo=${encodeURIComponent(repoName)}&branch=${encodeURIComponent(branch)}&component=${missing}`}
            className="flex min-h-16 items-center justify-center gap-2 rounded-lg border border-dashed p-3 text-sm font-medium text-muted-foreground capitalize outline-none transition-colors hover:border-primary hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Plus className="size-4" />
            Add {missing}
          </Link>
        )}
      </div>
      <CardFooter
        sha={sha}
        note={sha ? "Last deployed commit" : "Never deployed"}
        when={ago(newest?.UpdatedAt)}
        status={status}
        busy={busy}
        redeployLabel={`Redeploy ${repoName}`}
        onRedeploy={() => onRedeploy(members)}
        href={`/projects/${sorted[0]?.ID ?? ""}`}
        openLabel={`Open ${repoName}`}
      />
    </Card>
  )
}

type Entry = { key: string; group: boolean; members: Project[]; status: string; text: string }

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(false)
  const [filter, setFilter]     = useState<Filter>("all")
  const [query, setQuery]       = useState("")
  const [redeploying, setRedeploying] = useState<Set<string>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const inFlight  = useRef(false)

  const fetchProjects = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const { data } = await nodeApi.get<unknown>("/api/projects")
      setProjects(Array.isArray(data) ? (data as Project[]) : [])
      setError(false)
    } catch { setError(true) }
    finally { inFlight.current = false; setLoading(false) }
  }, [])

  // Poll: quickly while something is building (so the card flips to Running/Failed), slowly otherwise.
  const anyBusy = projects.some(p => isBusy(p.Status))
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (!document.hidden) await fetchProjects()
      if (!stopped) timer = setTimeout(tick, anyBusy ? 3000 : 15000)
    }
    tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, [fetchProjects, anyBusy])

  // "/" focuses the search box (unless you are already typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  // Group projects that were deployed as separate frontend/backend components
  // of the same repo (BaseDir set) under one card; everything else is a plain card.
  const entries = useMemo<Entry[]>(() => {
    const seen = new Set<string>()
    const out: Entry[] = []
    for (const proj of projects) {
      if (proj.BaseDir) {
        const key = repoSlug(proj.RepoURL)
        if (seen.has(key)) continue
        seen.add(key)
        const members = projects.filter(p => p.BaseDir && repoSlug(p.RepoURL) === key)
        out.push({ key, group: true, members, status: overall(members), text: [key, ...members.map(m => m.Domain)].join(" ").toLowerCase() })
      } else {
        out.push({
          key: proj.ID, group: false, members: [proj], status: proj.Status,
          text: [proj.Name, proj.RepoURL, proj.Image ?? "", proj.Domain].join(" ").toLowerCase(),
        })
      }
    }
    return out
  }, [projects])

  const counts = useMemo(() => {
    const c = { all: entries.length, running: 0, building: 0, failed: 0, idle: 0 }
    for (const e of entries) {
      if (e.status === "running") c.running++
      else if (isBusy(e.status)) c.building++
      else if (e.status === "failed") c.failed++
      else if (e.status === "idle") c.idle++
    }
    return c
  }, [entries])

  const services = useMemo(() => projects.length, [projects])

  const q = query.trim().toLowerCase()
  const visible = entries.filter(e => {
    if (filter === "running" && e.status !== "running") return false
    if (filter === "building" && !isBusy(e.status)) return false
    if (filter === "failed" && e.status !== "failed") return false
    if (filter === "idle" && e.status !== "idle") return false
    return !q || e.text.includes(q)
  })

  const redeploy = async (members: Project[]) => {
    const targets = members.filter(m => !m.External && !isBusy(m.Status))
    if (targets.length === 0) return
    const ids = targets.map(m => m.ID)
    setRedeploying(prev => new Set([...prev, ...ids]))
    let ok = 0
    let lastErr = ""
    for (const m of targets) {
      try {
        await nodeApi.post(`/api/projects/${m.ID}/deploy`)
        ok++
      } catch (e) {
        // 409 = this project is already building; 503 = the queue is full or shutting down.
        const status = (e as ApiError).status
        lastErr = e instanceof Error ? e.message : "Redeploy failed"
        if (status === 503) break
      }
    }
    setRedeploying(prev => { const n = new Set(prev); ids.forEach(i => n.delete(i)); return n })
    if (ok > 0) toast.success(`Redeploy queued for ${members.length > 1 ? `${ok} services` : members[0].Name}`)
    if (lastErr) toast.error(lastErr)
    fetchProjects()
  }

  return (
    <>
      <PageHeader
        icon={FolderGit2}
        title="Projects"
        description={loading ? "Loading projects…" : (
          <>
            <span className="font-semibold text-foreground tabular-nums">{entries.length}</span> project{entries.length !== 1 ? "s" : ""} ·{" "}
            <span className="font-semibold text-foreground tabular-nums">{services}</span> service{services !== 1 ? "s" : ""} deployed from GitHub and images
          </>
        )}
        actions={
          <Button nativeButton={false} render={<Link href="/projects/new" />}>
            <Plus className="size-4" />
            New project
          </Button>
        }
      />
      <PageBody>
        {loading ? (
          <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
            {[0, 1, 2].map(i => <Skeleton key={i} className="h-44 rounded-xl" />)}
          </div>
        ) : error && projects.length === 0 ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load projects</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-3">
              The request to the PulseNode API failed.
              <Button variant="outline" size="sm" onClick={() => { setLoading(true); fetchProjects() }}>
                <RefreshCw className="size-3.5" />Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={FolderGit2}
            title="No projects yet"
            description="Deploy your first project from a GitHub repository."
            action={
              <Button nativeButton={false} render={<Link href="/projects/new" />}>
                <Plus className="size-4" />
                Deploy a project
              </Button>
            }
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2.5">
              <Segmented<Filter>
                aria-label="Filter by status"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "All", count: counts.all },
                  { value: "running", label: "Running", count: counts.running },
                  { value: "building", label: "Building", count: counts.building },
                  { value: "failed", label: "Failed", count: counts.failed },
                  { value: "idle", label: "Idle", count: counts.idle },
                ]}
                className="max-w-full flex-wrap"
              />
              <div className="relative ml-auto w-full sm:w-72">
                <SearchInput
                  ref={searchRef}
                  aria-label="Search projects"
                  placeholder="Search projects, repos, domains"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  className="max-w-none"
                />
                <kbd className="pointer-events-none absolute top-1/2 right-2 hidden h-[18px] min-w-[18px] -translate-y-1/2 items-center justify-center rounded border bg-muted px-1 font-mono text-[11px] text-muted-foreground sm:inline-flex">/</kbd>
              </div>
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertDescription>Could not refresh projects — showing the last loaded list.</AlertDescription>
              </Alert>
            )}

            {visible.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-12 text-center">
                <FolderGit2 className="size-5 text-muted-foreground" aria-hidden />
                <p className="text-sm font-semibold">No projects match this filter.</p>
                <Button variant="outline" size="sm" onClick={() => { setFilter("all"); setQuery("") }}>Clear filter</Button>
              </div>
            ) : (
              <section aria-label="Project list" className="grid items-start gap-3.5 md:grid-cols-2 xl:grid-cols-3">
                {visible.map(e => (
                  <div key={e.key} className={cn(e.group && "md:col-span-2 xl:col-span-3")}>
                    {e.group ? (
                      <RepoGroup
                        repoUrl={e.members[0].RepoURL}
                        members={e.members}
                        busy={e.members.some(m => redeploying.has(m.ID))}
                        onRedeploy={redeploy}
                      />
                    ) : (
                      <ProjectCard proj={e.members[0]} busy={redeploying.has(e.members[0].ID)} onRedeploy={redeploy} />
                    )}
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </PageBody>
    </>
  )
}
