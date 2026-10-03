import { API_BASE } from "@/lib/api"

export type CacheState = "idle" | "running" | "done" | "error"

type ReaderRef = { current: ReadableStreamDefaultReader<Uint8Array> | null }

/**
 * Streams `docker builder prune` output from the backend (SSE over POST).
 * Lines are re-assembled across network chunks; the run only counts as "done"
 * when the server says so, and a non-2xx response or a cut-off stream is an error.
 */
export async function clearBuildCache({ onLine, onState, readerRef }: {
  onLine: (line: string) => void
  onState: (s: CacheState) => void
  readerRef: ReaderRef
}) {
  onLine("$ docker builder prune -f")
  onState("running")
  let finished = false
  let hasReader = false
  const finish = (s: "done" | "error") => { finished = true; onState(s) }

  try {
    const res = await fetch(`${API_BASE}/api/docker/build-cache/clear`, { method: "POST" })
    if (res.status === 401 && typeof window !== "undefined") { window.location.href = "/login"; return }
    if (!res.ok) throw new Error(`Server responded ${res.status}`)
    if (!res.body) throw new Error("No response body")

    const reader = res.body.getReader()
    readerRef.current = reader
    hasReader = true
    const decoder = new TextDecoder()
    let buf = ""

    const handle = (raw: string) => {
      const line = raw.trim()
      if (!line.startsWith("data:")) return
      try {
        const payload = JSON.parse(line.slice(5).trim())
        if (payload.type === "line") onLine(payload.text)
        else if (payload.type === "done") { onLine("✔ Build cache cleared."); finish("done") }
        else if (payload.type === "error") { onLine(`✗ ${payload.text}`); finish("error") }
      } catch { /* malformed SSE line — skip */ }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      lines.forEach(handle)
    }
    buf += decoder.decode()
    if (buf) handle(buf)
    if (!finished) { onLine("✗ The stream ended before the server reported completion."); finish("error") }
  } catch (err) {
    // Closing the dialog cancels the reader; that is not a failure.
    if (hasReader && readerRef.current === null) return
    onLine(`✗ ${err instanceof Error ? err.message : String(err)}`)
    finish("error")
  }
}
