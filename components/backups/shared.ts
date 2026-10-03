import { nodeApi, API_BASE, type ApiError } from "@/lib/api"

export type DestType = "local" | "s3"

export type Destination = {
  id: string
  name: string
  type: DestType
  enabled: boolean
  dir?: string
  endpoint?: string
  region?: string
  bucket?: string
  prefix?: string
  useSSL?: boolean
  pathStyle?: boolean
  accessKeyHint?: string
  secretSet?: boolean
}

export type Frequency = "hourly" | "daily" | "weekly"

export type Schedule = {
  id: string
  name: string
  /** "panel" or "db:<managedDatabaseId>" */
  target: string
  targetName?: string
  frequency: Frequency
  hour: number
  weekday: number
  retention: number
  destinationIds: string[]
  encrypt: boolean
  notifyOnSuccess: boolean
  enabled: boolean
  lastRunAt?: string | number | null
  lastStatus?: string | null
  nextRunAt?: string | number | null
}

export type HistoryFile = { destinationId: string; destinationName: string; name: string; ok: boolean; error?: string }

export type HistoryEntry = {
  id: string
  scheduleId: string
  scheduleName: string
  target: string
  targetName?: string
  startedAt: string | number
  finishedAt?: string | number | null
  status: "running" | "success" | "failed"
  sizeBytes: number
  encrypted: boolean
  error?: string
  files: HistoryFile[]
}

export type BackupStatus = {
  schedulerRunning: boolean
  lastRunAt?: string | number | null
  nextRunAt?: string | number | null
  failedLast24h: number
  destinations: number
  schedules: number
  passphraseSet: boolean
}

export type ManagedDb = { id: string; name: string; engine: string; status?: string }

export type TestResult = { ok?: boolean; message?: string; error?: string }

export const isPanel = (target: string) => target === "panel"
export const dbIdOf = (target: string) => (target.startsWith("db:") ? target.slice(3) : "")

export function targetText(target: string, name?: string) {
  return isPanel(target) ? "Panel (settings, keys, database)" : name || target
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const pad = (n: number) => String(n).padStart(2, "0")

export function frequencyText(s: Pick<Schedule, "frequency" | "hour" | "weekday">) {
  if (s.frequency === "hourly") return "Every hour"
  const at = `${pad(s.hour)}:00`
  return s.frequency === "weekly" ? `${WEEKDAYS[s.weekday] ?? "Weekly"}s at ${at}` : `Daily at ${at}`
}

/** Accepts ISO strings, unix seconds or unix milliseconds. */
export function toMs(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "" || v === 0) return null
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v
  const t = Date.parse(v)
  return Number.isNaN(t) || t <= 0 ? null : t
}

export function absTime(v: string | number | null | undefined) {
  const ms = toMs(v)
  return ms === null ? "—" : new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

/** "5 min ago" / "in 2 h". */
export function relTime(v: string | number | null | undefined, now = Date.now()) {
  const ms = toMs(v)
  if (ms === null) return "never"
  const diff = ms - now
  const abs = Math.abs(diff)
  const unit = abs < 60_000 ? "less than a minute" : abs < 3_600_000 ? `${Math.round(abs / 60_000)} min` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)} h` : `${Math.round(abs / 86_400_000)} d`
  if (abs < 60_000) return diff < 0 ? "just now" : "in under a minute"
  return diff < 0 ? `${unit} ago` : `in ${unit}`
}

export function fmtSize(b: number) {
  if (!b || b < 0) return "—"
  const u = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let n = b
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`
}

export function errMsg(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback
}

export const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

async function send<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    if (res.status === 401 && window.location.pathname !== "/login") window.location.href = "/login"
    const b = await res.json().catch(() => ({})) as { error?: string }
    const err = new Error(b.error ?? `${res.status} request failed`)
    ;(err as ApiError).status = res.status
    throw err
  }
  // Mutations may answer with an empty body; never let that look like a failure.
  return res.json().catch(() => ({})) as Promise<T>
}

export const api = {
  get: <T,>(path: string) => nodeApi.get<T>(path).then(r => r.data),
  post: <T,>(path: string, body?: unknown) => send<T>("POST", path, body ?? {}),
  patch: <T,>(path: string, body: unknown) => send<T>("PATCH", path, body),
  del: <T,>(path: string) => send<T>("DELETE", path),
}
