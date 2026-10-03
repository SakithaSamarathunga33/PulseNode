"use client"

import { ThemeProvider } from "next-themes"
import { usePathname } from "next/navigation"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"

// Theme: light / dark / system, stored under the same "pn-theme" key as before.
// The login screen is always dark (it sits on a photographic background).
export function Providers({ children }: { children: React.ReactNode }) {
  const onLogin = usePathname()?.startsWith("/login")
  return (
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="dark"
      enableSystem
      storageKey="pn-theme"
      forcedTheme={onLogin ? "dark" : undefined}
      disableTransitionOnChange
    >
      <TooltipProvider delay={200}>{children}</TooltipProvider>
      <Toaster position="bottom-right" richColors closeButton />
    </ThemeProvider>
  )
}
