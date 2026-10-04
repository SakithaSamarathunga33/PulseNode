"use client"

import { Cloud, HardDrive, Loader2, Pencil, Plus, Trash2, Zap } from "lucide-react"
import { Pill } from "@/components/dashboard/Pill"
import { EmptyState } from "@/components/pn/EmptyState"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Destination } from "./shared"
import { Truncate } from "@/components/pn/Truncate"

type Props = {
  destinations: Destination[]
  testingId: string | null
  onNew: () => void
  onEdit: (d: Destination) => void
  onDelete: (d: Destination) => void
  onTest: (d: Destination) => void
  onToggle: (d: Destination, enabled: boolean) => void
}

function where(d: Destination) {
  return d.type === "s3"
    ? `${d.bucket ?? ""}${d.prefix ? `/${d.prefix.replace(/^\/+/, "")}` : ""} @ ${d.endpoint ?? ""}`
    : d.dir ?? ""
}

function TypePill({ d }: { d: Destination }) {
  return (
    <Pill tone="outline" className="gap-1">
      {d.type === "s3" ? <Cloud className="size-3" /> : <HardDrive className="size-3" />}
      {d.type === "s3" ? "S3" : "Local"}
    </Pill>
  )
}

function Actions({ d, testing, onEdit, onDelete, onTest }: { d: Destination; testing: boolean } & Pick<Props, "onEdit" | "onDelete" | "onTest">) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      <Button variant="ghost" size="sm" disabled={testing} onClick={() => onTest(d)} aria-label={`Test ${d.name}`}>
        {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />} Test
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${d.name}`} onClick={() => onEdit(d)}><Pencil className="size-4" /></Button>
      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${d.name}`} onClick={() => onDelete(d)}><Trash2 className="size-4 text-danger" /></Button>
    </div>
  )
}

export function DestinationsTab({ destinations, testingId, onNew, onEdit, onDelete, onTest, onToggle }: Props) {
  if (destinations.length === 0) {
    return (
      <EmptyState
        icon={Cloud} title="No destinations yet"
        description="A destination is where backups are stored. Add a local folder, and an S3-compatible bucket so a copy survives the loss of this server."
        action={<Button onClick={onNew}><Plus className="size-4" /> Add destination</Button>}
      />
    )
  }
  return (
    <>
      <Card className="hidden gap-0 overflow-hidden py-0 md:block">
        <div className="overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Credentials</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {destinations.map(d => (
                <TableRow key={d.id} className="h-[52px]">
                  <TableCell className="max-w-[14rem] text-sm font-medium"><Truncate text={d.name} /></TableCell>
                  <TableCell><TypePill d={d} /></TableCell>
                  <TableCell className="max-w-[280px] text-xs text-muted-foreground"><Truncate mono text={where(d)} /></TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {d.type === "s3" ? (d.secretSet ? <span className="font-mono text-xs">{d.accessKeyHint || "saved"} · secret saved</span> : <span className="text-warning">not set</span>) : "—"}
                  </TableCell>
                  <TableCell><Switch checked={d.enabled} onCheckedChange={v => onToggle(d, v)} aria-label={`Enable destination ${d.name}`} /></TableCell>
                  <TableCell><Actions d={d} testing={testingId === d.id} onEdit={onEdit} onDelete={onDelete} onTest={onTest} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      <ul className="space-y-3 md:hidden">
        {destinations.map(d => (
          <li key={d.id}>
            <Card className="gap-3 py-4">
              <div className="flex items-start justify-between gap-3 px-4">
                <div className="min-w-0">
                  <Truncate text={d.name} className="text-sm font-medium" />
                  <Truncate mono text={where(d)} className="text-xs text-muted-foreground" />
                </div>
                <Switch checked={d.enabled} onCheckedChange={v => onToggle(d, v)} aria-label={`Enable destination ${d.name}`} />
              </div>
              <div className="flex items-center gap-2 px-4"><TypePill d={d} />
                {d.type === "s3" && !d.secretSet && <span className="text-xs text-warning">credentials not set</span>}
              </div>
              <div className="px-3"><Actions d={d} testing={testingId === d.id} onEdit={onEdit} onDelete={onDelete} onTest={onTest} /></div>
            </Card>
          </li>
        ))}
      </ul>
    </>
  )
}
