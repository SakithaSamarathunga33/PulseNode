"use client"

import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { toast } from "sonner"
import {
  ShieldCheck, ShieldAlert, AlertTriangle, AlertCircle, Info, Package, Play, Eye, Download, RotateCcw,
  CheckCircle2, XCircle, Loader2, ScanSearch, CircleSlash,
} from "lucide-react"
import { nodeApi } from "@/lib/api"
import type { Scan } from "@/lib/types"
import { useSlashFocus } from "@/lib/use-slash-focus"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { SearchInput } from "@/components/pn/SearchInput"
import { EmptyState } from "@/components/pn/EmptyState"
import { SummaryStrip } from "@/components/pn/SummaryStrip"
import { Pill } from "@/components/dashboard/Pill"
import { VulnBar } from "@/components/dashboard/VulnBar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Truncate } from "@/components/pn/Truncate"

type ScanRow = Omit<Scan, "status"> & { status: Scan["status"] | "unavailable"; message?: string }

function StatusPill({ status }: { status: ScanRow["status"] }) {
  switch (status) {
    case "done":
      return <Pill tone="ok"><CheckCircle2 className="size-3" />Succeeded</Pill>
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
    <div className="rounded-lg px-3 py-2.5" style={{ background: `var(--sev-${tone}-bg)`, color: `var(--sev-${tone}-fg)` }}>
      <p className="text-[11px] font-bold tracking-wider">{label}</p>
      <p className="text-[22px] leading-tight font-semibold tabular-nums">{value}</p>
    </div>
  )
}

const total = (s: ScanRow) => s.crit + s.high + s.med + s.low

/** Row actions: view report, download the recorded result, re-scan the image. */
function RowActions({ scan, busy, onView, onDownload, onRescan }: {
  scan: ScanRow; busy: boolean
  onView: () => void; onDownload: () => void; onRescan: () => void
}) {
  const btn = (label: string, icon: React.ReactNode, onClick: () => void, disabled?: boolean) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={`${label} ${scan.id}`} disabled={disabled}
            onClick={e => { e.stopPropagation(); onClick() }} />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
  return (
    <div className="flex justify-end gap-0.5">
      {btn("View report", <Eye className="size-4" />, onView)}
      {btn("Download JSON", <Download className="size-4" />, onDownload)}
      {btn("Re-scan", <RotateCcw className="size-4" />, onRescan, busy)}
    </div>
  )
}

const STICKY = "sticky right-0 bg-card shadow-[-1px_0_0_var(--border)]"

