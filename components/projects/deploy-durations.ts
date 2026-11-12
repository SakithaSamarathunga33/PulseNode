const MAX_BARS = 20

type Dep = { ID: string; Status: string; CommitSHA: string; StartedAt: string | null; FinishedAt: string | null }
export type DurationRow = { name: string; success?: number; failed?: number }

/**
 * Finished deployments (both timestamps, success/failed) from a newest-first list, as
 * oldest → newest bar rows keyed by outcome. Labels are the short SHA, made unique
 * because a rollback redeploys the same commit.
 */
export function durationRows(deployments: Dep[]): DurationRow[] {
  const seen = new Map<string, number>()
  return deployments
    .filter(d => d.StartedAt && d.FinishedAt && (d.Status === "success" || d.Status === "failed"))
    .slice(0, MAX_BARS)
    .reverse()
    .flatMap(d => {
      const ms = new Date(d.FinishedAt!).getTime() - new Date(d.StartedAt!).getTime()
      if (!Number.isFinite(ms)) return [] // unparseable timestamp: skip rather than chart NaN
      const secs = Math.max(0, Math.round(ms / 1000))
      const base = d.CommitSHA ? d.CommitSHA.slice(0, 7) : d.ID.slice(0, 7)
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      return [{ name: n > 1 ? `${base} (${n})` : base, [d.Status]: secs }]
    })
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}
