"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import uPlot from "uplot"
import "uplot/dist/uPlot.min.css"

type Series = {
  label: string
  values: number[]
  color: string
  fill?: string
  width?: number
}

type UPlotChartProps = {
  series: Series[]
  height?: number
  mode?: "line" | "bar"
  max?: number
}

// Canvas cannot resolve CSS custom properties — convert via a temporary DOM element
function resolveCssColor(value: string | undefined): string | undefined {
  if (!value || !value.includes("var(")) return value
  const el = document.createElement("div")
  el.style.color = value
  document.documentElement.appendChild(el)
  const resolved = getComputedStyle(el).color
  el.remove()
  return resolved || value
}

export function UPlotChart({ series, height = 200, mode = "line", max }: UPlotChartProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<uPlot | null>(null)
  // Bumped whenever <html data-theme> changes so the canvas is rebuilt with fresh token colours
  const [themeTick, setThemeTick] = useState(0)

  useEffect(() => {
    const obs = new MutationObserver(() => setThemeTick(t => t + 1))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] })
    return () => obs.disconnect()
  }, [])

  const data = useMemo(() => {
    const len = Math.max(2, ...series.map(s => s.values.length))
    const x = Array.from({ length: len }, (_, i) => i)
    return [x, ...series.map(s => padSeries(s.values, len))] as uPlot.AlignedData
  }, [series])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const mutedColor = resolveCssColor("var(--muted-foreground)")
    const gridColor = resolveCssColor("color-mix(in srgb, var(--border) 70%, transparent)")
    const fontFamily = getComputedStyle(root).fontFamily || "sans-serif"
    const font = `11px ${fontFamily}`

    const buildOptions = (): uPlot.Options => ({
      width: root.clientWidth || 400,
      height,
      cursor: { drag: { x: false, y: false } },
      legend: { show: false },
      scales: { x: { time: false }, y: { range: max ? [0, max] : undefined } },
      axes: [
        {
          stroke: mutedColor,
          grid: { show: false },
          ticks: { show: false },
          values: (_, vals) => vals.map(v => String(v)),
          font,
        },
        {
          stroke: mutedColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { show: false },
          font,
        },
      ],
      series: [
        {},
        ...series.map(s => ({
          label: s.label,
          stroke: resolveCssColor(s.color),
          fill: mode === "line"
            ? resolveCssColor(s.fill)
            : resolveCssColor(`color-mix(in srgb, ${s.color} 60%, transparent)`),
          width: s.width ?? 1.5,
          points: { show: false },
          paths: mode === "bar" ? uPlot.paths.bars!({ size: [0.65, 60] }) : undefined,
        })),
      ],
    })

    const chart = new uPlot(buildOptions(), data, root)
    chartRef.current = chart

    const resize = () => chart.setSize({ width: root.clientWidth || 400, height })
    const observer = new ResizeObserver(resize)
    observer.observe(root)

    return () => {
      observer.disconnect()
      chart.destroy()
      chartRef.current = null
    }
  }, [height, max, mode, themeTick]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    chartRef.current?.setData(data)
  }, [data])

  return <div ref={rootRef} className="uplot-wrap w-full" />
}

function padSeries(values: number[], len: number) {
  const out = values.slice(-len)
  while (out.length < len) out.unshift(out[0] ?? 0)
  return out
}
