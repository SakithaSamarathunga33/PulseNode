"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Plus, RefreshCw, FolderGit2, GitBranch, Globe, Circle, PlayCircle, ChevronDown, ChevronRight, Boxes, Server } from "lucide-react"

const GO_API = process.env.NEXT_PUBLIC_GO_API ?? ""

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

const STATUS_COLORS: Record<string, string> = {
  running:  "var(--ok)",
  building: "var(--acc)",
  failed:   "var(--err)",
  idle:     "var(--fg-4)",
}

// Normalizes a repo URL to owner/repo so projects deployed separately from the
// same repo (one for frontend/, one for backend/) can be grouped together.
function repoSlug(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").toLowerCase()
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-full capitalize"
      style={{
        background: (STATUS_COLORS[status] ?? "var(--fg-4)") + "20",
        color: STATUS_COLORS[status] ?? "var(--fg-4)",
      }}
    >
      <Circle size={6} fill="currentColor" />
      {status}
    </span>
  )
}

function ProjectCard({ proj, compact }: { proj: Project; compact?: boolean }) {
  return (
    <Link
      href={`/projects/${proj.ID}`}
      className="block rounded-xl p-4 transition-colors hover:opacity-90"
      style={{ background: compact ? "var(--bg-1)" : "var(--bg-2)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "var(--bg-3)" }}>
            {proj.External
              ? <Server size={16} style={{ color: "var(--acc)" }} />
              : <FolderGit2 size={16} style={{ color: "var(--acc)" }} />}
          </div>
          <div className="min-w-0">
            <p className="font-medium text-sm flex items-center gap-1.5" style={{ color: "var(--fg)" }}>
              {proj.Name}
              {proj.External && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                  style={{ background: "var(--bg-3)", color: "var(--fg-3)" }}
                >
                  Hosted on VPS
                </span>
              )}
              {proj.BaseDir && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-medium capitalize"
                  style={{ background: "var(--bg-3)", color: "var(--fg-3)" }}
                >
                  {proj.BaseDir}
                </span>
              )}
            </p>
            <p className="text-xs truncate mt-0.5" style={{ color: "var(--fg-3)" }}>
              {proj.External ? proj.Image : proj.RepoURL.replace("https://github.com/", "")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={proj.Status} />
        </div>
      </div>
      <div className="flex items-center gap-4 mt-3 text-xs" style={{ color: "var(--fg-3)" }}>
        {!proj.External && (
          <span className="flex items-center gap-1">
            <GitBranch size={11} />
            {proj.Branch}
          </span>
        )}
        <span className="flex items-center gap-1">
          <Globe size={11} />
          {proj.Domain}
        </span>
        {!proj.External && (
          <span className="flex items-center gap-1 ml-auto">
            <PlayCircle size={11} />
            {proj.BuildMethod}
          </span>
        )}
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
    <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between gap-4 p-4 text-left transition-colors hover:opacity-90"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "var(--bg-3)" }}>
            <Boxes size={16} style={{ color: "var(--acc)" }} />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-sm" style={{ color: "var(--fg)" }}>{repoName}</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--fg-3)" }}>
              Deployed separately · {members.length} of 2 services
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {members.map(m => <StatusBadge key={m.ID} status={m.Status} />)}
          {expanded ? <ChevronDown size={16} style={{ color: "var(--fg-3)" }} /> : <ChevronRight size={16} style={{ color: "var(--fg-3)" }} />}
        </div>
      </button>

      {expanded && (
        <div className="p-3 pt-0 space-y-2">
          {members.map(m => <ProjectCard key={m.ID} proj={m} compact />)}
          {missing && (
            <Link
              href={`/projects/new?repo=${encodeURIComponent(repoName)}&branch=${encodeURIComponent(branch)}&component=${missing}`}
              className="flex items-center justify-center gap-2 rounded-xl p-3 text-sm font-medium capitalize transition-colors hover:opacity-90"
              style={{ background: "var(--bg-1)", border: "1px dashed var(--border)", color: "var(--acc)" }}
            >
              <Plus size={14} />
              Add {missing}
            </Link>
          )}
        </div>
      )}
    </div>
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw size={20} className="animate-spin" style={{ color: "var(--fg-3)" }} />
      </div>
    )
  }

  // Group projects that were deployed as separate frontend/backend components
  // of the same repo (BaseDir set) under one expandable card; everything else
  // renders as a plain card, unchanged from before.
  const renderedGroups = new Set<string>()
  const items: { key: string; node: React.ReactNode }[] = []
  for (const proj of projects) {
    if (proj.BaseDir) {
      const key = repoSlug(proj.RepoURL)
      if (renderedGroups.has(key)) continue
      renderedGroups.add(key)
      const members = projects.filter(p => p.BaseDir && repoSlug(p.RepoURL) === key)
      items.push({ key, node: <RepoGroup repoUrl={proj.RepoURL} members={members} /> })
    } else {
      items.push({ key: proj.ID, node: <ProjectCard proj={proj} /> })
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: "var(--fg)" }}>Projects</h1>
          <p className="text-sm mt-0.5" style={{ color: "var(--fg-3)" }}>
            {projects.length} project{projects.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Link
          href="/projects/new"
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          style={{ background: "var(--acc)", color: "#fff" }}
        >
          <Plus size={14} />
          New Project
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4 rounded-xl"
          style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
          <FolderGit2 size={40} style={{ color: "var(--fg-4)" }} />
          <div className="text-center">
            <p className="font-medium text-sm" style={{ color: "var(--fg)" }}>No projects yet</p>
            <p className="text-sm mt-1" style={{ color: "var(--fg-3)" }}>
              Deploy your first project from a GitHub repository.
            </p>
          </div>
          <Link
            href="/projects/new"
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium"
            style={{ background: "var(--acc)", color: "#fff" }}
          >
            <Plus size={14} />
            Deploy a project
          </Link>
        </div>
      ) : (
        <div className="grid gap-3">
          {items.map(item => <div key={item.key}>{item.node}</div>)}
        </div>
      )}
    </div>
  )
}
