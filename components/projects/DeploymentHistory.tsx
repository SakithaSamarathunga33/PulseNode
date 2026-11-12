"use client"

import { CircleCheck, CircleX, Clock, History, Loader2, RotateCcw, ScrollText, User, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/pn/EmptyState"
import { Truncate } from "@/components/pn/Truncate"
import { Pill } from "@/components/dashboard/Pill"
import { DeployDurationChart } from "@/components/projects/DeployDurationChart"
import { age, duration, isBusyStatus, type Deployment } from "@/components/projects/project-ui"
import { cn } from "@/lib/utils"

/** Deployment list (newest first) with a build-duration chart on top; rollback needs a stored ImageTag. */
export function DeploymentHistory({ deployments, rolling, onViewLogs, onRollback }: {
  deployments: Deployment[]
  rolling: string | null
  onViewLogs: (id: string) => void
  onRollback: (dep: Deployment) => void
}) {
  if (deployments.length === 0) {
    return <EmptyState icon={History} title="No deployments yet" description="Deployments appear here after the first deploy." />
  }
  const currentDep = deployments.find(d => d.Status === "success")

  return (
    <div className="space-y-3">
      <DeployDurationChart deployments={deployments} />
      <ol aria-label="Deployments" className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
        {deployments.map(dep => {
          const ok = dep.Status === "success"
          const failed = dep.Status === "failed"
          const live = isBusyStatus(dep.Status)
          const isCurrent = currentDep?.ID === dep.ID
          const sha = dep.CommitSHA ? dep.CommitSHA.slice(0, 7) : ""
          const canRollback = ok && !isCurrent && Boolean(dep.ImageTag)
          const dur = duration(dep)
          const trigger = dep.Trigger || "manual"
          return (
            <li
              key={dep.ID}
              className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
            >
              <span className={cn("mt-0.5 sm:mt-0", ok ? "text-success" : failed ? "text-danger" : "text-info")}>
                {ok ? <CircleCheck className="size-4" aria-hidden /> : failed ? <CircleX className="size-4" aria-hidden /> : <Loader2 className="size-4 animate-spin" aria-hidden />}
              </span>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("text-ui font-semibold", ok ? "text-success" : failed ? "text-danger" : "text-info")}>
                    {ok ? "Succeeded" : failed ? "Failed" : dep.Status === "queued" ? "Queued" : "Building"}
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground capitalize">
                    {trigger === "auto" ? <Zap className="size-3" aria-hidden /> : trigger === "rollback" ? <RotateCcw className="size-3" aria-hidden /> : <User className="size-3" aria-hidden />}
                    {trigger}
                  </span>
                  {isCurrent && <Pill tone="acc">Current</Pill>}
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                    <Clock className="size-3" aria-hidden />{age(dep.CreatedAt)}{dur && ` · ${dur}`}
                  </span>
                </div>
                <div className="flex min-w-0 items-baseline gap-2 text-ui">
                  {sha && <span className="shrink-0 font-mono text-xs text-foreground">{sha}</span>}
                  <Truncate text={dep.CommitMsg || (live ? "Deployment in progress" : "")} className="text-muted-foreground" />
                </div>
              </div>
              <div className="col-span-2 flex flex-wrap items-center gap-2 pl-7 sm:col-span-1 sm:justify-end sm:pl-0">
                <Button variant="ghost" size="sm" onClick={() => onViewLogs(dep.ID)}>
                  <ScrollText className="size-3.5" />View logs
                </Button>
                {canRollback && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={rolling !== null}
                    title="Redeploy this build's image (zero-downtime)"
                    onClick={() => onRollback(dep)}
                  >
                    <RotateCcw className={cn("size-3.5", rolling === dep.ID && "animate-spin")} />
                    {rolling === dep.ID ? "Rolling…" : `Rollback to ${sha || dep.ID.slice(0, 7)}`}
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
