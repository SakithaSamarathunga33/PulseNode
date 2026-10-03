"use client"

import { useState, useRef, useMemo, useEffect, useCallback } from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import {
  ChevronDown, ChevronUp,
  XCircle, PauseCircle, PlayCircle, Ban,
  ShieldAlert, ShieldCheck, AlertTriangle, CheckCircle2,
} from "lucide-react"
import { PROCESSES as MOCK_PROCESSES } from "@/lib/mock-data"
import { nodeApi, pythonApi } from "@/lib/api"
import type { Process } from "@/lib/types"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog"
import { Pill } from "@/components/dashboard/Pill"
import { ProgressBar } from "@/components/dashboard/ProgressBar"
import { cn } from "@/lib/utils"

type DialogState = { type: "kill" | "suspend"; proc: Process } | null
type Tab = "processes" | "suspicious"

// ── Python process mapper ──────────────────────────────────────────────────────

type PyProcess = {
  pid: number; name: string; cpu: number; mem_mb: number
  status: string; user: string; cmd: string; type: string
}

function mapPyProcess(p: PyProcess): Process {
  return {
    pid:   p.pid,
    user:  p.user,
    cpu:   p.cpu,
    mem:   p.mem_mb,
    virt:  "—",
    res:   `${p.mem_mb} MB`,
    cmd:   p.cmd || p.name,
    state: p.status === "running" ? "R" : "S",
    time:  "—",
    type:  "system" as const,
    name:  p.name,
    memMb: p.mem_mb,
  }
}

// ── Suspicious process detection engine ───────────────────────────────────────

const KNOWN_SAFE = new Set([
  // kernel & virtual
  "systemd","init","kthreadd","kworker","ksoftirqd","migration","rcu_sched",
  "rcu_bh","rcu_gp","rcu_par_gp","watchdog","cpuhp","kdevtmpfs","netns",
  "khugepaged","kcompactd","kswapd","kswapd0","kswapd1","crypto","idle",
  "irq","ata_sff","nvme","scsi_eh","ext4-rsv-conver","jbd2","writeback",
  "bioset","kblockd","cfq","md","dm_multipath","pool_workqueue_release",
  "kworker/R-rcu_g","kworker/R-rcu_p","kworker/R-slub_","kworker/R-netns",
  "kworker/R-mm_pe","rcu_tasks_kthread","rcu_tasks_rude_","rcu_tasks_trace",
  "kauditd","khungtaskd","oom_reaper","writeback","kthrotld","irq/9-acpi",
  "acpi_thermal_pm","scsi_tmf_1","ipv6_addrconf","kstrp","charger_manager",
  "ttm_evict","drm_fb_helper_","card0-crtc0","card0-crtc1","zswap1",
  // containers & infra
  "dockerd","containerd","containerd-shim","containerd-shim-runc-v2",
  "docker-proxy","runc","docker",
  "nginx","apache2","httpd","caddy","traefik","haproxy","lighttpd",
  // databases
  "redis-server","postgres","postmaster","mysqld","mysql","mongod","mongos",
  "clickhouse-server","clickhouse","etcd","cassandra",
  // runtimes & app servers
  "node","nodejs","python","python3","python3.12","python3.11","python3.10",
  "php","php-fpm","ruby","java","uvicorn","gunicorn","puma","unicorn",
  "npm","yarn","pm2","pm2-runtime","deno","bun",
  "soketi-server","soketi","soketi-worker",
  // infra tools
  "telegraf","prometheus","alertmanager","grafana-server","node_exporter",
  "vector","fluentd","logstash","filebeat","metricbeat",
  "qemu-ga","qemu-guest-agent","virtio","vhost",
  // shells & common utils
  "bash","sh","dash","zsh","fish","tcsh","csh",
  "ps","top","htop","htop","glances","nmon",
  "grep","find","awk","sed","sort","uniq","head","tail","cut","tr","wc",
  "curl","wget","ssh","rsync","tar","gzip","bzip2","xz","zip","unzip",
  "cp","mv","rm","ls","cat","echo","printf","tee","xargs",
  "vi","vim","nano","emacs","less","more",
  "ping","traceroute","nmap","netstat","ss","ip","ifconfig","route",
  "systemctl","journalctl","loginctl","hostnamectl","timedatectl",
  "mount","umount","df","du","lsblk","fdisk","parted",
  "useradd","usermod","userdel","groupadd","passwd","chown","chmod",
  "cron","crond","atd","anacron","at",
  "sshd","sftp-server","scp",
  "dbus-daemon","dbus","polkitd","udisksd","udevd","systemd-udevd",
  "systemd-journald","systemd-logind","systemd-networkd","systemd-resolved",
  "systemd-timesyncd","systemd-hostnamed","systemd-timedated",
  "rsyslogd","syslogd","klogd","logrotate",
  "agetty","login","su","sudo","doas",
  "ntpd","chronyc","chronyd","ntpdate",
  "avahi-daemon","bluetoothd","cupsd","cups",
  "acpid","thermald","powerd","irqbalance",
  "nscd","sssd","ldap","openldap",
  "postfix","sendmail","dovecot","exim",
  "xinetd","inetd","nfs","mountd","rpcbind","portmap",
  "snmpd","zabbix_agentd","puppet","chef","ansible",
  "fail2ban","csf","firewalld","iptables","nftables",
  "claude","node_modules",
  // coolify ecosystem
  "coolify","coolify-sentinel","sentinel",
  "minio","minio-server",
  "litestream","restic","rclone",
])

