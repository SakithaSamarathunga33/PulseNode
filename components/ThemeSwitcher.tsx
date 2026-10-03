"use client"

import { useTheme } from "next-themes"
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Light/dark toggle with the Magic UI circular reveal (View Transitions API).
 * "System" is available from the Ctrl+K palette.
 */
export function ThemeSwitcher() {
  const { resolvedTheme, setTheme } = useTheme()
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
