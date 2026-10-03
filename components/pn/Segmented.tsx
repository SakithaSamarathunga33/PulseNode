"use client"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

export type SegmentedOption<T extends string> = { value: T; label: React.ReactNode; count?: number }

/** Single-choice segmented control (status filters, time ranges, sort keys). */
export function Segmented<T extends string>({
  value, onChange, options, size = "sm", className, "aria-label": ariaLabel,
}: {
  value: T
  onChange: (v: T) => void
  options: SegmentedOption<T>[]
  size?: "sm" | "default"
  className?: string
  "aria-label"?: string
}) {
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      value={[value]}
      onValueChange={v => { if (v[0]) onChange(v[0] as T) }}
      variant="outline"
      size={size}
      spacing={0}
      className={cn("bg-background", className)}
    >
      {options.map(o => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          className="data-[pressed]:bg-[color-mix(in_srgb,var(--hue,var(--primary))_14%,transparent)] data-[pressed]:text-foreground"
        >
          {o.label}
          {o.count !== undefined && (
            <span className="ml-1 rounded-full bg-muted px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
              {o.count}
            </span>
          )}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
