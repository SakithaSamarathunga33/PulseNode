"use client"

import { useState, useEffect, useMemo, useCallback } from "react"
import { toast } from "sonner"
import {
  ShieldCheck, Package, Play, Eye, CheckCircle2, XCircle, Loader2, ScanSearch, AlertCircle, CircleSlash,
} from "lucide-react"
import { nodeApi } from "@/lib/api"
import type { Scan } from "@/lib/types"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { SearchInput } from "@/components/pn/SearchInput"
import { EmptyState } from "@/components/pn/EmptyState"
import { StatCard } from "@/components/dashboard/StatCard"
import { Pill } from "@/components/dashboard/Pill"
import { VulnBar } from "@/components/dashboard/VulnBar"
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
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type ScanRow = Omit<Scan, "status"> & { status: Scan["status"] | "unavailable"; message?: string }

function StatusPill({ status }: { status: ScanRow["status"] }) {
  switch (status) {
    case "done":
      return <Pill tone="ok"><CheckCircle2 className="size-3" />Done</Pill>
    case "failed":
      return <Pill tone="bad"><XCircle className="size-3" />Failed</Pill>
    case "unavailable":
      return <Pill tone="warn"><CircleSlash className="size-3" />Unavailable</Pill>
    case "running":
      return <Pill tone="info"><Loader2 className="size-3 animate-spin" />Running</Pill>
    default:
      return <Pill tone="outline">{status}</Pill>
  }
}

function SevTile({ label, value, tone }: { label: string; value: number; tone: "crit" | "high" | "med" | "low" }) {
  return (
    <div
      className="rounded-lg p-3 text-center"
      style={{ background: `var(--sev-${tone}-bg)`, color: `var(--sev-${tone}-fg)` }}
    >
      <p className="text-xl font-bold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs font-semibold tracking-wider">{label}</p>
    </div>
  )
}

