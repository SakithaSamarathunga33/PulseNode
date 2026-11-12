import { describe, expect, it } from "vitest"
import { shortId, splitImage, toneFor, trendOf } from "@/components/containers/utils"

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
