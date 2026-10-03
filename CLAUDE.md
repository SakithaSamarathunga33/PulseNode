## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Architecture notes

### Routing / deployment
- External TLS is terminated by a shared **Traefik** instance (project `vps-monitor`, network `vps-monitor_proxy`), not by this project's Caddy. Caddy has no host port bindings and only does internal routing (`/go/*`, `/events`, `/ws`, `/health` → go-api; everything else → web). Bring the stack up with **both** compose files or Traefik can't see it:
  `docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d`
- `NEXT_PUBLIC_GO_API` is baked into the web bundle **at build time** and must be `/go` (Caddy proxies `/go/*` to go-api). If it's empty, client API calls hit Next.js instead of the backend and every page shows zero data. Default lives in `docker-compose.yml`.

### Self-update (Settings page → `backend/internal/api/update.go`)
- `runUpdate()` runs **inside the go-api container** and shells out to `docker compose up -d --build`, which recreates the very container running it. State (`globalUpdate`) is in-memory and is lost on restart, so the frontend cannot rely on polling `/api/system/update/status` for completion.
- Key gotcha: `up -d --build` **builds the new image while the old containers keep serving**, so `/health` answers from old code the whole time. Detecting "update done" by `/health` being reachable reloads the *old* version. Instead, `/health` exposes `startedAt` (process boot time) and the settings page reloads only when that boot id **changes** (proving the container actually restarted). The 180s countdown is cosmetic only.

### Project builds — nixpacks (`backend/internal/builder/`)
- A user repo with **no Dockerfile** builds via **nixpacks**, run **directly inside the go-api container** against the mounted host Docker socket. So `backend/Dockerfile` must install both the `nixpacks` CLI binary **and** `docker-cli-buildx` (nixpacks builds with BuildKit). Gotcha: `ghcr.io/railwayapp/nixpacks` is nixpacks' *runtime base image*, **not** a CLI image — `docker run …nixpacks nixpacks build` fails with exit 127 (`executable not found`).
- Node projects that don't pin a version (`engines.node` / `.nvmrc`) get `NIXPACKS_NODE_VERSION=20` injected (`buildNixpacks`), because nixpacks defaults to Node 18 — too old for Next.js 16+ (`next build` hard-fails on <20.9.0). Projects that pin a version still win.

