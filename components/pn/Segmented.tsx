"use client"

import { SegmentedControl } from "@/components/interior/segmented-control"
import { cn } from "@/lib/utils"

export type SegmentedOption<T extends string> = { value: T; label: React.ReactNode; count?: number }

/**
 * Single-choice segmented control (status filters, time ranges, sort keys) — interior.dev's
 * SegmentedControl (radiogroup, sliding thumb, arrow keys) from the user's DevAtlas library.
 */
export function Segmented<T extends string>({
  value, onChange, options, className, "aria-label": ariaLabel,
}: {
  value: T
  onChange: (v: T) => void
  options: SegmentedOption<T>[]
  /** Kept for API compatibility; the control has one size. */
  size?: "sm" | "default"
  className?: string
  "aria-label"?: string
}) {
  return (
    <SegmentedControl
      label={ariaLabel ?? "Options"}
      value={value}
      onValueChange={v => onChange(v as T)}
      className={cn("max-w-full", className)}
      options={options.map(o => ({
        value: o.value,
        label: o.count === undefined ? o.label : (
          <>
            {o.label}
            <span className="ml-1.5 rounded-md bg-background/60 px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">{o.count}</span>
          </>
        ),
      }))}
    />
  )
}
