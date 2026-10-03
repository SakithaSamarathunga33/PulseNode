import { StatusDot, type StatusShape } from "@/components/pn/StatusDot"
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

export const STATUS: Record<DomainStatus, { label: string; shape: StatusShape; chip: string; desc: string }> = {
  pointed:   { label: "Pointed",     shape: "ok",   chip: "bg-success/12 text-success",  desc: "resolves to this VPS" },
  proxied:   { label: "Proxied",     shape: "info", chip: "bg-info/12 text-info",        desc: "behind Cloudflare" },
  not:       { label: "Not pointed", shape: "bad",  chip: "bg-danger/12 text-danger",    desc: "resolves elsewhere" },
  unchecked: { label: "Unchecked",   shape: "off",  chip: "bg-muted text-muted-foreground", desc: "not checked yet" },
  error:     { label: "Error",       shape: "warn", chip: "bg-warning/12 text-warning",  desc: "lookup failed" },
}

/** Status chip whose shape (circle / ring / diamond / dashed / triangle) carries the meaning as well as the colour. */
export function StatusChip({ status, checking }: { status: DomainStatus; checking?: boolean }) {
  const s = STATUS[status]
  return (
    <span className={cn("inline-flex h-[22px] items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium whitespace-nowrap", checking ? "bg-info/12 text-info" : s.chip)}>
      {checking ? <span className="size-2 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden /> : <StatusDot tone={s.shape} />}
      {checking ? "Checking…" : s.label}
    </span>
  )
}

export function StatusLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 bg-muted/40 px-[18px] py-2.5 text-[11px] text-muted-foreground" aria-label="Status legend">
      {(Object.keys(STATUS) as DomainStatus[]).map(k => (
        <li key={k} className="inline-flex items-center gap-1.5">
          <span className={cn("inline-flex", STATUS[k].chip.split(" ")[1])}><StatusDot tone={STATUS[k].shape} /></span>
          <b className="font-semibold text-foreground/80">{STATUS[k].label}</b> {STATUS[k].desc}
        </li>
      ))}
    </ul>
  )
}
