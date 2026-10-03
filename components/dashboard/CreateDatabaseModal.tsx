"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowLeft, Check, CheckCircle2, Clock, Copy, Loader2, XCircle } from "lucide-react"
import { DbIcon } from "@/components/dashboard/DbIcon"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { nodeApi } from "@/lib/api"
import { cn, copyText } from "@/lib/utils"

const ENGINES = [
  { id: "postgres", label: "PostgreSQL", kind: "Relational", image: "postgres:16-alpine" },
  { id: "mysql",    label: "MySQL",      kind: "Relational", image: "mysql:8.0" },
  { id: "redis",    label: "Redis",      kind: "Key-value",  image: "redis:7-alpine" },
  { id: "mongodb",  label: "MongoDB",    kind: "Document",   image: "mongo:7" },
]

const STEPS = ["Engine", "Provision", "Done"]

type Phase = "pick" | "name" | "provisioning" | "done" | "error"

function Stepper({ step }: { step: number }) {
  return (
    <ol aria-label="Progress" className="flex items-center gap-2">
      {STEPS.map((label, i) => {
        const n = i + 1
        const done = step > n
        const cur = step === n
        return (
          <li key={label} aria-current={cur ? "step" : undefined} className={cn("flex items-center gap-2 text-sm", i < 2 && "flex-1")}>
            <span
              className={cn(
                "grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums",
                done || cur ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3.5" /> : n}
            </span>
            <span className={cn("font-medium", cur ? "text-foreground" : "text-muted-foreground")}>{label}</span>
            {i < 2 && <span className={cn("h-px flex-1", done ? "bg-primary" : "bg-border")} aria-hidden />}
          </li>
        )
      })}
    </ol>
  )
}

interface Creds {
  username: string
  password: string
  db_name: string
  host_port: number
  connection_string: string
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    const ok = await copyText(value)
    if (!ok) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2 rounded-lg border bg-muted/40 py-1.5 pl-3 pr-1.5">
        <code className="min-w-0 flex-1 break-all font-mono text-xs">{value}</code>
        <Button variant="ghost" size="xs" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
          {copied ? <Check className="text-success" /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  )
}

export function CreateDatabaseModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [phase,    setPhase]    = useState<Phase>("pick")
  const [engine,   setEngine]   = useState("")
  const [name,     setName]     = useState("")
  const [progress, setProgress] = useState("Starting provisioning…")
  const [creds,    setCreds]    = useState<Creds | null>(null)
  const [errMsg,   setErrMsg]   = useState("")
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  async function provision() {
    const dbName = name.trim() || `${engine}-${Date.now()}`
    setPhase("provisioning")
    setProgress("Sending request…")

    let id: string
    try {
      const res = await nodeApi.post<{ id: string; name: string }>("/api/databases/managed", {
        engine,
        name: dbName,
      })
      id = res.id
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : "Failed to start provisioning")
      setPhase("error")
      return
    }

    setProgress("Pulling image and creating container… (this may take a few minutes)")

    // Poll for status every 3s for up to 5 min
    const started = Date.now()
    pollRef.current = setInterval(async () => {
      if (Date.now() - started > 5 * 60 * 1000) {
        clearInterval(pollRef.current!)
        setErrMsg("Timed out waiting for database to start")
        setPhase("error")
        return
      }
      try {
        const { data: db } = await nodeApi.get<{ status: string; name: string }>(`/api/databases/managed/${id}`)
        if (db.status === "running") {
          clearInterval(pollRef.current!)
          setProgress("Fetching credentials…")
          const { data: c } = await nodeApi.get<Creds>(`/api/databases/managed/${id}/credentials`)
          setCreds(c)
          setPhase("done")
          onCreated()
        } else if (db.status === "error") {
          clearInterval(pollRef.current!)
          setErrMsg("Provisioning failed — check container logs for details")
          setPhase("error")
        } else {
          setProgress(`Container status: ${db.status} — waiting…`)
        }
      } catch {
        // network blip, keep polling
      }
    }, 3000)
  }

  return (
    <Dialog open disablePointerDismissal onOpenChange={open => { if (!open && (phase === "pick" || phase === "name" || phase === "error")) onClose() }}>
      <DialogContent className="max-h-[90vh] gap-4 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create database</DialogTitle>
          <DialogDescription>Spin up a new container on this VPS</DialogDescription>
        </DialogHeader>

        <Stepper step={phase === "pick" ? 1 : phase === "done" ? 3 : 2} />

        {/* Step 1: engine */}
        {phase === "pick" && (
          <>
            <div role="radiogroup" aria-label="Database engine" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {ENGINES.map(e => (
                <button
                  key={e.id}
                  type="button"
                  role="radio"
                  aria-checked={engine === e.id}
                  onClick={() => setEngine(e.id)}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                    engine === e.id ? "border-primary bg-primary/8 ring-1 ring-primary" : "hover:bg-muted/60",
                  )}
                >
                  <DbIcon engine={e.id} size={24} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-semibold">{e.label}</span>
                    <span className="truncate text-xs text-muted-foreground">{e.kind} · <span className="font-mono">{e.image}</span></span>
                  </span>
                  {engine === e.id && <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden />}
                </button>
              ))}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button onClick={() => setPhase("name")} disabled={!engine}>Continue</Button>
            </DialogFooter>
          </>
        )}

        {/* Step 2: name, then provisioning */}
        {(phase === "name" || phase === "provisioning" || phase === "error") && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="create-db-name">
                Container name <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="create-db-name"
                value={name}
                disabled={phase === "provisioning"}
                onChange={e => setName(e.target.value.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_.-]/g, ""))}
                placeholder={engine ? `my-${engine}` : "my-database"}
                spellCheck={false}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Leave blank to auto-generate. Letters, numbers, dots, dashes and underscores only.
              </p>
            </div>
            <div className="rounded-lg border bg-muted/40 px-3 py-2">
              <div className="text-xs text-muted-foreground">Image</div>
              <div className="font-mono text-xs">{ENGINES.find(e => e.id === engine)?.image}</div>
            </div>

            {phase === "name" && (
              <Alert>
                <Clock />
                <AlertDescription>First-time pulls may take 1–5 minutes depending on image size and network speed.</AlertDescription>
              </Alert>
            )}

            {phase === "provisioning" && (
              <div role="status" className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
                <Loader2 className="size-5 shrink-0 animate-spin text-primary" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Provisioning {engine}…</p>
                  <p className="text-xs text-muted-foreground">{progress}</p>
                </div>
              </div>
            )}

            {phase === "error" && (
              <Alert variant="destructive">
                <XCircle />
                <AlertDescription className="break-all font-mono text-xs">{errMsg}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button variant="ghost" disabled={phase === "provisioning"} onClick={() => setPhase("pick")}>
                <ArrowLeft /> Back
              </Button>
              <Button onClick={provision} disabled={phase === "provisioning"}>
                {phase === "provisioning" ? <><Loader2 className="animate-spin" /> Provisioning…</> : phase === "error" ? "Try again" : "Provision"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Success */}
        {phase === "done" && creds && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-success">
              <CheckCircle2 className="size-5 shrink-0" />
              <span className="text-sm font-medium">
                {name.trim() || engine} is running and added to monitoring. Store the password now — it is shown only once.
              </span>
            </div>
            <CopyField label="Connection string" value={creds.connection_string} />
            <CopyField label="Password" value={creds.password} />
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border bg-muted/40 p-2.5">
                <div className="mb-1 text-xs text-muted-foreground">User</div>
                <div className="font-mono text-sm">{creds.username}</div>
              </div>
              <div className="rounded-lg border bg-muted/40 p-2.5">
                <div className="mb-1 text-xs text-muted-foreground">Port</div>
                <div className="font-mono text-sm tabular-nums">{creds.host_port}</div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">The container uses <code className="font-mono">--restart unless-stopped</code> and will survive VPS reboots.</p>
            <DialogFooter>
              <Button onClick={onClose}>Open database</Button>
            </DialogFooter>
          </div>
        )}

      </DialogContent>
    </Dialog>
  )
}
