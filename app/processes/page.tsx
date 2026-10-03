"use client"

import { useState, useMemo, useEffect, useCallback, useRef } from "react"
import { toast } from "sonner"
import {
  Activity, AlertCircle, ArrowDown, ArrowUp, ChevronDown, ChevronUp, ChevronsUpDown, Ban, CheckCircle2,
  PlayCircle, ShieldAlert, ShieldCheck, X,
} from "lucide-react"
import { nodeApi } from "@/lib/api"
import { useSlashFocus } from "@/lib/use-slash-focus"
import type { Process } from "@/lib/types"
import { Pill } from "@/components/dashboard/Pill"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { SearchInput } from "@/components/pn/SearchInput"
import { Segmented } from "@/components/pn/Segmented"
import { EmptyState } from "@/components/pn/EmptyState"
import { LiveBadge } from "@/components/pn/LiveBadge"
import { StatusDot } from "@/components/pn/StatusDot"
import { TONE_BG, TONE_TEXT, toneFor } from "@/components/containers/utils"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { detectSuspicious } from "@/components/processes/detect"
import { ProcessConfirm, ProcessIconActions, RiskPill, procName, type DialogState, type Risk } from "@/components/processes/parts"
import { cn } from "@/lib/utils"

type SortKey = "pid" | "user" | "cmd" | "state" | "cpu" | "mem" | "res"
type Dir = "asc" | "desc"

const SORT_LABEL: Record<SortKey, string> = { pid: "PID", user: "User", cmd: "Command", state: "State", cpu: "CPU", mem: "MEM", res: "RES" }
const NUMERIC: SortKey[] = ["cpu", "mem", "res"]
const STICKY = "sticky right-0 bg-card shadow-[-1px_0_0_var(--border)]"

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

/** Memory in MB when the host reports it, otherwise the percentage the PM2 list gives. */
const memLabel = (p: Process) => (p.memMb != null ? `${p.memMb} MB` : `${p.mem.toFixed(1)}%`)
const memValue = (p: Process) => p.memMb ?? p.mem
const cpuText = (cpu: number) => TONE_TEXT[toneFor(cpu)] === "text-success" ? "text-foreground" : TONE_TEXT[toneFor(cpu)]

function StateLabel({ state }: { state: string }) {
  const running = state === "R"
  const suspended = state === "T"
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", running ? "text-success" : suspended ? "text-warning" : "text-muted-foreground")}>
      <StatusDot tone={running ? "ok" : suspended ? "warn" : "off"} />
      {running ? "Running" : suspended ? "Suspended" : "Sleeping"}
    </span>
  )
}

function CommandCell({ proc, flagged, max = "max-w-[420px]" }: { proc: Process; flagged?: boolean; max?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {flagged && (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex text-danger" aria-label="Matched a detection rule" />}>
            <ShieldAlert className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Matched a detection rule</TooltipContent>
        </Tooltip>
      )}
      <span className={cn("truncate font-mono text-xs", max)} title={proc.cmd}>{proc.cmd}</span>
      {proc.type === "pm2" && (
        <span className="shrink-0 rounded bg-primary/12 px-1.5 py-px text-[11px] font-semibold text-primary">pm2 · {procName(proc)}</span>
      )}
    </div>
  )
}

