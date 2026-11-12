import { StatusDot, type StatusShape } from "@/components/pn/StatusDot"
import { Pill } from "@/components/dashboard/Pill"
import { cn } from "@/lib/utils"

export type SavedDomain = {
  host: string
  isPrimary: boolean
  pointed: boolean | null
  proxied: boolean
  records: string[] | null
  message?: string
  error?: string
  checkedAt?: string
}

export type DomainStatus = "pointed" | "proxied" | "not" | "unchecked" | "error"

export function statusOf(d: Pick<SavedDomain, "error" | "pointed" | "proxied">): DomainStatus {
  if (d.error) return "error"
  if (d.pointed === null) return "unchecked"
  if (d.proxied) return "proxied"
  return d.pointed ? "pointed" : "not"
}

type PillTone = "ok" | "info" | "bad" | "warn" | "outline"

export const STATUS: Record<DomainStatus, { label: string; shape: StatusShape; tone: PillTone; text: string; desc: string }> = {
  pointed:   { label: "Pointed",     shape: "ok",   tone: "ok",      text: "text-success",          desc: "resolves to this VPS" },
  proxied:   { label: "Proxied",     shape: "info", tone: "info",    text: "text-info",             desc: "behind Cloudflare" },
  not:       { label: "Not pointed", shape: "bad",  tone: "bad",     text: "text-danger",           desc: "resolves elsewhere" },
  unchecked: { label: "Unchecked",   shape: "off",  tone: "outline", text: "text-muted-foreground", desc: "not checked yet" },
  error:     { label: "Error",       shape: "warn", tone: "warn",    text: "text-warning",          desc: "lookup failed" },
}

/** Status pill whose dot shape (circle / ring / diamond / dashed / triangle) carries the meaning as well as the colour. */
export function StatusChip({ status, checking }: { status: DomainStatus; checking?: boolean }) {
  if (checking) {
    return (
      <Pill tone="info" className="whitespace-nowrap">
        <span className="size-2 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden />Checking…
      </Pill>
    )
  }
  const s = STATUS[status]
  return <Pill tone={s.tone} dot className="whitespace-nowrap">{s.label}</Pill>
}

export function StatusLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 border-t px-4 py-2.5 text-xs text-muted-foreground" aria-label="Status legend">
      {(Object.keys(STATUS) as DomainStatus[]).map(k => (
        <li key={k} className="inline-flex items-center gap-1.5">
          <span className={cn("inline-flex", STATUS[k].text)}><StatusDot tone={STATUS[k].shape} /></span>
          <span className="font-medium text-foreground">{STATUS[k].label}</span> {STATUS[k].desc}
        </li>
      ))}
    </ul>
  )
}
