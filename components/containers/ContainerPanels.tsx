"use client"

import { useTimeouts } from "@/lib/use-timeouts"
import { useState, useRef, useEffect, useCallback, useMemo } from "react"
import { FileText, Pause, Play, RefreshCw, Terminal, Trash2, Loader2, CornerDownLeft, ArrowUp } from "lucide-react"
import { toast } from "sonner"
import { nodeApi } from "@/lib/api"
import type { Container } from "@/lib/types"
import { TerminalWindow } from "@/components/magicui/terminal"
import { LiveBadge } from "@/components/pn/LiveBadge"
import { SearchInput } from "@/components/pn/SearchInput"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

const TAIL_OPTIONS = [100, 200, 500, 1000].map(n => ({ value: String(n), label: `${n} lines` }))

type Level = "error" | "warn" | "debug" | "info"
const levelOf = (line: string): Level =>
  /\b(error|fatal|panic|err)\b|exception|ECONN\w+/i.test(line) ? "error"
  : /\bwarn(ing)?\b/i.test(line) ? "warn"
  : /\bdebug\b|\btrace\b/i.test(line) ? "debug"
  : "info"

const LEVEL_STYLE: Record<Level, string> = {
  error: "border-l-[var(--t-err)] bg-[var(--t-err)]/10 text-[var(--t-err)]",
  warn: "border-l-transparent text-[var(--t-warn)]",
  debug: "border-l-transparent text-[var(--t-muted)]",
  info: "border-l-transparent",
}

function PanelFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex h-9 shrink-0 items-center gap-3 border-t px-4 text-[11px] text-muted-foreground">{children}</div>
}

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border bg-muted px-1 font-mono text-[11px] text-foreground/80">{children}</kbd>
)

/** Body of the Logs drawer: polls `docker logs` every 5s; filter, pause, clear and level colouring are client-side. */
export function LogsPanel({ container }: { container: Container }) {
  const [logs, setLogs]       = useState("")
  const [loading, setLoading] = useState(true)
  const [failed, setFailed]   = useState(false)
  const [tail, setTail]       = useState(200)
  const [query, setQuery]     = useState("")
  const [paused, setPaused]   = useState(false)
  const [clearedAt, setClearedAt] = useState(0) // number of leading lines hidden by "Clear"
  const pausedRef = useRef(false)
  pausedRef.current = paused
  const running = container.state === "running"

  const fetchLogs = useCallback(async (force = false) => {
    if (pausedRef.current && !force) return
    try {
      const { data } = await nodeApi.get<{ logs: string }>(`/api/docker/logs/${container.id}?tail=${tail}`)
      setLogs(data.logs || "")
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [container.id, tail])

  useEffect(() => {
    setLoading(true)
    setClearedAt(0)
    fetchLogs(true)
    const t = setInterval(() => { if (!document.hidden) fetchLogs() }, 5000)
    return () => clearInterval(t)
  }, [fetchLogs])

  const all = useMemo(() => (logs ? logs.replace(/\n$/, "").split("\n") : []), [logs])
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const lines = all.slice(clearedAt)
    return q ? lines.filter(l => l.toLowerCase().includes(q)) : lines
  }, [all, clearedAt, query])

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(visible.join("\n"))
      toast.success(`${visible.length} log lines copied`)
    } catch {
      toast.error("Could not copy to the clipboard")
    }
  }

  const empty = failed ? "Could not fetch logs." : loading ? "Loading logs…" : all.length === 0 ? "No log output." : clearedAt >= all.length && !query ? "Log view cleared. New lines will appear here." : `No lines match “${query}”.`

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader className="border-b pr-14">
        <SheetTitle className="flex items-center gap-2 font-mono text-sm">
          <FileText className="size-4 text-[var(--hue-fg,var(--primary))]" />
          <span className="truncate">{container.name}</span>
        </SheetTitle>
        <SheetDescription className="font-mono text-[11px]">docker logs --follow --tail {tail}</SheetDescription>
      </SheetHeader>

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <LiveBadge stale={paused || !running}>{paused ? "Paused" : running ? "Live · every 5s" : "Stopped"}</LiveBadge>
        <span className="flex-1" />
        <Label htmlFor="log-tail" className="sr-only">Lines to load</Label>
        <Select value={String(tail)} onValueChange={v => setTail(Number(v))} items={TAIL_OPTIONS}>
          <SelectTrigger id="log-tail" size="sm" className="w-[7.5rem] font-mono text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {TAIL_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon-sm" aria-label="Reload logs" onClick={() => { setLoading(true); setClearedAt(0); fetchLogs(true) }}>
          <RefreshCw className="size-4" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2">
        <SearchInput aria-label="Search logs" placeholder="Search logs" value={query} onChange={e => setQuery(e.target.value)} className="min-w-40 max-w-none flex-1 [&_input]:h-7 [&_input]:font-mono [&_input]:text-xs" />
        <Button variant={paused ? "secondary" : "outline"} size="sm" aria-pressed={paused} onClick={() => setPaused(p => !p)}>
          {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}{paused ? "Resume" : "Pause"}
        </Button>
        <Button variant="outline" size="sm" onClick={copyAll} disabled={visible.length === 0}>Copy</Button>
        <Button variant="outline" size="sm" onClick={() => setClearedAt(all.length)} disabled={all.length === 0}>
          <Trash2 className="size-3.5" /> Clear
        </Button>
      </div>

      <div className="min-h-0 flex-1 p-3">
        <TerminalWindow title={container.name} className="h-full">
          {visible.length === 0 ? (
            <div className="py-10 text-center font-sans text-sm text-[var(--t-muted)]">{empty}</div>
          ) : (
            visible.map((line, i) => (
              <div key={i} className={cn("border-l-2 px-2", LEVEL_STYLE[levelOf(line)])}>{line || " "}</div>
            ))
          )}
        </TerminalWindow>
      </div>

      <PanelFooter>
        <span className="tabular-nums">{visible.length} lines</span>
        <span>·</span>
        <span>{paused ? "Updates paused" : "Following new output"}</span>
        <span className="flex-1" />
        <span className="inline-flex items-center gap-1.5"><Kbd>esc</Kbd> close</span>
      </PanelFooter>
    </div>
  )
}

