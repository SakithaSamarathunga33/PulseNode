"use client"

import { useMemo, useState } from "react"
import { Pause, Play, Search } from "lucide-react"
import { TerminalWindow } from "@/components/magicui/terminal"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export type LogEntry = { stream: string; line: string; ts: string }

// nixpacks/BuildKit write normal build output to stderr, so colour by content —
// red is reserved for actual errors, not the whole stderr stream.
const isErrorLine = (line: string) =>
  line.includes("✕") || line.includes("✖") ||
  /(^|[^a-z])(error|errors|failed|failure|fatal|panic|exit status [1-9])/i.test(line)

const logColor = (stream: string, line: string) =>
  isErrorLine(line) ? "text-[var(--t-err)]" : stream === "system" ? "text-[var(--t-sys)]" : "text-[var(--t-fg)]"

type State = "live" | "completed" | "failed" | "stopped"

const STATE_STYLE: Record<State, { label: string; cls: string; pulse: boolean }> = {
  live: { label: "Live", cls: "text-success", pulse: true },
  completed: { label: "Completed", cls: "text-success", pulse: false },
  failed: { label: "Failed", cls: "text-danger", pulse: false },
  stopped: { label: "Stopped", cls: "text-muted-foreground", pulse: false },
}

/**
 * Terminal log with the toolbar from the design: state, search, pause/resume and a footer with
 * the line count and transport. Pausing freezes what is shown; new lines keep arriving underneath.
 */
export function LogPane({ title, lines, state, transport, emptyText = "Waiting for logs…", className }: {
  title: string
  lines: LogEntry[]
  state: State
  transport: string
  emptyText?: string
  className?: string
}) {
  const [query, setQuery] = useState("")
  const [frozen, setFrozen] = useState<number | null>(null)
  const paused = frozen !== null
  const st = STATE_STYLE[state]

  const shown = useMemo(() => {
    const base = frozen === null ? lines : lines.slice(0, frozen)
    const q = query.trim().toLowerCase()
    return q ? base.filter(l => l.line.toLowerCase().includes(q)) : base
  }, [lines, frozen, query])

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" className={cn("inline-flex items-center gap-1.5 text-xs font-semibold", paused ? "text-muted-foreground" : st.cls)}>
          <span className={cn("size-1.5 rounded-full bg-current", st.pulse && !paused && "motion-safe:animate-pulse")} aria-hidden />
          {paused ? "Paused" : st.label}
        </span>
        <span className="flex-1" />
        <div className="relative w-full sm:w-44">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            aria-label="Search log"
            placeholder="Search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="h-7 pl-7 font-mono text-xs"
          />
        </div>
        <button
          type="button"
          aria-pressed={paused}
          onClick={() => setFrozen(f => (f === null ? lines.length : null))}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
            paused ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground",
          )}
        >
          {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
          {paused ? "Resume" : "Pause"}
        </button>
      </div>
      <TerminalWindow className="min-h-64 flex-1" title={title}>
        {shown.length === 0 ? (
          <p className="text-[var(--t-muted)]">{query.trim() ? "No lines match the search." : emptyText}</p>
        ) : (
          shown.map((entry, i) => (
            <div key={`${entry.ts}|${i}`} className="flex items-start gap-3">
              {entry.ts && (
                <span className="shrink-0 text-[var(--t-dim)] tabular-nums select-none">
                  {new Date(entry.ts).toLocaleTimeString()}
                </span>
              )}
              <span className={cn("min-w-0 flex-1", logColor(entry.stream, entry.line))}>{entry.line}</span>
            </div>
          ))
        )}
      </TerminalWindow>
      <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{shown.length}{query.trim() ? ` of ${lines.length}` : ""} lines</span>
        <span aria-hidden>·</span>
        <span>{transport}</span>
      </p>
    </div>
  )
}
