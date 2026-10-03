import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

// GO_API_INTERNAL is set at runtime via docker-compose and is always an absolute URL
// reachable from the Next.js container (http://go-api:4002). NEXT_PUBLIC_GO_API is
// baked into the client bundle at image-build time and may be relative (/go).
const GO_API_INTERNAL = process.env.GO_API_INTERNAL ?? process.env.NEXT_PUBLIC_GO_API ?? ""

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Never gate the login page or the GitHub App install callback.
  // The callback is a public relay (GitHub redirects here after installation)
  // and must be accessible without a session.
  if (pathname.startsWith("/login") || pathname.startsWith("/github/app/callback")) {
    return NextResponse.next()
  }

  const sessionCookie = request.cookies.get("pn_session")
  const loginUrl = new URL("/login", request.url)
  loginUrl.searchParams.set("next", pathname)

  // Forward the browser's IP (set by Caddy) so go-api rate-limits per client,
  // not one shared bucket for this server, and the scheme for the Secure flag.
  const headers: Record<string, string> = {}
  if (sessionCookie) headers.Cookie = `pn_session=${sessionCookie.value}`
  for (const h of ["x-real-ip", "x-forwarded-proto"]) {
    const v = request.headers.get(h)
    if (v) headers[h] = v
  }

  let res: Response
  try {
    res = await fetch(`${GO_API_INTERNAL}/api/auth/status`, { headers, cache: "no-store" })
  } catch {
    // Go API unreachable (startup, update) — don't block the user. The API
    // itself still enforces auth on every data request.
    return NextResponse.next()
  }

  try {
    // Any non-OK answer (e.g. 429) must not open the gate.
    if (!res.ok) return NextResponse.redirect(loginUrl)
    const data = (await res.json()) as { enabled: boolean; loggedIn: boolean }

    if (!data.enabled) {
      // Login explicitly disabled (PULSENODE_INSECURE_NO_AUTH) — pass through.
      return NextResponse.next()
    }

    if (!data.loggedIn) {
      return NextResponse.redirect(loginUrl)
    }

    // Valid session — pass through and forward any refreshed cookie from Go.
    const response = NextResponse.next()
    const setCookie = res.headers.get("set-cookie")
    if (setCookie) {
      response.headers.set("set-cookie", setCookie)
    }
    return response
  } catch {
    return NextResponse.redirect(loginUrl)
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|login|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|otf)).*)"],
}
