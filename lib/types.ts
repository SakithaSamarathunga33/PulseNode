export interface Container {
  id: string
  name: string
  image: string
  state: "running" | "stopped" | "paused" | "exited"
  uptime: string
  cpu: number
  ram: number
  ports: string
  created: string
  node?: string
}

export interface ContainerStats {
  containerId: string
  cpu: number
  ram: number
  timestamp?: number
}

export interface SystemMetrics {
  cpu: number
  ram: number
  disk: number
  diskRead: number
  diskWrite: number
  netIn: number
  netOut: number
  ts: number
}

export interface HostInfo {
  name: string
  distro: string
  kernel: string
  uptime: string
  cpu: { cores: number; model: string; usage: number }
  memory: { used: number; total: number; unit: string; pct: number }
  disk: { used: number; total: number; free: number; unit: string; pct: number }
  swap: { used: number; total: number; pct: number }
  network: { rx: number; tx: number; unit: string }
  load: number[]
  apps: number
  ip: string
  region: string
}

export interface Process {
  pid: number
  user: string
  cpu: number
  mem: number
  virt: string
  res: string
  cmd: string
  state: string
  time: string
  type: "pm2" | "system"
  name?: string
  memMb?: number
  uptime?: string
}

export interface DockerImage {
  repo: string
  tag: string
  id: string
  size: string
  created: string
  used: number
  layers: number
  vulns: { crit: number; high: number; med: number; low: number }
}

export interface DockerNetwork {
  name: string
  driver: string
  scope: string
  subnet: string
  gateway: string
  containers: number
  attachable: boolean
  internal: boolean
}

export interface Database {
  name: string
  containerId?: string
  engine: string
  version: string
  host: string
  port: number
  size: string
  conns: number
  maxConns: number
  qps: number
  slow: number
  state: "ok" | "warn" | "error"
  tables?: DBTable[]
  slowQueries?: SlowQuery[]
  activeConns?: DBConnection[]
}

export interface DBTable {
  name: string
  rows: number
  totalSize: string
  indexSize: string
}

export interface SlowQuery {
  query: string
  duration: number
  timestamp: string
}

export interface DBConnection {
  pid: number
  user: string
  state: string
  duration: string
}

export interface Scan {
  id: string
  image: string
  scanner: string
  started: string
  duration: string
  status: "done" | "failed" | "running"
  crit: number
  high: number
  med: number
  low: number
}

export interface SBOM {
  image: string
  format: string
  packages: number
  generated: string
  licenses: number
  ecosystem: { go: number; npm: number; deb: number; other: number }
}

export interface Alert {
  id?: string
  sev: "bad" | "warn" | "info" | "ok"
  title: string
  target: string
  time: string
  rule?: string
  state: "firing" | "ack" | "resolved"
  message?: string
  read?: boolean
}

export interface AlertRule {
  name: string
  expr: string
  channels: string[]
  enabled: boolean
  sev: "bad" | "warn" | "info"
}

export interface SparkData {
  cpu: number[]
  cpuLong: number[]
  mem: number[]
  memLong: number[]
  disk: number[]
  net: number[]
  netTx: number[]
  load: number[]
  io: number[]
}

export interface DbMetricItem {
  label: string
  value: string | number
  tone?: "ok" | "warn" | "bad" | "info"
}

export interface DbMetrics {
  engine: string
  metrics: DbMetricItem[]
}

export interface ProvisionResult {
  name: string
  engine: string
  image: string
  port: string
  password: string
  connectionString: string
}

export interface CustomConnection {
  id: string
  connectionString: string
  name?: string
  engine: string
  host: string
  port: number
  version?: string
  addedAt: string
}

export interface DbSchemaResult {
  databases: string[]
  tables: Array<{ name: string; rows: number }>
}

export interface DbQueryResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  durationMs: number
}
