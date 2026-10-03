"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { CalendarClock, Cloud, DatabaseBackup, History, KeyRound, Plus, RefreshCw, ShieldAlert, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { PageBody, PageHeader } from "@/components/pn/PageHeader"
import { ConfirmDialog } from "@/components/pn/ConfirmDialog"
import { Segmented } from "@/components/pn/Segmented"
import { SummaryStrip } from "@/components/pn/SummaryStrip"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { DestinationDialog } from "@/components/backups/DestinationDialog"
import { DestinationsTab } from "@/components/backups/DestinationsTab"
import { HistoryTab } from "@/components/backups/HistoryTab"
import { PassphraseCard } from "@/components/backups/PassphraseCard"
import { RestoreDialog } from "@/components/backups/RestoreDialog"
import { ScheduleDialog } from "@/components/backups/ScheduleDialog"
import { SchedulesTab } from "@/components/backups/SchedulesTab"
import {
  absTime, api, asArray, errMsg, isPanel, relTime, targetText,
  type BackupStatus, type Destination, type HistoryEntry, type Schedule, type TestResult,
} from "@/components/backups/shared"

type Tab = "schedules" | "history" | "destinations"
type Confirm =
  | { kind: "schedule"; item: Schedule }
  | { kind: "destination"; item: Destination }
  | { kind: "history"; item: HistoryEntry }

const POLL_FAST = 3000   // while a backup is running
const POLL_IDLE = 30000

