/** Helpers shared by the Dashboard's host-health card and container table. */

export type Tone = "ok" | "warn" | "bad"

/** Usage thresholds used everywhere on the dashboard: 60% = elevated, 80% = high. */
export const toneFor = (pct: number): Tone => (pct >= 80 ? "bad" : pct >= 60 ? "warn" : "ok")

export const TONE_TEXT: Record<Tone, string> = { ok: "text-success", warn: "text-warning", bad: "text-danger" }
export const TONE_BG: Record<Tone, string> = { ok: "bg-success", warn: "bg-warning", bad: "bg-danger" }

/** Splits "ghcr.io/acme/web:1.2" into repo + tag ("latest" when untagged; registry ports are not tags). */
export function splitImage(image: string): { repo: string; tag: string } {
  const colon = image.lastIndexOf(":")
  if (colon > image.lastIndexOf("/") && colon > 0) return { repo: image.slice(0, colon), tag: image.slice(colon + 1) }
  return { repo: image, tag: "latest" }
}

export const shortId = (id: string) => id.slice(0, 12)

/** Line + filled-area SVG paths for a series (viewBox w×h). `max` fixes the scale; otherwise it auto-fits. */
export function sparkPaths(data: number[], w = 200, h = 44, max?: number) {
  const d = data.length >= 2 ? data : [0, 0]
  const lo = max === undefined ? Math.min(...d) : 0
  const hi = max === undefined ? Math.max(...d) : max
  const pad = max === undefined ? (hi - lo || 1) * 0.15 : 0
  const range = hi + pad - (lo - pad) || 1
  const x = (i: number) => (i * w) / (d.length - 1)
  const y = (v: number) => h - 3 - ((v - (lo - pad)) / range) * (h - 6)
  const line = d.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")
  return { line, area: `${line} L${w},${h} L0,${h} Z` }
}

/** Change of the latest sample against the average of the 12 before it. */
export function trendOf(data: number[], unit: string) {
  if (data.length < 2) return { text: `0${unit}`, up: true }
  const last = data[data.length - 1]
  const prev = data.slice(-13, -1)
  const avg = prev.reduce((a, b) => a + b, 0) / (prev.length || 1)
  const delta = last - avg
  return { text: `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}${unit}`, up: delta >= 0 }
}
