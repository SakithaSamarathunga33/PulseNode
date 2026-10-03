"use client"

import { useState, useMemo, useEffect, useCallback } from "react"
import { toast } from "sonner"
import {
  Activity, ArrowDown, ArrowUp, ArrowUpDown, Ban, CheckCircle2, Cpu, PlayCircle, ShieldAlert, ShieldCheck, X,
} from "lucide-react"
import { PROCESSES as MOCK_PROCESSES } from "@/lib/mock-data"
import { nodeApi, pythonApi } from "@/lib/api"
import type { Process } from "@/lib/types"
import { Pill } from "@/components/dashboard/Pill"
import { ProgressBar } from "@/components/dashboard/ProgressBar"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { SearchInput } from "@/components/pn/SearchInput"
import { Segmented } from "@/components/pn/Segmented"
import { EmptyState } from "@/components/pn/EmptyState"
import { LiveBadge } from "@/components/pn/LiveBadge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { detectSuspicious } from "@/components/processes/detect"
import { ProcessActions, ProcessConfirm, RiskPill, procName, type DialogState, type Risk } from "@/components/processes/parts"

type Tab = "processes" | "suspicious"
type SortKey = "cpu" | "mem" | "pid"

// ── Python process mapper ──────────────────────────────────────────────────────

type PyProcess = {
  pid: number; name: string; cpu: number; mem_mb: number
  status: string; user: string; cmd: string; type: string
}

function mapPyProcess(p: PyProcess): Process {
  return {
    pid:   p.pid,
    user:  p.user,
    cpu:   p.cpu,
    mem:   p.mem_mb,
    virt:  "—",
    res:   `${p.mem_mb} MB`,
    cmd:   p.cmd || p.name,
    state: p.status === "running" ? "R" : "S",
    time:  "—",
    type:  "system" as const,
    name:  p.name,
    memMb: p.mem_mb,
  }
}

function CountBadge({ n, tone }: { n: number; tone?: "bad" }) {
  return (
    <span className={`rounded-full px-1.5 font-mono text-[11px] tabular-nums ${tone === "bad" ? "bg-danger/12 text-danger" : "bg-muted text-muted-foreground"}`}>
      {n}
    </span>
  )
}

function CommandCell({ proc, max = "max-w-[320px]" }: { proc: Process; max?: string }) {
  return (
    <div className="flex items-center gap-2">
      {proc.type === "pm2" && <Pill tone="acc" className="shrink-0">PM2</Pill>}
      <div className="min-w-0">
        <p className={`truncate text-sm font-medium ${max}`}>{procName(proc)}</p>
        <p className={`truncate font-mono text-xs text-muted-foreground ${max}`} title={proc.cmd}>{proc.cmd}</p>
      </div>
    </div>
  )
}

function UsageCell({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <ProgressBar value={pct} tone="info" className="w-14 shrink-0" />
      <span className="font-mono text-xs tabular-nums">{label}</span>
    </div>
  )
}

