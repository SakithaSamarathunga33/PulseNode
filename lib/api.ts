const GO_API = process.env.NEXT_PUBLIC_GO_API ?? ""

export const API_BASE = GO_API

export interface ApiError extends Error { status: number }

async function throwApiError(res: Response, label: string): Promise<never> {
  // A 401 means the browser session is gone/expired — send the user to log in
  // rather than surfacing a dead-end "Unauthorized" error.
  if (res.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.href = "/login"
  }
  let msg = `${res.status} ${label}`
  try {
    const body = await res.json()
    if (body?.error) msg = body.error
    else if (body?.detail) msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail)
  } catch { /* keep default msg */ }
  const err = new Error(msg)
  ;(err as ApiError).status = res.status
  throw err
}

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<{ data: T }> {
  const res = await fetch(url, { cache: "no-store", ...init })
  if (!res.ok) await throwApiError(res, url)
  return { data: await res.json() as T }
}

async function mutateJSON<T>(path: string, body: unknown, method: "POST" | "DELETE"): Promise<T> {
  const init: RequestInit = {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" && body ? JSON.stringify(body) : undefined,
  }
  const res = await fetch(`${GO_API}${path}`, init)
  if (!res.ok) await throwApiError(res, path)
  return res.json() as Promise<T>
}

const goApi = {
  get: <T>(path: string) => fetchJSON<T>(`${GO_API}${path}`),
  post: <T>(path: string, body?: unknown): Promise<T> => mutateJSON<T>(path, body, "POST"),
  delete: <T>(path: string): Promise<T> => mutateJSON<T>(path, undefined, "DELETE"),
}

export const nodeApi = goApi
// Alias still imported by the scan-history and sbom-history pages.
export const pythonApi = goApi
