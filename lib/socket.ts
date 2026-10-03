"use client"

type Handler = (payload: unknown) => void

const CHANNEL_NAME = "pulsenode:realtime"
const REALTIME_EVENTS = [
  "system:metrics",
  "container:stats",
  "deploy:log",
  "alert:new",
  "alert:update",
  "alert:count",
]

class BrowserRealtime {
  private source: EventSource | null = null
  private worker: SharedWorker | null = null
  private channel: BroadcastChannel | null = null
  private listeners = new Map<string, Set<Handler>>()
  private reconnects = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private url: string) {
    this.connect()
  }

  on<T = unknown>(event: string, handler: (payload: T) => void) {
    const wrapped = handler as Handler
    const set = this.listeners.get(event) ?? new Set<Handler>()
    set.add(wrapped)
    this.listeners.set(event, set)
  }

  off<T = unknown>(event: string, handler: (payload: T) => void) {
    this.listeners.get(event)?.delete(handler as Handler)
  }

  private emit(event: string, payload?: unknown) {
    this.listeners.get(event)?.forEach(handler => handler(payload))
  }

  private connect() {
    if (!this.url || typeof window === "undefined") return

    if ("SharedWorker" in window && "BroadcastChannel" in window) {
      this.connectSharedWorker()
      return
    }

    this.connectEventSource()
  }

  private connectSharedWorker() {
    this.channel = new BroadcastChannel(CHANNEL_NAME)
    this.channel.addEventListener("message", event => {
      const msg = event.data
      if (msg?.type === "realtime:status") {
        return
      }
      if (msg?.type) this.emit(msg.type, msg.data)
    })

    this.worker = new SharedWorker("/realtime-shared-worker.js")
    this.worker.port.start()
    this.worker.port.postMessage({ type: "connect", url: this.url })
  }

  private connectEventSource() {
    this.source = new EventSource(this.url)
    this.source.addEventListener("open", () => {
      this.reconnects = 0
    })

    this.source.addEventListener("error", () => {
      this.source?.close()
      this.source = null
      this.scheduleReconnect()
    })

    for (const event of REALTIME_EVENTS) {
      this.source.addEventListener(event, message => {
        try {
          this.emit(event, JSON.parse(message.data))
        } catch {
          this.emit(event, message.data)
        }
      })
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.reconnects >= 5) return
    this.reconnects += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 2000)
  }
}

let socket: BrowserRealtime | null = null

function realtimeUrl() {
  const explicit = process.env.NEXT_PUBLIC_GO_SSE
  if (explicit) return explicit

  const goApi = process.env.NEXT_PUBLIC_GO_API
  if (goApi) {
    const url = new URL(goApi, window.location.origin)
    if (url.pathname.endsWith("/go")) url.pathname = url.pathname.slice(0, -3) || "/"
    url.pathname = "/events"
    return url.toString()
  }

  return `${window.location.origin}/events`
}

export function getSocket(): BrowserRealtime {
  if (!socket) socket = new BrowserRealtime(realtimeUrl())
  return socket
}
