"use client"

import { useState, useEffect } from "react"
import { AlertTriangle, Box, Boxes, Database, Rocket, Server } from "lucide-react"
import { nodeApi } from "@/lib/api"
import type { CoolifyProject, CoolifyDeployment } from "@/lib/types"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { StatCard } from "@/components/dashboard/StatCard"
import { Pill } from "@/components/dashboard/Pill"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion"

/* Engine colour for Coolify databases (brand vars) */
const ENGINE_TONE: Record<string, string> = {
  postgres: "var(--db-postgres)",
  redis:    "var(--db-redis)",
  mysql:    "var(--db-mysql)",
}

function EnginePill({ engine }: { engine: string }) {
  const color = ENGINE_TONE[engine] ?? "var(--db-other)"
  return (
    <span
      className="inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold"
      style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color: `color-mix(in srgb, ${color} 70%, var(--foreground))` }}
    >
      {engine}
    </span>
  )
}

function statusTone(s: string): "ok" | "bad" | "warn" {
  if (s === "running")  return "ok"
  if (s === "stopped")  return "bad"
  return "warn"
}

function DeployStatus({ status }: { status: string }) {
  if (status === "success") return <Pill tone="ok" dot>success</Pill>
  if (status === "failed")  return <Pill tone="bad" dot>failed</Pill>
  return <Pill tone="warn" dot>running</Pill>
}

function SubHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <Badge variant="secondary" className="font-mono tabular-nums">{count}</Badge>
    </div>
  )
}

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>
)

