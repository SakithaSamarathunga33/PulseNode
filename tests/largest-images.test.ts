import { describe, expect, it } from "vitest"
import { largestImages } from "@/components/images/largest-images"

const img = (id: string, repo: string, tag: string, size: string) => ({ id, repo, tag, size })
const parse = (s: string) => parseFloat(s) || 0

describe("largestImages", () => {
  it("returns the N largest, biggest first, with the short repo name as label", () => {
    const rows = largestImages([img("a", "library/redis", "7", "40 MB"), img("b", "ghcr.io/acme/web", "1", "200 MB"), img("c", "node", "20", "130 MB")], parse, 2)
    expect(rows.map(r => r.name)).toEqual(["web", "node"])
    expect(rows.map(r => r.id)).toEqual(["b", "c"])
  })

  it("keeps every label unique, even for several dangling <none>:latest images", () => {
    const rows = largestImages([
      img("a", "<none>", "latest", "300 MB"), img("b", "<none>", "latest", "200 MB"), img("c", "<none>", "latest", "100 MB"),
    ], parse, 6)
    const names = rows.map(r => r.name)
    expect(new Set(names).size).toBe(3)
    expect(names[0]).toBe("<none>")
  })

  it("skips images whose size is zero or unparseable", () => {
    expect(largestImages([img("a", "x", "1", "?"), img("b", "y", "1", "0 MB")], parse, 6)).toEqual([])
  })
})
