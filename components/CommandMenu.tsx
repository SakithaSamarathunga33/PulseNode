"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { FolderGit2, Monitor, Moon, Plus, RefreshCw, Sun } from "lucide-react"
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
  CommandSeparator, CommandShortcut,
} from "@/components/ui/command"
import { NAV_GROUPS, SETTINGS_ITEM } from "@/lib/nav"

const Ctx = createContext<{ open: () => void }>({ open: () => {} })
export const useCommandMenu = () => useContext(Ctx)

/** ⌘K / Ctrl+K palette: jump to any page, create a project, switch theme. */
export function CommandMenuProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const { setTheme } = useTheme()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen(o => !o)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const go = useCallback((href: string) => { setOpen(false); router.push(href) }, [router])
  const run = useCallback((fn: () => void) => { setOpen(false); fn() }, [])
  const value = useMemo(() => ({ open: () => setOpen(true) }), [])

  return (
    <Ctx.Provider value={value}>
      {children}
      <CommandDialog open={open} onOpenChange={setOpen} title="Search" description="Jump to a page or run an action">
        <CommandInput placeholder="Search pages and actions…" />
        <CommandList>
          <CommandEmpty>Nothing found.</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => go("/projects/new")} keywords={["deploy", "create", "new project"]}>
              <Plus /> New project
            </CommandItem>
            <CommandItem onSelect={() => run(() => window.location.reload())} keywords={["reload"]}>
              <RefreshCw /> Refresh page
            </CommandItem>
            <CommandItem onSelect={() => run(() => setTheme("light"))} keywords={["theme"]}><Sun /> Light theme</CommandItem>
            <CommandItem onSelect={() => run(() => setTheme("dark"))} keywords={["theme"]}><Moon /> Dark theme</CommandItem>
            <CommandItem onSelect={() => run(() => setTheme("system"))} keywords={["theme"]}><Monitor /> System theme</CommandItem>
          </CommandGroup>
          {[...NAV_GROUPS, { label: "System", area: "neutral" as const, items: [SETTINGS_ITEM] }].map(group => (
            <div key={group.label}>
              <CommandSeparator />
              <CommandGroup heading={group.label}>
                {group.items.map(item => (
                  <CommandItem
                    key={item.href}
                    value={item.label}
                    keywords={item.keywords}
                    onSelect={() => go(item.href)}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                    <span className="ml-2 truncate text-xs text-muted-foreground">{item.description}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </div>
          ))}
          <CommandSeparator />
          <CommandGroup heading="Tips">
            <CommandItem disabled><FolderGit2 /> Press <CommandShortcut>Ctrl B</CommandShortcut> to collapse the sidebar</CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </Ctx.Provider>
  )
}
