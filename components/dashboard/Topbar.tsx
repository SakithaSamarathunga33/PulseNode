"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Bell, LogOut, RefreshCw, Search, Settings } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ThemeSwitcher } from "@/components/ThemeSwitcher"
import { useCommandMenu } from "@/components/CommandMenu"
import { routeInfo } from "@/lib/nav"

const GO_API = process.env.NEXT_PUBLIC_GO_API ?? ""

export function Topbar() {
  const pathname = usePathname()
  const info = routeInfo(pathname)
  const { open: openSearch } = useCommandMenu()
  const [authEnabled, setAuthEnabled] = useState(false)
  const [username, setUsername] = useState("")

  // The sign-out menu is only shown when login protection is configured.
  useEffect(() => {
    fetch(`${GO_API}/api/auth/status`, { cache: "no-store" })
      .then(r => r.json() as Promise<{ enabled?: boolean; username?: string }>)
      .then(d => { setAuthEnabled(!!d.enabled); setUsername(d.username ?? "") })
      .catch(() => {})
  }, [])

  async function logout() {
    try { await fetch(`${GO_API}/api/auth/logout`, { method: "POST" }) }
    finally { window.location.href = "/login" } // hard navigation so middleware sees the cleared cookie
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mx-1 hidden h-5 sm:block" />
      <Breadcrumb className="hidden sm:block">
        <BreadcrumbList>
          {info && (
            <>
              <BreadcrumbItem className="text-muted-foreground">{info.group}</BreadcrumbItem>
              <BreadcrumbSeparator />
            </>
          )}
          <BreadcrumbItem>
            <BreadcrumbPage>{info?.title ?? info?.label ?? "PulseNode"}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <button
        type="button"
        onClick={openSearch}
        className="mx-auto flex h-9 w-full max-w-sm items-center gap-2 rounded-lg border bg-muted/60 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Search pages and actions"
      >
        <Search className="size-4 shrink-0" />
        <span className="truncate">Search or jump to…</span>
        <kbd className="ml-auto hidden rounded border bg-background px-1.5 font-mono text-[11px] sm:block">Ctrl K</kbd>
      </button>

      <div className="ml-auto flex items-center gap-0.5">
        <ThemeSwitcher />
        <Button variant="ghost" size="icon" aria-label="Refresh page" title="Refresh" onClick={() => window.location.reload()}>
          <RefreshCw className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Alerts" title="Alerts" nativeButton={false} render={<Link href="/alerts" />}>
          <Bell className="size-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" className="ml-1 rounded-full" aria-label="Account menu" />}
          >
            <span className="grid size-7 place-items-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
              {username.trim().charAt(0).toUpperCase() || "?"}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {username && (
              <DropdownMenuGroup>
                <DropdownMenuLabel className="truncate">{username}</DropdownMenuLabel>
              </DropdownMenuGroup>
            )}
            {username && <DropdownMenuSeparator />}
            <DropdownMenuItem render={<Link href="/settings" />}>
              <Settings className="size-4" /> Settings
            </DropdownMenuItem>
            {authEnabled && (
              <DropdownMenuItem onClick={logout}>
                <LogOut className="size-4" /> Sign out
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
