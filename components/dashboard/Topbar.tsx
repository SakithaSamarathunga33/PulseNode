"use client"

import { API_BASE, nodeApi } from "@/lib/api"
import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Bell, LogOut, RefreshCw, Search, Server, Settings } from "lucide-react"
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
import { getSocket } from "@/lib/socket"

const GO_API = API_BASE

/**
 * Pulse rail: the top bar's bottom hairline. Every live system:metrics frame re-keys the
 * accent segment, restarting its sweep. Kept separate so only this span re-renders per frame.
 */
function PulseRail() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    try {
      const socket = getSocket()
      const onMetrics = () => setTick(t => t + 1)
      socket.on("system:metrics", onMetrics)
      return () => { socket.off("system:metrics", onMetrics) }
    } catch { return undefined } // socket unavailable during SSR
  }, [])
  return (
    <span aria-hidden className="pointer-events-none absolute inset-x-0 -bottom-px h-px overflow-hidden">
      {tick > 0 && <span key={tick} className="pulse-rail-seg absolute inset-y-0 left-0 block" />}
    </span>
  )
}

export function Topbar() {
  const pathname = usePathname()
  const info = routeInfo(pathname)
  const { open: openSearch } = useCommandMenu()
  const [authEnabled, setAuthEnabled] = useState(false)
  const [username, setUsername] = useState("")
  const [hostName, setHostName] = useState("")

  // The sign-out menu is only shown when login protection is configured.
  useEffect(() => {
    nodeApi.get<{ enabled?: boolean; username?: string }>("/api/auth/status")
      .then(({ data: d }) => { setAuthEnabled(!!d.enabled); setUsername(d.username ?? "") })
      .catch(() => {})
    nodeApi.get<{ name?: string }>("/api/host")
      .then(({ data: d }) => { if (d?.name) setHostName(d.name) })
      .catch(() => {})
  }, [])

  async function logout() {
    try { await fetch(`${GO_API}/api/auth/logout`, { method: "POST" }) }
    finally { window.location.href = "/login" } // hard navigation so middleware sees the cleared cookie
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur-md supports-[backdrop-filter]:bg-background/75 sm:px-4">
      <PulseRail />
      <SidebarTrigger className="-ml-1 hidden md:inline-flex" />
      <Separator orientation="vertical" className="mx-1 hidden h-5 sm:block" />
      <Breadcrumb className="hidden sm:block">
        <BreadcrumbList>
          {hostName && (
            <>
              <BreadcrumbItem className="gap-1.5 text-muted-foreground"><Server className="size-3.5" />{hostName}</BreadcrumbItem>
              <BreadcrumbSeparator />
            </>
          )}
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
        className="mx-auto flex h-9 w-full min-w-0 max-w-sm items-center gap-2 rounded-lg border bg-card px-3 text-sm text-muted-foreground shadow-card transition-colors hover:border-[var(--border-2)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Search pages and actions"
      >
        <Search className="size-4 shrink-0" />
        <span className="truncate">Search pages, containers, projects…</span>
        <kbd className="ml-auto hidden rounded-md border bg-muted px-1.5 py-px font-mono text-2xs text-muted-foreground sm:block">Ctrl K</kbd>
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
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
            <span className="grid size-7 place-items-center rounded-full border bg-[linear-gradient(140deg,var(--muted),var(--card))] text-2xs font-semibold text-foreground shadow-card">
              {username.trim().slice(0, 2).toUpperCase() || "?"}
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
