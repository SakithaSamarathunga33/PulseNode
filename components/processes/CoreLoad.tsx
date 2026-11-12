"use client"

import { useState } from "react"
import { Cpu } from "lucide-react"
import { BarSparkline } from "@/components/charts/sparkline"
import { TONE_TEXT, toneFor } from "@/components/containers/utils"
import { cn } from "@/lib/utils"
import { Panel } from "@/components/pn/Panel"

const cpuText = (pct: number) => (toneFor(pct) === "ok" ? "text-foreground" : TONE_TEXT[toneFor(pct)])

/** Per-core CPU load from /metrics/live: a Bklit bar sparkline pinned to 0–100% above the exact per-core values. */
export function CoreLoad({ cores }: { cores: number[] }) {
  const [hover, setHover] = useState<number | null>(null)
  if (cores.length === 0) return null
  const avg = cores.reduce((s, v) => s + v, 0) / cores.length
  const busiest = cores.indexOf(Math.max(...cores))

  return (
    <Panel role="region" aria-labelledby="cores-title" className="space-y-3 rounded-xl p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="cores-title" className="inline-flex items-center gap-2 text-sm font-semibold">
          <Cpu className="size-4 text-[var(--hue)]" strokeWidth={1.75} />CPU cores
        </h2>
        <p className="text-xs text-muted-foreground tabular-nums" aria-live="off">
          {hover !== null
            ? <>CPU {hover + 1} · <span className="font-medium text-foreground">{cores[hover]}%</span></>
            : <>Average {avg.toFixed(1)}% · busiest CPU {busiest + 1} at {cores[busiest]}%</>}
        </p>
      </div>

      <div aria-hidden>
        <BarSparkline
          data={cores}
          dataKey={v => v}
          height={64}
          yDomain={[0, 100]}
          color="var(--chart-1)"
          barGap={cores.length > 32 ? 1 : 3}
          barRadius={2}
          crosshair={false}
          onHoverChange={i => setHover(i)}
        />
      </div>

      <ul className="-mx-1 grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-x-4 gap-y-1 border-t pt-3 text-xs">
        {cores.map((pct, i) => (
          <li key={i} className={cn("flex items-baseline justify-between gap-2 rounded px-1 py-0.5", hover === i && "bg-accent")}>
            <span className="text-muted-foreground">CPU {i + 1}</span>
            <span className={cn("font-medium tabular-nums", cpuText(pct))}>{pct}%</span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
