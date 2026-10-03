import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface PillProps {
  children: React.ReactNode
  tone?: "ok" | "bad" | "warn" | "info" | "acc" | "outline"
  dot?: boolean
  className?: string
}

const TONE: Record<NonNullable<PillProps["tone"]>, string> = {
  ok: "bg-success/12 text-success",
  bad: "bg-danger/12 text-danger",
  warn: "bg-warning/14 text-warning",
  info: "bg-info/12 text-info",
  acc: "bg-primary/12 text-primary",
  outline: "border-border bg-transparent text-muted-foreground",
}

/** Status badge. Tone carries meaning (ok/warn/bad/info), so pair it with text — never colour alone. */
export function Pill({ children, tone = "outline", dot, className }: PillProps) {
  return (
    <Badge variant="ghost" className={cn("h-5 gap-1.5 text-[11px] font-semibold", TONE[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </Badge>
  )
}
