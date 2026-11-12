import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { BlurFade } from "@/components/magicui/blur-fade"

/**
 * Page title row on the page ground (no card): an area-hued icon (--hue comes from
 * the [data-area] wrapper set by AppShell), the title, a muted description and
 * page-level `actions` on the right. Tabs / filters go in `children`, under a hairline.
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
    <header className={cn("mx-auto w-full max-w-[1600px] px-4 pt-6 sm:px-6 sm:pt-8", className)}>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3">
        {Icon && (
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-card text-[var(--hue)] shadow-card">
            <Icon className="size-[18px]" strokeWidth={1.75} />
          </span>
        )}
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="min-w-0 text-[22px] leading-tight font-semibold break-words">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-5 border-b pb-3">{children}</div>}
    </header>
  )
}

/** Standard page content wrapper: consistent gutters, max width and vertical rhythm. */
export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    // Magic UI BlurFade: the page body eases in once on load (MotionConfig in Providers honours reduced motion).
    <BlurFade duration={0.35} offset={8} blur="4px" className={cn("mx-auto w-full max-w-[1600px] space-y-5 p-4 sm:p-6", className)}>
      {children}
    </BlurFade>
  )
}
