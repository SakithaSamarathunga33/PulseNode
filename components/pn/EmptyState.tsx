import type { LucideIcon } from "lucide-react"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { cn } from "@/lib/utils"

/** "Nothing here yet" panel with an optional action. Used for empty lists and zero-result filters. */
export function EmptyState({
  icon: Icon, title, description, action, className,
}: {
  icon?: LucideIcon
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <Empty className={cn("border py-12", className)}>
      <EmptyHeader>
        {Icon && (
          <EmptyMedia variant="icon" className="size-11 bg-[color-mix(in_srgb,var(--hue,var(--primary))_14%,transparent)] text-[var(--hue,var(--primary))]">
            <Icon className="size-5" />
          </EmptyMedia>
        )}
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  )
}