### Monorepo (frontend/ + backend/) — two services, one domain (`builder.go` `DetectMonorepo`/`runMonorepo`)
- When the build method is **auto** (an explicit method is always respected and never split) and the cloned repo has **both** a `frontend/` and `backend/` directory at root that are each independently buildable (`buildableDir`: Dockerfile or a recognized manifest — `package.json`, `go.mod`, `requirements.txt`/`pyproject.toml`/`Pipfile`, `Gemfile`, `Cargo.toml`, `composer.json`), `Run()` calls `runMonorepo` instead of the single-service switch. Each folder is built with its **own** detected method (`buildImage` → Dockerfile or nixpacks; a nested compose is rejected). Images are `pn-<slug>-frontend:<tag>` and `pn-<slug>-backend:<tag>`. **Both images build first**, then deploy, so a build error never half-swaps.
- **Routing:** frontend on `Host(domain)` (router `pn-<id>`, same as single-service), backend on `Host(domain) && PathPrefix(/api)` (router `pn-<id>-api`, **priority 100** so /api wins) — same domain, one cert, **no extra DNS, no CORS**. The `/api` prefix is **not stripped**, so the frontend should call `/api/...` and the backend should serve its routes under `/api`. Backend listen port comes from the **`BACKEND_PORT` env var** (falls back to the project `Port`); `PORT` is injected per-container (forced to the per-service port for monorepo components, so a shared `PORT` env can't mismatch the Traefik target). **No rollback** for monorepos (Result has no single `ImageTag`, like compose).
- **Separate env per component.** `projects.backend_env_vars` (encrypted, alongside `env_vars`) holds the backend container's env; `env_vars` is the frontend/single-service env. `runMonorepo` injects `EnvVars` into the frontend and `BackendEnvVars` into the backend — so backend secrets (DB URL, JWT secret) never reach the frontend container. `BACKEND_PORT` belongs in the **backend** env. The new-project form and the project Settings tab show a second "Backend Environment Variables" box only when the repo is a monorepo, detected via **`GET /api/github/detect-layout`** (probes the repo root through the GitHub contents API; accepts `repo=owner/repo` **or** a clone URL). Single-service projects leave `backend_env_vars` empty.
- **Per-component swap (`deployService` + component-aware `removeOldContainers`).** Each container carries a `pulsenode.component=frontend|backend` label in addition to `pulsenode.project=<id>`. `removeOldContainers(projectID, component, keepID)` removes only containers of the **same** component (plus unlabeled legacy ones, which the frontend/default pass cleans up via the shared root router label `traefik.http.routers.pn-<id>.entrypoints` + `PrevContainerID`). This is what stops a frontend deploy from killing the backend (and vice versa), and converts a previously single-service project to monorepo cleanly. The single-service path uses the same `deployService` with component `""` (a thin `deployContainer` wrapper builds `defaultSpec()`), producing the exact same labels as before.

### Deployment pipeline — webhooks, rollback, zero-downtime (`backend/internal/builder/builder.go`, `internal/queue/queue.go`)
- **Per-deploy image tags + rollback.** Dockerfile/Nixpacks builds tag the image `pn-<slug>:<shortSHA>` (falls back to a short deployment id) and store it on `deployments.image_tag`, so a previous build's image survives for rollback. `POST /api/projects/{id}/deployments/{depID}/rollback` makes a new deployment with `trigger='rollback'` + the target's `image_tag`; the queue routes those to `builder.RunFromImage` (skips clone/build, just `docker image inspect` + re-run). **Compose builds get no image tag → rollback is disabled for them** (the rollback handler 400s, the UI only shows the button when `ImageTag` is set). Rollback fails cleanly if the image was pruned.
- **Zero-downtime + health gate (`deployContainer`).** Every deploy starts a **new** container under a unique name `pn-<slug>-<unix>` carrying *identical* Traefik router/service labels (`pn-<id>`) **plus** a `pulsenode.project=<id>` label, so Traefik load-balances across old+new during the overlap. `waitHealthy` then gates: if the image has a `HEALTHCHECK`, its status is authoritative; otherwise the container must stay up (not exited/restarting) for `stableWindow` (6s), up to `healthTimeout` (90s). Only **after** healthy does `removeOldContainers` delete the previous container(s) — matched by the `pulsenode.project` label **plus** the shared Traefik router label `traefik.http.routers.pn-<id>.entrypoints` (this one is also present on pre-label legacy containers, so they get cleaned up even though they predate `pulsenode.project`) **plus** the caller-supplied `PrevContainerID` as a final fallback. Why it matters: old and new carry *identical* Traefik service labels, so any old container left running keeps receiving ~half the traffic via round-robin and the user sees the old version intermittently (this was a real bug — a legacy `pn-yt` matched neither the project label nor PrevContainerID and split traffic for 14h). On failure the new container is removed and **the old one keeps serving**; the queue preserves the project's `container_id` on failed deploys for the same reason (don't clear the ref to a still-running container). Tradeoff: during the gate window a broken new container can still receive a share of traffic (label-based LB has no per-server health), but this is strictly better than the old "rm old, then run new" which guaranteed downtime every deploy.
- **Push webhooks (`backend/internal/api/github_webhook.go`).** `POST /api/github/webhook` is **public** (registered outside the `/api` auth group, next to the OAuth callback) and authenticated per-request by HMAC-SHA256 over the raw body vs `X-Hub-Signature-256` (`validSignature`). Secret is generated on first read of `GET /api/github/webhook-info` and stored in `settings` (`github_webhook_secret`, via new `DB.GetSetting/SetSetting`). The handler matches push events to auto-deploy projects by owner/repo + branch and enqueues like the poller. **The branch poller stays on as a fallback** — webhooks just make it instant. Note: the public URL is `https://<host>/go/api/github/webhook` because Caddy strips `/go` before proxying (same reason the documented OAuth callback is `/go/api/github/callback`); the frontend builds the URL from `window.location.origin + NEXT_PUBLIC_GO_API`.
- **Auto-install (no manual paste).** Webhooks are per-repo, so `createProject` best-effort registers the hook on the repo via the GitHub API (`github.EnsureWebhook` → `POST /repos/{o}/{r}/hooks`, idempotent: it lists hooks first and skips if our URL is already present) using the connected OAuth/PAT token — the `repo` scope grants `admin:repo_hook`. The server-side hook URL is derived like the OAuth callback: `NEXT_PUBLIC_ORIGIN + "/go/api/github/webhook"` (`webhookTargetURL`), so origin **must** be set for auto-install to work. `GET /api/projects/{id}/webhook` reports `{installed, supported, url}` and `POST` re-installs/repairs (for projects made before connecting GitHub, or if the token lacked admin rights). The project Settings tab shows the status + an Install/repair button; the GitHub-page card is now just the manual fallback. There is **no GitHub App** — this is plain per-repo REST hook creation, so it only covers repos the token can admin.

### Version display (`installedVersion()` / `version()` in `backend/internal/api/server.go`)
- This is the **dev/publish box**: commits are pushed from here and CI auto-tags on the remote, but the box never pulls those tags back, so its local git tags lag and `git describe --tags` reports a **stale** version. `version()` reconciles by resolving the latest GitHub release tag to its commit and checking it's an ancestor of HEAD (`git merge-base --is-ancestor`); an at-or-ahead box reports up-to-date. Falls back to tag-string compare when the commit isn't local (shallow clones).

