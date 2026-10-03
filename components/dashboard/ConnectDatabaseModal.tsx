"use client"

import { useState } from "react"
import { CheckCircle2, Loader2, XCircle } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { CustomConnection } from "@/lib/types"

type Phase = "input" | "testing" | "tested" | "saving" | "saved" | "error"

export function ConnectDatabaseModal({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: (conn: CustomConnection) => void
}) {
  const [phase,      setPhase]      = useState<Phase>("input")
  const [connStr,    setConnStr]    = useState("")
  const [alias,      setAlias]      = useState("")
  const [testResult, setTestResult] = useState<{ engine: string; host: string; port: number; version?: string } | null>(null)
  const [errMsg,     setErrMsg]     = useState("")
  const [step,       setStep]       = useState<1 | 2>(1)

  async function testConnection() {
    if (!connStr.trim()) return
    setPhase("testing")
    setErrMsg("")
    try {
      const res = await fetch("/api/database/custom/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionString: connStr.trim() }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
      setTestResult(body)
      setPhase("tested")
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : "Connection failed")
      setPhase("error")
    }
  }

  async function saveConnection() {
    if (!testResult) return
    setPhase("saving")
    try {
      const res = await fetch("/api/database/custom/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionString: connStr.trim(),
          name:    alias.trim() || `${testResult.engine} @ ${testResult.host}`,
          engine:  testResult.engine,
          host:    testResult.host,
          port:    testResult.port,
          version: testResult.version,
        }),
      })
      const body = await res.json() as CustomConnection
      if (!res.ok) throw new Error((body as { error?: string })?.error || `HTTP ${res.status}`)
      setPhase("saved")
      onSaved(body)
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : "Failed to save")
      setPhase("error")
    }
  }

  const ENGINE_EXAMPLES: Record<string, string> = {
    postgres: "postgresql://user:pass@host:5432/db",
    mysql:    "mysql://user:pass@host:3306/db",
    redis:    "redis://:pass@host:6379",
    mongodb:  "mongodb://user:pass@host:27017/db",
  }

  const busy = phase === "testing" || phase === "saving"

  // Hide the password in the confirmation line on step 2.
  const masked = connStr.trim().replace(/(:\/\/[^:/@]*:)[^@]*@/, "$1••••••@")

  return (
    <Dialog open disablePointerDismissal onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] gap-4 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect external database</DialogTitle>
          <DialogDescription>Step {step} of 2 · {step === 1 ? "Connection string" : "Name and test"}</DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-1.5">
            <Label htmlFor="connect-db-string">Connection string</Label>
            <Textarea
              id="connect-db-string"
              value={connStr}
              onChange={e => { setConnStr(e.target.value); setPhase("input"); setTestResult(null) }}
              placeholder={ENGINE_EXAMPLES.postgres}
              rows={3}
              spellCheck={false}
              className="resize-none font-mono text-xs"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Examples:</span>
              {Object.entries(ENGINE_EXAMPLES).map(([eng, ex]) => (
                <Button key={eng} type="button" variant="outline" size="xs" onClick={() => setConnStr(ex)}>
                  {eng}
                </Button>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="connect-db-alias">
                Display name <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="connect-db-alias"
                value={alias}
                onChange={e => setAlias(e.target.value)}
                placeholder="My Production DB"
              />
            </div>
            <div className="rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs break-all">{masked}</div>
          </>
        )}

        {step === 2 && phase === "tested" && testResult && (
          <Alert className="border-success/40 bg-success/10 text-success">
            <CheckCircle2 />
            <AlertDescription className="text-success">
              Connected · <span className="font-mono">{testResult.engine} {testResult.version && `v${testResult.version}`}</span> · <span className="font-mono">{testResult.host}:{testResult.port}</span>
            </AlertDescription>
          </Alert>
        )}

        {step === 2 && phase === "error" && (
          <Alert variant="destructive">
            <XCircle />
            <AlertDescription className="break-all font-mono text-xs">{errMsg}</AlertDescription>
          </Alert>
        )}

        {phase === "saved" && (
          <Alert className="border-success/40 bg-success/10 text-success">
            <CheckCircle2 />
            <AlertDescription className="text-success">
              Added to monitoring. The database will appear in the list on next refresh.
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => { if (step === 1) onClose(); else { setStep(1); setPhase("input"); setTestResult(null) } }}
          >
            {step === 1 ? "Cancel" : "Back"}
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {step === 2 && (
              <Button variant="outline" onClick={testConnection} disabled={busy}>
                {phase === "testing" && <Loader2 className="animate-spin" />}
                {phase === "testing" ? "Testing…" : "Test connection"}
              </Button>
            )}
            {step === 1 ? (
              <Button onClick={() => setStep(2)} disabled={!/^\w+:\/\/.+/.test(connStr.trim())}>Continue</Button>
            ) : (
              <Button onClick={saveConnection} disabled={phase !== "tested"}>
                {phase === "saving" && <Loader2 className="animate-spin" />}
                {phase === "saving" ? "Saving…" : "Save to monitoring"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
