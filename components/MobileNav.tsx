"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu } from "lucide-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { NAV_GROUPS, SETTINGS_ITEM, routeInfo } from "@/lib/nav"
import { cn } from "@/lib/utils"

const PRIMARY = ["/containers", "/runtime", "/projects", "/databases"]

/** Phone navigation: four primary destinations plus "More" (everything else) in a bottom sheet. */
export function MobileNav() {
  const pathname = usePathname()
  const [more, setMore] = useState(false)
  const all = [...NAV_GROUPS.flatMap(g => g.items), SETTINGS_ITEM]
  const primary = PRIMARY.map(h => all.find(i => i.href === h)!).filter(Boolean)
  const rest = all.filter(i => !PRIMARY.includes(i.href) && !i.optional)
  const current = routeInfo(pathname)?.href
  const moreActive = !!current && !PRIMARY.includes(current)

  const tab = "relative flex flex-col items-center justify-center gap-1 rounded-md text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 grid h-16 grid-cols-5 border-t bg-sidebar pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {primary.map(item => {
          const on = current === item.href
          return (
            <Link key={item.href} href={item.href} aria-current={on ? "page" : undefined} className={cn(tab, on ? "text-foreground" : "text-muted-foreground")}>
              <span className={cn("absolute top-0 left-[30%] right-[30%] h-0.5 rounded-b bg-primary", on ? "opacity-100" : "opacity-0")} />
              <item.icon className="size-5" />
              {item.label}
            </Link>
          )
        })}
        <button type="button" onClick={() => setMore(true)} className={cn(tab, moreActive || more ? "text-foreground" : "text-muted-foreground")} aria-haspopup="dialog" aria-expanded={more} aria-controls="mobile-more-sheet">
          <span className={cn("absolute top-0 left-[30%] right-[30%] h-0.5 rounded-b bg-primary", moreActive ? "opacity-100" : "opacity-0")} />
          <Menu className="size-5" />
          More
        </button>
      </nav>

      <Sheet open={more} onOpenChange={setMore}>
        <SheetContent id="mobile-more-sheet" side="bottom" className="max-h-[80svh] gap-0 rounded-t-2xl">
          <SheetHeader><SheetTitle>More</SheetTitle></SheetHeader>
          <div className="grid grid-cols-3 gap-2 overflow-y-auto p-4 pt-0 pb-6">
            {rest.map(item => (
              <Link
                key={item.href} href={item.href} onClick={() => setMore(false)}
                aria-current={current === item.href ? "page" : undefined}
                className="flex min-h-[72px] flex-col items-start gap-2.5 rounded-xl border bg-card p-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <item.icon className="size-[18px] text-muted-foreground" />
                {item.label}
              </Link>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
