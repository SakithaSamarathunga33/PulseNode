"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, CircleCheck, Copy, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Pill } from "@/components/dashboard/Pill"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { nodeApi } from "@/lib/api"
import { cn, copyText } from "@/lib/utils"

export type WildcardStatus = "ok" | "proxied" | "missing" | "wrong" | "error"

export type WildcardResult = {
  domain: string
  root: string
  probeHost: string
  resolves: boolean
  proxied: boolean
  ips: string[]
  expectedIp: string
  status: WildcardStatus
  message: string
}

const KNOWN: WildcardStatus[] = ["ok", "proxied", "missing", "wrong", "error"]

// Max simultaneous probes, so a long "In use" list does not fire dozens of lookups at once.
const MAX_PARALLEL = 3
let active = 0
const waiting: (() => void)[] = []
const inflight = new Map<string, Promise<WildcardResult>>()

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>(res => waiting.push(res))
  active++
  try { return await fn() } finally {
    active--
    waiting.shift()?.()
  }
}

/** One GET /api/domains/wildcard per host; identical in-flight requests are shared. */
export function fetchWildcard(host: string): Promise<WildcardResult> {
  const existing = inflight.get(host)
  if (existing) return existing
  const p = withSlot(async () => {
    const { data } = await nodeApi.get<Partial<WildcardResult> | null>(`/api/domains/wildcard?domain=${encodeURIComponent(host)}`)
    const status = KNOWN.includes(data?.status as WildcardStatus) ? (data?.status as WildcardStatus) : "error"
    return {
      domain: data?.domain ?? host,
      root: data?.root ?? "",
      probeHost: data?.probeHost ?? "",
      resolves: Boolean(data?.resolves),
      proxied: Boolean(data?.proxied),
      ips: Array.isArray(data?.ips) ? data.ips : [],
      expectedIp: data?.expectedIp ?? "",
      status,
      message: data?.message ?? "",
    } satisfies WildcardResult
  }).finally(() => { inflight.delete(host) })
  inflight.set(host, p)
  return p
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
export const looksLikeHost = (h: string) => h.length <= 253 && HOST_RE.test(h)

type WildcardState = { loading: boolean; data: WildcardResult | null; error: string | null }

/**
 * Checks a hostname against the wildcard record. Lazy (nothing happens until the host looks valid),
 * optionally debounced, and stale responses are dropped when the host changes or the component unmounts.
 */
export function useWildcard(host: string, debounceMs = 0) {
  const [state, setState] = useState<WildcardState>({ loading: false, data: null, error: null })
  const seq = useRef(0)
  const h = host.trim().toLowerCase()

  const invalidate = useCallback(() => { seq.current++ }, [])

  const run = useCallback(async (target: string, keep: boolean) => {
    const mine = ++seq.current
    setState(s => ({ loading: true, data: keep ? s.data : null, error: null }))
    try {
      const data = await fetchWildcard(target)
      if (mine === seq.current) setState({ loading: false, data, error: null })
    } catch (e) {
      if (mine === seq.current) setState({ loading: false, data: null, error: e instanceof Error ? e.message : "Check failed" })
    }
  }, [])

  useEffect(() => {
    if (!looksLikeHost(h)) {
      invalidate()
      setState({ loading: false, data: null, error: null })
      return
    }
    const t = setTimeout(() => { void run(h, false) }, debounceMs)
    return () => { clearTimeout(t); invalidate() }
  }, [h, debounceMs, run, invalidate])

  const recheck = useCallback(() => { if (looksLikeHost(h)) void run(h, true) }, [h, run])
  return { ...state, valid: looksLikeHost(h), recheck }
}

const CHIP: Record<WildcardStatus, { label: string; tone: "ok" | "info" | "warn" | "bad" }> = {
  ok:      { label: "DNS ok",       tone: "ok" },
  proxied: { label: "Proxied",      tone: "info" },
  missing: { label: "No wildcard",  tone: "warn" },
  wrong:   { label: "Wrong IP",     tone: "bad" },
  error:   { label: "Check failed", tone: "warn" },
}

/** Wildcard DNS status chip. The dot shape (circle/ring/triangle/diamond) and the label carry the meaning. */
export function WildcardChip({ loading, data, error, className }: {
  loading: boolean; data: WildcardResult | null; error?: string | null; className?: string
}) {
  if (loading && !data) return <Pill tone="info" className={className}><span className="size-2 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden />Checking…</Pill>
  if (error && !data) return <Pill tone="warn" dot className={className}><span title={error}>Check failed</span></Pill>
  if (!data) return null
  const c = CHIP[data.status]
  return (
    <Pill tone={c.tone} dot className={className}>
      <span title={data.message || undefined}>{c.label}</span>
    </Pill>
  )
}

export const wildcardFixText = (ip: string) =>
  `Add an A record  *  →  ${ip || "<this server's IP>"}  (a wildcard, once) at your DNS provider. Proxied through Cloudflare is fine.`

/** The copyable fix instruction shown for missing/wrong wildcard DNS. */
export function WildcardFix({ expectedIp, className }: { expectedIp: string; className?: string }) {
  const text = wildcardFixText(expectedIp)
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2", className)}>
      <p className="min-w-0 flex-1 text-xs whitespace-pre-wrap break-words">
        Add an A record <code className="rounded bg-muted px-1 font-mono">*</code> →{" "}
        <code className="rounded bg-muted px-1 font-mono tabular-nums">{expectedIp || "<this server's IP>"}</code>{" "}
        (a wildcard, once) at your DNS provider. Proxied through Cloudflare is fine.
      </p>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Copy DNS fix instructions"
              onClick={async () => { if (await copyText(text)) toast.success("DNS instructions copied") }}
            />
          }
        >
          <Copy />
        </TooltipTrigger>
        <TooltipContent>Copy</TooltipContent>
      </Tooltip>
    </div>
  )
}

