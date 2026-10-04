import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Page title band, tinted with the page's area hue (--hue comes from the
 * [data-area] wrapper set by AppShell). Put page-level actions in `actions`
 * and tabs / filters in `children`.
 */
export function PageHeader({
  icon: Icon, title, description, actions, children, className,
}: {
  icon?: LucideIcon
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "border-b bg-[linear-gradient(100deg,color-mix(in_srgb,var(--hue)_13%,transparent),color-mix(in_srgb,var(--hue)_4%,transparent)_55%,transparent)] px-4 pt-5 sm:px-6",
        children ? "pb-0" : "pb-5",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {Icon && (
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--hue)_18%,transparent)] text-[var(--hue)]">
            <Icon className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="min-w-0 text-xl font-semibold tracking-tight break-words">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}

/** Standard page content wrapper: consistent gutters, max width and vertical rhythm. */
export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-[1600px] space-y-5 p-4 sm:p-6", className)}>
      {children}
    </div>
  )
}
