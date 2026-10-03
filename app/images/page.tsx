"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { toast } from "sonner"
import { nodeApi } from "@/lib/api"
import type { DockerImage } from "@/lib/types"
import { useTimeouts } from "@/lib/use-timeouts"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { SearchInput } from "@/components/pn/SearchInput"
import { EmptyState } from "@/components/pn/EmptyState"
import { SummaryStrip } from "@/components/pn/SummaryStrip"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import {
  ImageCards, ImageTable, fmtMb, parseMb, shortDigest, sortValue, type Sort, type SortKey,
} from "@/components/images/ImageParts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertCircle, Check, Download, HardDrive, Layers, Loader2, PackageSearch, RefreshCw, ShieldAlert, Trash2,
} from "lucide-react"

const PULL_EXAMPLES = ["nginx:latest", "postgres:16-alpine", "redis:7-alpine"]

export default function ImagesPage() {
  const [search, setSearch] = useState("")
  const [unusedOnly, setUnusedOnly] = useState(false)
  const [sort, setSort] = useState<Sort>({ key: "size", dir: -1 })
  const [images, setImages] = useState<DockerImage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [pruneOpen, setPruneOpen] = useState(false)
  const [pruning, setPruning] = useState(false)
  const [pullOpen, setPullOpen] = useState(false)
  const [pullImage, setPullImage] = useState("")
  const [pulling, setPulling] = useState(false)
  const [pullError, setPullError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const later = useTimeouts()

  const fetchImages = useCallback(() => {
    nodeApi.get<DockerImage[]>("/api/docker/images")
      .then(({ data }) => { setImages(Array.isArray(data) ? data : []); setLoadError(false) })
      .catch(() => setLoadError(true))
      .finally(() => setLoaded(true))
  }, [])

  useEffect(() => { fetchImages() }, [fetchImages])

  // "/" focuses the search box (unless you are already typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const handlePrune = useCallback(async () => {
    setPruning(true)
    try {
      const res = await nodeApi.post<{ reclaimedMB: string }>("/api/docker/images/prune")
      toast.success(`Pruned unused images · ${res.reclaimedMB} MB reclaimed`)
      setPruneOpen(false)
      fetchImages()
    } catch (e: unknown) {
      toast.error(`Error: ${e instanceof Error ? e.message : "prune failed"}`)
    } finally {
      setPruning(false)
    }
  }, [fetchImages])

  const handlePull = useCallback(async () => {
    const ref = pullImage.trim()
    if (!ref) return
    setPulling(true)
    setPullError(null)
    try {
      await nodeApi.post("/api/docker/pull", { image: ref })
      toast.success(`Pulled ${ref} successfully`)
      fetchImages()
      setPullOpen(false)
    } catch (e: unknown) {
      setPullError(e instanceof Error ? e.message : "pull failed")
    } finally {
      setPulling(false)
    }
  }, [pullImage, fetchImages])

  useEffect(() => {
    if (!pullOpen) { setPullImage(""); setPullError(null); setPulling(false) }
  }, [pullOpen])

  const copyDigest = useCallback((id: string) => {
    navigator.clipboard?.writeText(id).then(
      () => { setCopied(id); toast.success("Digest copied"); later(() => setCopied(c => (c === id ? null : c)), 1500) },
      () => toast.error("Could not copy"),
    )
  }, [later])

  const onSort = (key: SortKey) =>
    setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "repo" ? 1 : -1 }))

  const stats = useMemo(() => {
    const totalMb = images.reduce((s, i) => s + parseMb(i.size), 0)
    const unused = images.filter(i => i.used === 0)
    const vt = images.reduce(
      (a, i) => ({ crit: a.crit + i.vulns.crit, high: a.high + i.vulns.high, med: a.med + i.vulns.med, low: a.low + i.vulns.low }),
      { crit: 0, high: 0, med: 0, low: 0 },
    )
    const layers = images.map(i => i.layers)
    return {
      totalMb, unused,
      reclaimMb: unused.reduce((s, i) => s + parseMb(i.size), 0),
      vt, findings: vt.crit + vt.high + vt.med + vt.low,
      avgLayers: layers.length ? layers.reduce((a, b) => a + b, 0) / layers.length : 0,
      maxLayers: layers.length ? Math.max(...layers) : 0,
    }
  }, [images])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const get = sortValue[sort.key]
    return images
      .filter(i => (!unusedOnly || i.used === 0) && (!q || `${i.repo}:${i.tag}`.toLowerCase().includes(q)))
      .sort((a, b) => { const x = get(a), y = get(b); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir })
  }, [images, search, unusedOnly, sort])

  const { totalMb, unused, reclaimMb, vt, findings, avgLayers, maxLayers } = stats

  return (
    <>
      <PageHeader
        icon={Layers}
        title="Images"
        description={`${images.length} images · ${fmtMb(totalMb)} · ${unused.length} unused`}
        actions={
          <>
            <Button variant="outline" onClick={() => setPruneOpen(true)} disabled={pruning || unused.length === 0}>
              <Trash2 className="size-4" />Prune unused
            </Button>
            <Button onClick={() => setPullOpen(true)}>
              <Download className="size-4" />Pull image
            </Button>
          </>
        }
      />
      <PageBody className="motion-safe:animate-in fade-in-0 duration-300">
        {loadError && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load images</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-3">
              The Docker API did not respond. The list may be out of date.
              <Button size="sm" variant="outline" onClick={fetchImages}><RefreshCw className="size-3.5" />Retry</Button>
            </AlertDescription>
          </Alert>
        )}

        {!loaded ? (
          <Skeleton className="h-[112px] rounded-xl" />
        ) : (
          <SummaryStrip
            items={[
              { label: "Total", icon: Layers, value: images.length, unit: "images", meta: `${unused.length} unused` },
              { label: "Disk", icon: HardDrive, value: (totalMb / 1024).toFixed(2), unit: "GB", meta: `${(reclaimMb / 1024).toFixed(2)} GB reclaimable` },
              { label: "Vulnerabilities", icon: ShieldAlert, value: findings, unit: "findings", meta: `${vt.crit} critical · ${vt.high} high`, tone: vt.crit > 0 ? "bad" : vt.high > 0 ? "warn" : undefined },
              { label: "Average layers", icon: Layers, value: avgLayers.toFixed(1), unit: "per image", meta: `max ${maxLayers}` },
            ]}
          />
        )}

        <section aria-label="Image list" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              ref={searchRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search repository or tag"
              aria-label="Search images"
              className="max-w-[320px]"
            />
            <Button
              variant={unusedOnly ? "secondary" : "outline"} size="sm" aria-pressed={unusedOnly}
              onClick={() => setUnusedOnly(v => !v)}
            >
              {unusedOnly && <Check className="size-3.5" />}Unused only
            </Button>
            <span className="ml-auto text-xs text-muted-foreground">{rows.length} shown</span>
          </div>

          {!loaded ? (
            <div className="space-y-3 rounded-xl border bg-card p-4">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={PackageSearch}
              title={images.length === 0 ? "No images yet" : "No images match the current filter"}
              description={images.length === 0 ? "Pull an image to get started." : "Try a different repository or tag, or clear “Unused only”."}
              action={images.length === 0 ? <Button onClick={() => setPullOpen(true)}>Pull image</Button> : undefined}
            />
          ) : (
            <>
              <div className="md:hidden"><ImageCards rows={rows} copied={copied} onCopy={copyDigest} /></div>
              <Card className="hidden gap-0 overflow-hidden py-0 md:block">
                <div className="overflow-x-auto">
                  <ImageTable rows={rows} copied={copied} onCopy={copyDigest} sort={sort} onSort={onSort} />
                </div>
              </Card>
            </>
          )}
        </section>
      </PageBody>

      <ConfirmDialog
        open={pruneOpen}
        onOpenChange={setPruneOpen}
        title={`Prune ${unused.length} unused image${unused.length === 1 ? "" : "s"}?`}
        icon={Trash2}
        items={unused.map(i => ({ primary: `${i.repo}:${i.tag}`, secondary: `${i.size} · ${shortDigest(i.id)}` }))}
        note={`Frees about ${fmtMb(reclaimMb)}. This action cannot be undone.`}
        confirmLabel="Prune images"
        loading={pruning}
        onConfirm={handlePrune}
      />

      <Dialog open={pullOpen} onOpenChange={o => { if (!pulling) setPullOpen(o) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Download className="size-4" />Pull image</DialogTitle>
            <DialogDescription>Enter a full image reference to pull onto this host.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pull-image">Image reference</Label>
            <Input
              id="pull-image"
              autoFocus
              value={pullImage}
              disabled={pulling}
              spellCheck={false}
              onChange={e => setPullImage(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handlePull() }}
              placeholder="e.g. node:20-alpine or ghcr.io/org/app:tag"
              className="font-mono"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Examples:</span>
              {PULL_EXAMPLES.map(ex => (
                <button
                  key={ex} type="button" disabled={pulling} onClick={() => setPullImage(ex)}
                  className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
          {pulling && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" />Pulling {pullImage.trim()} — large images can take a minute.
            </p>
          )}
          {pullError && (
            <Alert variant="destructive"><AlertDescription>{pullError}</AlertDescription></Alert>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={pulling} onClick={() => setPullOpen(false)}>Cancel</Button>
            <Button onClick={handlePull} disabled={pulling || !pullImage.trim()}>
              {pulling && <Loader2 className="size-4 animate-spin" />}
              {pulling ? "Pulling…" : "Pull"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