/** Per-hostname row addition for lists: chip + re-check button, plus the fix text when DNS is missing/wrong. */
export function WildcardInline({ host }: { host: string }) {
  const w = useWildcard(host)
  if (!w.valid) return null
  const needsFix = w.data && (w.data.status === "missing" || w.data.status === "wrong")
  return (
    <div className="flex basis-full flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Wildcard DNS</span>
        <WildcardChip loading={w.loading} data={w.data} error={w.error} />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button type="button" variant="ghost" size="icon-xs" onClick={w.recheck} disabled={w.loading} aria-label={`Re-check wildcard DNS for ${host}`} />
            }
          >
            <RefreshCw className={w.loading ? "animate-spin" : ""} />
          </TooltipTrigger>
          <TooltipContent>Re-check</TooltipContent>
        </Tooltip>
        {w.data?.status === "error" && w.data.message && <span className="text-xs text-muted-foreground">{w.data.message}</span>}
        {w.error && !w.data && <span className="text-xs text-muted-foreground">{w.error}</span>}
      </div>
      {needsFix && w.data && <WildcardFix expectedIp={w.data.expectedIp} />}
    </div>
  )
}

/** Debounced, non-blocking DNS hint for a domain input (new project, project settings). */
export function WildcardHint({ domain, className }: { domain: string; className?: string }) {
  const w = useWildcard(domain, 600)
  if (!w.valid) return null
  const d = w.data
  const bad = d && (d.status === "missing" || d.status === "wrong")
  return (
    <div className={cn("space-y-1.5", className)} role="status" aria-live="polite">
      {w.loading && !d ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden />Checking DNS…
        </p>
      ) : w.error && !d ? (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          Could not check DNS right now.
          <Button type="button" variant="ghost" size="xs" onClick={w.recheck}><RefreshCw />Retry</Button>
        </p>
      ) : d && (d.status === "ok" || d.status === "proxied") ? (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-success">
          <CircleCheck className="size-3.5 shrink-0" aria-hidden />
          {d.status === "proxied" ? "DNS looks good (proxied through Cloudflare)." : "DNS looks good: this domain points to your server."}
          <Button type="button" variant="ghost" size="icon-xs" onClick={w.recheck} disabled={w.loading} aria-label="Re-check DNS"><RefreshCw className={w.loading ? "animate-spin" : ""} /></Button>
        </p>
      ) : bad && d ? (
        <>
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-warning">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            {d.status === "missing" ? "No wildcard DNS record found for this domain yet." : "This domain does not point to your server."}
            <span className="text-muted-foreground">You can still continue.</span>
            <Button type="button" variant="ghost" size="icon-xs" onClick={w.recheck} disabled={w.loading} aria-label="Re-check DNS"><RefreshCw className={w.loading ? "animate-spin" : ""} /></Button>
          </p>
          <WildcardFix expectedIp={d.expectedIp} />
        </>
      ) : d ? (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />{d.message || "Could not check DNS."}
          <Button type="button" variant="ghost" size="icon-xs" onClick={w.recheck} disabled={w.loading} aria-label="Re-check DNS"><RefreshCw className={w.loading ? "animate-spin" : ""} /></Button>
        </p>
      ) : null}
    </div>
  )
}

/** Compact chip for headers: lazy lookup of one hostname, no fix text. */
export function WildcardBadge({ domain }: { domain: string }) {
  const w = useWildcard(domain)
  if (!w.valid || (!w.loading && !w.data && !w.error)) return null
  return (
    <span className="inline-flex items-center gap-1">
      <WildcardChip loading={w.loading} data={w.data} error={w.error} />
      <button
        type="button"
        onClick={w.recheck}
        disabled={w.loading}
        aria-label={`Re-check wildcard DNS for ${domain}`}
        className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
      >
        <RefreshCw className={cn("size-3", w.loading && "animate-spin")} aria-hidden />
      </button>
    </span>
  )
}
