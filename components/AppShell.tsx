"use client"

import { usePathname } from "next/navigation"
import { AppSidebar } from "@/components/sidebar/AppSidebar"
import { Topbar } from "@/components/dashboard/Topbar"
import { CommandMenuProvider } from "@/components/CommandMenu"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { areaOf } from "@/lib/nav"

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
        <SidebarInset id="main" tabIndex={-1} className="h-svh min-w-0 overflow-hidden outline-none">
          <Topbar />
          <div data-area={areaOf(pathname)} className="min-h-0 flex-1 overflow-y-auto">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </CommandMenuProvider>
  )
}
