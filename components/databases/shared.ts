const ENGINE_COLOR: Record<string, string> = {
  postgres: "var(--db-postgres)",
  postgresql: "var(--db-postgres)",
  redis: "var(--db-redis)",
  mysql: "var(--db-mysql)",
  clickhouse: "var(--db-clickhouse)",
  mongodb: "var(--db-mongo)",
}

/** Brand colour of a database engine (falls back to the neutral --db-other). */
export function engineColor(engine: string) {
  return ENGINE_COLOR[engine.toLowerCase()] ?? "var(--db-other)"
}

/** Maps a database state to a Pill / filter tone. */
export function statusTone(state: string): "ok" | "warn" | "bad" {
  if (state === "ok") return "ok"
  if (state === "warn") return "warn"
  return "bad"
}

export function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(2)} MB`
}

export function statusLabel(state: string) {
  return state === "ok" ? "Healthy" : state === "warn" ? "Degraded" : "Error"
}
