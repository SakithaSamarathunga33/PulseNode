"use client"

import { useMemo } from "react"
import { Boxes } from "lucide-react"
import { RingChart } from "@/components/charts/ring-chart"
import { Ring } from "@/components/charts/ring"
import { RingCenter } from "@/components/charts/ring-center"
import { ProgressBar } from "@/components/dashboard/ProgressBar"
import { Truncate } from "@/components/pn/Truncate"
import type { Container } from "@/lib/types"
import { Panel } from "@/components/pn/Panel"

const TOP_N = 6

/** Container states as Bklit progress rings (share of all containers) beside the top CPU consumers. */
export function Fleet({ containers }: { containers: Container[] }) {
  const total = containers.length
  const rings = useMemo(() => {
    const count = (s: Container["state"]) => containers.filter(c => c.state === s).length
    return [
      { label: "Running", value: count("running"), maxValue: Math.max(total, 1), color: "var(--success)" },
      { label: "Paused", value: count("paused"), maxValue: Math.max(total, 1), color: "var(--warning)" },
      { label: "Stopped", value: count("stopped") + count("exited"), maxValue: Math.max(total, 1), color: "var(--danger)" },
    ]
  }, [containers, total])
  const top = useMemo(
    () => containers.filter(c => c.state === "running").sort((a, b) => b.cpu - a.cpu).slice(0, TOP_N),
    [containers],
  )

  return (
    <Panel role="region" aria-labelledby="fleet-title" className="grid gap-5 rounded-xl p-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
      <div className="space-y-4">
        <h2 id="fleet-title" className="inline-flex items-center gap-2 text-sm font-semibold">
          <Boxes className="size-4 text-[var(--hue)]" strokeWidth={1.75} />Fleet
        </h2>
        <div className="flex items-center gap-5">
          <div className="w-[112px] shrink-0">
            <RingChart data={rings} strokeWidth={9} ringGap={5} baseInnerRadius={20}>
              {rings.map((r, i) => <Ring key={r.label} index={i} color={r.color} showGlow={false} />)}
              <RingCenter defaultLabel="Containers" />
            </RingChart>
          </div>
          <ul className="min-w-0 flex-1 space-y-1.5 text-ui">
            {rings.map(r => (
              <li key={r.label} className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-muted-foreground">
                  <span aria-hidden className="size-2 rounded-full" style={{ background: r.color }} />{r.label}
                </span>
                <span className="font-mono tabular-nums">{r.value}<span className="text-muted-foreground">/{total}</span></span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="min-w-0 space-y-3 border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5">
        <h3 className="text-sm font-medium text-muted-foreground">Top CPU · running containers</h3>
        {top.length === 0 ? (
          <p className="text-sm text-muted-foreground">No running containers.</p>
        ) : (
          <ol className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {top.map(c => (
              <li key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
                <Truncate text={c.name} className="text-ui font-medium" />
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{c.cpu.toFixed(1)}%</span>
                <ProgressBar value={c.cpu} label={`${c.name} CPU`} className="col-span-2 h-1" />
              </li>
            ))}
          </ol>
        )}
      </div>
    </Panel>
  )
}
