"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Cpu } from "lucide-react"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarRail,
} from "@/components/ui/sidebar"
import { NumberTicker } from "@/components/magicui/number-ticker"
import { LiveBadge } from "@/components/pn/LiveBadge"
import { TONE_BG, toneFor } from "@/components/containers/utils"
import { getSocket } from "@/lib/socket"
import { nodeApi } from "@/lib/api"
import { NAV_GROUPS, SETTINGS_ITEM, type NavBadge } from "@/lib/nav"
import type { Alert, HostInfo, SystemMetrics } from "@/lib/types"

export function AppSidebar() {
  const pathname = usePathname()
  const [cpu, setCpu] = useState<number | null>(null)
  const [host, setHost] = useState<{ name: string; ip: string } | null>(null)
  const [hasUpdate, setHasUpdate] = useState(false)
  const [counts, setCounts] = useState<Partial<Record<NavBadge, number>>>({})

  useEffect(() => {
    nodeApi.get<{ hasUpdate?: boolean }>("/api/system/version")
      .then(({ data }) => { if (data?.hasUpdate) setHasUpdate(true) }).catch(() => {})
    nodeApi.get<HostInfo>("/api/host")
      .then(({ data }) => {
        setHost({ name: data.name, ip: data.ip })
        if (typeof data.cpu?.usage === "number") setCpu(c => c ?? data.cpu.usage)
      }).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      nodeApi.get<unknown[]>("/api/docker/images"),
      nodeApi.get<unknown[]>("/api/docker/networks"),
      nodeApi.get<unknown[]>("/api/docker/databases"),
      nodeApi.get<unknown[]>("/api/projects"),
    ]).then(r => {
      if (cancelled) return
      const keys: NavBadge[] = ["images", "networks", "databases", "projects"]
      setCounts(prev => {
        const next = { ...prev }
        r.forEach((res, i) => { if (res.status === "fulfilled") next[keys[i]] = res.value.data.length })
        return next
      })
    })
    return () => { cancelled = true }
  }, [pathname]) // re-count after create/delete elsewhere in the app

  useEffect(() => {
    let cancelled = false
    // First paint: the real number of firing alerts (never a placeholder). Until
    // it arrives, or if the request fails, no badge is shown.
    const loadAlertCount = () => {
      nodeApi.get<Alert[]>("/api/alerts/history?limit=1000")
        .then(({ data }) => {
          if (cancelled || !Array.isArray(data)) return
          const firing = data.filter(a => a.state === "firing").length
          setCounts(p => ({ ...p, alerts: firing }))
        })
        .catch(() => {})
    }
    loadAlertCount()
    try {
      const socket = getSocket()
      const onMetrics = (m: SystemMetrics) => setCpu(m.cpu)
      // The server sends the authoritative count after every change; new/updated
      // alerts just trigger a re-read in case that frame was missed.
      const onAlertCount = (n: number) => { if (typeof n === "number") setCounts(p => ({ ...p, alerts: n })) }
      socket.on("system:metrics", onMetrics)
      socket.on("alert:new", loadAlertCount)
      socket.on("alert:update", loadAlertCount)
      socket.on("alert:count", onAlertCount)
      return () => {
        cancelled = true
        socket.off("system:metrics", onMetrics); socket.off("alert:new", loadAlertCount)
        socket.off("alert:update", loadAlertCount); socket.off("alert:count", onAlertCount)
      }
    } catch { /* socket unavailable during SSR */ }
    return () => { cancelled = true }
  }, [])

  const isActive = (href: string) => pathname === href || pathname?.startsWith(href + "/")

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 justify-center border-b border-sidebar-border">
        <Link href="/containers" className="flex items-center gap-2.5 px-1" aria-label="PulseNode home">
          <span className="relative grid size-8 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
            <Cpu className="size-4" />
            <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-success ring-2 ring-sidebar" />
          </span>
          <span className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="relative block h-6 w-32 overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logodark-removebg-preview.png" alt="PulseNode" className="theme-logo-dark h-full w-full object-contain object-left" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo-removebg-preview.png" alt="PulseNode" className="theme-logo-light h-full w-full object-contain object-left" />
            </span>
            <span className="text-[11px] text-muted-foreground">VPS console</span>
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent role="navigation" aria-label="Primary">
        {NAV_GROUPS.map(group => {
          const items = group.items
          return (
            <SidebarGroup key={group.label} data-area={group.area}>
              <SidebarGroupLabel className="text-[11px] font-semibold uppercase tracking-wider text-[var(--hue-fg)]">
                {group.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map(item => {
                    const active = isActive(item.href)
                    const count = item.badge ? counts[item.badge] : undefined
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          render={<Link href={item.href} />}
                          isActive={active}
                          aria-current={active ? "page" : undefined}
                          tooltip={item.label}
                          className="data-active:bg-[color-mix(in_srgb,var(--hue)_14%,transparent)] data-active:text-sidebar-foreground data-active:shadow-[inset_2px_0_0_var(--hue)]"
                        >
                          <span className="grid size-5 shrink-0 place-items-center rounded-md bg-[color-mix(in_srgb,var(--hue)_16%,transparent)] text-[var(--hue)]">
                            <item.icon className="size-3.5" />
                          </span>
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                        {count !== undefined && (
                          <SidebarMenuBadge
                            className={item.badge === "alerts" && count > 0 ? "bg-danger/15 text-danger" : ""}
                          >
                            {count}
                          </SidebarMenuBadge>
                        )}
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )
        })}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <div className="space-y-2 group-data-[collapsible=icon]:hidden">
          <div className="space-y-2 rounded-lg border bg-card p-2.5 shadow-card">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Host CPU</span>
              <span className="text-sm font-semibold tabular-nums">{cpu === null ? "—" : <><NumberTicker value={cpu} decimals={1} />%</>}</span>
            </div>
            <div
              role="meter" aria-label="Host CPU" aria-valuenow={Math.round(cpu ?? 0)} aria-valuemin={0} aria-valuemax={100}
              className="relative h-1 rounded-full bg-muted"
            >
              <div className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ${TONE_BG[toneFor(cpu ?? 0)]}`} style={{ width: `${Math.min(100, cpu ?? 0)}%` }} />
              <span className="absolute -top-0.5 left-[60%] h-2 w-px bg-border" aria-hidden />
              <span className="absolute -top-0.5 left-[80%] h-2 w-px bg-border" aria-hidden />
            </div>
            <div className="h-px bg-border" />
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{host?.name ?? "—"}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">{host?.ip ?? ""}</span>
              </div>
              <LiveBadge className="text-[11px]">Live</LiveBadge>
            </div>
          </div>
          <p className="px-1 text-[11px] text-muted-foreground italic">Infrastructure at a glance.</p>
        </div>
        <SidebarMenu>
          <SidebarMenuItem data-area="neutral">
            <SidebarMenuButton
              render={<Link href={SETTINGS_ITEM.href} />}
              isActive={isActive(SETTINGS_ITEM.href)}
              aria-current={isActive(SETTINGS_ITEM.href) ? "page" : undefined}
              tooltip={hasUpdate ? "Settings — update available" : "Settings"}
            >
              <SETTINGS_ITEM.icon />
              <span>Settings</span>
              {hasUpdate && (
                <span className="ml-auto flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning group-data-[collapsible=icon]:hidden">
                  <span className="size-1.5 rounded-full bg-warning" /> Update
                </span>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
