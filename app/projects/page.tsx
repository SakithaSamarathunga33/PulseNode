"use client"

import { API_BASE } from "@/lib/api"
import { useState, useEffect } from "react"
import Link from "next/link"
import {
  Plus, FolderGit2, GitBranch, Globe, Hammer, ChevronDown, Boxes, Server,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { EmptyState } from "@/components/pn/EmptyState"
import { Pill } from "@/components/dashboard/Pill"
import { cn } from "@/lib/utils"

const GO_API = API_BASE

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
  // Set for apps already hosted on the VPS (behind a domain) that weren't
  // deployed through PulseNode — discovered from running containers rather
  // than the projects table, so RepoURL/Branch/BuildMethod are "".
  External?: boolean
  Image?: string
}

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "outline"> = {
  running: "ok",
  building: "info",
  failed: "bad",
  idle: "outline",
}

// Normalizes a repo URL to owner/repo so projects deployed separately from the
// same repo (one for frontend/, one for backend/) can be grouped together.
function repoSlug(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").toLowerCase()
}

function StatusPill({ status }: { status: string }) {
  return (
    <Pill tone={STATUS_TONE[status] ?? "outline"} dot className="capitalize">
      {status || "unknown"}
    </Pill>
  )
}

function Chip({ icon: Icon, children, className }: { icon: typeof Globe; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground", className)}>
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate font-mono">{children}</span>
    </span>
  )
}

function ProjectCard({ proj, compact }: { proj: Project; compact?: boolean }) {
  return (
    <Link
      href={`/projects/${proj.ID}`}
      className={cn(
        "group block rounded-xl border p-4 outline-none transition-colors hover:border-[color-mix(in_srgb,var(--hue)_45%,var(--border))] focus-visible:ring-3 focus-visible:ring-ring/50",
        compact ? "bg-background" : "bg-card shadow-card",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[color-mix(in_srgb,var(--hue)_14%,transparent)] text-[var(--hue)]">
            {proj.External ? <Server className="size-4" /> : <FolderGit2 className="size-4" />}
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
              <span className="truncate">{proj.Name}</span>
              {proj.External && <Badge variant="secondary" className="text-[11px]">Hosted on VPS</Badge>}
              {proj.BaseDir && <Badge variant="secondary" className="text-[11px] capitalize">{proj.BaseDir}</Badge>}
            </p>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              {proj.External ? proj.Image : proj.RepoURL.replace("https://github.com/", "")}
            </p>
          </div>
        </div>
        <StatusPill status={proj.Status} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        {!proj.External && <Chip icon={GitBranch}>{proj.Branch}</Chip>}
        <Chip icon={Globe}>{proj.Domain}</Chip>
        {!proj.External && <Chip icon={Hammer} className="sm:ml-auto">{proj.BuildMethod}</Chip>}
      </div>
    </Link>
  )
}

// A repo deployed in "separate" mode (one independent project per
// frontend/backend folder, see app/projects/new) renders here instead of as a
// plain card: grouped under the repo name, expandable, with a "+ Add …" action
// for whichever component hasn't been deployed yet.
function RepoGroup({ repoUrl, members }: { repoUrl: string; members: Project[] }) {
  const [expanded, setExpanded] = useState(true)
  const hasFrontend = members.some(m => m.BaseDir === "frontend")
  const hasBackend = members.some(m => m.BaseDir === "backend")
  const missing = !hasFrontend ? "frontend" : !hasBackend ? "backend" : null
  const branch = members[0]?.Branch ?? "main"
  const repoName = repoUrl.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "")

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(e => !e)}
        className="flex w-full items-center justify-between gap-3 p-4 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[color-mix(in_srgb,var(--hue)_14%,transparent)] text-[var(--hue)]">
            <Boxes className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate font-mono text-sm font-medium">{repoName}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Deployed separately · <span className="tabular-nums">{members.length}</span> of 2 services
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {members.map(m => <StatusPill key={m.ID} status={m.Status} />)}
          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", !expanded && "-rotate-90")} />
        </div>
      </button>

      {expanded && (
        <div className="space-y-2 border-t bg-muted/30 p-3">
          {members.map(m => <ProjectCard key={m.ID} proj={m} compact />)}
          {missing && (
            <Link
              href={`/projects/new?repo=${encodeURIComponent(repoName)}&branch=${encodeURIComponent(branch)}&component=${missing}`}
              className="flex items-center justify-center gap-2 rounded-xl border border-dashed p-3 text-sm font-medium capitalize text-[var(--hue-fg)] outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--hue)_8%,transparent)] focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <Plus className="size-4" />
              Add {missing}
            </Link>
          )}
        </div>
      )}
    </Card>
  )
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading]   = useState(true)

  const fetchProjects = async () => {
    try {
      const r = await fetch(`${GO_API}/api/projects`)
      if (r.ok) setProjects(await r.json())
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  useEffect(() => { fetchProjects() }, [])

  // Group projects that were deployed as separate frontend/backend components
  // of the same repo (BaseDir set) under one expandable card; everything else
  // renders as a plain card, unchanged from before.
  const renderedGroups = new Set<string>()
  const items: { key: string; group: boolean; node: React.ReactNode }[] = []
  for (const proj of projects) {
    if (proj.BaseDir) {
      const key = repoSlug(proj.RepoURL)
      if (renderedGroups.has(key)) continue
      renderedGroups.add(key)
      const members = projects.filter(p => p.BaseDir && repoSlug(p.RepoURL) === key)
      items.push({ key, group: true, node: <RepoGroup repoUrl={proj.RepoURL} members={members} /> })
    } else {
      items.push({ key: proj.ID, group: false, node: <ProjectCard proj={proj} /> })
    }
  }

  return (
    <>
      <PageHeader
        icon={FolderGit2}
        title="Projects"
        description={loading ? "Loading projects…" : <><span className="tabular-nums">{projects.length}</span> project{projects.length !== 1 ? "s" : ""}</>}
        actions={
          <Button nativeButton={false} render={<Link href="/projects/new" />}>
            <Plus className="size-4" />
            New project
          </Button>
        }
      />
      <PageBody>
        {loading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
            {[0, 1, 2].map(i => <Skeleton key={i} className="h-28 rounded-xl" />)}
          </div>
        ) : projects.length === 0 ? (
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
          <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map(item => (
              <div key={item.key} className={cn(item.group && "md:col-span-2 xl:col-span-2")}>{item.node}</div>
            ))}
          </div>
        )}
      </PageBody>
    </>
  )
}
