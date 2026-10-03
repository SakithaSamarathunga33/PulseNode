"use client"

import { useState, useEffect, useMemo, useRef, useCallback } from "react"
import { toast } from "sonner"
import { FileCode2, Package, Layers, ScrollText, AlertCircle, CircleSlash, Download } from "lucide-react"
import { nodeApi } from "@/lib/api"
import type { SBOM } from "@/lib/types"
import { useSlashFocus } from "@/lib/use-slash-focus"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { SearchInput } from "@/components/pn/SearchInput"
import { EmptyState } from "@/components/pn/EmptyState"
import { SummaryStrip } from "@/components/pn/SummaryStrip"
import { Pill } from "@/components/dashboard/Pill"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const ECOSYSTEMS = [
  { key: "go", label: "Go", color: "var(--eco-go)" },
  { key: "npm", label: "npm", color: "var(--eco-npm)" },
  { key: "deb", label: "Debian", color: "var(--eco-deb)" },
  { key: "other", label: "Other", color: "var(--eco-other)" },
] as const

type EcoKey = (typeof ECOSYSTEMS)[number]["key"]
const FILTERS = [{ value: "all", label: "All ecosystems" }, ...ECOSYSTEMS.map(e => ({ value: e.key, label: e.label }))]

function EcosystemBar({ eco }: { eco: SBOM["ecosystem"] }) {
  const total = eco.go + eco.npm + eco.deb + eco.other || 1
  const present = ECOSYSTEMS.filter(e => eco[e.key] > 0)
  return (
    <div className="space-y-2">
      <div
        className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-muted" role="img"
        aria-label={ECOSYSTEMS.map(e => `${e.label} ${eco[e.key]}`).join(", ")}
      >
        {present.map(e => <span key={e.key} style={{ flex: `${eco[e.key] / total} 0 0`, background: e.color }} />)}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {present.map(e => (
          <span key={e.key} className="inline-flex items-center gap-1.5">
            <span className="size-[7px] rounded-[2px]" style={{ background: e.color }} />
            {e.label} <span className="tabular-nums">{eco[e.key].toLocaleString()}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

export default function SBOMHistoryPage() {
  const [list, setList] = useState<SBOM[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [syft, setSyft] = useState<boolean | null>(null)
  const [search, setSearch] = useState("")
  const [eco, setEco] = useState<"all" | EcoKey>("all")
  const searchRef = useRef<HTMLInputElement>(null)
  useSlashFocus(searchRef)

  const load = useCallback(() => {
    setError(null)
    nodeApi.get<SBOM[]>("/security/sboms")
      .then(({ data }) => setList(Array.isArray(data) ? data : []))
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : "Could not load SBOMs"); setList(l => l ?? []) })
  }, [])

  useEffect(() => {
    load()
    nodeApi.get<{ syft: boolean }>("/security/status").then(({ data }) => setSyft(data.syft)).catch(() => {})
  }, [load])

  const sboms = useMemo(() => list ?? [], [list])
  const totalPackages = sboms.reduce((a, s) => a + s.packages, 0)
  const totalLicenses = sboms.reduce((a, s) => a + s.licenses, 0)
  const largest = sboms.reduce<SBOM | null>((m, s) => (!m || s.packages > m.packages ? s : m), null)

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return sboms.filter(s => (eco === "all" || s.ecosystem[eco] > 0) && (!q || s.image.toLowerCase().includes(q)))
  }, [sboms, search, eco])

  function download(s: SBOM) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(s, null, 2)], { type: "application/json" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `${s.image.replace(/[/:]/g, "_")}.sbom-summary.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success("SBOM summary downloaded")
  }

  const loading = list === null

  return (
    <>
      <PageHeader
        icon={FileCode2}
        title="Software bills of materials"
        description={
          <span>
            <b className="font-semibold text-foreground tabular-nums">{sboms.length}</b> images ·{" "}
            <b className="font-semibold text-foreground tabular-nums">{totalPackages.toLocaleString()}</b> packages tracked · generated with <span className="font-mono text-xs">syft</span>
          </span>
        }
      />
      <PageBody className="motion-safe:animate-in fade-in-0 duration-300">
        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load SBOMs</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {error}
              <Button variant="outline" size="xs" onClick={load}>Retry</Button>
            </AlertDescription>
          </Alert>
        )}
        {syft === false && (
          <Alert>
            <CircleSlash />
            <AlertTitle>SBOM generator not installed</AlertTitle>
            <AlertDescription>This PulseNode image has no Syft, so SBOMs cannot be generated. Update PulseNode to get it. Package counts are never estimated.</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <Skeleton className="h-[112px] rounded-xl" />
        ) : (
          <SummaryStrip
            items={[
              { label: "SBOMs", icon: FileCode2, value: sboms.length, meta: "one per image" },
              { label: "Packages", icon: Package, value: totalPackages.toLocaleString(), meta: "across all images" },
              { label: "Licenses", icon: ScrollText, value: totalLicenses.toLocaleString(), meta: "summed per image" },
              { label: "Largest image", icon: Layers, value: (largest?.packages ?? 0).toLocaleString(), unit: "packages", meta: <span className="font-mono">{largest?.image ?? "—"}</span> },
            ]}
          />
        )}

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative w-full max-w-[300px]">
            <SearchInput
              ref={searchRef}
              className="max-w-none"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search image"
              aria-label="Search images"
            />
            <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground sm:block">/</kbd>
          </div>
          <Select value={eco} onValueChange={v => setEco(v as "all" | EcoKey)} items={FILTERS}>
            <SelectTrigger size="sm" aria-label="Ecosystem" className="w-[170px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {FILTERS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <Skeleton className="h-48 rounded-xl" />
        ) : sboms.length === 0 ? (
          <EmptyState icon={FileCode2} title="No SBOMs yet" description="SBOMs appear here once generated for an image." />
        ) : shown.length === 0 ? (
          <EmptyState icon={FileCode2} title="No SBOMs match the current filters" description="Try a different image name or ecosystem." />
        ) : (
          <section aria-label="SBOM inventory" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] gap-3.5">
            {shown.map(s => (
              <article key={s.image} className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-card">
                <div className="space-y-1 px-4 pt-3.5 pb-3">
                  <h2 className="truncate font-mono text-[13px] font-medium" title={s.image}>{s.image}</h2>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>Generated {s.generated}</span>
                    <Pill tone="outline">{s.format}</Pill>
                  </p>
                </div>
                <dl className="grid grid-cols-2 gap-2.5 px-4 pb-3">
                  <div><dt className="text-[11px] text-muted-foreground">Packages</dt><dd className="text-[17px] font-semibold tabular-nums">{s.packages.toLocaleString()}</dd></div>
                  <div><dt className="text-[11px] text-muted-foreground">Licenses</dt><dd className="text-[17px] font-semibold tabular-nums">{s.licenses.toLocaleString()}</dd></div>
                </dl>
                <div className="px-4 pb-3.5"><EcosystemBar eco={s.ecosystem} /></div>
                <div className="mt-auto flex justify-end border-t bg-muted/40 px-3 py-2.5">
                  <Button variant="outline" size="sm" onClick={() => download(s)}>
                    <Download className="size-3.5" />Export summary
                  </Button>
                </div>
              </article>
            ))}
          </section>
        )}
      </PageBody>
    </>
  )
}