### Domain DNS checker (`app/domain/page.tsx` ↔ `backend/internal/api/domain_handler.go`)
- `checkDomain()` resolves the domain with `net.DefaultResolver.LookupIPAddr`. For a domain that **doesn't resolve** (NXDOMAIN / no A record — i.e. one not pointed anywhere), it returns early with only `Error` set, leaving `Records` **nil**, which Go marshals as JSON `null` (not `[]`). The frontend's `result.records.length`/`.join(...)` then throws `Cannot read properties of null` → "Application error: a client-side exception". Fix is two-layer: backend initializes `Records: []string{}` so it always serializes an array, **and** the frontend treats it as nullable (`records: string[] | null`, `result.records?.length`). General rule here: any Go `[]T` returned in JSON should be initialized to a non-nil empty slice, since `nil` becomes `null` and breaks `.length`/`.map` in the React client.

### Security model (see SECURITY.md)
- **Login is mandatory and fails closed.** `requireAuth` rejects everything when no admin exists (or the DB errors); the first admin is created via `POST /api/auth/setup` with a one-time **setup token** (`PULSENODE_SETUP_TOKEN` from install.sh, else generated into `/var/lib/pulsenode/setup-token` and logged by go-api). `PULSENODE_INSECURE_NO_AUTH=true` is the only opt-out. There is no "disable login".
- Sessions embed `ver` (fingerprint of the password hash) + `auth_time`; `validSession` enforces both, so password change revokes sessions and `sessionMaxAge` caps lifetime. Don't call `auth.ValidateToken` directly for sessions.
- `sameOriginWrites` blocks non-GET requests whose Origin/Referer host isn't the request Host or a configured origin (sibling subdomains are same-site, so SameSite=Lax alone isn't enough). Rate limits key on `X-Real-IP`, which **Caddy overwrites** (`request_header X-Real-IP {client_ip}`) — keep that line if you touch the Caddyfile.
- Empty/placeholder `JWT_SECRET`/`AES_KEY` are replaced by random keys persisted in the data dir; `db.Encrypt` errors instead of storing plaintext.
- Builder: commands run with the `passEnv` allow-list only (no panel secrets); the GitHub token goes via `gitAuthEnv` (env `http.extraheader`), never the clone URL; user compose files must pass `composeViolations` (no privileged/host namespaces/cap_add/devices/host binds/traefik labels/out-of-repo files).

### UI / design system (see docs/design-system.md)
- **Tailwind 4 + shadcn/ui on base-ui** (no `asChild` — use the `render` prop). Tokens live in `app/theme.css` (light on `:root`, dark on `[data-theme="dark"]`, theme via `next-themes`: light/dark/system, key `pn-theme`). `AppShell` tags the content with `data-area` (monitor/resource/deploy/security/neutral → `--hue`), derived from `lib/nav.ts` — the same file drives the sidebar, breadcrumb and Ctrl+K palette, so add new pages there.
- Page = `PageHeader` + `PageBody` (`components/pn/*`), shadcn `Table`/`Dialog`/`Sheet`/`Tabs`, `ConfirmDialog` instead of `confirm()`, sonner `toast` instead of `alert()`. No hard-coded hex colours; status colours (`success/warning/danger/info`) always come with text or an icon.
- Add shadcn components with `npx shadcn@latest add <name>`; check the diff afterwards (it can overwrite files).

### Workflow rule: go live on this VPS first, then commit + push
Every change to this project is deployed and verified on this VPS **before** it is committed and pushed. Pushing to `main` triggers a release (new GHCR images for every user), so nothing gets pushed that hasn't run live here.
1. Make the change and run the checks: `cd backend && go test ./...`, `npx tsc --noEmit`, `npm run build` (whichever apply).
2. Deploy from the working tree to the live stack (project `pulsenode`, port 8080) — build from source, **without** the ghcr overlay, and only the affected services (`go-api` for `backend/`, `web` for the Next.js app, `caddy` for the Caddyfile):
   `docker compose --env-file .env.local -f docker-compose.yml -f docker-compose.nossl.yml up -d --build go-api web`
3. Verify live: containers healthy (`docker compose -p pulsenode ps`), logs clean (`docker logs pulsenode-go-api-1`), and the change works on `http://127.0.0.1:8080`.
4. Only then commit and push. If it fails live, fix it first — or roll back by re-running step 2 from the last good commit.

### Local dev / verify
- Old containers keep serving until a rebuilt image is ready, so step 2 above has little downtime. The dev box's workspace is bind-mounted at `/workspace` in go-api.
- Most `/api/*` endpoints are auth-gated (401 without a token), so you can't curl them directly to verify — exercise the underlying logic with `docker exec pulsenode-go-api-1 …` (e.g. the git commands behind `version()`) instead.
- Build logs render in a chrome-only `TerminalWindow` (live stream, no typing animation) in `components/magicui/terminal.tsx` — distinct from the sequencing `Terminal` in the same file.

# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
