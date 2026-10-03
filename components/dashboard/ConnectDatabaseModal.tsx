"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import type { CustomConnection } from "@/lib/types"

type Phase = "input" | "testing" | "tested" | "saving" | "saved" | "error"

export function ConnectDatabaseModal({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: (conn: CustomConnection) => void
}) {
  const [mounted,    setMounted]    = useState(false)
  const [phase,      setPhase]      = useState<Phase>("input")
  const [connStr,    setConnStr]    = useState("")
  const [alias,      setAlias]      = useState("")
  const [testResult, setTestResult] = useState<{ engine: string; host: string; port: number; version?: string } | null>(null)
  const [errMsg,     setErrMsg]     = useState("")

  useEffect(() => setMounted(true), [])

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

  if (!mounted) return null

  return createPortal(
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="bg-pulseNode-navyLight rounded-2xl border border-pulseNode-border/20 shadow-2xl w-full max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-pulseNode-border/10">
          <div>
            <h2 className="text-base font-bold text-helm-fg">Add External Database</h2>
            <p className="text-xs text-helm-fg3 mt-0.5">Monitor any database by connection string</p>
          </div>
          <button onClick={onClose} className="text-helm-fg3 hover:text-helm-fg transition-colors text-lg">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Connection string input */}
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-helm-fg3 font-semibold">Connection String</label>
            <textarea
              value={connStr}
              onChange={e => { setConnStr(e.target.value); setPhase("input"); setTestResult(null) }}
              placeholder={ENGINE_EXAMPLES.postgres}
              rows={3}
              className="w-full bg-pulseNode-navy border border-pulseNode-border/20 text-helm-fg font-mono text-xs rounded-lg px-3 py-2.5 outline-hidden focus:border-pn-electric/50 resize-none placeholder:text-helm-fg3/40"
            />
            <div className="flex gap-2 flex-wrap">
              {Object.entries(ENGINE_EXAMPLES).map(([eng, ex]) => (
                <button
                  key={eng}
                  onClick={() => setConnStr(ex)}
                  className="text-[9px] text-helm-fg3 hover:text-helm-fg bg-pulseNode-navy/60 px-2 py-0.5 rounded transition-colors"
                >
                  {eng}
                </button>
              ))}
            </div>
          </div>

          {/* Optional alias */}
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-helm-fg3 font-semibold">
              Display Name <span className="normal-case opacity-60">(optional)</span>
            </label>
            <input
              value={alias}
              onChange={e => setAlias(e.target.value)}
              placeholder="My Production DB"
              className="w-full bg-pulseNode-navy border border-pulseNode-border/20 text-helm-fg text-xs rounded-lg px-3 py-2 outline-hidden focus:border-pn-electric/50 placeholder:text-helm-fg3/40"
            />
          </div>

          {/* Test result */}
          {phase === "tested" && testResult && (
            <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
              <span className="text-emerald-400">✓</span>
              <span className="text-xs text-emerald-400">
                Connected · {testResult.engine} {testResult.version && `v${testResult.version}`} · {testResult.host}:{testResult.port}
              </span>
            </div>
          )}

          {/* Error */}
          {phase === "error" && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <span className="text-red-400 shrink-0">✕</span>
              <p className="text-xs text-red-400 font-mono break-all">{errMsg}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg rounded-xl py-2 text-sm transition-colors"
            >
              Cancel
            </button>

            {(phase === "input" || phase === "error" || phase === "tested") && (
              <button
                onClick={phase === "tested" ? saveConnection : testConnection}
                className={`flex-1 rounded-xl py-2 text-sm font-semibold transition-colors ${
                  phase === "tested"
                    ? "bg-emerald-600 hover:bg-emerald-500 text-white"
                    : "bg-(--acc) hover:bg-(--acc-2) text-white shadow-xs shadow-(--acc-soft)"
                }`}
              >
                {phase === "tested" ? "Save to monitoring" : "Test Connection"}
              </button>
            )}

            {(phase === "testing" || phase === "saving") && (
              <button disabled className="flex-1 bg-pulseNode-border/20 text-helm-fg3 rounded-xl py-2 text-sm">
                {phase === "testing" ? "Testing…" : "Saving…"}
              </button>
            )}
          </div>

          {phase === "saved" && (
            <div className="text-center text-xs text-emerald-400">
              ✓ Added to monitoring. The database will appear in the list on next refresh.
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