function SortHead({ k, label, className, sortKey, sortDir, onSort }: {
  k: SortKey; label: string; className?: string; sortKey: SortKey; sortDir: "asc" | "desc"; onSort: (k: SortKey) => void
}) {
  const active = sortKey === k
  const Icon = !active ? ArrowUpDown : sortDir === "desc" ? ArrowDown : ArrowUp
  return (
    <TableHead className={className} aria-sort={active ? (sortDir === "desc" ? "descending" : "ascending") : "none"}>
      <button
        onClick={() => onSort(k)}
        className="inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {label}
        <Icon className={`size-3 ${active ? "" : "text-muted-foreground"}`} />
      </button>
    </TableHead>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ProcessesPage() {
  const [activeTab,  setActiveTab]   = useState<Tab>("processes")
  const [search,     setSearch]      = useState("")
  const [sortKey,    setSortKey]     = useState<SortKey>("cpu")
  const [sortDir,    setSortDir]     = useState<"asc" | "desc">("desc")
  const [processes,   setProcesses]   = useState<Process[]>(MOCK_PROCESSES)
  const [cpuCores,    setCpuCores]    = useState<number[]>([])
  const [dialog,     setDialog]      = useState<DialogState>(null)
  const [blocked,    setBlocked]     = useState<Process[]>([])
  const [released,   setReleased]    = useState<Set<number>>(new Set())

  useEffect(() => {
    function fetchProcesses() {
      pythonApi.get<PyProcess[]>("/metrics/processes")
        .then(({ data }) => {
          if (data.length >= 5) setProcesses(data.map(mapPyProcess))
          else return nodeApi.get<Process[]>("/api/pm2/list")
            .then(({ data: pm2 }) => { if (pm2.length) setProcesses(pm2) })
        })
        .catch(() => {
          nodeApi.get<Process[]>("/api/pm2/list")
            .then(({ data }) => { if (data.length) setProcesses(data) })
            .catch(() => {})
        })
    }

    function fetchCores() {
      pythonApi.get<{ cpuCores?: number[] }>("/metrics/live")
        .then(({ data }) => { if (data.cpuCores?.length) setCpuCores(data.cpuCores) })
        .catch(() => {})
    }

    fetchProcesses()
    fetchCores()
    const t1 = setInterval(() => { if (!document.hidden) fetchProcesses() }, 5000)
    const t2 = setInterval(() => { if (!document.hidden) fetchCores() }, 5000)
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [])

  // ── Actions ──────────────────────────────────────────────────────────────────

  const handleKill = useCallback((proc: Process) => {
    nodeApi.post(`/api/processes/kill/${proc.pid}`)
      .then(() => {
        setProcesses(prev => prev.filter(p => p.pid !== proc.pid))
        setBlocked(prev => prev.filter(p => p.pid !== proc.pid))
        toast.success(`Killed ${proc.name || proc.cmd} (PID ${proc.pid})`)
      })
      .catch(err => toast.error(`Kill failed: ${(err as Error).message}`))
  }, [])

  const handleSuspend = useCallback((proc: Process) => {
    nodeApi.post(`/api/processes/suspend/${proc.pid}`)
      .then(() => {
        setBlocked(prev => prev.find(p => p.pid === proc.pid) ? prev : [...prev, { ...proc, state: "T" }])
        toast.success(`Suspended ${proc.name || proc.cmd} (PID ${proc.pid})`)
      })
      .catch(err => toast.error(`Suspend failed: ${(err as Error).message}`))
  }, [])

  const handleResume = useCallback((proc: Process) => {
    nodeApi.post(`/api/processes/resume/${proc.pid}`)
      .then(() => {
        setBlocked(prev => prev.filter(p => p.pid !== proc.pid))
        toast.success(`Resumed ${proc.name || proc.cmd} (PID ${proc.pid})`)
      })
      .catch(err => toast.error(`Resume failed: ${(err as Error).message}`))
  }, [])

  // ── Sorting / filtering ───────────────────────────────────────────────────────

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "desc" ? "asc" : "desc")
    else { setSortKey(key); setSortDir("desc") }
  }

  const blockedPids = useMemo(() => new Set(blocked.map(p => p.pid)), [blocked])

  const sorted = useMemo(() => {
    const q = search.toLowerCase()
    const list = processes
      .filter(p => !blockedPids.has(p.pid))
      .filter(p => !q || p.cmd.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) || String(p.pid).includes(q))
    list.sort((a, b) => {
      const av = a[sortKey as keyof typeof a] as number
      const bv = b[sortKey as keyof typeof b] as number
      return sortDir === "desc" ? bv - av : av - bv
    })
    return list
  }, [search, sortKey, sortDir, processes, blockedPids])

  // ── Suspicious detection ──────────────────────────────────────────────────────

  const suspicious = useMemo(() =>
    processes
      .filter(p => !released.has(p.pid) && !blockedPids.has(p.pid))
      .map(p => ({ proc: p, result: detectSuspicious(p) }))
      .filter(({ result }) => result.suspicious)
      .sort((a, b) => {
        const order = { critical: 0, high: 1, medium: 2 }
        return order[a.result.risk] - order[b.result.risk]
      }),
  [processes, released, blockedPids])

  const requestAction = (type: "kill" | "suspend", proc: Process) => setDialog({ type, proc })

  const riskCounts = (["critical", "high", "medium"] as Risk[])
    .map(r => ({ r, n: suspicious.filter(s => s.result.risk === r).length }))
    .filter(x => x.n > 0)

  return (
    <>
      <PageHeader
        icon={Activity}
        title={
          <span className="flex items-center gap-2">
            Processes
            {suspicious.length > 0 && (
              <Pill tone="bad"><ShieldAlert className="size-3" />{suspicious.length} suspicious</Pill>
            )}
          </span>
        }
        description={`${processes.length} processes${blocked.length > 0 ? ` · ${blocked.length} suspended` : ""}`}
        actions={<LiveBadge>Live · 5s</LiveBadge>}
      >
        <Tabs value={activeTab} onValueChange={v => setActiveTab(v as Tab)}>
          <TabsList variant="line">
            <TabsTrigger value="processes">
              All processes <CountBadge n={processes.length} />
            </TabsTrigger>
            <TabsTrigger value="suspicious">
              <ShieldAlert className="size-3.5" />
              Suspicious activity <CountBadge n={suspicious.length} tone={suspicious.length > 0 ? "bad" : undefined} />
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>

      <PageBody className="motion-safe:animate-in motion-safe:fade-in-0 duration-300">
        <ProcessConfirm
          dialog={dialog}
          onClose={() => setDialog(null)}
          onConfirmKill={handleKill}
          onConfirmSuspend={handleSuspend}
        />

        {/* ── CPU cores ── */}
        {cpuCores.length > 0 && (
          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Cpu className="size-4 text-[var(--hue)]" /> CPU cores
              </CardTitle>
              <CardAction><LiveBadge>Live</LiveBadge></CardAction>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:grid-cols-8">
                {cpuCores.map((pct, i) => (
                  <div key={i}>
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">CPU{i + 1}</span>
                      <span className="font-mono font-semibold tabular-nums">{pct}%</span>
                    </div>
                    <ProgressBar value={pct} tone={pct > 85 ? "bad" : pct > 65 ? "warn" : "ok"} />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ═════ TAB: ALL PROCESSES ═════ */}
        {activeTab === "processes" && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput
                aria-label="Search processes"
                placeholder="Search by command, user or PID…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Sort by</span>
                <Segmented<SortKey>
                  aria-label="Sort processes"
                  value={sortKey}
                  onChange={handleSort}
                  options={[
                    { value: "cpu", label: "CPU" },
                    { value: "mem", label: "MEM" },
                    { value: "pid", label: "PID" },
                  ]}
                />
              </div>
            </div>

            <Card className="gap-0 py-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortHead sortKey={sortKey} sortDir={sortDir} onSort={handleSort} k="pid" label="PID" className="pl-4" />
                      <TableHead>User</TableHead>
                      <TableHead>Command</TableHead>
                      <TableHead>State</TableHead>
                      <SortHead sortKey={sortKey} sortDir={sortDir} onSort={handleSort} k="cpu" label="CPU%" />
                      <SortHead sortKey={sortKey} sortDir={sortDir} onSort={handleSort} k="mem" label="MEM" />
                      <TableHead>RES</TableHead>
                      <TableHead className="pr-4 text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map(proc => (
                      <TableRow key={proc.pid}>
                        <TableCell className="pl-4 font-mono tabular-nums text-muted-foreground">{proc.pid}</TableCell>
                        <TableCell className="text-muted-foreground">{proc.user}</TableCell>
                        <TableCell><CommandCell proc={proc} /></TableCell>
                        <TableCell>
                          {proc.state === "R" ? <Pill tone="ok" dot>Running</Pill> : <Pill tone="outline">Sleep</Pill>}
                        </TableCell>
                        <TableCell><UsageCell pct={(proc.cpu / 15) * 100} label={proc.cpu.toFixed(1)} /></TableCell>
                        <TableCell>
                          <UsageCell
                            pct={proc.memMb != null ? Math.min(100, (proc.memMb / 500) * 100) : (proc.mem / 10) * 100}
                            label={proc.memMb != null ? `${proc.memMb}M` : `${proc.mem.toFixed(1)}%`}
                          />
                        </TableCell>
                        <TableCell className="font-mono tabular-nums text-muted-foreground">{proc.res}</TableCell>
                        <TableCell className="pr-4 text-right"><ProcessActions proc={proc} onRequest={requestAction} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {sorted.length === 0 && (
                <EmptyState className="m-4" icon={Activity} title="No processes match" description="Try a different search term." />
              )}
              <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-muted-foreground">
                <span>Showing {sorted.length} of {processes.length} processes</span>
                <LiveBadge>Live · 5s</LiveBadge>
              </div>
            </Card>

            {blocked.length > 0 && (
              <Card className="gap-0 py-0">
                <CardHeader className="border-b bg-warning/8 py-3">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Ban className="size-4 text-warning" /> Suspended processes <CountBadge n={blocked.length} />
                  </CardTitle>
                  <CardAction>
                    <span className="text-xs text-muted-foreground">Unblock a process to let it run again</span>
                  </CardAction>
                </CardHeader>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">PID</TableHead>
                        <TableHead>User</TableHead>
                        <TableHead>Command</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead className="pr-4 text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {blocked.map(proc => (
                        <TableRow key={proc.pid}>
                          <TableCell className="pl-4 font-mono tabular-nums">{proc.pid}</TableCell>
                          <TableCell className="text-muted-foreground">{proc.user}</TableCell>
                          <TableCell><CommandCell proc={proc} max="max-w-[360px]" /></TableCell>
                          <TableCell><Pill tone="warn" dot>SIGSTOP · paused</Pill></TableCell>
                          <TableCell className="pr-4 text-right">
                            <Button variant="outline" size="xs" onClick={() => handleResume(proc)}>
                              <PlayCircle className="size-3.5 text-success" /> Unblock
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Card>
            )}
          </>
        )}

        {/* ═════ TAB: SUSPICIOUS ACTIVITY ═════ */}
        {activeTab === "suspicious" && (
          <>
            {suspicious.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title="No suspicious activity detected"
                description={`All ${processes.length} running processes look normal.${released.size > 0 ? ` ${released.size} manually released.` : ""}`}
              />
            ) : (
              <>
                <Alert variant="destructive">
                  <ShieldAlert />
                  <AlertTitle>
                    {suspicious.length} suspicious process{suspicious.length !== 1 ? "es" : ""} detected
                  </AlertTitle>
                  <AlertDescription>
                    <p>Review each process below. Kill confirmed threats, or release if it is a false positive.</p>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      {riskCounts.map(({ r, n }) => (
                        <span key={r} className="flex items-center gap-1.5 text-foreground">
                          <RiskPill risk={r} /> <span className="font-mono text-xs tabular-nums">{n}</span>
                        </span>
                      ))}
                    </div>
                  </AlertDescription>
                </Alert>

                <Card className="gap-0 py-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="pl-4">Risk</TableHead>
                          <TableHead>PID</TableHead>
                          <TableHead>Process</TableHead>
                          <TableHead>User</TableHead>
                          <TableHead>CPU%</TableHead>
                          <TableHead>Why flagged</TableHead>
                          <TableHead className="pr-4 text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {suspicious.map(({ proc, result }) => (
                          <TableRow key={proc.pid}>
                            <TableCell className="pl-4"><RiskPill risk={result.risk} /></TableCell>
                            <TableCell className="font-mono tabular-nums text-muted-foreground">{proc.pid}</TableCell>
                            <TableCell>
                              <p className="text-sm font-medium">{proc.name || "unknown"}</p>
                              <p className="max-w-[220px] truncate font-mono text-xs text-muted-foreground" title={proc.cmd}>{proc.cmd}</p>
                            </TableCell>
                            <TableCell className="text-muted-foreground">{proc.user}</TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <ProgressBar value={(proc.cpu / 15) * 100} tone={proc.cpu > 70 ? "bad" : "info"} className="w-14 shrink-0" />
                                <span className={`font-mono text-xs tabular-nums ${proc.cpu > 70 ? "font-semibold text-danger" : ""}`}>
                                  {proc.cpu.toFixed(1)}%
                                </span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col items-start gap-1">
                                {result.reasons.map((r, i) => (
                                  <Pill key={i} tone="warn" className="h-auto whitespace-normal py-0.5 text-left">{r}</Pill>
                                ))}
                              </div>
                            </TableCell>
                            <TableCell className="pr-4 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <Button
                                  variant="outline" size="xs" title="Mark as false positive / safe"
                                  onClick={() => { setReleased(prev => new Set(Array.from(prev).concat(proc.pid))); toast.success(`Released PID ${proc.pid} — marked as safe`) }}
                                >
                                  <CheckCircle2 className="size-3.5 text-success" /> Release
                                </Button>
                                <ProcessActions proc={proc} onRequest={requestAction} />
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </Card>
              </>
            )}

            {released.size > 0 && (
              <Card size="sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <ShieldCheck className="size-4 text-success" /> Released (false positives) <CountBadge n={released.size} />
                  </CardTitle>
                  <CardAction>
                    <Button variant="ghost" size="xs" onClick={() => setReleased(new Set())}>Clear all</Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  {Array.from(released).map(pid => {
                    const p = processes.find(pr => pr.pid === pid)
                    return (
                      <Button
                        key={pid} variant="outline" size="xs" className="rounded-full"
                        title="Click to re-flag"
                        aria-label={`Re-flag PID ${pid}`}
                        onClick={() => setReleased(prev => { const n = new Set(prev); n.delete(pid); return n })}
                      >
                        <span className="font-mono">{pid}</span>
                        {p && <span className="text-muted-foreground">{p.name}</span>}
                        <X className="size-3 text-muted-foreground" />
                      </Button>
                    )
                  })}
                </CardContent>
              </Card>
            )}
          </>
        )}
      </PageBody>
    </>
  )
}
