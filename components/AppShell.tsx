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
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="h-svh min-w-0 overflow-hidden">
          <Topbar />
          <div data-area={areaOf(pathname)} className="min-h-0 flex-1 overflow-y-auto">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </CommandMenuProvider>
  )
}
