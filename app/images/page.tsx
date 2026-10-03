"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { toast } from "sonner"
import { nodeApi } from "@/lib/api"
import type { DockerImage } from "@/lib/types"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { SearchInput } from "@/components/pn/SearchInput"
import { EmptyState } from "@/components/pn/EmptyState"
import { StatCard } from "@/components/dashboard/StatCard"
import { Pill } from "@/components/dashboard/Pill"
import { VulnBar } from "@/components/dashboard/VulnBar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AlertCircle, Layers, Loader2, Trash2, Download, HardDrive, ShieldAlert, PackageSearch } from "lucide-react"
import {
  Docker, GitHubDark, PostgreSQL, MySQL, MariaDB, Redis,
  MongoDB, ClickHouse, Elastic,
} from "developer-icons"

/* ── Registry / image icon ───────────────────────────────────────────── */
type DeveloperIcon = React.ComponentType<React.SVGProps<SVGSVGElement> & { size?: number }>

const IMAGE_ICON_MAP: Array<[RegExp, DeveloperIcon]> = [
  [/postgres/i,   PostgreSQL],
  [/mysql/i,      MySQL],
  [/mariadb/i,    MariaDB],
  [/redis/i,      Redis],
  [/mongo/i,      MongoDB],
  [/clickhouse/i, ClickHouse],
  [/elastic/i,    Elastic],
  [/ghcr\.io/i,   GitHubDark],
]

function RegistryIcon({ repo }: { repo: string }) {
  for (const [re, Icon] of IMAGE_ICON_MAP) {
    if (re.test(repo)) return <Icon size={22} className={Icon === GitHubDark ? "shrink-0 theme-dark-surface-icon" : "shrink-0"} />
  }
  return <Docker size={22} className="shrink-0" />
}

function parseMb(s: string): number {
  const n = parseFloat(s)
  if (s.includes("GB")) return n * 1024
  return n
}

const PULL_EXAMPLES = ["nginx:latest", "postgres:16-alpine", "redis:7-alpine"]

export default function ImagesPage() {
  const [search, setSearch] = useState("")
  const [images, setImages] = useState<DockerImage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [pruning, setPruning] = useState(false)
  const [pullOpen, setPullOpen] = useState(false)
  const [pullImage, setPullImage] = useState("")
  const [pulling, setPulling] = useState(false)
  const [pullError, setPullError] = useState<string | null>(null)

  const fetchImages = useCallback(() => {
    nodeApi.get<DockerImage[]>("/api/docker/images")
      .then(({ data }) => { setImages(data); setLoadError(false) })
      .catch(() => setLoadError(true))
      .finally(() => setLoaded(true))
  }, [])

  useEffect(() => { fetchImages() }, [fetchImages])

  const handlePrune = useCallback(async () => {
    setPruning(true)
    try {
      const res = await nodeApi.post<{ reclaimedMB: string }>("/api/docker/images/prune")
      toast.success(`Pruned unused images · ${res.reclaimedMB} MB reclaimed`)
      fetchImages()
    } catch (e: unknown) {
      toast.error(`Error: ${e instanceof Error ? e.message : "prune failed"}`)
    } finally {
      setPruning(false)
    }
  }, [fetchImages])

  const handlePull = useCallback(async () => {
    if (!pullImage.trim()) return
    setPulling(true)
    setPullError(null)
    try {
      await nodeApi.post("/api/docker/pull", { image: pullImage.trim() })
      toast.success(`Pulled ${pullImage.trim()} successfully`)
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

  const totalMb   = images.reduce((s, i) => s + parseMb(i.size), 0)
  const unused    = images.filter(i => i.used === 0).length
  const vulnSum   = images.reduce((s, i) => s + i.vulns.crit + i.vulns.high, 0)
  const avgLayers = images.length > 0 ? Math.round(images.reduce((s, i) => s + i.layers, 0) / images.length) : 0

  const filtered = useMemo(() => images.filter(img =>
    img.repo.toLowerCase().includes(search.toLowerCase()) ||
    img.tag.toLowerCase().includes(search.toLowerCase())
  ), [images, search])

  return (
    <>
      <PageHeader
        icon={Layers}
        title="Images"
        description={`${images.length} images · ${Math.round(totalMb)} MB · ${unused} unused`}
        actions={
          <>
            <Button variant="outline" onClick={handlePrune} disabled={pruning}>
              {pruning ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Prune unused
            </Button>
            <Button onClick={() => setPullOpen(true)}>
              <Download className="size-4" />
              Pull image
            </Button>
          </>
        }
      />
      <PageBody className="motion-safe:animate-in fade-in-0 duration-300">
        {loadError && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load images</AlertTitle>
            <AlertDescription>The Docker API did not respond. The list may be out of date.</AlertDescription>
          </Alert>
        )}
        {!loaded ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)}
          </div>
        ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard icon={Layers} label="Total images" value={images.length} tone="acc" />
          <StatCard icon={HardDrive} label="Disk used" value={Math.round(totalMb)} unit="MB" tone="info" />
          <StatCard icon={ShieldAlert} label="Vulnerabilities" value={vulnSum} tone={vulnSum > 0 ? "bad" : "ok"} sub="crit + high" />
          <StatCard icon={Layers} label="Avg layers" value={avgLayers} tone="acc" />
        </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search images…"
            aria-label="Search images"
          />
        </div>

        {!loaded ? (
          <div className="space-y-3 rounded-xl border bg-card p-4">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={PackageSearch}
            title={images.length === 0 ? "No images yet" : "No images match your search"}
            description={images.length === 0 ? "Pull an image to get started." : "Try a different repository or tag."}
            action={images.length === 0 ? <Button onClick={() => setPullOpen(true)}>Pull image</Button> : undefined}
          />
        ) : (
          <Card className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repository</TableHead>
                  <TableHead>Tag</TableHead>
                  <TableHead>Digest</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Layers</TableHead>
                  <TableHead>Vulnerabilities</TableHead>
                  <TableHead>Used by</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((img, i) => (
                  <TableRow key={`${img.id}-${img.repo}-${img.tag}-${i}`}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <RegistryIcon repo={img.repo} />
                        <span className="max-w-[220px] truncate text-sm font-medium" title={img.repo}>{img.repo}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-[11px]">{img.tag}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {img.id.replace("sha256:", "").slice(0, 12)}…
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{img.size}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{img.layers}</TableCell>
                    <TableCell><VulnBar v={img.vulns} /></TableCell>
                    <TableCell>
                      <Pill tone={img.used > 0 ? "ok" : "outline"} dot={img.used > 0}>
                        {img.used > 0 ? `${img.used} container${img.used > 1 ? "s" : ""}` : "unused"}
                      </Pill>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{img.created}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </PageBody>

      <Dialog open={pullOpen} onOpenChange={setPullOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pull image</DialogTitle>
            <DialogDescription>Enter a full image reference to pull onto this host.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pull-image">Image reference</Label>
            <Input
              id="pull-image"
              autoFocus
              value={pullImage}
              onChange={e => setPullImage(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handlePull() }}
              placeholder="image:tag"
              className="font-mono"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Examples:</span>
              {PULL_EXAMPLES.map(ex => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setPullImage(ex)}
                  className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
          {pullError && (
            <Alert variant="destructive">
              <AlertDescription>{pullError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPullOpen(false)}>Cancel</Button>
            <Button onClick={handlePull} disabled={pulling || !pullImage.trim()}>
              {pulling && <Loader2 className="size-4 animate-spin" />}
              Pull
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
