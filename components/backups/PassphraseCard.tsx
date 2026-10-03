"use client"

import { useState } from "react"
import { KeyRound, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Pill } from "@/components/dashboard/Pill"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field } from "./DestinationDialog"
import { api, errMsg } from "./shared"

const DOCS = "https://github.com/SakithaSamarathunga33/PulseNode/blob/main/docs/backups.md"
const MIN = 12

/** Set / change the passphrase that encrypts backups, with the disaster-recovery summary. */
export function PassphraseCard({ set, onSaved }: { set: boolean; onSaved: () => void }) {
  const [pass, setPass] = useState("")
  const [again, setAgain] = useState("")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const tooShort = pass.length > 0 && pass.length < MIN
  const mismatch = again.length > 0 && pass !== again
  const valid = pass.length >= MIN && pass === again

  async function save() {
    setSaving(true); setErr(null)
    try {
      await api.post("/api/backups/passphrase", { passphrase: pass })
      toast.success(set ? "Passphrase changed" : "Passphrase set")
      setPass(""); setAgain("")
      onSaved()
    } catch (e) { setErr(errMsg(e, "Could not save the passphrase")) } finally { setSaving(false) }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-[var(--hue)]" /> Backup passphrase
          <Pill tone={set ? "ok" : "warn"} dot>{set ? "Set" : "Not set"}</Pill>
        </CardTitle>
        <CardDescription>
          The panel backup is encrypted with this passphrase. If you lose it the backup cannot be restored.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={e => { e.preventDefault(); if (valid && !saving) void save() }}
        >
          <Field id="bp-pass" label={set ? "New passphrase" : "Passphrase"} hint={tooShort ? undefined : `At least ${MIN} characters.`}>
            <Input id="bp-pass" type="password" value={pass} onChange={e => setPass(e.target.value)} autoComplete="new-password" aria-invalid={tooShort} />
          </Field>
          <Field id="bp-again" label="Repeat passphrase">
            <Input id="bp-again" type="password" value={again} onChange={e => setAgain(e.target.value)} autoComplete="new-password" aria-invalid={mismatch} />
          </Field>
          <Button type="submit" disabled={!valid || saving}>
            {saving && <Loader2 className="size-4 animate-spin" />} {set ? "Change passphrase" : "Set passphrase"}
          </Button>
        </form>
        {tooShort && <p role="alert" className="text-xs font-medium text-danger">Use at least {MIN} characters.</p>}
        {mismatch && <p role="alert" className="text-xs font-medium text-danger">The two passphrases do not match.</p>}
        {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
        {set && (
          <p className="text-xs text-muted-foreground">
            Changing it does not re-encrypt existing backups. Keep the old passphrase for as long as you keep those backups.
          </p>
        )}

        <details className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">If the server is lost: how to recover</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>Install PulseNode on a new server.</li>
            <li>Download the latest panel backup from an off-site destination (or the History tab).</li>
            <li>Restore it with your passphrase. That brings back settings, encryption keys and the database.</li>
            <li>Restore database backups from the History tab.</li>
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">
            Full steps:{" "}
            <a href={DOCS} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-2">docs/backups.md</a>.
            Keep the passphrase somewhere other than this server.
          </p>
        </details>
      </CardContent>
    </Card>
  )
}