const MINER_KEYWORDS = [
  "xmr","xmrig","xmr-stak","monero","miner","mining","minerd",
  "cgminer","cpuminer","bfgminer","sgminer","nsgminer",
  "ethminer","claymore","phoenixminer","t-rex","nbminer","lolminer",
  "gminer","teamredminer","trex","kawpow","randomx","cryptonight",
  "nicehash","hashrate","stratum+","pool.","mining-pool",
  "coin-hive","coinhive","deepminer","crypto-loot",
]

type SuspicionResult = {
  suspicious: boolean
  risk: "critical" | "high" | "medium"
  reasons: string[]
}

function detectSuspicious(proc: Process): SuspicionResult {
  const reasons: string[] = []
  const name  = (proc.name || "").toLowerCase().trim()
  const cmd   = (proc.cmd  || "").toLowerCase()

  // Skip kernel threads (low PIDs or bracket names)
  if (proc.pid < 300) return { suspicious: false, risk: "medium", reasons: [] }
  if (name.startsWith("[") && name.endsWith("]")) return { suspicious: false, risk: "medium", reasons: [] }

  // Skip known-safe by exact name
  if (KNOWN_SAFE.has(name)) return { suspicious: false, risk: "medium", reasons: [] }

  // ── Signal 1: Mining keywords ────────────────────────────────────────────
  const minerHit = MINER_KEYWORDS.find(k => name.includes(k) || cmd.includes(k))
  if (minerHit) reasons.push(`Mining keyword: "${minerHit}"`)

  // ── Signal 2: Suspicious execution path ─────────────────────────────────
  if (/\/(tmp|dev\/shm|var\/tmp|run\/user\/\d+|proc\/\d+\/fd)\//.test(cmd))
    reasons.push("Executing from suspicious path (/tmp, /dev/shm, etc.)")

  if (/\/\.[a-zA-Z]/.test(cmd) && !/\/(\.local|\.config|\.npm|\.node|\.pm2|\.pyenv|\.rbenv)/.test(cmd))
    reasons.push("Hidden directory in executable path")

  // ── Signal 3: Obfuscated / injection commands ────────────────────────────
  if (/base64\s+[^|]*\|/.test(cmd))
    reasons.push("Base64 decode piped to shell")
  if (/(curl|wget)\s+[^\s]+\s*\|\s*(ba)?sh/.test(cmd))
    reasons.push("Remote script piped to shell (curl|sh / wget|sh)")
  if (/eval\s*[\$\(]/.test(cmd))
    reasons.push("eval() with dynamic content")
  if (/python[23]?\s+-c\s+['"]import/.test(cmd))
    reasons.push("Inline Python execution")
  if (/perl\s+-e/.test(cmd))
    reasons.push("Inline Perl execution")

  // ── Signal 4: Hex / random-string process name ───────────────────────────
  if (/^[a-f0-9]{12,}$/.test(name))
    reasons.push("Long hex string process name (common in malware)")
  if (/^[a-z0-9]{16,}$/.test(name) && !/[aeiou]/.test(name))
    reasons.push("Long string with no vowels (likely random/generated name)")
  // Short all-consonant names 5+ chars (e.g. "xmrrg", "kswrk")
  if (name.length >= 5 && name.length <= 12 && /^[bcdfghjklmnpqrstvwxyz0-9]+$/.test(name))
    reasons.push("All-consonant name pattern (common in renamed malware)")

  // ── Signal 5: High CPU from unrecognised process ─────────────────────────
  if (proc.cpu > 70 && reasons.length === 0)
    reasons.push(`Unrecognised process consuming ${proc.cpu.toFixed(1)}% CPU`)

  if (reasons.length === 0) return { suspicious: false, risk: "medium", reasons: [] }

  const hasCritical = reasons.some(r => r.includes("Mining") || r.includes("Base64") || r.includes("curl|sh") || r.includes("wget|sh") || r.includes("hex string"))
  const risk = hasCritical ? "critical" : reasons.length >= 2 ? "high" : "medium"

  return { suspicious: true, risk, reasons }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function FilterChip({ label, value }: { label: string; value: string }) {
  return (
    <button className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-pulseNode-navyLight border border-pulseNode-border/15 text-xs text-helm-fg3 hover:text-helm-fg transition-colors">
      <span className="text-helm-fg4">{label}</span>
      <span className="text-helm-fg">{value}</span>
      <ChevronDown size={10} />
    </button>
  )
}

function MiniBar({ value, color = "var(--pn-cyan)" }: { value: number; color?: string }) {
  return (
    <div className="w-[60px] h-[3px] bg-pulseNode-navy rounded-full overflow-hidden shrink-0">
      <div className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.min(100, value)}%`, backgroundColor: color }} />
    </div>
  )
}

function RiskBadge({ risk }: { risk: "critical" | "high" | "medium" }) {
  const map = {
    critical: { bg: "var(--bad-soft)",  color: "var(--bad)",  label: "Critical" },
    high:     { bg: "var(--warn-soft)", color: "var(--warn)", label: "High" },
    medium:   { bg: "var(--info-soft)", color: "var(--info)", label: "Medium" },
  }
  const s = map[risk]
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold"
      style={{ background: s.bg, color: s.color }}>
      {risk === "critical" && <AlertTriangle size={9} />}
      {s.label}
    </span>
  )
}

// ── Action dropdown ────────────────────────────────────────────────────────────

type ActionMenuProps = {
  proc: Process
  onRequestKill: (p: Process) => void
  onRequestSuspend: (p: Process) => void
  onClose: () => void
}

function ActionMenu({ proc, onRequestKill, onRequestSuspend, onClose }: ActionMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function h(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener("mousedown", h)
    return () => document.removeEventListener("mousedown", h)
  }, [onClose])

  return (
    <div ref={ref} className="absolute right-0 top-7 z-50 w-52 rounded-xl overflow-hidden"
      style={{ background: "var(--card-elev)", border: "1px solid var(--border-2)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.12)" }}>
      <div className="px-3 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
        <p className="text-[10px] font-mono" style={{ color: "var(--fg-3)" }}>PID {proc.pid}</p>
        <p className="text-[12px] font-semibold truncate" style={{ color: "var(--fg)" }}>
          {proc.name || proc.cmd.split("/").pop()}
        </p>
      </div>
      <div className="p-1.5 space-y-0.5">
        <button onClick={() => { onRequestSuspend(proc); onClose() }}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs text-left transition-colors"
          style={{ color: "var(--warn)" }}
          onMouseEnter={e => (e.currentTarget.style.background = "var(--warn-soft)")}
          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
          <PauseCircle size={14} className="shrink-0" />
          <div>
            <p className="font-semibold leading-tight">Suspend</p>
            <p className="text-[10px] leading-tight mt-0.5" style={{ color: "var(--fg-3)" }}>SIGSTOP · pause execution</p>
          </div>
        </button>
        <button onClick={() => { onRequestKill(proc); onClose() }}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs text-left transition-colors"
          style={{ color: "var(--bad)" }}
          onMouseEnter={e => (e.currentTarget.style.background = "var(--bad-soft)")}
          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
          <XCircle size={14} className="shrink-0" />
          <div>
            <p className="font-semibold leading-tight">Kill process</p>
            <p className="text-[10px] leading-tight mt-0.5" style={{ color: "var(--fg-3)" }}>SIGKILL · force terminate</p>
          </div>
        </button>
      </div>
    </div>
  )
}

// ── Confirm dialog ─────────────────────────────────────────────────────────────

function ProcessConfirmDialog({ dialog, onClose, onConfirmKill, onConfirmSuspend }: {
  dialog: DialogState; onClose: () => void
  onConfirmKill: (p: Process) => void; onConfirmSuspend: (p: Process) => void
}) {
  if (!dialog) return null
  const isKill = dialog.type === "kill"
  const proc   = dialog.proc
  const name   = proc.name || proc.cmd.split("/").pop() || `PID ${proc.pid}`
  function confirm() { if (isKill) onConfirmKill(proc); else onConfirmSuspend(proc); onClose() }
  return (
    <AlertDialog open onOpenChange={open => { if (!open) onClose() }}>
      <AlertDialogContent className="max-w-sm p-0 overflow-hidden gap-0"
        style={{ background: "var(--card-elev)", border: "1px solid var(--border-2)", color: "var(--fg)" }}>
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-7"
          style={{ background: isKill ? "var(--bad-soft)" : "var(--warn-soft)" }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: isKill ? "var(--bad-soft)" : "var(--warn-soft)",
              border: `2px solid ${isKill ? "var(--bad)" : "var(--warn)"}` }}>
            {isKill ? <XCircle size={28} style={{ color: "var(--bad)" }} /> : <PauseCircle size={28} style={{ color: "var(--warn)" }} />}
          </div>
          <AlertDialogHeader className="text-center gap-1">
            <AlertDialogTitle className="text-base font-bold"
              style={{ color: isKill ? "var(--bad)" : "var(--warn)" }}>
              {isKill ? "Kill process?" : "Suspend process?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[12px]" style={{ color: "var(--fg-3)" }}>
              {isKill
                ? "This will immediately terminate the process. Any unsaved work will be lost and cannot be undone."
                : "This will pause the process with SIGSTOP. It stays in memory and can be resumed later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
        </div>
        <div className="flex items-center gap-3 px-5 py-3"
          style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", background: "var(--bg-2)" }}>
          <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-[10px] font-bold"
            style={{ background: isKill ? "var(--bad-soft)" : "var(--warn-soft)", color: isKill ? "var(--bad)" : "var(--warn)" }}>
            {proc.pid}
          </div>
          <div className="min-w-0">
            <p className="text-[12px] font-semibold truncate" style={{ color: "var(--fg)" }}>{name}</p>
            <p className="text-[10px] font-mono truncate" style={{ color: "var(--fg-3)" }}>{proc.user} · {proc.cmd}</p>
          </div>
        </div>
        <AlertDialogFooter className="flex-row gap-3 px-5 py-4 border-0 bg-transparent rounded-none"
          style={{ background: "var(--card-elev)" }}>
          <AlertDialogCancel className="flex-1 py-2 rounded-xl text-sm font-medium transition-colors"
            style={{ background: "var(--bg-3)", border: "1px solid var(--border-2)", color: "var(--fg-2)" }}>
            Cancel
          </AlertDialogCancel>
          <button onClick={confirm}
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-bold text-white transition-opacity hover:opacity-90"
            style={{ background: isKill ? "var(--bad)" : "var(--warn)" }}>
            {isKill ? <XCircle size={15} /> : <PauseCircle size={15} />}
            {isKill ? "Kill" : "Suspend"}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

type SortKey = "cpu" | "mem" | "pid"

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ProcessesPage() {
  const [activeTab,  setActiveTab]   = useState<Tab>("processes")
  const [search,     setSearch]      = useState("")
  const [sortKey,    setSortKey]     = useState<SortKey>("cpu")
  const [sortDir,    setSortDir]     = useState<"asc" | "desc">("desc")
  const [processes,   setProcesses]   = useState<Process[]>(MOCK_PROCESSES)
  const [cpuCores,    setCpuCores]    = useState<number[]>([])
  const [menuPid,     setMenuPid]     = useState<number | null>(null)
  const [dialog,     setDialog]      = useState<DialogState>(null)
  const [blocked,    setBlocked]     = useState<Process[]>([])
  const [released,   setReleased]    = useState<Set<number>>(new Set())
  const [toast,      setToast]       = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(null), 3000) }

  useEffect(() => {
    function fetchProcesses() {
      pythonApi.get<PyProcess[]>("/metrics/processes")
        .then(({ data }) => {
          if (data.length >= 5) setProcesses(data.map(mapPyProcess))
          else return nodeApi.get<Process[]>("/api/pm2/list")
            .then(({ data: pm2 }) => { if (pm2.length) setProcesses(pm2) })
        })
        .catch(() => {
          nodeApi.get<Process[]>("/api/pm2/list")
            .then(({ data }) => { if (data.length) setProcesses(data) })
            .catch(() => {})
        })
    }

    function fetchCores() {
      pythonApi.get<{ cpuCores?: number[] }>("/metrics/live")
        .then(({ data }) => { if (data.cpuCores?.length) setCpuCores(data.cpuCores) })
        .catch(() => {})
    }

    fetchProcesses()
    fetchCores()
    const t1 = setInterval(() => { if (!document.hidden) fetchProcesses() }, 5000)
    const t2 = setInterval(() => { if (!document.hidden) fetchCores() }, 5000)
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [])

  useGSAP(() => {
    gsap.fromTo(".gsap-enter", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.45, stagger: 0.08, ease: "power2.out" })
  }, { scope: containerRef })

  // ── Actions ──────────────────────────────────────────────────────────────────

  const handleKill = useCallback((proc: Process) => {
    nodeApi.post(`/api/processes/kill/${proc.pid}`)
      .then(() => {
        setProcesses(prev => prev.filter(p => p.pid !== proc.pid))
        setBlocked(prev => prev.filter(p => p.pid !== proc.pid))
        showToast(`Killed ${proc.name || proc.cmd} (PID ${proc.pid})`)
      })
      .catch(err => showToast(`Kill failed: ${(err as Error).message}`))
  }, [])

  const handleSuspend = useCallback((proc: Process) => {
    nodeApi.post(`/api/processes/suspend/${proc.pid}`)
      .then(() => {
        setBlocked(prev => prev.find(p => p.pid === proc.pid) ? prev : [...prev, { ...proc, state: "T" }])
        showToast(`Suspended ${proc.name || proc.cmd} (PID ${proc.pid})`)
      })
      .catch(err => showToast(`Suspend failed: ${(err as Error).message}`))
  }, [])

  const handleResume = useCallback((proc: Process) => {
    nodeApi.post(`/api/processes/resume/${proc.pid}`)
      .then(() => {
        setBlocked(prev => prev.filter(p => p.pid !== proc.pid))
        showToast(`Resumed ${proc.name || proc.cmd} (PID ${proc.pid})`)
      })
      .catch(err => showToast(`Resume failed: ${(err as Error).message}`))
  }, [])

  // ── Sorting / filtering ───────────────────────────────────────────────────────

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "desc" ? "asc" : "desc")
    else { setSortKey(key); setSortDir("desc") }
  }

  const blockedPids = useMemo(() => new Set(blocked.map(p => p.pid)), [blocked])

  const sorted = useMemo(() => {
    const q = search.toLowerCase()
    const list = processes
      .filter(p => !blockedPids.has(p.pid))
      .filter(p => !q || p.cmd.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) || String(p.pid).includes(q))
    list.sort((a, b) => {
      const av = a[sortKey as keyof typeof a] as number
      const bv = b[sortKey as keyof typeof b] as number
      return sortDir === "desc" ? bv - av : av - bv
    })
    return list
  }, [search, sortKey, sortDir, processes, blockedPids])

  // ── Suspicious detection ──────────────────────────────────────────────────────

  const suspicious = useMemo(() =>
    processes
      .filter(p => !released.has(p.pid) && !blockedPids.has(p.pid))
      .map(p => ({ proc: p, result: detectSuspicious(p) }))
      .filter(({ result }) => result.suspicious)
      .sort((a, b) => {
        const order = { critical: 0, high: 1, medium: 2 }
        return order[a.result.risk] - order[b.result.risk]
      }),
  [processes, released, blockedPids])

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return null
    return sortDir === "desc"
      ? <ChevronDown size={11} className="inline ml-0.5" />
      : <ChevronUp size={11} className="inline ml-0.5" />
  }

  // ── Shared action row renderer ────────────────────────────────────────────────

  function ActionCell({ proc }: { proc: Process }) {
    return (
      <div className="relative flex justify-end">
        <button
          onClick={() => setMenuPid(menuPid === proc.pid ? null : proc.pid)}
          className="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
          style={{
            color: menuPid === proc.pid ? "var(--fg)" : "var(--fg-3)",
            background: menuPid === proc.pid ? "var(--bg-active)" : "transparent",
            border: "1px solid var(--border)",
          }}
          onMouseEnter={e => { if (menuPid !== proc.pid) (e.currentTarget as HTMLButtonElement).style.color = "var(--fg)" }}
          onMouseLeave={e => { if (menuPid !== proc.pid) (e.currentTarget as HTMLButtonElement).style.color = "var(--fg-3)" }}
        >
          Actions <ChevronDown size={10} />
        </button>
        {menuPid === proc.pid && (
          <ActionMenu
            proc={proc}
            onRequestKill={p => { setDialog({ type: "kill", proc: p }); setMenuPid(null) }}
            onRequestSuspend={p => { setDialog({ type: "suspend", proc: p }); setMenuPid(null) }}
            onClose={() => setMenuPid(null)}
          />
        )}
      </div>
    )
  }

  return (
    <div ref={containerRef} className="p-6 space-y-5">

      {/* ── Toast ── */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-xl text-xs font-medium"
          style={{ background: "var(--card-elev)", border: "1px solid var(--border-2)",
            color: "var(--fg)", boxShadow: "0 8px 24px rgba(0,0,0,0.18)" }}>
          {toast}
        </div>
      )}

      {/* ── Confirm dialog ── */}
      <ProcessConfirmDialog
        dialog={dialog}
        onClose={() => setDialog(null)}
        onConfirmKill={handleKill}
        onConfirmSuspend={handleSuspend}
      />

      {/* ── Header ── */}
      <div className="gsap-enter flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-helm-fg flex items-center gap-2">
            Processes
            {suspicious.length > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold animate-pulse"
                style={{ background: "var(--bad-soft)", color: "var(--bad)" }}>
                <ShieldAlert size={11} /> {suspicious.length} suspicious
              </span>
            )}
          </h1>
          <p className="text-[12px] text-helm-fg3 mt-0.5">
            {processes.length} processes
            {blocked.length > 0 && <span className="text-amber-400"> · {blocked.length} suspended</span>}
          </p>
        </div>
      </div>

      {/* ── CPU core strip ── */}
      {cpuCores.length > 0 && (
        <div className="gsap-enter rounded-xl bg-pulseNode-navyLight border border-pulseNode-border/10 shadow-card px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-helm-fg3 mb-3">CPU Cores · live</p>
          <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${Math.min(cpuCores.length, 8)}, 1fr)` }}>
            {cpuCores.map((pct, i) => (
              <div key={i}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-helm-fg3">CPU{i + 1}</span>
                  <span className="text-[10px] font-mono font-bold text-pulseNode-cyan">{pct}%</span>
                </div>
                <ProgressBar value={pct} tone={pct > 85 ? "bad" : pct > 65 ? "warn" : "ok"} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Tab bar ── */}
      <div className="gsap-enter flex items-center gap-0" style={{ borderBottom: "1px solid var(--border)" }}>
        {([
          { key: "processes", label: "All Processes", count: processes.length },
          { key: "suspicious", label: "Suspicious Activity", count: suspicious.length, alert: suspicious.length > 0 },
        ] as { key: Tab; label: string; count: number; alert?: boolean }[]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className="px-4 py-2.5 text-xs font-medium transition-colors flex items-center gap-1.5"
            style={{
              color: tab.key === "suspicious"
                ? "var(--bad)"
                : activeTab === tab.key ? "var(--fg)" : "var(--fg-3)",
              borderBottom: activeTab === tab.key
                ? `2px solid ${tab.key === "suspicious" ? "var(--bad)" : "var(--acc)"}`
                : "2px solid transparent",
              marginBottom: "-1px",
            }}
          >
            {tab.key === "suspicious" && <ShieldAlert size={12} style={{ color: "var(--bad)" }} />}
            {tab.label}
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-mono"
              style={{
                background: "var(--bad-soft)",
                color: "var(--bad)",
              }}
            >
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* ════════════════════════════════════════════════════════
          TAB: ALL PROCESSES
          ════════════════════════════════════════════════════════ */}
      {activeTab === "processes" && (
        <>
          {/* Filter row */}
          <div className="gsap-enter flex items-center gap-2 flex-wrap">
            <input type="text" placeholder="Search processes…" value={search}
              onChange={e => setSearch(e.target.value)}
              className="flex-1 min-w-[180px] max-w-[280px] px-3 py-1.5 rounded-lg bg-pulseNode-navyLight border border-pulseNode-border/20 text-xs text-helm-fg placeholder:text-helm-fg3 focus:outline-hidden focus:ring-1 focus:ring-pulseNode-cyan/40"
            />
            <FilterChip label="User" value="All" />
            <FilterChip label="State" value="All" />
            <div className="flex items-center rounded-lg border border-pulseNode-border/15 overflow-hidden ml-auto">
              {(["cpu", "mem", "pid"] as SortKey[]).map(k => (
                <button key={k} onClick={() => handleSort(k)}
                  className={cn("px-3 py-1.5 text-xs font-medium transition-colors uppercase tracking-wide",
                    sortKey === k ? "bg-pulseNode-navyLight text-helm-fg" : "text-helm-fg3 hover:text-helm-fg")}>
                  {k}
                </button>
              ))}
            </div>
          </div>

          {/* Table */}
          <div className="gsap-enter rounded-xl bg-pulseNode-navyLight border border-pulseNode-border/10 shadow-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="pn-table w-full">
                <thead>
                  <tr>
                    <th className="w-14">
                      <button onClick={() => handleSort("pid")} className="flex items-center gap-0.5 hover:text-helm-fg transition-colors">
                        PID <SortIcon k="pid" />
                      </button>
                    </th>
                    <th>User</th>
                    <th>Command</th>
                    <th>State</th>
                    <th><button onClick={() => handleSort("cpu")} className="flex items-center gap-0.5 hover:text-helm-fg transition-colors">CPU% <SortIcon k="cpu" /></button></th>
                    <th><button onClick={() => handleSort("mem")} className="flex items-center gap-0.5 hover:text-helm-fg transition-colors">MEM <SortIcon k="mem" /></button></th>
                    <th>RES</th>
                    <th className="right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(proc => (
                    <tr key={proc.pid} className={cn(proc.type === "pm2" && "border-l-2 border-pulseNode-cyan")}>
                      <td className="mono-cell dim">{proc.pid}</td>
                      <td className="dim">{proc.user}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          {proc.type === "pm2" && <span className="bg-pn-cyan/10 text-pn-cyan text-[9px] px-1.5 py-0.5 rounded font-bold shrink-0">PM2</span>}
                          <div className="min-w-0">
                            <p className="text-[12px] font-semibold text-helm-fg truncate max-w-[300px]">
                              {proc.name || proc.cmd.split("/").pop()?.split(" ")[0] || proc.cmd}
                            </p>
                            <p className="font-mono text-[10px] text-helm-fg3 truncate max-w-[300px]" title={proc.cmd}>{proc.cmd}</p>
                          </div>
                        </div>
                      </td>
                      <td>{proc.state === "R" ? <Pill tone="ok" dot>Running</Pill> : <Pill tone="outline">Sleep</Pill>}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <MiniBar value={(proc.cpu / 15) * 100} color="var(--pn-cyan)" />
                          <span className="text-[11px] font-mono text-helm-fg">{proc.cpu.toFixed(1)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <MiniBar value={proc.memMb != null ? Math.min(100, (proc.memMb / 500) * 100) : (proc.mem / 10) * 100} color="var(--pn-blue)" />
                          <span className="text-[11px] font-mono text-helm-fg">{proc.memMb != null ? `${proc.memMb}M` : `${proc.mem.toFixed(1)}%`}</span>
                        </div>
                      </td>
                      <td className="mono-cell dim">{proc.res}</td>
                      <td className="right"><ActionCell proc={proc} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-pulseNode-border/10">
              <span className="text-[11px] text-helm-fg3">Showing {sorted.length} of {processes.length} processes</span>
              <div className="flex items-center gap-1.5 text-[11px] text-green-400">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 status-live" />
                Live · 2s
              </div>
            </div>
          </div>

          {/* Suspended section */}
          {blocked.length > 0 && (
            <div className="gsap-enter rounded-xl overflow-hidden shadow-card"
              style={{ border: "1px solid var(--warn-soft)", background: "var(--card)" }}>
              <div className="flex items-center justify-between px-5 py-3"
                style={{ borderBottom: "1px solid var(--border)", background: "var(--warn-soft)" }}>
                <div className="flex items-center gap-2">
                  <Ban size={14} style={{ color: "var(--warn)" }} />
                  <span className="text-sm font-semibold" style={{ color: "var(--warn)" }}>Suspended Processes</span>
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono"
                    style={{ background: "var(--warn-soft)", color: "var(--warn)", border: "1px solid var(--warn)" }}>
                    {blocked.length}
                  </span>
                </div>
                <span className="text-[11px]" style={{ color: "var(--fg-3)" }}>Resume a process to allow it to run again</span>
              </div>
              <table className="pn-table w-full">
                <thead>
                  <tr>
                    <th>PID</th><th>User</th><th>Command</th><th>State</th><th className="right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {blocked.map(proc => (
                    <tr key={proc.pid} style={{ borderLeft: "2px solid var(--warn)" }}>
                      <td className="mono-cell" style={{ color: "var(--warn)" }}>{proc.pid}</td>
                      <td className="dim">{proc.user}</td>
                      <td>
                        <div className="min-w-0">
                          <p className="text-[12px] font-semibold truncate max-w-[350px]" style={{ color: "var(--fg)" }}>
                            {proc.name || proc.cmd.split("/").pop()?.split(" ")[0] || proc.cmd}
                          </p>
                          <p className="font-mono text-[10px] truncate max-w-[350px]" style={{ color: "var(--fg-3)" }} title={proc.cmd}>{proc.cmd}</p>
                        </div>
                      </td>
                      <td>
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                          style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--warn)" }} />
                          SIGSTOP · paused
                        </span>
                      </td>
                      <td className="right">
                        <button onClick={() => handleResume(proc)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity ml-auto hover:opacity-80"
                          style={{ background: "var(--ok-soft)", color: "var(--ok)", border: "1px solid var(--ok)" }}>
                          <PlayCircle size={12} /> Unblock
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ════════════════════════════════════════════════════════
          TAB: SUSPICIOUS ACTIVITY
          ════════════════════════════════════════════════════════ */}
      {activeTab === "suspicious" && (
        <div className="space-y-4">

          {/* Banner */}
          {suspicious.length === 0 ? (
            <div className="rounded-xl flex flex-col items-center justify-center gap-3 py-16 text-center"
              style={{ border: "1px solid var(--border)", background: "var(--card)" }}>
              <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
                style={{ background: "var(--ok-soft)", border: "1px solid var(--ok)" }}>
                <ShieldCheck size={28} style={{ color: "var(--ok)" }} />
              </div>
              <div>
                <p className="text-sm font-semibold" style={{ color: "var(--fg)" }}>No suspicious activity detected</p>
                <p className="text-[12px] mt-1" style={{ color: "var(--fg-3)" }}>
                  All {processes.length} running processes look normal.
                  {released.size > 0 && ` · ${released.size} manually released`}
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* Summary strip */}
              <div className="rounded-xl px-5 py-4 flex items-center justify-between gap-4 flex-wrap"
                style={{ background: "var(--bad-soft)", border: "1px solid var(--bad)" }}>
                <div className="flex items-center gap-3">
                  <ShieldAlert size={20} style={{ color: "var(--bad)" }} />
                  <div>
                    <p className="text-sm font-bold" style={{ color: "var(--bad)" }}>
                      {suspicious.length} suspicious process{suspicious.length !== 1 ? "es" : ""} detected
                    </p>
                    <p className="text-[11px] mt-0.5" style={{ color: "var(--fg-3)" }}>
                      Review each process below. Kill confirmed threats, or release if it is a false positive.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-[11px]" style={{ color: "var(--fg-3)" }}>
                  {(["critical","high","medium"] as const).map(r => {
                    const n = suspicious.filter(s => s.result.risk === r).length
                    if (!n) return null
                    return (
                      <span key={r} className="flex items-center gap-1">
                        <RiskBadge risk={r} />
                        <span>{n}</span>
                      </span>
                    )
                  })}
                </div>
              </div>

              {/* Detection table */}
              <div className="rounded-xl overflow-hidden shadow-card"
                style={{ border: "1px solid var(--border)", background: "var(--card)" }}>
                <table className="pn-table w-full">
                  <thead>
                    <tr>
                      <th>Risk</th>
                      <th>PID</th>
                      <th>Process</th>
                      <th>User</th>
                      <th>CPU%</th>
                      <th>Why flagged</th>
                      <th className="right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suspicious.map(({ proc, result }) => (
                      <tr key={proc.pid}
                        style={{ borderLeft: `2px solid ${result.risk === "critical" ? "var(--bad)" : result.risk === "high" ? "var(--warn)" : "var(--info)"}` }}>
                        <td><RiskBadge risk={result.risk} /></td>
                        <td className="mono-cell" style={{ color: result.risk === "critical" ? "var(--bad)" : "var(--fg-3)" }}>
                          {proc.pid}
                        </td>
                        <td>
                          <div className="space-y-0.5">
                            <p className="text-[12px] font-semibold" style={{ color: "var(--fg)" }}>
                              {proc.name || "unknown"}
                            </p>
                            <p className="text-[10px] font-mono truncate max-w-[200px]" style={{ color: "var(--fg-3)" }} title={proc.cmd}>
                              {proc.cmd}
                            </p>
                          </div>
                        </td>
                        <td className="dim">{proc.user}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            <MiniBar
                              value={(proc.cpu / 15) * 100}
                              color={proc.cpu > 70 ? "var(--bad)" : "var(--pn-cyan)"}
                            />
                            <span className="text-[11px] font-mono" style={{ color: proc.cpu > 70 ? "var(--bad)" : "var(--fg)" }}>
                              {proc.cpu.toFixed(1)}%
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="flex flex-col gap-1">
                            {result.reasons.map((r, i) => (
                              <span key={i} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full w-fit"
                                style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
                                <AlertTriangle size={9} /> {r}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="right">
                          <div className="flex items-center gap-2 justify-end">
                            {/* Release / false positive */}
                            <button
                              onClick={() => { setReleased(prev => new Set(Array.from(prev).concat(proc.pid))); showToast(`Released PID ${proc.pid} — marked as safe`) }}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-opacity hover:opacity-80"
                              style={{ background: "var(--ok-soft)", color: "var(--ok)", border: "1px solid var(--ok)" }}
                              title="Mark as false positive / safe">
                              <CheckCircle2 size={12} /> Release
                            </button>
                            <ActionCell proc={proc} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Released / cleared list */}
          {released.size > 0 && (
            <div className="rounded-xl overflow-hidden"
              style={{ border: "1px solid var(--border)", background: "var(--card)" }}>
              <div className="flex items-center justify-between px-5 py-3"
                style={{ borderBottom: "1px solid var(--border)" }}>
                <div className="flex items-center gap-2">
                  <ShieldCheck size={14} style={{ color: "var(--ok)" }} />
                  <span className="text-sm font-semibold" style={{ color: "var(--ok)" }}>Released (false positives)</span>
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono"
                    style={{ background: "var(--ok-soft)", color: "var(--ok)" }}>
                    {released.size}
                  </span>
                </div>
                <button
                  onClick={() => setReleased(new Set())}
                  className="text-[11px] transition-opacity hover:opacity-70"
                  style={{ color: "var(--fg-3)" }}>
                  Clear all
                </button>
              </div>
              <div className="px-5 py-3 flex flex-wrap gap-2">
                {Array.from(released).map(pid => {
                  const p = processes.find(pr => pr.pid === pid)
                  return (
                    <span key={pid}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] cursor-pointer transition-opacity hover:opacity-70"
                      style={{ background: "var(--bg-3)", color: "var(--fg-2)", border: "1px solid var(--border)" }}
                      title="Click to re-flag"
                      onClick={() => setReleased(prev => { const n = new Set(prev); n.delete(pid); return n })}>
                      <span className="font-mono">{pid}</span>
                      {p && <span className="text-[10px]" style={{ color: "var(--fg-3)" }}>{p.name}</span>}
                      <XCircle size={10} style={{ color: "var(--fg-4)" }} />
                    </span>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
