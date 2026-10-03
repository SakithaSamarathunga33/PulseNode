"use client"

import { useState, useRef, useEffect, useCallback, useMemo } from "react"
import { AlertCircle, Box, LayoutDashboard, Play, RefreshCw, RotateCcw, Search, Square, Trash2 } from "lucide-react"
import { AnimatedSpan, TerminalWindow } from "@/components/magicui/terminal"
import { nodeApi } from "@/lib/api"
import { clearBuildCache } from "@/lib/build-cache"
import { getSocket } from "@/lib/socket"
import { useTimeouts } from "@/lib/use-timeouts"
import type { Container, ContainerStats, HostInfo, SystemMetrics } from "@/lib/types"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { LiveBadge } from "@/components/pn/LiveBadge"
import { EmptyState } from "@/components/pn/EmptyState"
import { Segmented } from "@/components/pn/Segmented"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import { HostHealth } from "@/components/containers/HostHealth"
import { EMPTY_HOST } from "@/components/containers/utils"
import { ContainerCards, ContainerTable, type Sort, type SortKey } from "@/components/containers/ContainerTable"
import { LogsPanel, TerminalPanel } from "@/components/containers/ContainerPanels"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

function pushCapped<T>(arr: T[], val: T, max = 20): T[] {
  return arr.length >= max ? [...arr.slice(-(max - 1)), val] : [...arr, val]
}