function SortHead({ k, sortKey, dir, onSort, className }: {
  k: SortKey; sortKey: SortKey; dir: Dir; onSort: (k: SortKey) => void; className?: string
}) {
  const active = sortKey === k
  const Icon = !active ? ChevronsUpDown : dir === "asc" ? ChevronUp : ChevronDown
  return (
    <TableHead
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn("sticky top-0 z-[1] bg-card", NUMERIC.includes(k) && "text-right", className)}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
          active && "text-foreground",
        )}
      >
        {SORT_LABEL[k]}
        <Icon className={cn("size-3", !active && "opacity-50")} />
      </button>
    </TableHead>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ProcessesPage() {
  const [search,     setSearch]      = useState("")
  const [sortKey,    setSortKey]     = useState<SortKey>("cpu")
  const [sortDir,    setSortDir]     = useState<Dir>("desc")
  const [processes,   setProcesses]   = useState<Process[]>([])
  const [loaded,     setLoaded]      = useState(false)
  const [loadError,  setLoadError]   = useState(false)
  const [cpuCores,    setCpuCores]    = useState<number[]>([])
  const [dialog,     setDialog]      = useState<DialogState>(null)
  const [blocked,    setBlocked]     = useState<Process[]>([])
  const [released,   setReleased]    = useState<Set<number>>(new Set())
  const [inspecting, setInspecting]  = useState<Set<number>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const inflight = useRef({ procs: false, cores: false })
  useSlashFocus(searchRef)

  useEffect(() => {
    function fetchProcesses() {
      if (inflight.current.procs) return
      inflight.current.procs = true
      const apply = (list: Process[]) => { setProcesses(list); setLoadError(false) }
      nodeApi.get<PyProcess[]>("/metrics/processes")
        .then(({ data }) => apply(Array.isArray(data) ? data.map(mapPyProcess) : []))
        .catch(() =>
          // Host process list unavailable — fall back to the PM2 list.
          nodeApi.get<Process[]>("/api/pm2/list")
            .then(({ data }) => apply(Array.isArray(data) ? data : []))
            .catch(() => setLoadError(true)),
        )
        .finally(() => { inflight.current.procs = false; setLoaded(true) })
    }

    function fetchCores() {
      if (inflight.current.cores) return
      inflight.current.cores = true
      nodeApi.get<{ cpuCores?: number[] }>("/metrics/live")
        .then(({ data }) => { if (Array.isArray(data?.cpuCores) && data.cpuCores.length) setCpuCores(data.cpuCores) })
        .catch(() => {})
        .finally(() => { inflight.current.cores = false })
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

  const requestAction = (type: "kill" | "suspend", proc: Process) => setDialog({ type, proc })
  const toggleInspect = (pid: number) =>
    setInspecting(prev => { const n = new Set(prev); if (n.has(pid)) n.delete(pid); else n.add(pid); return n })

  // ── Sorting / filtering ───────────────────────────────────────────────────────

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "desc" ? "asc" : "desc")
    else { setSortKey(key); setSortDir(NUMERIC.includes(key) || key === "pid" ? "desc" : "asc") }
  }

  const blockedPids = useMemo(() => new Set(blocked.map(p => p.pid)), [blocked])

  // ── Suspicious detection ──────────────────────────────────────────────────────

  const flagged = useMemo(() => {
    const map = new Map<number, Risk>()
    for (const p of processes) {
      const r = detectSuspicious(p)
      if (r.suspicious) map.set(p.pid, r.risk)
    }
    return map
  }, [processes])

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

  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = processes
      .filter(p => !blockedPids.has(p.pid))
      .filter(p => !q || p.cmd.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) || String(p.pid).includes(q))
    const val = (p: Process): number | string => {
      switch (sortKey) {
        case "pid": return p.pid
        case "user": return p.user
        case "cmd": return p.cmd
        case "state": return p.state
        case "cpu": return p.cpu
        case "mem": return memValue(p)
        case "res": return memValue(p)
      }
    }
    const mul = sortDir === "desc" ? -1 : 1
    list.sort((a, b) => {
      const x = val(a), y = val(b)
      return (typeof x === "string" ? x.localeCompare(y as string) : x - (y as number)) * mul
    })
    return list
  }, [search, sortKey, sortDir, processes, blockedPids])

  const riskCounts = (["critical", "high", "medium"] as Risk[])
    .map(r => ({ r, n: suspicious.filter(s => s.result.risk === r).length }))
    .filter(x => x.n > 0)

  return (
    <>
      <PageHeader
        className="pb-5"
        icon={Activity}
        title={
          <span className="flex flex-wrap items-center gap-3">
            Processes
            {loaded && suspicious.length > 0 && (
              <a href="#suspicious" className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                <Pill tone="bad" className="h-6 px-2.5 text-xs"><ShieldAlert className="size-3.5" />{suspicious.length} suspicious</Pill>
              </a>
            )}
            {loaded && suspicious.length === 0 && (
              <Pill tone="ok" className="h-6 px-2.5 text-xs"><ShieldCheck className="size-3.5" />No suspicious activity</Pill>
            )}
          </span>
        }
        description={`${processes.length} processes${cpuCores.length ? ` · ${cpuCores.length} cores` : ""}${blocked.length > 0 ? ` · ${blocked.length} suspended` : ""}`}
        actions={<LiveBadge stale={loadError}>{loadError ? "Updates failing" : "Auto · 5s"}</LiveBadge>}
      />

      <PageBody className="motion-safe:animate-in motion-safe:fade-in-0 duration-300">
        {loadError && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load processes</AlertTitle>
            <AlertDescription>The process list did not respond. Retrying every 5 seconds.</AlertDescription>
          </Alert>
        )}
        <ProcessConfirm
          dialog={dialog}
          onClose={() => setDialog(null)}
          onConfirmKill={handleKill}
          onConfirmSuspend={handleSuspend}
        />

        {/* ── CPU cores ── */}
        {cpuCores.length > 0 && (
          <section
            aria-label="CPU cores"
            className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border shadow-card sm:grid-cols-4 min-[1200px]:grid-cols-8"
          >
            {cpuCores.map((pct, i) => (
              <div key={i} className="space-y-2 bg-card px-3.5 py-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs font-medium text-muted-foreground">CPU {i + 1}</span>
                  <span className={cn("text-[15px] font-semibold tabular-nums", cpuText(pct))}>{pct}%</span>
                </div>
                <div
                  role="meter" aria-label={`CPU ${i + 1}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
                  className="h-1 overflow-hidden rounded-full bg-muted"
                >
                  <div className={cn("h-full transition-[width] duration-500", TONE_BG[toneFor(pct)])} style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
              </div>
            ))}
          </section>
        )}

        {/* ── Suspicious activity ── */}
        <section id="suspicious" aria-labelledby="sus-title" className="scroll-mt-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="sus-title" className="text-lg font-semibold">Suspicious activity</h2>
            <span className="text-xs text-muted-foreground">Heuristic rules · re-evaluated on every refresh</span>
          </div>

          {!loaded ? (
            <Skeleton className="h-24 rounded-xl" />
          ) : suspicious.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="No suspicious activity detected"
              description={`All ${processes.length} running processes look normal.${released.size > 0 ? ` ${released.size} manually released.` : ""}`}
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-danger/30 bg-card shadow-card">
              <div role="alert" className="flex items-start gap-3 border-b border-danger/20 bg-danger/10 px-[18px] py-3.5">
                <ShieldAlert className="mt-0.5 size-[18px] shrink-0 text-danger" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-semibold">{suspicious.length} process{suspicious.length !== 1 ? "es" : ""} matched detection rules</p>
                  <p className="text-[13px] text-muted-foreground">These are rule matches, not confirmed malware. Inspect before acting. Kill confirmed threats, or release a false positive.</p>
                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    {riskCounts.map(({ r, n }) => (
                      <span key={r} className="flex items-center gap-1.5"><RiskPill risk={r} /><span className="font-mono text-xs tabular-nums">{n}</span></span>
                    ))}
                  </div>
                </div>
              </div>
              <ul className="divide-y">
                {suspicious.map(({ proc, result }) => {
                  const open = inspecting.has(proc.pid)
                  return (
                    <li key={proc.pid} className="space-y-2.5 px-[18px] py-3.5">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <RiskPill risk={result.risk} />
                        <span className="font-mono text-xs text-muted-foreground">PID <b className="font-semibold text-foreground">{proc.pid}</b></span>
                        <span className="font-mono text-xs text-muted-foreground">{proc.user}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">CPU <b className={cn("font-semibold", proc.cpu >= 60 ? "text-danger" : "text-foreground")}>{proc.cpu.toFixed(1)}%</b></span>
                        <span className="flex-1" />
                        <div className="flex flex-wrap gap-1.5">
                          <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => toggleInspect(proc.pid)}>
                            {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}Inspect
                          </Button>
                          <Button
                            variant="outline" size="sm" title="Mark as false positive / safe"
                            onClick={() => { setReleased(prev => new Set(Array.from(prev).concat(proc.pid))); toast.success(`Released PID ${proc.pid} — marked as safe`) }}
                          >
                            <CheckCircle2 className="size-3.5 text-success" />Release
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => requestAction("suspend", proc)}>Suspend</Button>
                          <Button variant="destructive" size="sm" onClick={() => requestAction("kill", proc)}>Kill</Button>
                        </div>
                      </div>
                      <code className="block rounded-md border bg-muted/60 px-2.5 py-2 font-mono text-xs break-all">{proc.cmd}</code>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Flagged because</span>
                        {result.reasons.map(r => (
                          <span key={r} className="inline-flex items-center gap-1.5 rounded-md border bg-muted px-2 py-0.5 text-xs">{r}</span>
                        ))}
                      </div>
                      {open && (
                        <dl className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-x-5 gap-y-2.5 rounded-lg border bg-muted/40 p-3 motion-safe:animate-in motion-safe:fade-in-0">
                          {([
                            ["Process", proc.name || procName(proc)],
                            ["User", proc.user],
                            ["State", proc.state === "R" ? "Running" : proc.state === "T" ? "Suspended (SIGSTOP)" : "Sleeping"],
                            ["Memory", memLabel(proc)],
                            ["Managed by", proc.type === "pm2" ? "PM2" : "Host (system)"],
                          ] as const).map(([k, v]) => (
                            <div key={k} className="space-y-0.5">
                              <dt className="text-[11px] text-muted-foreground">{k}</dt>
                              <dd className="font-mono text-xs break-all">{v}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {released.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-4 py-3 shadow-card">
              <ShieldCheck className="size-4 text-success" />
              <span className="text-sm font-medium">Released (false positives)</span>
              <span className="rounded-full bg-muted px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">{released.size}</span>
              <div className="flex flex-wrap gap-2">
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
              </div>
              <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setReleased(new Set())}>Clear all</Button>
            </div>
          )}
        </section>

        {/* ── Suspended ── */}
        {blocked.length > 0 && (
          <section aria-labelledby="blocked-title" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="blocked-title" className="flex items-center gap-2 text-lg font-semibold">
                <Ban className="size-[18px] text-warning" />Suspended processes
                <span className="rounded-full bg-muted px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">{blocked.length}</span>
              </h2>
              <span className="text-xs text-muted-foreground">Unblock a process to let it run again</span>
            </div>
            <Card className="gap-0 overflow-hidden border-warning/30 py-0">
              <div className="overflow-x-auto">
                <Table className="min-w-[640px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>PID</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead>Command</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {blocked.map(proc => (
                      <TableRow key={proc.pid}>
                        <TableCell className="font-mono text-xs tabular-nums">{proc.pid}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{proc.user}</TableCell>
                        <TableCell><CommandCell proc={proc} max="max-w-[360px]" /></TableCell>
                        <TableCell><StateLabel state="T" /></TableCell>
                        <TableCell className="text-right">
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
          </section>
        )}

        {/* ── All processes ── */}
        <section aria-labelledby="pt-title" className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h2 id="pt-title" className="text-lg font-semibold">All processes</h2>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-3.5 w-[3px] rounded-sm bg-primary" aria-hidden />PM2-managed
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented<SortKey>
                aria-label="Sort processes"
                className="md:hidden"
                value={sortKey}
                onChange={handleSort}
                options={[{ value: "cpu", label: "CPU" }, { value: "mem", label: "MEM" }, { value: "pid", label: "PID" }]}
              />
              <div className="relative w-full min-w-[220px] max-w-[300px]">
                <SearchInput
                  ref={searchRef}
                  className="max-w-none"
                  aria-label="Search processes"
                  placeholder="Search command, user or PID"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground sm:block">/</kbd>
              </div>
            </div>
          </div>

          {!loaded ? (
            <Card className="gap-0 py-0"><div className="space-y-3 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div></Card>
          ) : sorted.length === 0 ? (
            <EmptyState icon={Activity}
              title={processes.length === 0 ? "No processes reported" : `No processes match “${search}”`}
              description={processes.length === 0 ? "The host did not return any processes." : "Try a different command, user or PID."} />
          ) : (
            <>
              <ul className="space-y-3 md:hidden" aria-label="Processes">
                {sorted.map(proc => (
                  <li
                    key={proc.pid}
                    className={cn(
                      "space-y-2.5 rounded-xl border bg-card p-3.5 shadow-card",
                      flagged.has(proc.pid) && "bg-danger/5",
                      proc.type === "pm2" && "shadow-[inset_3px_0_0_var(--primary)]",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">PID {proc.pid}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{proc.user}</span>
                      <StateLabel state={proc.state} />
                    </div>
                    <CommandCell proc={proc} flagged={flagged.has(proc.pid)} max="max-w-full" />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        CPU <b className={cn("font-semibold", cpuText(proc.cpu))}>{proc.cpu.toFixed(1)}</b> · MEM {memLabel(proc)}
                      </span>
                      <ProcessIconActions proc={proc} onRequest={requestAction} />
                    </div>
                  </li>
                ))}
              </ul>

              <Card className="hidden gap-0 overflow-hidden py-0 md:block">
                <div className="max-h-[640px] overflow-auto">
                  <Table className="min-w-[980px]">
                    <TableHeader>
                      <TableRow>
                        <SortHead k="pid" sortKey={sortKey} dir={sortDir} onSort={handleSort} />
                        <SortHead k="user" sortKey={sortKey} dir={sortDir} onSort={handleSort} />
                        <SortHead k="cmd" sortKey={sortKey} dir={sortDir} onSort={handleSort} />
                        <SortHead k="state" sortKey={sortKey} dir={sortDir} onSort={handleSort} />
                        <SortHead k="cpu" sortKey={sortKey} dir={sortDir} onSort={handleSort} />
                        <SortHead k="mem" sortKey={sortKey} dir={sortDir} onSort={handleSort} />
                        <SortHead k="res" sortKey={sortKey} dir={sortDir} onSort={handleSort} />
                        <TableHead className={cn(STICKY, "top-0 z-[2] text-right")}>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sorted.map(proc => (
                        <TableRow key={proc.pid} className={cn("h-[46px]", flagged.has(proc.pid) && "bg-danger/5")}>
                          <TableCell className={cn("font-mono text-xs tabular-nums text-muted-foreground", proc.type === "pm2" && "shadow-[inset_3px_0_0_var(--primary)]")}>{proc.pid}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{proc.user}</TableCell>
                          <TableCell className="max-w-[460px]"><CommandCell proc={proc} flagged={flagged.has(proc.pid)} /></TableCell>
                          <TableCell><StateLabel state={proc.state} /></TableCell>
                          <TableCell className={cn("text-right font-medium tabular-nums", cpuText(proc.cpu))}>{proc.cpu.toFixed(1)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{proc.memMb != null ? proc.memMb.toLocaleString() : proc.mem.toFixed(1)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{proc.res}</TableCell>
                          <TableCell className={cn(STICKY, "px-2")}><ProcessIconActions proc={proc} onRequest={requestAction} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-muted-foreground">
                  <span>Showing {sorted.length} of {processes.length} processes</span>
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    Sorted by {SORT_LABEL[sortKey]} {sortDir === "desc" ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />}
                  </span>
                </div>
              </Card>
            </>
          )}
        </section>
      </PageBody>
    </>
  )
}
