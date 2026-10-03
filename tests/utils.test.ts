import { describe, expect, it } from "vitest"
import { shortId, sparkPaths, splitImage, toneFor, trendOf } from "@/components/containers/utils"

describe("toneFor", () => {
  it("uses the 60% / 80% thresholds shown across the dashboard", () => {
    expect(toneFor(0)).toBe("ok")
    expect(toneFor(59.9)).toBe("ok")
    expect(toneFor(60)).toBe("warn")
    expect(toneFor(79.9)).toBe("warn")
    expect(toneFor(80)).toBe("bad")
    expect(toneFor(100)).toBe("bad")
  })
})

describe("splitImage", () => {
  it("splits repo and tag", () => {
    expect(splitImage("ghcr.io/acme/web:1.2")).toEqual({ repo: "ghcr.io/acme/web", tag: "1.2" })
  })
  it("defaults to latest when untagged", () => {
    expect(splitImage("nginx")).toEqual({ repo: "nginx", tag: "latest" })
  })
  it("does not mistake a registry port for a tag", () => {
    expect(splitImage("registry.local:5000/app")).toEqual({ repo: "registry.local:5000/app", tag: "latest" })
    expect(splitImage("registry.local:5000/app:v2")).toEqual({ repo: "registry.local:5000/app", tag: "v2" })
  })
})

describe("shortId", () => {
  it("keeps the first 12 characters", () => {
    expect(shortId("0123456789abcdef")).toBe("0123456789ab")
    expect(shortId("abc")).toBe("abc")
  })
})

describe("sparkPaths", () => {
  it("draws a line and a closed area inside the viewBox", () => {
    const { line, area } = sparkPaths([1, 5, 3], 200, 44)
    expect(line.startsWith("M0.0,")).toBe(true)
    expect(line.match(/L/g)).toHaveLength(2)
    expect(area.endsWith("L200,44 L0,44 Z")).toBe(true)
  })
  it("survives empty and single-point series", () => {
    expect(sparkPaths([]).line).toMatch(/^M0\.0,/)
    expect(sparkPaths([7]).line).toMatch(/^M0\.0,/)
  })
  it("keeps y coordinates finite for a flat series", () => {
    const { line } = sparkPaths([4, 4, 4, 4])
    expect(line).not.toMatch(/NaN|Infinity/)
  })
  it("uses a fixed scale when max is given", () => {
    const low = sparkPaths([0, 0], 100, 40, 100).line
    const high = sparkPaths([100, 100], 100, 40, 100).line
    expect(low).toContain(",37.0")
    expect(high).toContain(",3.0")
  })
})

describe("trendOf", () => {
  it("is neutral with fewer than two samples", () => {
    expect(trendOf([], "%")).toEqual({ text: "0%", up: true })
    expect(trendOf([5], "%")).toEqual({ text: "0%", up: true })
  })
  it("compares the latest sample against the previous average", () => {
    expect(trendOf([10, 10, 10, 20], "%")).toEqual({ text: "+10.0%", up: true })
    expect(trendOf([20, 20, 20, 10], "%")).toEqual({ text: "-10.0%", up: false })
  })
})
