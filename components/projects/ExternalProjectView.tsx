"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Box, Play, RotateCw, Server, Square } from "lucide-react"
import { toast } from "sonner"
import { API_BASE, nodeApi } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { Truncate } from "@/components/pn/Truncate"
import { LogPane, type LogEntry } from "@/components/projects/LogPane"
import { BackLink, DomainLink, StatusPill, type Project } from "@/components/projects/project-ui"
import { cn } from "@/lib/utils"

// Read-only(ish) detail view for an app already hosted on the VPS behind a
// domain but not deployed through PulseNode (discovered from a running
// container, not the projects table — see backend discoverExternalProjects).
// No settings/redeploy/rollback, since there's no repo or build config for
// it here; container start/stop/restart and logs reuse the generic docker
// endpoints the Containers page uses.
export function ExternalProjectView({ project }: { project: Project }) {
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

  // The last 300 lines, refreshed every 2.5s while the tab is visible.
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
      const r = await fetch(`${API_BASE}/api/docker/${action}/${containerID}`, { method: "POST" })
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
            <span className="text-sm font-normal text-muted-foreground">External · read-only</span>
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
        <p className="text-ui text-muted-foreground">
          Hosted on this VPS behind a domain, but not deployed through PulseNode — read-only details, pulled live from Docker.
        </p>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border shadow-card lg:grid-cols-4">
          {info.map(row => (
            <div key={row.label} className="min-w-0 bg-card px-4 py-3">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="mt-1 flex items-center gap-1 text-ui">
                {row.label === "Container" && <Box className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
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