type TermLine = { type: "cmd" | "out" | "err" | "sys"; text: string }

/** Body of the Shell drawer (one-shot `docker exec` per command, with ↑/↓ history). */
export function TerminalPanel({ container }: { container: Container }) {
  const later = useTimeouts()
  const [lines, setLines]   = useState<TermLine[]>([
    { type: "sys", text: `Connected to ${container.name}. Type a command below.` },
  ])
  const [cmd, setCmd]       = useState("")
  const [running, setRunning] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [hi, setHi]         = useState(-1)
  const inputRef            = useRef<HTMLInputElement>(null)

  const run = async () => {
    const trimmed = cmd.trim()
    if (!trimmed || running) return
    setCmd("")
    setHistory(h => [...h, trimmed])
    setHi(-1)
    setLines(prev => [...prev, { type: "cmd", text: `$ ${trimmed}` }])
    setRunning(true)
    try {
      const result = await nodeApi.post<{ output: string }>(`/api/docker/exec/${container.id}`, { cmd: trimmed })
      const out = (result.output || "").trimEnd()
      setLines(prev => [...prev, { type: "out", text: out || "(no output)" }])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "exec failed"
      setLines(prev => [...prev, { type: "err", text: `[error] ${msg}` }])
    } finally {
      setRunning(false)
      later(() => inputRef.current?.focus(), 50)
    }
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { run(); return }
    if (e.key === "ArrowUp" && history.length) {
      e.preventDefault()
      const next = hi < 0 ? history.length - 1 : Math.max(0, hi - 1)
      setHi(next); setCmd(history[next])
    } else if (e.key === "ArrowDown" && hi >= 0) {
      e.preventDefault()
      const next = hi + 1
      if (next >= history.length) { setHi(-1); setCmd("") } else { setHi(next); setCmd(history[next]) }
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader className="border-b pr-14">
        <SheetTitle className="flex items-center gap-2 font-mono text-sm">
          <Terminal className="size-4 text-[var(--hue-fg,var(--primary))]" />
          <span className="truncate">{container.name}</span>
          <span className="font-sans font-normal text-muted-foreground">· /bin/sh</span>
        </SheetTitle>
        <SheetDescription className="flex items-center gap-3 text-xs">
          <LiveBadge stale={running}>{running ? "Running…" : "Ready"}</LiveBadge>
          <Button variant="ghost" size="xs" onClick={() => setLines([{ type: "sys", text: "Session cleared." }])}>Clear</Button>
        </SheetDescription>
      </SheetHeader>

      <div className="min-h-0 flex-1 p-3 pb-2" onClick={() => inputRef.current?.focus()}>
        <TerminalWindow title={`docker exec -it ${container.name} sh`} className="h-full">
          {lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap break-all leading-relaxed",
                l.type === "cmd" ? "mb-0.5 text-[var(--t-fg)]" : "mb-2",
                l.type === "sys" && "text-[var(--t-ok)]",
                l.type === "err" ? "text-[var(--t-err)]" : l.type === "out" && "text-[var(--t-fg)]/90",
              )}
            >
              {l.text}
            </div>
          ))}
          {running && (
            <div className="flex items-center gap-1.5 text-[var(--t-muted)]">
              <Loader2 className="size-3 animate-spin" /> running…
            </div>
          )}
        </TerminalWindow>
      </div>

      <div className="flex items-center gap-2 border-t px-4 py-3">
        <Label htmlFor="shell-cmd" className="sr-only">Command</Label>
        <span className="font-mono text-sm font-semibold text-[var(--hue-fg,var(--primary))]" aria-hidden>$</span>
        <Input
          id="shell-cmd"
          ref={inputRef}
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          onKeyDown={onKey}
          placeholder={running ? "running…" : "type a command…"}
          disabled={running}
          className="flex-1 font-mono"
          autoFocus
          autoComplete="off"
          spellCheck={false}
        />
        <Button size="sm" onClick={run} disabled={running || !cmd.trim()}>Run</Button>
      </div>

      <PanelFooter>
        <span className="inline-flex items-center gap-1.5"><Kbd><CornerDownLeft className="size-3" /></Kbd> execute</span>
        <span className="inline-flex items-center gap-1.5"><Kbd><ArrowUp className="size-3" /></Kbd> history</span>
        <span className="flex-1" />
        <span className="inline-flex items-center gap-1.5"><Kbd>esc</Kbd> close</span>
      </PanelFooter>
    </div>
  )
}
