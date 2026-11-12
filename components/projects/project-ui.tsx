"use client"

import Link from "next/link"
import { ChevronLeft, ExternalLink } from "lucide-react"
import { toast } from "sonner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Pill } from "@/components/dashboard/Pill"
import { cn } from "@/lib/utils"

export type Project = {
  ID: string; Name: string; RepoURL: string; Branch: string
  Domain: string; Status: string; BuildMethod: string; Port: number
  BuildCommand: string; EnvVars: string; BackendEnvVars: string; BaseDir: string; CreatedAt: string
  AutoDeploy: boolean; LastCommitSHA: string
  // Set for apps already hosted on the VPS (behind a domain) that weren't
  // deployed through PulseNode — see ExternalProjectView.
  External?: boolean; Image?: string; Ports?: string; ContainerID?: string
}

export type Deployment = {
  ID: string; Status: string; Trigger: string
  CommitSHA: string; CommitMsg: string; ImageTag: string
  StartedAt: string | null; FinishedAt: string | null; CreatedAt: string
}

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "outline"> = {
  running: "ok", success: "ok", building: "info", queued: "info",
  failed: "bad", idle: "outline", exited: "outline",
}

export const isBusyStatus = (s: string) => s === "building" || s === "queued"

export function StatusPill({ status }: { status: string }) {
  return (
    <Pill tone={STATUS_TONE[status] ?? "outline"} dot className="capitalize">
      {status || "unknown"}
    </Pill>
  )
}

export function DomainLink({ domain }: { domain: string }) {
  if (!domain) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={`https://${domain}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 max-w-[16rem] items-center gap-1 rounded-sm font-mono text-xs text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
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

export function BackLink() {
  return (
    <Link href="/projects" className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
      <ChevronLeft className="size-3.5" aria-hidden /> Projects
    </Link>
  )
}

export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch { toast.error("Could not copy — clipboard unavailable") }
}

export function age(ts: string) {
  const d = Date.now() - new Date(ts).getTime()
  if (d < 60_000) return "just now"
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`
  const days = Math.floor(d / 86_400_000)
  return days === 1 ? "yesterday" : `${days} days ago`
}

export function fmtSeconds(s: number): string {
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}

export function duration(dep: Deployment): string {
  if (!dep.StartedAt) return ""
  const end = dep.FinishedAt ? new Date(dep.FinishedAt).getTime() : Date.now()
  return fmtSeconds(Math.max(0, Math.round((end - new Date(dep.StartedAt).getTime()) / 1000)))
}

/** Settings-column card: title row over a hairline, then content. */
export function Panel({ title, description, aside, children, className }: {
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
