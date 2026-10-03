"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Loader2 } from "lucide-react"
import { DbIcon } from "@/components/dashboard/DbIcon"
import { nodeApi } from "@/lib/api"
import { copyText } from "@/lib/utils"

const ENGINES = [
  { id: "postgres", label: "PostgreSQL", desc: "Relational · postgres:16-alpine" },
  { id: "mysql",    label: "MySQL",      desc: "Relational · mysql:8.0" },
  { id: "redis",    label: "Redis",      desc: "Key-value  · redis:7-alpine" },
  { id: "mongodb",  label: "MongoDB",    desc: "Document   · mongo:7" },
]

type Phase = "pick" | "provisioning" | "done" | "error"

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
      <div className="text-[10px] uppercase tracking-wider text-helm-fg3 font-semibold">{label}</div>
      <div className="flex items-center gap-2 bg-pulseNode-navy rounded-lg px-3 py-2 border border-pulseNode-border/20">
        <code className="flex-1 text-[11px] text-helm-fg font-mono break-all">{value}</code>
        <button
          onClick={copy}
          className="shrink-0 text-[10px] text-pn-electric hover:text-pn-electric/80 transition-colors font-medium"
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
    </div>
  )
}

export function CreateDatabaseModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [mounted,  setMounted]  = useState(false)
  const [phase,    setPhase]    = useState<Phase>("pick")
  const [engine,   setEngine]   = useState("")
  const [name,     setName]     = useState("")
  const [progress, setProgress] = useState("Starting provisioning…")
  const [creds,    setCreds]    = useState<Creds | null>(null)
  const [errMsg,   setErrMsg]   = useState("")
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => { setMounted(true) }, [])

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

  if (!mounted) return null

  return createPortal(
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="bg-pulseNode-navyLight rounded-2xl border border-pulseNode-border/20 shadow-2xl w-full max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-pulseNode-border/10">
          <div>
            <h2 className="text-base font-bold text-helm-fg">Create Database</h2>
            <p className="text-xs text-helm-fg3 mt-0.5">Spin up a new container on this VPS</p>
          </div>
          <button onClick={onClose} className="text-helm-fg3 hover:text-helm-fg transition-colors text-lg">✕</button>
        </div>

        <div className="p-5 space-y-5">
          {/* Engine + name picker */}
          {phase === "pick" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                {ENGINES.map(e => (
                  <button
                    key={e.id}
                    onClick={() => setEngine(e.id)}
                    className={`flex flex-col items-start gap-1.5 p-3 rounded-xl border transition-all text-left ${
                      engine === e.id
                        ? "border-pn-electric/60 bg-pn-electric/10"
                        : "border-pulseNode-border/20 hover:border-pulseNode-border/40"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <DbIcon engine={e.id} size={22} />
                      <span className="font-semibold text-sm text-helm-fg">{e.label}</span>
                    </div>
                    <span className="text-[10px] text-helm-fg3">{e.desc}</span>
                  </button>
                ))}
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-helm-fg3">
                  Database name <span className="text-helm-fg4 font-normal">(optional)</span>
                </label>
                <input
                  value={name}
                  onChange={e => setName(e.target.value.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_.-]/g, ""))}
                  placeholder={engine ? `my-${engine}` : "my-database"}
                  className="w-full px-3 py-2 rounded-lg text-sm font-mono focus:outline-hidden"
                  style={{
                    background: "var(--bg-2)",
                    border: "1px solid var(--border)",
                    color: "var(--fg)",
                  }}
                  onFocus={e => { (e.target as HTMLInputElement).style.borderColor = "var(--acc-border)" }}
                  onBlur={e =>  { (e.target as HTMLInputElement).style.borderColor = "var(--border)" }}
                />
                <p className="text-[10px] text-helm-fg3">
                  Leave blank to auto-generate. Used as the container and database name — letters, numbers, dots, dashes and underscores only.
                </p>
              </div>

              <div className="text-[11px] text-helm-fg3 bg-pulseNode-navy/50 rounded-lg px-3 py-2">
                ⏱ First-time pulls may take 1–5 minutes depending on image size and network speed.
              </div>
              <div className="flex gap-3">
                <button onClick={onClose} className="flex-1 border border-pulseNode-border/20 text-helm-fg3 hover:text-helm-fg rounded-xl py-2 text-sm transition-colors">
                  Cancel
                </button>
                <button
                  onClick={provision}
                  disabled={!engine}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-pulseNode-border/20 disabled:text-helm-fg3 text-white rounded-xl py-2 text-sm font-semibold transition-colors"
                >
                  Create {engine ? ENGINES.find(e => e.id === engine)?.label : ""}
                </button>
              </div>
            </>
          )}

          {/* Provisioning */}
          {phase === "provisioning" && (
            <div className="flex flex-col items-center gap-4 py-6">
              <Loader2 className="w-10 h-10 animate-spin text-pn-electric" />
              <div className="text-center">
                <p className="text-sm font-medium text-helm-fg">Provisioning {engine}…</p>
                <p className="text-xs text-helm-fg3 mt-1">{progress}</p>
              </div>
            </div>
          )}

          {/* Success */}
          {phase === "done" && creds && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-emerald-400">
                <span className="text-xl">✓</span>
                <span className="font-semibold">{engine} is running</span>
              </div>
              <CopyField label="Connection String" value={creds.connection_string} />
              <CopyField label="Password" value={creds.password} />
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-pulseNode-navy rounded-lg p-2.5">
                  <div className="text-helm-fg3 text-[9px] uppercase tracking-wider mb-1">User</div>
                  <div className="text-helm-fg font-mono">{creds.username}</div>
                </div>
                <div className="bg-pulseNode-navy rounded-lg p-2.5">
                  <div className="text-helm-fg3 text-[9px] uppercase tracking-wider mb-1">Port</div>
                  <div className="text-helm-fg font-mono">{creds.host_port}</div>
                </div>
              </div>
              <p className="text-[10px] text-helm-fg3">The container uses <code className="font-mono">--restart unless-stopped</code> and will survive VPS reboots.</p>
              <button onClick={onClose} className="w-full bg-(--acc) hover:bg-(--acc-2) text-white rounded-xl py-2 text-sm font-semibold shadow-xs shadow-(--acc-soft) transition-colors">
                Done
              </button>
            </div>
          )}

          {/* Error */}
          {phase === "error" && (
            <div className="space-y-4">
              <div className="flex items-start gap-2 text-red-400">
                <span>✕</span>
                <p className="text-sm font-mono break-all">{errMsg}</p>
              </div>
              <div className="flex gap-3">
                <button onClick={onClose} className="flex-1 border border-pulseNode-border/20 text-helm-fg3 rounded-xl py-2 text-sm transition-colors">
                  Close
                </button>
                <button onClick={() => setPhase("pick")} className="flex-1 bg-(--acc) hover:bg-(--acc-2) text-white rounded-xl py-2 text-sm font-semibold shadow-xs shadow-(--acc-soft) transition-colors">
                  Try again
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
