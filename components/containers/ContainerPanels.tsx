"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { FileText, Terminal, RefreshCw, Send, Loader2 } from "lucide-react"
import { nodeApi } from "@/lib/api"
import type { Container } from "@/lib/types"
import { TerminalWindow } from "@/components/magicui/terminal"
import { LiveBadge } from "@/components/pn/LiveBadge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

const TAIL_OPTIONS = [50, 100, 200, 500, 1000].map(n => ({ value: String(n), label: `${n} lines` }))

/** Body of the Logs drawer. Polls every 5s. */
export function LogsPanel({ container }: { container: Container }) {
  const [logs, setLogs]       = useState("Loading…")
  const [loading, setLoading] = useState(true)
  const [tail, setTail]       = useState(200)

  const fetchLogs = useCallback(async () => {
    try {
      const { data } = await nodeApi.get<{ logs: string }>(`/api/docker/logs/${container.id}?tail=${tail}`)
      setLogs(data.logs || "(no output)")
    } catch {
      setLogs("[error fetching logs]")
    } finally {
      setLoading(false)
    }
  }, [container.id, tail])

  useEffect(() => {
    setLoading(true)
    fetchLogs()
    const t = setInterval(() => { if (!document.hidden) fetchLogs() }, 5000)
    return () => clearInterval(t)
  }, [fetchLogs])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader className="border-b pr-14">
        <SheetTitle className="flex items-center gap-2">
          <FileText className="size-4 text-[var(--hue-fg,var(--primary))]" />
          Logs
        </SheetTitle>
        <SheetDescription className="truncate font-mono text-xs">{container.name}</SheetDescription>
      </SheetHeader>

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Label htmlFor="log-tail" className="sr-only">Lines to show</Label>
        <Select value={String(tail)} onValueChange={v => setTail(Number(v))} items={TAIL_OPTIONS}>
          <SelectTrigger id="log-tail" size="sm" className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            {TAIL_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={fetchLogs}>
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
        <span className="ml-auto flex items-center gap-2">
          {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          <LiveBadge>Live · every 5s</LiveBadge>
        </span>
      </div>

      <div className="min-h-0 flex-1 p-4">
        <TerminalWindow title={container.name} className="h-full">
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{logs}</pre>
        </TerminalWindow>
      </div>
    </div>
  )
}

type TermLine = { type: "cmd" | "out" | "err"; text: string }

/** Body of the Shell drawer (one-shot `docker exec` per command). */
export function TerminalPanel({ container }: { container: Container }) {
  const [lines, setLines]   = useState<TermLine[]>([
    { type: "out", text: `Connected to ${container.name}. Type a command below.` },
  ])
  const [cmd, setCmd]       = useState("")
  const [running, setRunning] = useState(false)
  const inputRef            = useRef<HTMLInputElement>(null)

  const run = async () => {
    const trimmed = cmd.trim()
    if (!trimmed || running) return
    setCmd("")
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
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader className="border-b pr-14">
        <SheetTitle className="flex items-center gap-2">
          <Terminal className="size-4 text-[var(--hue-fg,var(--primary))]" />
          Terminal
        </SheetTitle>
        <SheetDescription className="truncate font-mono text-xs">{container.name}</SheetDescription>
      </SheetHeader>

      <div className="min-h-0 flex-1 p-4 pb-2" onClick={() => inputRef.current?.focus()}>
        <TerminalWindow title={container.name} className="h-full">
          {lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap break-all leading-relaxed",
                l.type === "cmd" ? "mb-0.5 text-[var(--t-ok)]" : "mb-2",
                l.type === "err" ? "text-[var(--t-err)]" : l.type === "out" && "text-[var(--t-fg)]",
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
        <Button variant="outline" size="sm" onClick={() => setLines([{ type: "out", text: "Session cleared." }])}>
          Clear
        </Button>
        <Label htmlFor="shell-cmd" className="sr-only">Command</Label>
        <span className="font-mono text-sm text-muted-foreground" aria-hidden>$</span>
        <Input
          id="shell-cmd"
          ref={inputRef}
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") run() }}
          placeholder={running ? "running…" : "type a command…"}
          disabled={running}
          className="flex-1 font-mono"
          autoFocus
          autoComplete="off"
          spellCheck={false}
        />
        <Button size="icon" onClick={run} disabled={running || !cmd.trim()} aria-label="Run command">
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  )
}