export default function CoolifyPage() {
  const [projects,     setProjects]     = useState<CoolifyProject[]>([])
  const [deployments,  setDeployments]  = useState<CoolifyDeployment[]>([])
  const [live, setLive] = useState({ projects: false, deployments: false })
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    const p = nodeApi.get<CoolifyProject[]>("/api/coolify/projects")
      .then(({ data }) => { setProjects(data); setLive(l => ({ ...l, projects: true })) })
      .catch(() => {})
    const d = nodeApi.get<CoolifyDeployment[]>("/api/coolify/deployments")
      .then(({ data }) => { setDeployments(data); setLive(l => ({ ...l, deployments: true })) })
      .catch(() => {})
    Promise.all([p, d]).finally(() => setSettled(true))
  }, [])

  const loadFailed = settled && !(live.projects && live.deployments)

  const totalApps = projects.reduce((s, p) => s + p.apps.length, 0)
  const totalDbs  = projects.reduce((s, p) => s + p.databases.length, 0)
  const runningServices = projects.reduce(
    (s, p) => s + p.services.filter(sv => sv.status === "running").length, 0
  )

  return (
    <>
      <PageHeader
        icon={Boxes}
        title={<span className="flex items-center gap-2">Coolify <Badge variant="secondary" className="uppercase tracking-wider">Labels</Badge></span>}
        description="Self-hosted deployment platform, detected from Docker labels."
      />
      <PageBody>
        {loadFailed && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Could not load Coolify data</AlertTitle>
            <AlertDescription>
              The Coolify API did not respond{!live.projects && !live.deployments ? "" : " for part of the data"}, so the figures below may be incomplete.
            </AlertDescription>
          </Alert>
        )}

        {!settled ? (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}
            </div>
            <Skeleton className="h-40 rounded-xl" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Total Apps"        value={totalApps}          tone="acc"  icon={Box} />
              <StatCard label="Running Services"  value={runningServices}    tone="ok"   icon={Server} />
              <StatCard label="Managed Databases" value={totalDbs}           tone="info" icon={Database} />
              <StatCard label="Deployments"       value={deployments.length} tone="acc"  icon={Rocket} />
            </div>

            <Accordion multiple defaultValue={projects.map(p => p.id)} className="space-y-3">
              {projects.map(project => (
                <Card key={project.id} className="gap-0 overflow-hidden py-0">
                  <AccordionItem value={project.id} className="border-0">
                    <AccordionTrigger className="px-4 py-3 hover:no-underline">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-sm font-semibold">{project.name}</span>
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                          <Badge variant="secondary">{project.apps.length} apps</Badge>
                          <Badge variant="secondary">{project.databases.length} dbs</Badge>
                          <Badge variant="secondary">{project.services.length} services</Badge>
                        </span>
                      </div>
                    </AccordionTrigger>

                    <AccordionContent className="space-y-6 border-t px-4 pt-4 pb-4">
                      {project.apps.length > 0 && (
                        <div>
                          <SubHeader title="Applications" count={project.apps.length} />
                          <div className="overflow-x-auto rounded-lg border">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Name</TableHead><TableHead>Domains</TableHead><TableHead>Status</TableHead>
                                  <TableHead>Last Deployed</TableHead><TableHead>Branch</TableHead><TableHead>Container</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {project.apps.map(app => (
                                  <TableRow key={app.id}>
                                    <TableCell className="font-medium">{app.name}</TableCell>
                                    <TableCell>
                                      <div className="flex flex-wrap gap-1">{app.domains.map(d => <Code key={d}>{d}</Code>)}</div>
                                    </TableCell>
                                    <TableCell><Pill tone={statusTone(app.status)} dot>{app.status}</Pill></TableCell>
                                    <TableCell className="text-muted-foreground">{app.lastDeployed}</TableCell>
                                    <TableCell><Code>{app.branch}</Code></TableCell>
                                    <TableCell className="font-mono text-xs text-muted-foreground">{app.containerName}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </div>
                      )}

                      {project.databases.length > 0 && (
                        <div>
                          <SubHeader title="Databases" count={project.databases.length} />
                          <div className="overflow-x-auto rounded-lg border">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Name</TableHead><TableHead>Engine</TableHead><TableHead>Status</TableHead>
                                  <TableHead className="text-right">Size</TableHead><TableHead className="text-right">Connections</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {project.databases.map(db => (
                                  <TableRow key={db.id}>
                                    <TableCell className="font-medium">{db.name}</TableCell>
                                    <TableCell><EnginePill engine={db.engine} /></TableCell>
                                    <TableCell><Pill tone={statusTone(db.status)} dot>{db.status}</Pill></TableCell>
                                    <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{db.size}</TableCell>
                                    <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{db.conns}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </div>
                      )}

                      {project.services.length > 0 && (
                        <div>
                          <SubHeader title="Services" count={project.services.length} />
                          <div className="overflow-x-auto rounded-lg border">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Status</TableHead><TableHead>Ports</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {project.services.map(svc => (
                                  <TableRow key={svc.id}>
                                    <TableCell className="font-medium">{svc.name}</TableCell>
                                    <TableCell className="text-muted-foreground">{svc.type}</TableCell>
                                    <TableCell><Pill tone={statusTone(svc.status)} dot>{svc.status}</Pill></TableCell>
                                    <TableCell>
                                      {svc.ports.length > 0
                                        ? <div className="flex flex-wrap gap-1">{svc.ports.map(p => <Code key={p}>{p}</Code>)}</div>
                                        : <span className="text-muted-foreground">—</span>}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </div>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                </Card>
              ))}
            </Accordion>

            <Card className="gap-0 overflow-hidden py-0">
              <CardHeader className="flex-row items-center gap-2 border-b py-4">
                <CardTitle>Recent Deployments</CardTitle>
                <Badge variant="secondary" className="font-mono tabular-nums">{deployments.length}</Badge>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>App Name</TableHead><TableHead>Branch</TableHead><TableHead>Status</TableHead>
                      <TableHead className="text-right">Duration</TableHead><TableHead>Triggered By</TableHead><TableHead>Timestamp</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deployments.map(dep => (
                      <TableRow key={dep.id}>
                        <TableCell className="font-medium">{dep.appName}</TableCell>
                        <TableCell><Code>{dep.branch}</Code></TableCell>
                        <TableCell><DeployStatus status={dep.status} /></TableCell>
                        <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{dep.duration}</TableCell>
                        <TableCell className="text-muted-foreground">{dep.triggeredBy}</TableCell>
                        <TableCell className="text-muted-foreground tabular-nums">{dep.timestamp}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
