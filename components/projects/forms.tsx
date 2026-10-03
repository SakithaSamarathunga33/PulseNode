"use client"

import type { ReactNode } from "react"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/** Label + control + helper text. `htmlFor` must match the control's id. */
export function FormField({
  label, htmlFor, hint, children, className,
}: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export type ChoiceOption<T extends string> = { value: T; label: string; desc?: string }

/** Radio-card group: a set of tiles where exactly one is selected. */
export function ChoiceGroup<T extends string>({
  value, onChange, options, columns = 2, label, className,
}: {
  value: T
  onChange: (v: T) => void
  options: ChoiceOption<T>[]
  columns?: 2 | 3
  label: string
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("grid gap-2", columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2", "grid-cols-1 min-[420px]:grid-cols-2", className)}
    >
      {options.map(opt => {
        const on = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-lg border bg-background p-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
              on && "border-[var(--hue)] bg-[color-mix(in_srgb,var(--hue)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--hue)_14%,transparent)]",
            )}
          >
            <span className="flex items-center justify-between gap-2 text-sm font-medium">
              {opt.label}
              <span
                aria-hidden
                className={cn(
                  "grid size-4 shrink-0 place-items-center rounded-full border",
                  on ? "border-[var(--hue)] bg-[var(--hue)]" : "border-input",
                )}
              >
                {on && <span className="size-1.5 rounded-full bg-[var(--hue-fg-on,var(--background))]" />}
              </span>
            </span>
            {opt.desc && <span className="mt-0.5 block text-xs text-muted-foreground">{opt.desc}</span>}
          </button>
        )
      })}
    </div>
  )
}

export const BUILD_METHODS = [
  { value: "auto", label: "Auto-detect", desc: "Compose → Dockerfile → Nixpacks" },
  { value: "compose", label: "Docker Compose", desc: "docker-compose.yml" },
  { value: "dockerfile", label: "Dockerfile", desc: "docker build" },
  { value: "nixpacks", label: "Nixpacks", desc: "Zero-config build" },
] as const
