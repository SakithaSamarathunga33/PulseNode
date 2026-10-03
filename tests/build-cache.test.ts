import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({ API_BASE: "http://api.test" }))

import { clearBuildCache, type CacheState } from "@/lib/build-cache"

const enc = new TextEncoder()

function streamOf(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach(s => c.enqueue(enc.encode(s)))
      c.close()
    },
  })
  return new Response(body, { status: 200 })
}

async function run(res: Response | Error) {
  vi.stubGlobal("fetch", vi.fn(async () => { if (res instanceof Error) throw res; return res }))
  const lines: string[] = []
  const states: CacheState[] = []
  await clearBuildCache({ onLine: l => lines.push(l), onState: s => states.push(s), readerRef: { current: null } })
  return { lines, states }
}

const line = (text: string) => `data: ${JSON.stringify({ type: "line", text })}\n\n`
const done = `data: ${JSON.stringify({ type: "done" })}\n\n`

afterEach(() => vi.unstubAllGlobals())

describe("clearBuildCache", () => {
  it("reassembles an SSE line split across network chunks", async () => {
    const full = line("Total reclaimed space: 1.2GB")
    const { lines, states } = await run(streamOf([full.slice(0, 20), full.slice(20), done]))
    expect(lines).toContain("Total reclaimed space: 1.2GB")
    expect(states).toEqual(["running", "done"])
  })

  it("only reports done when the server says so", async () => {
    const { lines, states } = await run(streamOf([line("pruning…")]))
    expect(states).toEqual(["running", "error"])
    expect(lines.at(-1)).toMatch(/ended before the server reported completion/)
  })

  it("treats a non-2xx response as an error, not an empty success", async () => {
    const { lines, states } = await run(new Response("nope", { status: 500 }))
    expect(states).toEqual(["running", "error"])
    expect(lines.at(-1)).toMatch(/500/)
  })

  it("surfaces a server-reported error", async () => {
    const err = `data: ${JSON.stringify({ type: "error", text: "daemon unreachable" })}\n\n`
    const { lines, states } = await run(streamOf([err]))
    expect(states).toEqual(["running", "error"])
    expect(lines).toContain("✗ daemon unreachable")
  })

  it("handles a final event without a trailing newline", async () => {
    const { states } = await run(streamOf([done.trimEnd()]))
    expect(states).toEqual(["running", "done"])
  })

  it("reports network failures", async () => {
    const { lines, states } = await run(new Error("connection refused"))
    expect(states).toEqual(["running", "error"])
    expect(lines.at(-1)).toBe("✗ connection refused")
  })
})
