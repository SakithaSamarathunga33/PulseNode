"use client"

import { ThemeProvider } from "next-themes"
import { MotionConfig } from "motion/react"
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
      {/* Every motion-based library component (Magic UI, React Bits, Kokonut, interior.dev) honours reduced motion. */}
      <MotionConfig reducedMotion="user">
        <TooltipProvider delay={200}>{children}</TooltipProvider>
      </MotionConfig>
      <Toaster position="bottom-right" richColors closeButton />
    </ThemeProvider>
  )
}
