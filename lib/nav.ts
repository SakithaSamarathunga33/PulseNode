import {
  Activity, BarChart3, BellRing, Boxes, Database, FileCode2, FolderGit2, Gauge,
  GitBranch, Globe, LayoutDashboard, Layers, Network, ShieldCheck, Settings,
  type LucideIcon,
} from "lucide-react"

/** Each app area owns one hue (see --area-* in app/theme.css). */
export type Area = "monitor" | "resource" | "deploy" | "security" | "neutral"
export type NavBadge = "images" | "networks" | "databases" | "alerts" | "projects"

export type NavItem = {
  label: string
  /** Heading shown in the top bar; defaults to label. */
  title?: string
  href: string
  icon: LucideIcon
  description: string
  keywords: string[]
  badge?: NavBadge
  /** Hidden unless the server says it is enabled (Coolify). */
  optional?: "coolify"
}

export type NavGroup = { label: string; area: Area; items: NavItem[] }

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace", area: "monitor",
    items: [
      { label: "Dashboard", title: "Dashboard", href: "/containers", icon: LayoutDashboard,
        description: "Containers, host vitals and quick actions",
        keywords: ["container", "docker", "running", "logs", "shell", "exec", "restart", "stop", "home"] },
      { label: "Runtime", title: "Runtime Monitor", href: "/runtime", icon: Gauge,
        description: "Live CPU and RAM per container, plus uptime history",
        keywords: ["runtime", "live", "cpu", "ram", "memory", "uptime", "heartbeat", "monitor"] },
      { label: "Stats", title: "System Stats", href: "/stats", icon: BarChart3,
        description: "CPU, memory, disk and network charts",
        keywords: ["stats", "metrics", "cpu", "ram", "memory", "disk", "network", "usage", "charts"] },
      { label: "Processes", href: "/processes", icon: Activity,
        description: "Host processes, kill/suspend, suspicious activity",
        keywords: ["process", "pid", "kill", "suspend", "resume", "pm2", "cpu", "memory", "malware"] },
      { label: "Coolify", href: "/coolify", icon: Boxes, optional: "coolify",
        description: "Coolify apps, databases and deployments",
        keywords: ["coolify", "deployment", "project", "service"] },
    ],
  },
  {
    label: "Resources", area: "resource",
    items: [
      { label: "Images", href: "/images", icon: Layers, badge: "images",
        description: "Docker images: pull, prune, scan",
        keywords: ["image", "docker", "pull", "prune", "layer", "tag"] },
      { label: "Networks", href: "/networks", icon: Network, badge: "networks",
        description: "Docker networks and traffic",
        keywords: ["network", "bridge", "docker", "subnet", "topology", "ip"] },
      { label: "Databases", href: "/databases", icon: Database, badge: "databases",
        description: "Provision, connect, query and back up databases",
        keywords: ["database", "postgres", "mysql", "redis", "mongo", "sql", "query", "backup", "restore"] },
    ],
  },
  {
    label: "Deploy", area: "deploy",
    items: [
      { label: "GitHub", href: "/github", icon: GitBranch,
        description: "Connect GitHub, OAuth app and webhooks",
        keywords: ["github", "oauth", "pat", "token", "repo", "repository", "connect", "webhook"] },
      { label: "Projects", href: "/projects", icon: FolderGit2, badge: "projects",
        description: "Deploy apps from GitHub repositories",
        keywords: ["project", "deploy", "github", "repo", "build", "deployment", "branch", "rollback"] },
      { label: "Domain", href: "/domain", icon: Globe,
        description: "Domains, DNS checks and what each container serves",
        keywords: ["domain", "dns", "ssl", "host", "cloudflare"] },
    ],
  },
  {
    label: "Security", area: "security",
    items: [
      { label: "Scan History", href: "/scan-history", icon: ShieldCheck,
        description: "Vulnerability scan results",
        keywords: ["scan", "security", "vulnerability", "trivy", "cve", "risk"] },
      { label: "SBOMs", href: "/sbom-history", icon: FileCode2,
        description: "Software bills of materials for your images",
        keywords: ["sbom", "bill", "materials", "dependency", "package", "syft", "license"] },
      { label: "Alerts", href: "/alerts", icon: BellRing, badge: "alerts",
        description: "Alert history, rules and notification channels",
        keywords: ["alert", "notification", "rule", "webhook", "slack", "email", "threshold"] },
    ],
  },
]

export const SETTINGS_ITEM: NavItem = {
  label: "Settings", href: "/settings", icon: Settings,
  description: "Updates, version and login security",
  keywords: ["setting", "security", "login", "password", "update", "version", "auth", "theme"],
}

const ALL_ITEMS = [...NAV_GROUPS.flatMap(g => g.items.map(i => ({ ...i, group: g.label, area: g.area }))),
  { ...SETTINGS_ITEM, group: "System", area: "neutral" as Area }]

/** Resolve the nav entry (and its group/area) for a pathname; sub-routes match their parent. */
export function routeInfo(pathname: string | null) {
  if (!pathname) return undefined
  return ALL_ITEMS.find(i => pathname === i.href) ??
    ALL_ITEMS.find(i => pathname.startsWith(i.href + "/"))
}

export const areaOf = (pathname: string | null): Area => routeInfo(pathname)?.area ?? "neutral"
