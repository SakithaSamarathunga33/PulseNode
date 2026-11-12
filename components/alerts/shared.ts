import { AlertTriangle, Hash, Info, Mail, MessageSquare, Send, Webhook, XCircle } from "lucide-react"
import { nodeApi, type ApiError } from "@/lib/api"

export type AlertEvent = {
  id: number; ruleId: string; rule: string; metric: string; severity: "critical" | "warning" | "info"
  sev: "bad" | "warn" | "info"; target: string; state: "firing" | "ack" | "resolved"
  message: string; value: number; firedAt: string; ackedAt: string | null; resolvedAt: string | null
}
export type Rule = {
  id: string; name: string; metric: string; operator: string; threshold: number; duration: number
  severity: "critical" | "warning" | "info"; target: string; channelIds: string[]; cooldown: number; enabled: boolean
}
export type Channel = {
  id: string; name: string; type: ChannelType; enabled: boolean; summary: string; config: Record<string, string>
}
export type ChannelType = "webhook" | "slack" | "discord" | "telegram" | "smtp"

export const METRICS: { value: string; label: string; percent: boolean; hint: string }[] = [
  { value: "host.cpu", label: "Host CPU", percent: true, hint: "CPU usage of the server" },
  { value: "host.memory", label: "Host memory", percent: true, hint: "RAM usage of the server" },
  { value: "host.disk", label: "Host disk", percent: true, hint: "Disk usage of the root filesystem" },
  { value: "container.down", label: "Container down", percent: false, hint: "A container is exited, dead or restarting" },
  { value: "deploy.failed", label: "Deploy failed", percent: false, hint: "A project deployment fails" },
]
export const metricOf = (v: string) => METRICS.find(m => m.value === v)

export const SEV = {
  critical: { icon: XCircle, cls: "bg-danger/12 text-danger", label: "Critical", tone: "bad" },
  warning: { icon: AlertTriangle, cls: "bg-warning/14 text-warning", label: "Warning", tone: "warn" },
  info: { icon: Info, cls: "bg-info/12 text-info", label: "Info", tone: "info" },
} as const

export const CHANNEL_META: Record<ChannelType, { label: string; icon: typeof Mail; desc: string }> = {
  webhook: { label: "Webhook", icon: Webhook, desc: "POST JSON to any URL, optionally HMAC-signed" },
  slack: { label: "Slack", icon: Hash, desc: "Incoming webhook into a Slack channel" },
  discord: { label: "Discord", icon: MessageSquare, desc: "Webhook into a Discord channel" },
  telegram: { label: "Telegram", icon: Send, desc: "Bot message to a chat or channel" },
  smtp: { label: "Email", icon: Mail, desc: "Send through your SMTP server" },
}

/** Newest alerts the page loads; the chart and filters only see these. */
export const HISTORY_LIMIT = 300

export const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)

/** PATCH helper (lib/api exposes get/post/delete only). */
export async function patch(path: string, body: unknown) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_GO_API ?? ""}${path}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
  if (!res.ok) {
    if (res.status === 401 && window.location.pathname !== "/login") window.location.href = "/login"
    const b = await res.json().catch(() => ({})) as { error?: string }
    const err = new Error(b.error ?? `${res.status} request failed`)
    ;(err as ApiError).status = res.status
    throw err
  }
  return res.json()
}

export async function sendJSON<T>(method: "POST" | "PATCH", path: string, body: unknown): Promise<T> {
  if (method === "POST") return nodeApi.post<T>(path, body)
  return patch(path, body) as Promise<T>
}
