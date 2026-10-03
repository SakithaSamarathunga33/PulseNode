import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/** Search box with a leading icon. Pass value/onChange like a normal input. */
export function SearchInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <div className={cn("relative w-full max-w-xs", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" className="pl-8" {...props} />
    </div>
  )
}