export default function BackupsPage() {
  const [tab, setTab] = useState<Tab>("schedules")
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")

  const [scheduleDialog, setScheduleDialog] = useState<Schedule | "new" | null>(null)
  const [destDialog, setDestDialog] = useState<Destination | "new" | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [restoring, setRestoring] = useState<HistoryEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [testingId, setTestingId] = useState<string | null>(null)

  const filterRef = useRef(filter)
  const seq = useRef(0)
  const inflight = useRef(false)

  const load = useCallback(async () => {
    const mine = ++seq.current
    inflight.current = true
    try {
      const q = filterRef.current ? `&scheduleId=${encodeURIComponent(filterRef.current)}` : ""
      const [st, de, sc, hi] = await Promise.all([
        api.get<BackupStatus>("/api/backups/status"),
        api.get<Destination[]>("/api/backups/destinations"),
        api.get<Schedule[]>("/api/backups/schedules"),
        api.get<HistoryEntry[]>(`/api/backups/history?limit=50${q}`),
      ])
      if (mine !== seq.current) return // a newer request (e.g. a filter change) superseded this one
      setStatus(st); setDestinations(asArray<Destination>(de)); setSchedules(asArray<Schedule>(sc)); setHistory(asArray<HistoryEntry>(hi))
      setError(null)
    } catch (e) {
      if (mine === seq.current) setError(errMsg(e, "Could not load backups"))
    } finally {
      if (mine === seq.current) { inflight.current = false; setLoaded(true) }
    }
  }, [])

  // Running rows come from history, from the schedule's own status, and from a run we just requested.
  const runningIds = new Set<string>(pending)
  history.forEach(h => { if (h.status === "running") runningIds.add(h.scheduleId) })
  schedules.forEach(s => { if (s.lastStatus === "running") runningIds.add(s.id) })
  const anyRunning = runningIds.size > 0
  const runningRef = useRef(anyRunning)
  runningRef.current = anyRunning

  // Self-scheduling poll: 3s while something runs, 30s otherwise; never overlaps, skips hidden tabs.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (!document.hidden && !inflight.current) await load()
      if (!cancelled) timer = setTimeout(tick, runningRef.current ? POLL_FAST : POLL_IDLE)
    }
    void tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [load])

  function changeFilter(id: string) {
    filterRef.current = id
    setFilter(id)
    void load()
  }

  async function runNow(s: Schedule) {
    setPending(p => new Set(p).add(s.id))
    try {
      await api.post(`/api/backups/schedules/${s.id}/run`)
      toast.success(`Backup “${s.name}” started`)
      setTab("history")
    } catch (e) {
      toast.error(errMsg(e, "Could not start the backup"))
    } finally {
      await load()
      setPending(p => { const n = new Set(p); n.delete(s.id); return n })
    }
  }

  async function toggleSchedule(s: Schedule, enabled: boolean) {
    setSchedules(prev => prev.map(x => (x.id === s.id ? { ...x, enabled } : x)))
    try { await api.patch(`/api/backups/schedules/${s.id}`, { enabled }); void load() }
    catch (e) { setSchedules(prev => prev.map(x => (x.id === s.id ? { ...x, enabled: s.enabled } : x))); toast.error(errMsg(e, "Could not update the schedule")) }
  }

  async function toggleDestination(d: Destination, enabled: boolean) {
    setDestinations(prev => prev.map(x => (x.id === d.id ? { ...x, enabled } : x)))
    try { await api.patch(`/api/backups/destinations/${d.id}`, { enabled }); void load() }
    catch (e) { setDestinations(prev => prev.map(x => (x.id === d.id ? { ...x, enabled: d.enabled } : x))); toast.error(errMsg(e, "Could not update the destination")) }
  }

  async function testDestination(d: Destination) {
    setTestingId(d.id)
    try {
      const r = await api.post<TestResult>(`/api/backups/destinations/${d.id}/test`)
      if (r.ok === false) toast.error(`${d.name}: ${r.error || r.message || "the test failed"}`)
      else toast.success(`${d.name}: ${r.message || "connection works"}`)
    } catch (e) { toast.error(`${d.name}: ${errMsg(e, "the test failed")}`) } finally { setTestingId(null) }
  }

  async function doConfirm() {
    if (!confirm) return
    setBusy(true)
    try {
      if (confirm.kind === "schedule") { await api.del(`/api/backups/schedules/${confirm.item.id}`); toast.success("Schedule deleted") }
      else if (confirm.kind === "destination") { await api.del(`/api/backups/destinations/${confirm.item.id}`); toast.success("Destination deleted") }
      else { await api.del(`/api/backups/history/${confirm.item.id}`); toast.success("Backup deleted") }
      setConfirm(null)
      await load()
    } catch (e) { toast.error(errMsg(e, "Could not delete")) } finally { setBusy(false) }
  }

  async function doRestore() {
    if (!restoring) return
    setBusy(true)
    try {
      await api.post(`/api/backups/history/${restoring.id}/restore`, { confirm: "restore" })
      toast.success(`Restore of ${restoring.targetName || "the database"} started`)
      setRestoring(null)
      await load()
    } catch (e) { toast.error(errMsg(e, "Could not restore")) } finally { setBusy(false) }
  }

  const enabledDests = destinations.filter(d => d.enabled).length
  const passphraseSet = status?.passphraseSet ?? false
  const needsPassphrase = loaded && !!status && !passphraseSet && schedules.some(s => s.encrypt || isPanel(s.target))
  const noDestination = loaded && !error && enabledDests === 0

  function gotoPassphrase() {
    setTab("destinations")
    requestAnimationFrame(() => document.getElementById("passphrase")?.scrollIntoView({ behavior: "smooth", block: "start" }))
  }

  const confirmProps = !confirm ? null
    : confirm.kind === "schedule" ? {
      title: "Delete this schedule?", confirmLabel: "Delete schedule",
      items: [{ primary: confirm.item.name, secondary: targetText(confirm.item.target, confirm.item.targetName) }],
      note: "No more automatic backups will run for it.",
    } : confirm.kind === "destination" ? {
      title: "Delete this destination?", confirmLabel: "Delete destination",
      items: [{ primary: confirm.item.name, secondary: confirm.item.type === "s3" ? `${confirm.item.bucket ?? ""} @ ${confirm.item.endpoint ?? ""}` : confirm.item.dir }],
      note: "Schedules that use it will stop copying backups there.",
    } : {
      title: "Delete this backup?", confirmLabel: "Delete backup",
      items: [{ primary: confirm.item.scheduleName, secondary: `${targetText(confirm.item.target, confirm.item.targetName)} · ${absTime(confirm.item.startedAt)}` }],
      note: "It can no longer be downloaded or restored. This cannot be undone.",
    }

  return (
    <>
      <PageHeader
        icon={DatabaseBackup}
        title="Backups"
        description="Automatic, encrypted backups of the panel and your databases, copied off this server."
        actions={
          <>
            <Segmented<Tab>
              aria-label="Backups view"
              value={tab}
              onChange={setTab}
              size="default"
              options={[
                { value: "schedules", label: <><CalendarClock className="size-3.5" />Schedules</>, count: schedules.length },
                { value: "history", label: <><History className="size-3.5" />History</> },
                { value: "destinations", label: <><Cloud className="size-3.5" />Destinations</>, count: destinations.length },
              ]}
            />
            {tab !== "history" && (
              <Button onClick={() => (tab === "destinations" ? setDestDialog("new") : setScheduleDialog("new"))}>
                <Plus className="size-4" /> {tab === "destinations" ? "Add destination" : "New schedule"}
              </Button>
            )}
          </>
        }
      />

      <PageBody className="motion-safe:animate-in fade-in-0 duration-300">
        {error && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Could not load backups</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            <AlertAction><Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="size-3.5" /> Retry</Button></AlertAction>
          </Alert>
        )}

        {noDestination && (
          <Alert>
            <ShieldAlert className="text-warning" />
            <AlertTitle>No backup destination yet</AlertTitle>
            <AlertDescription>Backups need somewhere to go. Add a local folder and, so a copy survives losing this server, an S3-compatible bucket.</AlertDescription>
            <AlertAction><Button size="sm" onClick={() => { setTab("destinations"); setDestDialog("new") }}><Plus className="size-3.5" /> Add destination</Button></AlertAction>
          </Alert>
        )}

        {needsPassphrase && (
          <Alert>
            <KeyRound className="text-warning" />
            <AlertTitle>Set a backup passphrase</AlertTitle>
            <AlertDescription>Encrypted backups, including every panel backup, cannot run until a passphrase is set. Without it, a backup cannot be restored.</AlertDescription>
            <AlertAction><Button size="sm" onClick={gotoPassphrase}>Set passphrase</Button></AlertAction>
          </Alert>
        )}

        {!loaded ? (
          <>
            <Skeleton className="h-[112px] rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </>
        ) : (
          <>
            {status && (
              <SummaryStrip
                aria-label="Backup summary"
                items={[
                  { label: "Last backup", icon: History, value: status.lastRunAt ? relTime(status.lastRunAt) : "never", meta: status.lastRunAt ? absTime(status.lastRunAt) : "No backup has run yet" },
                  {
                    label: "Next run", icon: CalendarClock, value: status.nextRunAt ? relTime(status.nextRunAt) : "—",
                    meta: status.schedulerRunning ? (status.nextRunAt ? absTime(status.nextRunAt) : "No active schedule") : "Scheduler is not running",
                    tone: status.schedulerRunning ? undefined : "bad",
                  },
                  { label: "Failed in 24h", icon: TriangleAlert, value: status.failedLast24h, meta: status.failedLast24h > 0 ? "Check the History tab" : "No failures", tone: status.failedLast24h > 0 ? "bad" : "ok" },
                  { label: "Destinations", icon: Cloud, value: enabledDests, unit: `of ${destinations.length}`, meta: `${schedules.length} schedule${schedules.length === 1 ? "" : "s"}` },
                ]}
              />
            )}

            {tab === "schedules" && (
              <SchedulesTab
                schedules={schedules} destinations={destinations} runningIds={runningIds}
                onNew={() => setScheduleDialog("new")} onEdit={setScheduleDialog}
                onDelete={s => setConfirm({ kind: "schedule", item: s })}
                onRun={runNow} onToggle={toggleSchedule}
              />
            )}
            {tab === "history" && (
              <HistoryTab
                history={history} schedules={schedules} filter={filter} onFilter={changeFilter}
                onDelete={h => setConfirm({ kind: "history", item: h })} onRestore={setRestoring}
              />
            )}
            {tab === "destinations" && (
              <div className="space-y-5">
                <DestinationsTab
                  destinations={destinations} testingId={testingId}
                  onNew={() => setDestDialog("new")} onEdit={setDestDialog}
                  onDelete={d => setConfirm({ kind: "destination", item: d })}
                  onTest={testDestination} onToggle={toggleDestination}
                />
                <div id="passphrase" className="scroll-mt-4">
                  <PassphraseCard set={passphraseSet} onSaved={() => void load()} />
                </div>
              </div>
            )}
          </>
        )}
      </PageBody>

      <ScheduleDialog
        value={scheduleDialog} destinations={destinations} passphraseSet={passphraseSet}
        onClose={() => setScheduleDialog(null)}
        onSaved={() => { setScheduleDialog(null); void load() }}
        onAddDestination={() => { setTab("destinations"); setDestDialog("new") }}
      />
      <DestinationDialog
        value={destDialog}
        onClose={() => setDestDialog(null)}
        onSaved={() => { setDestDialog(null); void load() }}
      />
      {confirmProps && (
        <ConfirmDialog
          open onOpenChange={o => { if (!o && !busy) setConfirm(null) }}
          {...confirmProps} loading={busy} onConfirm={doConfirm}
        />
      )}
      {restoring && <RestoreDialog entry={restoring} busy={busy} onConfirm={doRestore} onClose={() => setRestoring(null)} />}
    </>
  )
}
