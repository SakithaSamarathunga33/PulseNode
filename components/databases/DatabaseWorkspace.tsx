"use client"

import { BarChart3, LayoutDashboard, TerminalSquare } from "lucide-react"
import { Pill } from "@/components/dashboard/Pill"
import { DatabaseQueryEditor } from "@/components/dashboard/DatabaseQueryEditor"
import { DatabaseMetricsPanel } from "@/components/dashboard/DatabaseMetricsPanel"
import { Segmented } from "@/components/pn/Segmented"
import type { Database } from "@/lib/types"
import { TablesPanel } from "./TablesPanel"
import { statusLabel, statusTone } from "./shared"

export type WorkspaceTab = "overview" | "query" | "metrics"

/** Expanded row content: Overview / Query / Metrics tabs for one database. */
export function DatabaseWorkspace({ db, tab, onTab }: { db: Database; tab: WorkspaceTab; onTab: (t: WorkspaceTab) => void }) {
  return (
    <div className="flex flex-col gap-3.5 border-l-[3px] border-l-primary bg-muted/30 px-4 pt-3.5 pb-5 motion-safe:animate-in motion-safe:fade-in-0 duration-200">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          aria-label="Database workspace"
          value={tab}
          onChange={onTab}
          options={[
            { value: "overview", label: <><LayoutDashboard className="size-3.5" /> Overview</> },
            { value: "query", label: <><TerminalSquare className="size-3.5" /> Query</> },
            { value: "metrics", label: <><BarChart3 className="size-3.5" /> Metrics</> },
          ]}
        />
        <Pill tone={statusTone(db.state)} dot>{statusLabel(db.state)}</Pill>
      </div>
      {tab === "overview" && <TablesPanel db={db} />}
      {tab === "query" && <DatabaseQueryEditor db={db} initialQuery="" onClose={() => onTab("overview")} />}
      {tab === "metrics" && <DatabaseMetricsPanel db={db} onClose={() => onTab("overview")} />}
    </div>
  )
}
