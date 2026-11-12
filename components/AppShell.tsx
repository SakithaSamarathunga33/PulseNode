"use client"

import { usePathname } from "next/navigation"
import { AppSidebar } from "@/components/sidebar/AppSidebar"
import { Topbar } from "@/components/dashboard/Topbar"
import { CommandMenuProvider } from "@/components/CommandMenu"
import { MobileNav } from "@/components/MobileNav"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { areaOf } from "@/lib/nav"
import { DotPattern } from "@/components/magicui/dot-pattern"

// The login page is a standalone full-screen view — it must not render the
// dashboard chrome. Every other route gets the shell, and the content area is
// tagged with its app area so [data-area] sets --hue for headers, stat cards, etc.
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  if (pathname?.startsWith("/login")) return <>{children}</>

  return (
    <CommandMenuProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset id="main" tabIndex={-1} className="h-svh min-w-0 overflow-hidden outline-none md:h-[calc(100svh-1rem)] md:border md:shadow-pop">
          <Topbar />
          <div data-area={areaOf(pathname)} className="relative min-h-0 flex-1 overflow-y-auto pb-16 md:pb-0">
            {/* Magic UI DotPattern: a faint dot field at the top of the panel, fading out downwards. */}
            <DotPattern
              width={18} height={18} cr={1}
              className="pointer-events-none absolute inset-x-0 top-0 !h-80 text-foreground/[0.09] [mask-image:radial-gradient(ellipse_75%_100%_at_50%_0%,black,transparent)]"
            />
            <div className="relative">{children}</div>
          </div>
        </SidebarInset>
        <MobileNav />
      </SidebarProvider>
    </CommandMenuProvider>
  )
}