export default function ScanHistoryPage() {
  const [selectedScan, setSelectedScan] = useState<ScanRow | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [scans, setScans] = useState<ScanRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scanner, setScanner] = useState<{ trivy: boolean; syft: boolean } | null>(null)
  const [scanModalOpen, setScanModalOpen] = useState(false)
  const [scanTarget, setScanTarget] = useState("")
  /** Image currently being scanned (the server runs one scan at a time). */
  const [scanning, setScanning] = useState<string | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  useSlashFocus(searchRef)

  const loadScans = useCallback(() => {
    return nodeApi.get<ScanRow[]>("/security/scans")
      .then(({ data }) => { setScans(Array.isArray(data) ? data : []); setLoadError(null) })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : "Could not load scans"))
  }, [])

  useEffect(() => {
    loadScans()
    nodeApi.get<{ trivy: boolean; syft: boolean }>("/security/status").then(({ data }) => setScanner(data)).catch(() => {})
  }, [loadScans])

  useEffect(() => {
    if (!scanModalOpen) { setScanTarget(""); setScanError(null) }
  }, [scanModalOpen])

  /** Runs one scan. Resolves true when it produced a result; surfaces failures via toast or the dialog. */
  async function runScan(image: string, fromDialog: boolean) {
    const target = image.trim()
    if (!target || scanning) return
    setScanning(target)
    setScanError(null)
    try {
      const res = await nodeApi.post<ScanRow>("/security/scan", { target })
      if (res.status === "unavailable" || res.status === "failed") {
        const msg = res.message ?? (res.status === "unavailable" ? "The scanner is not available in this PulseNode image." : "The scan failed.")
        if (fromDialog) setScanError(msg); else toast.error(`Scan of ${target}: ${msg}`)
        if (res.status === "failed") void loadScans()
        return
      }
      toast.success(`Scan finished for ${target}`)
      if (fromDialog) setScanModalOpen(false)
      void loadScans()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "scan failed"
      if (fromDialog) setScanError(msg); else toast.error(`Scan of ${target}: ${msg}`)
    } finally {
      setScanning(null)
    }
  }

  function download(scan: ScanRow) {
    const blob = new Blob([JSON.stringify(scan, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${scan.id}.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`${scan.id}.json downloaded`)
  }

  const list = useMemo(() => scans ?? [], [scans])
  const succeeded = list.filter(s => s.status === "done").length
  const failed = list.filter(s => s.status === "failed").length

  // Open findings = the newest finished scan of each image (the list is newest first).
  const open = useMemo(() => {
    const latest = new Map<string, ScanRow>()
    for (const s of list) if (s.status === "done" && !latest.has(s.image)) latest.set(s.image, s)
    const rows = [...latest.values()]
    const sum = (k: "crit" | "high" | "med" | "low") => rows.reduce((a, s) => a + s[k], 0)
    const affected = (k: "crit" | "high" | "med" | "low") => rows.filter(s => s[k] > 0).length
    return { crit: sum("crit"), high: sum("high"), med: sum("med"), low: sum("low"), ac: affected("crit"), ah: affected("high"), am: affected("med"), al: affected("low") }
  }, [list])

  const filteredScans = useMemo(() => {
    const q = search.trim().toLowerCase()
    return list.filter(s => !q || s.id.toLowerCase().includes(q) || s.image.toLowerCase().includes(q))
  }, [list, search])

  function openSheet(scan: ScanRow) { setSelectedScan(scan); setSheetOpen(true) }

  const runningRow = scanning && (!search || scanning.toLowerCase().includes(search.trim().toLowerCase())) ? scanning : null

  return (
    <>
      <PageHeader
        icon={ShieldCheck}
        title="Scan History"
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span><b className="font-semibold text-foreground tabular-nums">{list.length}</b> scans</span>
            <span aria-hidden className="text-border">·</span>
            <span><b className="font-semibold text-success tabular-nums">{succeeded}</b> succeeded</span>
            <span aria-hidden className="text-border">·</span>
            <span><b className={failed > 0 ? "font-semibold text-danger tabular-nums" : "font-semibold text-foreground tabular-nums"}>{failed}</b> failed</span>
          </span>
        }
        actions={
          <Button onClick={() => setScanModalOpen(true)} disabled={!!scanning}>
            {scanning ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {scanning ? "Scanning…" : "Scan now"}
          </Button>
        }
      />
      <PageBody className="motion-safe:animate-in fade-in-0 duration-300">
        {loadError && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load scan history</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {loadError}
              <Button variant="outline" size="xs" onClick={() => void loadScans()}>Retry</Button>
            </AlertDescription>
          </Alert>
        )}
        {scanner && !scanner.trivy && (
          <Alert>
            <CircleSlash />
            <AlertTitle>Vulnerability scanner not installed</AlertTitle>
            <AlertDescription>This PulseNode image has no Trivy, so scans cannot run. Update PulseNode to get the built-in scanner. No results are ever estimated.</AlertDescription>
          </Alert>
        )}

        {scans === null && !loadError ? (
          <Skeleton className="h-[112px] rounded-xl" />
        ) : (
          <SummaryStrip
            aria-label="Open findings by severity"
            items={[
              { label: "Critical", icon: ShieldAlert, value: open.crit, meta: `${open.ac} images affected`, tone: open.crit > 0 ? "bad" : undefined },
              { label: "High", icon: AlertTriangle, value: open.high, meta: `${open.ah} images affected`, tone: open.high > 0 ? "warn" : undefined },
              { label: "Medium", icon: Info, value: open.med, meta: `${open.am} images affected` },
              { label: "Low", icon: Info, value: open.low, meta: `${open.al} images affected` },
            ]}
          />
        )}

        <section aria-labelledby="sh-table" className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="sh-table" className="text-lg font-semibold">Scans</h2>
            <div className="relative w-full max-w-[280px]">
              <SearchInput
                ref={searchRef}
                className="max-w-none"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search image or scan ID"
                aria-label="Search scans"
              />
              <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground sm:block">/</kbd>
            </div>
          </div>

          {scans === null && !loadError ? (
            <Skeleton className="h-48 rounded-xl" />
          ) : filteredScans.length === 0 && !runningRow ? (
            <EmptyState
              icon={ScanSearch}
              title={list.length === 0 ? "No scans yet" : "No scans match your search"}
              description={list.length === 0 ? "Run a scan to check an image for vulnerabilities." : "Try a different scan ID or image."}
              action={list.length === 0 ? <Button onClick={() => setScanModalOpen(true)}>Scan now</Button> : undefined}
            />
          ) : (
            <>
              <ul className="space-y-3 md:hidden" aria-label="Scans">
                {runningRow && (
                  <li className="space-y-2 rounded-xl border bg-card p-3.5 shadow-card">
                    <div className="flex items-center gap-2">
                      <Package className="size-3.5 shrink-0 text-muted-foreground" />
                      <Truncate mono text={runningRow} className="flex-1 text-xs" />
                      <StatusPill status="running" />
                    </div>
                    <p className="text-xs text-muted-foreground">Scanning…</p>
                  </li>
                )}
                {filteredScans.map(scan => (
                  <li key={scan.id} className="space-y-3 rounded-xl border bg-card p-3.5 shadow-card">
                    <div className="flex items-center gap-2">
                      <Package className="size-3.5 shrink-0 text-muted-foreground" />
                      <Truncate mono text={scan.image} className="flex-1 text-xs" />
                      <StatusPill status={scan.status} />
                    </div>
                    {total(scan) > 0
                      ? <VulnBar v={{ crit: scan.crit, high: scan.high, med: scan.med, low: scan.low }} />
                      : <p className="text-xs text-muted-foreground">{scan.status === "done" ? "No findings" : scan.message ?? "—"}</p>}
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-mono">{scan.id}</span>
                      <span>{scan.started} · <span className="font-mono tabular-nums">{scan.duration}</span></span>
                    </div>
                    <RowActions scan={scan} busy={!!scanning}
                      onView={() => openSheet(scan)} onDownload={() => download(scan)} onRescan={() => void runScan(scan.image, false)} />
                  </li>
                ))}
              </ul>

              <Card className="hidden gap-0 overflow-hidden py-0 md:block">
                <div className="overflow-x-auto">
                  <Table className="min-w-[1080px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Scan ID</TableHead>
                        <TableHead>Image</TableHead>
                        <TableHead>Scanner</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Started</TableHead>
                        <TableHead className="text-right">Duration</TableHead>
                        <TableHead>Findings</TableHead>
                        <TableHead className={`${STICKY} text-right`}>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runningRow && (
                        <TableRow className="h-[50px]">
                          <TableCell className="font-mono text-xs text-muted-foreground">—</TableCell>
                          <TableCell><Truncate mono text={runningRow} className="max-w-[320px] text-xs" /></TableCell>
                          <TableCell className="text-xs text-muted-foreground">Trivy</TableCell>
                          <TableCell><StatusPill status="running" /></TableCell>
                          <TableCell className="text-muted-foreground">just now</TableCell>
                          <TableCell className="text-right text-muted-foreground">—</TableCell>
                          <TableCell className="text-xs text-muted-foreground">Scanning…</TableCell>
                          <TableCell className={STICKY} />
                        </TableRow>
                      )}
                      {filteredScans.map(scan => (
                        <TableRow key={scan.id} className="h-[50px] cursor-pointer" onClick={() => openSheet(scan)}>
                          <TableCell className="font-mono text-xs text-muted-foreground">{scan.id}</TableCell>
                          <TableCell>
                            <Truncate mono text={scan.image} className="max-w-[320px] text-xs" />
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{scan.scanner}</TableCell>
                          <TableCell><StatusPill status={scan.status} /></TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">{scan.started}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{scan.duration}</TableCell>
                          <TableCell>
                            {total(scan) > 0
                              ? <VulnBar v={{ crit: scan.crit, high: scan.high, med: scan.med, low: scan.low }} />
                              : <Truncate text={scan.status === "done" ? "No findings" : scan.message ?? ""} className="max-w-[220px] text-xs text-muted-foreground" />}
                          </TableCell>
                          <TableCell className={STICKY}>
                            <RowActions scan={scan} busy={!!scanning}
                              onView={() => openSheet(scan)} onDownload={() => download(scan)} onRescan={() => void runScan(scan.image, false)} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Card>
            </>
          )}
        </section>
      </PageBody>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Scan report</SheetTitle>
            <SheetDescription className="space-y-0.5">
              <span className="block font-mono text-xs">{selectedScan?.id ?? "—"}</span>
              <Truncate mono text={selectedScan?.image ?? ""} className="text-xs" />
            </SheetDescription>
          </SheetHeader>
          {selectedScan && (
            <div className="space-y-4 px-4 pb-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={selectedScan.status} />
                <span className="text-xs text-muted-foreground">
                  {selectedScan.scanner} · {selectedScan.started} · <span className="font-mono tabular-nums">{selectedScan.duration}</span>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <SevTile label="CRITICAL" value={selectedScan.crit} tone="crit" />
                <SevTile label="HIGH" value={selectedScan.high} tone="high" />
                <SevTile label="MEDIUM" value={selectedScan.med} tone="med" />
                <SevTile label="LOW" value={selectedScan.low} tone="low" />
              </div>
              {selectedScan.message && (
                <Alert variant={selectedScan.status === "failed" ? "destructive" : "default"}>
                  <AlertDescription className="font-mono text-xs break-words">{selectedScan.message}</AlertDescription>
                </Alert>
              )}
              <p className="text-xs text-muted-foreground">PulseNode keeps the severity counts of each scan, not the individual CVEs. Re-scan to refresh them.</p>
              <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                <Button variant="outline" disabled={!!scanning}
                  onClick={() => { setSheetOpen(false); void runScan(selectedScan.image, false) }}>
                  <RotateCcw className="size-4" />Re-scan
                </Button>
                <Button onClick={() => download(selectedScan)}><Download className="size-4" />Export report</Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={scanModalOpen} onOpenChange={setScanModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Scan an image</DialogTitle>
            <DialogDescription>Trivy checks OS packages and language dependencies against current advisories. Only one scan runs at a time.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="scan-target">Image reference</Label>
            <Input
              id="scan-target"
              autoFocus
              value={scanTarget}
              onChange={e => setScanTarget(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") void runScan(scanTarget, true) }}
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
            <Button onClick={() => void runScan(scanTarget, true)} disabled={!!scanning || !scanTarget.trim()}>
              {scanning && <Loader2 className="size-4 animate-spin" />}
              Start scan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
