"use client"

import { useState, useEffect } from "react"
import { FileCode2, Package, Layers, ScrollText } from "lucide-react"
import { SBOMS as MOCK_SBOMS } from "@/lib/mock-data"
import { pythonApi } from "@/lib/api"
import type { SBOM } from "@/lib/types"
import { PageHeader, PageBody } from "@/components/pn/PageHeader"
import { EmptyState } from "@/components/pn/EmptyState"
import { StatCard } from "@/components/dashboard/StatCard"
import { Pill } from "@/components/dashboard/Pill"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

const ECOSYSTEMS = [
  { key: "go", label: "Go", color: "var(--eco-go)" },
  { key: "npm", label: "npm", color: "var(--eco-npm)" },
  { key: "deb", label: "Debian", color: "var(--eco-deb)" },
  { key: "other", label: "Other", color: "var(--eco-other)" },
] as const

function EcosystemBar({ eco }: { eco: SBOM["ecosystem"] }) {
  const total = eco.go + eco.npm + eco.deb + eco.other || 1
  return (
    <div className="space-y-2">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="img"
        aria-label={ECOSYSTEMS.map(e => `${e.label} ${eco[e.key]}`).join(", ")}>
        {ECOSYSTEMS.filter(e => eco[e.key] > 0).map(e => (
          <div key={e.key} style={{ width: `${(eco[e.key] / total) * 100}%`, background: e.color }} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
        {ECOSYSTEMS.map(e => (
          <div key={e.key} className="flex items-center gap-1.5 text-xs">
            <span className="size-2 shrink-0 rounded-full" style={{ background: e.color }} />
            <span className="truncate text-muted-foreground">{e.label}</span>
            <span className="ml-auto font-mono tabular-nums">{eco[e.key]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function SBOMHistoryPage() {
  const [sboms, setSboms] = useState<SBOM[]>(MOCK_SBOMS)

  useEffect(() => {
    pythonApi.get<SBOM[]>("/security/sboms")
      .then(({ data }) => { if (data.length > 0) setSboms(data) })
      .catch(() => {})
  }, [])

  const totalPackages = sboms.reduce((a, s) => a + s.packages, 0)
  const totalLicenses = sboms.reduce((a, s) => a + s.licenses, 0)

  return (
    <>
      <PageHeader
        icon={FileCode2}
        title="SBOMs"
        description={`Software bills of materials · ${sboms.length} images · ${totalPackages.toLocaleString()} packages tracked`}
      />
      <PageBody className="motion-safe:animate-in fade-in-0 duration-300">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard icon={FileCode2} label="SBOMs" value={sboms.length} tone="acc" sub="generated" />
          <StatCard icon={Package} label="Packages total" value={totalPackages} tone="info" sub="across all images" />
          <StatCard icon={ScrollText} label="Licenses" value={totalLicenses} tone="info" sub="summed per image" />
          <StatCard icon={Layers} label="Largest image" value={sboms.reduce((m, s) => Math.max(m, s.packages), 0)} tone="acc" sub="packages" />
        </div>

        {sboms.length === 0 ? (
          <EmptyState icon={FileCode2} title="No SBOMs yet" description="SBOMs appear here once generated for an image." />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {sboms.map(sbom => (
              <Card key={sbom.image}>
                <CardHeader>
                  <CardTitle className="truncate font-mono text-sm" title={sbom.image}>{sbom.image}</CardTitle>
                  <CardDescription className="flex flex-wrap items-center gap-2">
                    <span>{sbom.generated}</span>
                    <Pill tone="outline">{sbom.format}</Pill>
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold tabular-nums text-[var(--hue-fg)]">{sbom.packages.toLocaleString()}</span>
                    <span className="text-sm text-muted-foreground">packages</span>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">+ {sbom.licenses} licenses</span>
                  </div>
                  <EcosystemBar eco={sbom.ecosystem} />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </PageBody>
    </>
  )
}