export default function ScanHistoryPage() {
  const [selectedScan, setSelectedScan] = useState<ScanRow | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [scans, setScans] = useState<ScanRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scanner, setScanner] = useState<{ trivy: boolean; syft: boolean } | null>(null)
  const [scanModalOpen, setScanModalOpen] = useState(false)
  const [scanTarget, setScanTarget] = useState("")
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)

  const loadScans = useCallback(() => {
    nodeApi.get<ScanRow[]>("/security/scans")
      .then(({ data }) => { setScans(data); setLoadError(null) })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : "Could not load scans"))
  }, [])

  useEffect(() => {
    loadScans()
    nodeApi.get<{ trivy: boolean; syft: boolean }>("/security/status").then(({ data }) => setScanner(data)).catch(() => {})
  }, [loadScans])

  useEffect(() => {
    if (!scanModalOpen) { setScanTarget(""); setScanError(null); setScanning(false) }
  }, [scanModalOpen])

  async function runScan() {
    if (!scanTarget.trim()) return
    setScanning(true)
    setScanError(null)
    try {
      const res = await nodeApi.post<ScanRow>("/security/scan", { target: scanTarget.trim() })
      if (res.status === "unavailable") {
        setScanError(res.message ?? "The scanner is not available in this PulseNode image.")
        return
      }
      if (res.status === "failed") {
        setScanError(res.message ?? "The scan failed.")
        loadScans()
        return
      }
      toast.success(`Scan finished for ${scanTarget.trim()}`)
      setScanModalOpen(false)
      loadScans()
    } catch (e: unknown) {
      setScanError(e instanceof Error ? e.message : "scan failed")
    } finally {
      setScanning(false)
    }
  }

  const list = useMemo(() => scans ?? [], [scans])
  const succeeded = list.filter(s => s.status === "done").length
  const failed    = list.filter(s => s.status === "failed").length

  const totalCrit = list.filter(s => s.status === "done").reduce((a, s) => a + s.crit, 0)
  const totalHigh = list.filter(s => s.status === "done").reduce((a, s) => a + s.high, 0)
  const totalMed  = list.filter(s => s.status === "done").reduce((a, s) => a + s.med, 0)
  const totalLow  = list.filter(s => s.status === "done").reduce((a, s) => a + s.low, 0)

  const filteredScans = useMemo(() => list.filter(s =>
    !search ||
    s.id.toLowerCase().includes(search.toLowerCase()) ||
    s.image.toLowerCase().includes(search.toLowerCase())
  ), [list, search])

  function openSheet(scan: ScanRow) {
    setSelectedScan(scan)
    setSheetOpen(true)
  }

  return (
    <>
      <PageHeader
        icon={ShieldCheck}
        title="Scan History"
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="tabular-nums">{list.length} scans</span>
            <Pill tone="ok" dot>{succeeded} succeeded</Pill>
            <Pill tone={failed > 0 ? "bad" : "outline"} dot={failed > 0}>{failed} failed</Pill>
          </span>
        }
        actions={
          <Button onClick={() => setScanModalOpen(true)}>
            <Play className="size-4" />
            Scan now
          </Button>
        }
      />
      <PageBody className="motion-safe:animate-in fade-in-0 duration-300">
        {loadError && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load scan history</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}
        {scanner && !scanner.trivy && (
          <Alert>
            <CircleSlash />
            <AlertTitle>Vulnerability scanner not installed</AlertTitle>
            <AlertDescription>This PulseNode image has no Trivy, so scans cannot run. Update PulseNode to get the built-in scanner. No results are ever estimated.</AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Critical" value={totalCrit} tone="bad" sub="across all scans" />
          <StatCard label="High" value={totalHigh} tone="warn" sub="across all scans" />
          <StatCard label="Medium" value={totalMed} tone="info" sub="across all scans" />
          <StatCard label="Low" value={totalLow} tone="ok" sub="across all scans" />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search scans…"
            aria-label="Search scans"
          />
        </div>

        {scans === null && !loadError ? (
          <Skeleton className="h-48 rounded-xl" />
        ) : filteredScans.length === 0 ? (
          <EmptyState
            icon={ScanSearch}
            title={list.length === 0 ? "No scans yet" : "No scans match your search"}
            description={list.length === 0 ? "Run a scan to check an image for vulnerabilities." : "Try a different scan ID or image."}
            action={list.length === 0 ? <Button onClick={() => setScanModalOpen(true)}>Scan now</Button> : undefined}
          />
        ) : (
          <Card className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scan ID</TableHead>
                  <TableHead>Image</TableHead>
                  <TableHead>Scanner</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead>Findings</TableHead>
                  <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredScans.map(scan => (
                  <TableRow
                    key={scan.id}
                    className="cursor-pointer"
                    onClick={() => openSheet(scan)}
                  >
                    <TableCell className="font-mono text-xs text-muted-foreground">{scan.id}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Package className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="max-w-[220px] truncate font-mono text-xs" title={scan.image}>{scan.image}</span>
                      </div>
                    </TableCell>
                    <TableCell><Pill tone="outline">{scan.scanner}</Pill></TableCell>
                    <TableCell><StatusPill status={scan.status} /></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{scan.started}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{scan.duration}</TableCell>
                    <TableCell>
                      <VulnBar v={{ crit: scan.crit, high: scan.high, med: scan.med, low: scan.low }} />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`View report for ${scan.id}`}
                        onClick={e => { e.stopPropagation(); openSheet(scan) }}
                      >
                        <Eye className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </PageBody>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="font-mono text-sm">Scan report · {selectedScan?.id ?? "—"}</SheetTitle>
            <SheetDescription className="truncate font-mono text-xs">{selectedScan?.image}</SheetDescription>
          </SheetHeader>
          {selectedScan && (
            <div className="space-y-4 px-4 pb-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={selectedScan.status} />
                <Pill tone="outline">{selectedScan.scanner}</Pill>
                <span className="text-xs text-muted-foreground">
                  {selectedScan.started} · <span className="font-mono tabular-nums">{selectedScan.duration}</span>
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <SevTile label="CRIT" value={selectedScan.crit} tone="crit" />
                <SevTile label="HIGH" value={selectedScan.high} tone="high" />
                <SevTile label="MED" value={selectedScan.med} tone="med" />
                <SevTile label="LOW" value={selectedScan.low} tone="low" />
              </div>
              {selectedScan.message && (
                <Alert variant={selectedScan.status === "failed" ? "destructive" : "default"}>
                  <AlertDescription className="break-words font-mono text-xs">{selectedScan.message}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={scanModalOpen} onOpenChange={setScanModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Scan image</DialogTitle>
            <DialogDescription>Enter a container image to scan for vulnerabilities.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="scan-target">Image reference</Label>
            <Input
              id="scan-target"
              autoFocus
              value={scanTarget}
              onChange={e => setScanTarget(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") runScan() }}
              placeholder="nginx:latest"
              className="font-mono"
            />
          </div>
          {scanError && (
            <Alert variant="destructive">
              <AlertDescription>{scanError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setScanModalOpen(false)}>Cancel</Button>
            <Button onClick={runScan} disabled={scanning || !scanTarget.trim()}>
              {scanning && <Loader2 className="size-4 animate-spin" />}
              Scan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
