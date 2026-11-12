import { cn } from "@/lib/utils"

/**
 * Free-form card surface (same look as `Card`) for panels that lay out their own content:
 * surface, hairline border and soft shadow. Pass radius and padding via className (e.g. "rounded-xl p-4").
 */
export function Panel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("relative border bg-card text-card-foreground shadow-card", className)} {...props} />
}
