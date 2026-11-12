"use client"

import { useMemo } from "react"
import { HardDrive, ShieldAlert } from "lucide-react"
import { BarChart } from "@/components/charts/bar-chart"
import { Bar } from "@/components/charts/bar"
import { BarYAxis } from "@/components/charts/bar-y-axis"
import { ChartTooltip } from "@/components/charts/tooltip"
import { PieChart } from "@/components/charts/pie-chart"
import { PieSlice } from "@/components/charts/pie-slice"
import { PieCenter } from "@/components/charts/pie-center"
import type { DockerImage } from "@/lib/types"
import { fmtMb, parseMb } from "./ImageParts"
import { largestImages } from "./largest-images"
import { Panel } from "@/components/pn/Panel"

const TOP_N = 6
const ROW_PX = 30
const BAR_MARGIN = { top: 4, right: 8, bottom: 4, left: 84 }

const SEVERITIES = [
  { key: "crit", label: "Critical", color: "var(--sev-bar-crit)" },
  { key: "high", label: "High", color: "var(--sev-bar-high)" },
  { key: "med", label: "Medium", color: "var(--sev-bar-med)" },
  { key: "low", label: "Low", color: "var(--sev-bar-low)" },
] as const

/** Severity donut + largest-images bars, both from the image list the page already loaded. */
export function ImageCharts({ images }: { images: DockerImage[] }) {
  const sizes = useMemo(() => largestImages(images, parseMb, TOP_N), [images])
  const sev = useMemo(
    () => SEVERITIES.map(s => ({ ...s, value: images.reduce((sum, i) => sum + (i.vulns?.[s.key] ?? 0), 0) })),
    [images],
  )
  const findings = sev.reduce((a, s) => a + s.value, 0)
  const slices = sev.filter(s => s.value > 0)

  return (
    <Panel role="region" aria-label="Image overview" className="grid gap-5 rounded-xl p-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
      <div className="space-y-4">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert className="size-4 text-[var(--hue)]" strokeWidth={1.75} />Vulnerabilities by severity
        </h2>
        <div className="flex items-center gap-5">
          {findings > 0 && (
            <div aria-hidden className="w-[120px] shrink-0">
              <PieChart data={slices} size={120} innerRadius={40} padAngle={0.03} cornerRadius={3} hoverOffset={4}>
                {slices.map((s, i) => <PieSlice key={s.key} index={i} color={s.color} hoverEffect="grow" />)}
                <PieCenter defaultLabel="Findings" />
              </PieChart>
            </div>
          )}
          <ul className="min-w-0 flex-1 space-y-1.5 text-ui">
            {sev.map(s => (
              <li key={s.key} className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-muted-foreground">
                  <span aria-hidden className="size-2 rounded-full" style={{ background: s.color }} />{s.label}
                </span>
                <span className="font-mono tabular-nums">{s.value}</span>
              </li>
            ))}
            {findings === 0 && <li className="pt-1 text-xs text-muted-foreground">No known findings across {images.length} images.</li>}
          </ul>
        </div>
      </div>

      <div className="min-w-0 space-y-3 border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
          <HardDrive className="size-4 text-[var(--hue)]" strokeWidth={1.75} />Largest images · on disk
        </h2>
        {sizes.length === 0 ? (
          <p className="text-xs text-muted-foreground">No size information reported.</p>
        ) : (
          <>
            <div aria-hidden style={{ height: sizes.length * ROW_PX + BAR_MARGIN.top + BAR_MARGIN.bottom }}>
              <BarChart
                data={sizes}
                orientation="horizontal"
                aspectRatio="auto"
                className="h-full"
                margin={BAR_MARGIN}
                barGap={0.3}
                animationDuration={700}
              >
                <Bar
                  dataKey="mb"
                  fill="var(--chart-1)"
                  lineCap={3}
                  showValue
                  valueLabelPosition="top"
                  valueLabelFormatter={fmtMb}
                  // --primary-foreground keeps >= 4.5:1 on --chart-1 in both themes (white in light, near-black in dark).
                  valueLabelColor="var(--primary-foreground)"
                  valueLabelClassName="font-mono text-2xs"
                />
                <BarYAxis />
                <ChartTooltip
                  showDatePill={false}
                  rows={p => [{ color: "var(--chart-1)", label: String(p.full), value: fmtMb(Number(p.mb)) }]}
                />
              </BarChart>
            </div>
            <ol className="sr-only">
              {sizes.map(s => <li key={s.id}>{s.full}: {fmtMb(s.mb)}</li>)}
            </ol>
          </>
        )}
      </div>
    </Panel>
  )
}
