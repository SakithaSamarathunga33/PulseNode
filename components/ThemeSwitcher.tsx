"use client"

import { useSyncExternalStore } from "react"
import { useTheme } from "next-themes"
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Light/dark toggle with the Magic UI circular reveal (View Transitions API).
 * "System" is available from the Ctrl+K palette.
 */
const noopSubscribe = () => () => {}

export function ThemeSwitcher() {
  const { resolvedTheme, setTheme } = useTheme()
  // The theme is only known in the browser; render a same-size placeholder on the
  // server so the hydrated markup matches (otherwise React throws a hydration error).
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false)
  if (!mounted) return <span aria-hidden className={cn(buttonVariants({ variant: "ghost", size: "icon" }))} />
  const dark = resolvedTheme === "dark"
  return (
    <AnimatedThemeToggler
      theme={dark ? "dark" : "light"}
      onThemeChange={setTheme}
      variant="circle"
      duration={520}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "[&_svg]:size-4")}
    />
  )
}