type Tab = "all" | "running" | "stopped" | "exited"
type Confirm = { kind: "stop" | "remove"; items: Container[] } | null

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ContainersPage() {
  const [tab, setTab]             = useState<Tab>("all")
  const [search, setSearch]       = useState("")
  const [sort, setSort]           = useState<Sort>({ key: "name", dir: 1 })
  const [sel, setSel]             = useState<Record<string, boolean>>({})
  const [containers, setContainers] = useState<Container[]>([])
  const [host, setHost]             = useState<HostInfo>(EMPTY_HOST)
  const [loaded, setLoaded]         = useState(false)
  const [hostLoaded, setHostLoaded] = useState(false)
  const later = useTimeouts()
  const [loadError, setLoadError]   = useState(false)
  const [spin, setSpin]             = useState(false)
  const [cpuHist, setCpuHist]       = useState<number[]>([0, 0])
  const [ramHist, setRamHist]       = useState<number[]>([0, 0])
  const [diskHist, setDiskHist]     = useState<number[]>([0, 0])
  const [netHist, setNetHist]       = useState<number[]>([0, 0])
  const [netOutHist, setNetOutHist] = useState<number[]>([0, 0])
  const [netRx, setNetRx]           = useState(0)
  const [netTx, setNetTx]           = useState(0)
  const [panel, setPanel]           = useState<{ type: "logs" | "terminal"; container: Container } | null>(null)
  const [actionBusy, setActionBusy] = useState<Record<string, boolean>>({})
  const [confirm, setConfirm]       = useState<Confirm>(null)
  const [cacheOpen,  setCacheOpen]  = useState(false)
  const [cacheLines, setCacheLines] = useState<string[]>([])
  const [cacheState, setCacheState] = useState<"idle" | "running" | "done" | "error">("idle")
  const cacheReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  const loadHost = useCallback(() => {
    nodeApi.get<HostInfo>("/api/host")
      .then(({ data }) => {
        setHost(data)
        setNetRx(data.network.rx)
        setNetTx(data.network.tx)
        // Seed the sparklines so they draw a flat line until live samples arrive.
        const seed = (v: number) => (h: number[]) => (h.length <= 2 ? [v, v] : h)
        setCpuHist(seed(data.cpu.usage)); setRamHist(seed(data.memory.pct)); setDiskHist(seed(data.disk.pct))
        setNetHist(seed(data.network.rx)); setNetOutHist(seed(data.network.tx))
      })
      .catch(() => {})
      .finally(() => setHostLoaded(true))
  }, [])

  useEffect(() => {
    nodeApi.get<Container[]>("/api/docker/containers")
      .then(({ data }) => { setContainers(data); setLoadError(false) })
      .catch(() => setLoadError(true))
      .finally(() => setLoaded(true))
    loadHost()

    const socket = getSocket()

    // Live per-container CPU + RAM (backend broadcasts every 5s)
    const onContainerStats = (stats: ContainerStats[]) => {
      setContainers(prev => prev.map(c => {
        const s = stats.find(s => s.containerId === c.id)
        return s ? { ...c, cpu: s.cpu, ram: s.ram } : c
      }))
    }

    // Live system metrics every 3s
    const onSystemMetrics = (m: SystemMetrics) => {
      setNetHist(prev => pushCapped(prev, m.netIn, 60))
      setNetOutHist(prev => pushCapped(prev, m.netOut, 60))
      setCpuHist(prev => pushCapped(prev, m.cpu, 60))
      setRamHist(prev => pushCapped(prev, m.ram, 60))
      setDiskHist(prev => pushCapped(prev, m.disk, 60))
      setNetRx(Math.round(m.netIn))
      setNetTx(Math.round(m.netOut))
      setHost(prev => ({
        ...prev,
        cpu: { ...prev.cpu, usage: Math.round(m.cpu * 10) / 10 },
        memory: { ...prev.memory, pct: Math.round(m.ram * 10) / 10 },
        disk: { ...prev.disk, pct: Math.round(m.disk * 10) / 10 },
      }))
    }

    socket.on("container:stats", onContainerStats)
    socket.on("system:metrics",  onSystemMetrics)
    return () => {
      socket.off("container:stats", onContainerStats)
      socket.off("system:metrics",  onSystemMetrics)
    }
  }, [loadHost])

  // "/" focuses the container filter (unless you are already typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      e.preventDefault()
      filterRef.current?.focus()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const refreshContainers = useCallback(() => {
    nodeApi.get<Container[]>("/api/docker/containers")
      .then(({ data }) => setContainers(data))
      .catch(() => {})
  }, [])

  const refreshAll = useCallback(() => {
    setSpin(true)
    refreshContainers()
    loadHost()
    later(() => setSpin(false), 700)
  }, [refreshContainers, loadHost, later])

  const handleStop = useCallback(async (c: Container) => {
    setActionBusy(prev => ({ ...prev, [`stop-${c.id}`]: true }))
    try {
      await nodeApi.post(`/api/docker/stop/${c.id}`)
      later(refreshContainers, 1200)
    } catch {}
    setActionBusy(prev => ({ ...prev, [`stop-${c.id}`]: false }))
  }, [refreshContainers, later])

  const handleRestart = useCallback(async (c: Container) => {
    setActionBusy(prev => ({ ...prev, [`restart-${c.id}`]: true }))
    try {
      await nodeApi.post(`/api/docker/restart/${c.id}`)
      later(refreshContainers, 2000)
    } catch {}
    setActionBusy(prev => ({ ...prev, [`restart-${c.id}`]: false }))
  }, [refreshContainers, later])

  const handleStart = useCallback(async (c: Container) => {
    setActionBusy(prev => ({ ...prev, [`start-${c.id}`]: true }))
    try {
      await nodeApi.post(`/api/docker/start/${c.id}`)
      later(refreshContainers, 1200)
    } catch {}
    setActionBusy(prev => ({ ...prev, [`start-${c.id}`]: false }))
  }, [refreshContainers, later])

  const confirmRemove = useCallback(async (c: Container) => {
    setActionBusy(prev => ({ ...prev, [`remove-${c.id}`]: true }))
    try {
      await nodeApi.delete(`/api/docker/remove/${c.id}`)
      setContainers(prev => prev.filter(x => x.id !== c.id))
      setPanel(p => (p?.container.id === c.id ? null : p))
    } catch {}
    setActionBusy(prev => ({ ...prev, [`remove-${c.id}`]: false }))
  }, [])

  const handleClearCache = () => {
    setCacheLines([])
    setCacheOpen(true)
    return clearBuildCache({
      onLine: line => setCacheLines(prev => [...prev, line]),
      onState: setCacheState,
      readerRef: cacheReaderRef,
    })
  }

  const handleCacheDialogClose = () => {
    cacheReaderRef.current?.cancel()
    cacheReaderRef.current = null
    setCacheOpen(false)
    setCacheState("idle")
    setCacheLines([])
  }

  const running = containers.filter(c => c.state === "running").length
  const stopped = containers.filter(c => c.state === "stopped" || c.state === "paused").length
  const exited  = containers.filter(c => c.state === "exited").length

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = containers.filter(c => {
      const matchTab = tab === "all" || (tab === "stopped" ? c.state === "stopped" || c.state === "paused" : c.state === tab)
      return matchTab && (!q || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q))
    })
    const val: Record<SortKey, (c: Container) => string | number> = {
      name: c => c.name.toLowerCase(), image: c => c.image.toLowerCase(), state: c => c.state, cpu: c => c.cpu, ram: c => c.ram,
    }
    return list.sort((a, b) => {
      const x = val[sort.key](a), y = val[sort.key](b)
      return (x > y ? 1 : x < y ? -1 : 0) * sort.dir
    })
  }, [containers, tab, search, sort])

  const selected = containers.filter(c => sel[c.id])
  const clearSel = () => setSel({})
  const onSort = (key: SortKey) =>
    setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "cpu" || key === "ram" ? -1 : 1 }))
  const onToggle = (id: string, v: boolean) => setSel(s => ({ ...s, [id]: v }))
  const onToggleAll = (v: boolean) => setSel(v ? Object.fromEntries(rows.map(r => [r.id, true])) : {})

  const handlers = {
    onLogs: (c: Container) => setPanel({ type: "logs", container: c }),
    onTerm: (c: Container) => setPanel({ type: "terminal", container: c }),
    onRestart: handleRestart,
    onStart: handleStart,
    onStop: (c: Container) => setConfirm({ kind: "stop", items: [c] }),
    onRemove: (c: Container) => setConfirm({ kind: "remove", items: [c] }),
  }

  const runConfirm = async () => {
    if (!confirm) return
    const { kind, items } = confirm
    setConfirm(null)
    clearSel()
    await Promise.all(items.map(c => (kind === "stop" ? handleStop(c) : confirmRemove(c))))
  }

  const tabLabel = tab === "all" ? "all containers" : tab
  const many = confirm && confirm.items.length > 1

  return (
    <>
      <PageHeader
        icon={LayoutDashboard}
        title="Dashboard"
        description={
          <span className="flex flex-wrap gap-x-2">
            <span><b className="font-semibold text-foreground">{containers.length}</b> containers</span>
            <span aria-hidden>·</span>
            <span><b className="font-semibold text-success">{running}</b> running</span>
            <span aria-hidden>·</span>
            <span><b className="font-semibold text-foreground">{containers.length - running}</b> stopped</span>
          </span>
        }
        actions={
          <>
            <LiveBadge className="mr-1">Live</LiveBadge>
            <Button variant="outline" size="sm" onClick={handleClearCache} disabled={cacheState === "running"}>
              <Trash2 className="size-3.5" /> Clear build cache
            </Button>
            <Button variant="outline" size="sm" onClick={refreshAll}>
              <RefreshCw className={cn("size-3.5", spin && "motion-safe:animate-spin")} /> Refresh
            </Button>
          </>
        }
      />

      <PageBody className="motion-safe:animate-in fade-in-0 duration-300">
        {loadError && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load containers</AlertTitle>
            <AlertDescription>The Docker API did not respond. Retry with Refresh.</AlertDescription>
          </Alert>
        )}

        {!hostLoaded ? <Skeleton className="h-[148px] rounded-xl" /> : <HostHealth
          host={host}
          cpuHist={cpuHist} ramHist={ramHist} diskHist={diskHist}
          netInHist={netHist} netOutHist={netOutHist} netRx={netRx} netTx={netTx}
        />}

        <section aria-labelledby="ct-title" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3.5">
              <h2 id="ct-title" className="text-lg font-semibold">Containers</h2>
              <div className="max-w-full overflow-x-auto">
                <Segmented
                  aria-label="Filter by state"
                  value={tab}
                  onChange={v => { setTab(v); clearSel() }}
                  options={[
                    { value: "all",     label: "All",     count: containers.length },
                    { value: "running", label: "Running", count: running },
                    { value: "stopped", label: "Stopped", count: stopped },
                    { value: "exited",  label: "Exited",  count: exited },
                  ]}
                />
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground" title="Container stats are polled every 5 seconds">
                <RefreshCw className="size-3" /> Auto · 5s
              </span>
              <label className="relative flex w-[min(300px,70vw)] items-center">
                <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
                <Input
                  ref={filterRef}
                  type="search"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  aria-label="Filter containers by name or image"
                  placeholder="Filter by name or image"
                  className="pr-8 pl-8"
                />
                <kbd className="pointer-events-none absolute right-2 hidden sm:inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border bg-muted px-1 font-mono text-[11px] text-muted-foreground">/</kbd>
              </label>
            </div>
          </div>

          {selected.length > 0 && (
            <div
              role="toolbar" aria-label="Bulk actions"
              className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 py-2 pr-2.5 pl-3.5 motion-safe:animate-in fade-in-0 slide-in-from-top-1"
            >
              <span className="mr-1.5 text-sm font-semibold tabular-nums">{selected.length} selected</span>
              <Button variant="outline" size="sm" onClick={() => { selected.filter(c => c.state !== "running").forEach(handleStart); clearSel() }}>
                <Play className="size-3.5" /> Start
              </Button>
              <Button variant="outline" size="sm" onClick={() => { const l = selected.filter(c => c.state === "running"); if (l.length) setConfirm({ kind: "stop", items: l }) }}>
                <Square className="size-3.5" /> Stop
              </Button>
              <Button variant="outline" size="sm" onClick={() => { selected.forEach(handleRestart); clearSel() }}>
                <RotateCcw className="size-3.5" /> Restart
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setConfirm({ kind: "remove", items: selected })}>
                <Trash2 className="size-3.5" /> Remove
              </Button>
              <span className="flex-1" />
              <Button variant="ghost" size="sm" onClick={clearSel}>Clear</Button>
            </div>
          )}

          {!loaded ? (
            <div className="space-y-3 rounded-xl border bg-card p-4">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Box}
              title={containers.length === 0 ? "No containers" : "No containers found"}
              description={containers.length === 0
                ? "Containers on this host will appear here."
                : search.trim() ? `Nothing matches “${search.trim()}” in ${tabLabel}.` : `There are no ${tabLabel} right now.`}
              action={containers.length > 0 && (
                <Button variant="outline" size="sm" onClick={() => { setSearch(""); setTab("all") }}>Clear filter</Button>
              )}
            />
          ) : (
            <>
              <div className="hidden overflow-hidden rounded-xl border bg-card shadow-card min-[900px]:block">
                <ContainerTable
                  rows={rows} selected={sel} onToggle={onToggle} onToggleAll={onToggleAll}
                  sort={sort} onSort={onSort} busy={actionBusy} handlers={handlers}
                />
              </div>
              <div className="min-[900px]:hidden">
                <ContainerCards rows={rows} busy={actionBusy} handlers={handlers} />
              </div>
            </>
          )}
        </section>
      </PageBody>

      {/* Stop / remove confirmation (single or bulk) */}
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={open => { if (!open) setConfirm(null) }}
        title={confirm?.kind === "stop" ? (many ? `Stop ${confirm.items.length} containers?` : "Stop container?") : many ? `Remove ${confirm?.items.length} containers?` : "Remove container?"}
        description={confirm?.kind === "stop" ? "Connected services may fail until they are started again." : "This will permanently remove the container. This action cannot be undone."}
        target={confirm && (
          <ul className="space-y-1">
            {confirm.items.map(c => (
              <li key={c.id}>{c.name} <span className="text-muted-foreground">{c.image}</span></li>
            ))}
          </ul>
        )}
        confirmLabel={confirm?.kind === "stop" ? "Stop" : "Remove"}
        tone={confirm?.kind === "stop" ? "warning" : "danger"}
        icon={confirm?.kind === "stop" ? Square : Trash2}
        onConfirm={runConfirm}
      />

      {/* Clear build cache (streamed output) */}
      <Dialog open={cacheOpen} onOpenChange={open => { if (!open) handleCacheDialogClose() }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="size-4 text-danger" /> Clear Docker build cache
            </DialogTitle>
            <DialogDescription>
              {cacheState === "running" ? "Running docker builder prune…" : cacheState === "error" ? "The command reported an error." : "Finished."}
            </DialogDescription>
          </DialogHeader>
          <TerminalWindow title="docker builder prune -f" bodyClassName="h-64">
            {cacheLines.map((line, i) => (
              <AnimatedSpan
                key={i}
                className={cn(
                  "font-mono text-xs",
                  line.startsWith("✔") ? "text-[var(--t-ok)]" : line.startsWith("✗") ? "text-[var(--t-err)]" : "text-[var(--t-muted)]",
                )}
              >
                {line}
              </AnimatedSpan>
            ))}
            {cacheState === "running" && (
              <AnimatedSpan className="font-mono text-xs text-[var(--t-muted)]">
                <span className="motion-safe:animate-pulse">▋</span>
              </AnimatedSpan>
            )}
          </TerminalWindow>
          <DialogFooter>
            <Button variant="outline" onClick={handleCacheDialogClose}>
              {cacheState === "running" ? "Cancel" : "Close"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Logs / terminal drawer */}
      <Sheet open={!!panel} onOpenChange={open => { if (!open) setPanel(null) }}>
        <SheetContent
          side="right"
          className="data-[side=right]:w-full data-[side=right]:sm:max-w-[720px] gap-0"
        >
          {panel?.type === "logs" && <LogsPanel container={panel.container} />}
          {panel?.type === "terminal" && <TerminalPanel container={panel.container} />}
        </SheetContent>
      </Sheet>
    </>
  )
}
