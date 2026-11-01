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
    <div className={cn("px-4 pt-4 sm:px-6 sm:pt-5", className)}>
      <div className="relative overflow-hidden rounded-2xl border bg-[linear-gradient(110deg,color-mix(in_srgb,var(--hue)_16%,var(--card)),color-mix(in_srgb,var(--hue)_6%,var(--card))_55%,var(--card))] px-5 py-5 shadow-card sm:px-6">
        {/* Area photo (from [data-area] --hero-img), faded in from the left so text stays readable. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 hidden w-1/2 bg-[image:var(--hero-img)] bg-cover bg-center opacity-90 [mask-image:linear-gradient(to_right,transparent,black_55%)] sm:block dark:opacity-55"
        />
        <div className="relative flex flex-wrap items-center gap-x-4 gap-y-3">
          {Icon && (
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-[color-mix(in_srgb,var(--hue)_18%,var(--card))] text-[var(--hue)] shadow-sm ring-1 ring-[color-mix(in_srgb,var(--hue)_25%,transparent)]">
              <Icon className="size-6" />
            </span>
          )}
          <div className="min-w-0 flex-1 basis-56">
            <h1 className="min-w-0 text-2xl font-semibold tracking-tight break-words">{title}</h1>
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {children && <div className="relative mt-4">{children}</div>}
      </div>
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
