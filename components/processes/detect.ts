import type { Process } from "@/lib/types"
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

export type SuspicionResult = {
  suspicious: boolean
  risk: "critical" | "high" | "medium"
  reasons: string[]
}

export function detectSuspicious(proc: Process): SuspicionResult {
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

