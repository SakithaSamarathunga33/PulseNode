"use client"

import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react"
import type { DockerNetwork } from "@/lib/types"
import { Pill } from "@/components/dashboard/Pill"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export const SYSTEM_NETWORKS = new Set(["bridge", "host", "none"])
export const isSystem = (n: DockerNetwork) => SYSTEM_NETWORKS.has(n.name)

export type SortKey = "name" | "driver" | "containers"
export type Sort = { key: SortKey; dir: 1 | -1 }

export const sortValue: Record<SortKey, (n: DockerNetwork) => string | number> = {
  name: n => n.name, driver: n => n.driver, containers: n => n.containers,
}

function driverTone(d: string): "acc" | "warn" | "outline" {
  if (d === "bridge") return "acc"
  if (d === "host") return "warn"
  return "outline"
}

const Tag = ({ children }: { children: React.ReactNode }) => (
  <span className="rounded bg-muted px-1.5 py-px text-[11px] text-muted-foreground">{children}</span>
)

function Flags({ net }: { net: DockerNetwork }) {
  return (
    <>
      {isSystem(net) && <Tag>system</Tag>}
      {net.internal && <span className="rounded bg-info/12 px-1.5 py-px text-[11px] text-info">internal</span>}
      {net.attachable && <Tag>attachable</Tag>}
    </>
  )
}

function SortHead({ label, k, sort, onSort, className }: { label: string; k: SortKey; sort: Sort; onSort: (k: SortKey) => void; className?: string }) {
  const on = sort.key === k
  const Icon = !on ? ChevronsUpDown : sort.dir > 0 ? ChevronUp : ChevronDown
  return (
    <TableHead aria-sort={on ? (sort.dir > 0 ? "ascending" : "descending") : "none"} className={className}>
      <button
        type="button" onClick={() => onSort(k)}
        className={cn("inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-2", on && "text-foreground")}
      >
        {label}<Icon className={cn("size-3", !on && "opacity-50")} />
      </button>
    </TableHead>
  )
}

export function NetworkTable({ rows, sort, onSort }: { rows: DockerNetwork[]; sort: Sort; onSort: (k: SortKey) => void }) {
  return (
    <Table className="min-w-[820px]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <SortHead label="Name" k="name" sort={sort} onSort={onSort} className="pl-4" />
          <SortHead label="Driver" k="driver" sort={sort} onSort={onSort} />
          <TableHead>Scope</TableHead>
          <TableHead>Subnet</TableHead>
          <TableHead>Gateway</TableHead>
          <SortHead label="Containers" k="containers" sort={sort} onSort={onSort} className="text-right" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(net => (
          <TableRow key={net.name} className="h-[50px]">
            <TableCell className="pl-4">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-medium">{net.name}</span>
                <Flags net={net} />
              </span>
            </TableCell>
            <TableCell><Pill tone={driverTone(net.driver)}>{net.driver}</Pill></TableCell>
            <TableCell className="text-muted-foreground">{net.scope}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{net.subnet || "—"}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{net.gateway || "—"}</TableCell>
            <TableCell className="pr-4 text-right font-semibold tabular-nums">{net.containers}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function NetworkCards({ rows }: { rows: DockerNetwork[] }) {
  return (
    <ul className="space-y-3" aria-label="Networks">
      {rows.map(net => (
        <li key={net.name} className="space-y-2.5 rounded-xl border bg-card p-3.5 shadow-card">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium" title={net.name}>{net.name}</span>
            <Pill tone={driverTone(net.driver)}>{net.driver}</Pill>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <div><dt className="text-muted-foreground">Scope</dt><dd>{net.scope}</dd></div>
            <div><dt className="text-muted-foreground">Containers</dt><dd className="font-semibold tabular-nums">{net.containers}</dd></div>
            <div><dt className="text-muted-foreground">Subnet</dt><dd className="font-mono">{net.subnet || "—"}</dd></div>
            <div><dt className="text-muted-foreground">Gateway</dt><dd className="font-mono">{net.gateway || "—"}</dd></div>
          </dl>
          <div className="flex flex-wrap gap-1"><Flags net={net} /></div>
        </li>
      ))}
    </ul>
  )
}
