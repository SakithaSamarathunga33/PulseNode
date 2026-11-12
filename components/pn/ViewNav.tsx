"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import GooeyNav from "@/components/reactbits/GooeyNav"
import { cn } from "@/lib/utils"

export type ViewOption<T extends string> = { value: T; label: string; icon?: React.ReactNode }

/** Reads a token's computed colour; GooeyNav paints its pill and particles in WebGL, which can't use var(). */
function tokenColor(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/**
 * Page-level view switcher (whole sections of a page, e.g. Resources / Uptime) — React Bits GooeyNav,
 * saved in the user's DevAtlas library. Filters inside a view use `Segmented` instead.
 */
export function ViewNav<T extends string>({
  value, onChange, options, className, "aria-label": ariaLabel,
}: {
  value: T
  onChange: (v: T) => void
  options: ViewOption<T>[]
  className?: string
  "aria-label"?: string
}) {
  const { resolvedTheme } = useTheme()
  const [accent, setAccent] = useState<string | undefined>(undefined)

  useEffect(() => {
    // Re-read after the theme attribute flips, so the pill follows light/dark.
    const id = requestAnimationFrame(() => setAccent(tokenColor("--primary", "#7b93ff")))
    return () => cancelAnimationFrame(id)
  }, [resolvedTheme])

  const index = Math.max(0, options.findIndex(o => o.value === value))
  return (
    <div role="group" aria-label={ariaLabel ?? "Views"} className={cn("max-w-full", className)}>
      <GooeyNav
        items={options.map(o => ({ label: o.label, icon: o.icon }))}
        activeIndex={index}
        onChange={i => onChange(options[i].value)}
        theme={resolvedTheme === "light" ? "light" : "dark"}
        color={accent}
        colors={accent ? [accent] : []}
        size="sm"
        particleCount={10}
        spread={40}
      />
    </div>
  )
}
