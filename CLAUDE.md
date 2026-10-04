## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Architecture notes

### Routing / deployment
- Caddy only does internal routing for the **panel** (`/go/*`, `/events`, `/ws`, `/health` → go-api; everything else → web). How the panel is reached depends on the overlay: `docker-compose.nossl.yml` (this dev box: Caddy on host port **8080**, no TLS), `docker-compose.standalone.yml` (Caddy owns 80/443 + ACME), or `docker-compose.traefik.yml` (behind an existing Traefik; bring the stack up with **both** files or Traefik can't see it). Behind Traefik, `scripts/caddy-entrypoint.sh` trusts `X-Forwarded-For` **only from Traefik's own IP** (`TRAEFIK_CONTAINER`, default `traefik`; falls back to `private_ranges` with a warning; `scripts/trust-traefik.sh` fixes a differently-named Traefik).
- **Deployed projects are routed by Traefik, not Caddy** (see "Built-in proxy" below). This box currently has **no external Traefik**.
- `NEXT_PUBLIC_GO_API` is baked into the web bundle **at build time** and must be `/go` (Caddy proxies `/go/*` to go-api). If it's empty, client API calls hit Next.js instead of the backend and every page shows zero data. Default lives in `docker-compose.yml`.

### Self-update (Settings page → `backend/internal/api/update.go`, `update_state.go`, `update_sidecar.go`)
- Flow: **DB snapshot first** (`db.Snapshot()` → `VACUUM INTO` + `quick_check`, newest 5 kept in `snapshots/`; a failed snapshot aborts) → record pre-update state (commit, dirty flag, image IDs retagged `pulsenode-rollback:<svc>`, `PULSENODE_IMAGE_TAG`) → for ghcr installs **pin** to the latest release tag only if GHCR already has both images (else "still building", 409) → a **sidecar updater** started from the *old* image by ID (`pulsenode updater`) runs `compose up -d`, then waits up to 120s for go-api's boot id to change + both healthchecks → on failure it **rolls back** the images (and the git checkout only if the tree was clean and HEAD is still the pulled commit). It **never restores the DB on its own**; restore is manual + confirmed (`POST /api/system/update/restore-snapshot`, applied at next start). Refuses while a deploy is running.
- The verdict is persisted (`<workspace>/.pulsenode/update-result.json`, matched by update id), so the UI doesn't depend on in-memory state surviving the restart.
- Gotcha kept: `up -d --build` builds while old containers keep serving, so `/health` answers from old code; the page reloads only when `/health`'s `startedAt` boot id **changes**.
- The first update *from* a pre-sidecar version runs the old code (no snapshot/rollback).

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
- **Push webhooks (`backend/internal/api/github_webhook.go`).** `POST /api/github/webhook` is **public** (registered outside the `/api` auth group, next to the OAuth callback) and authenticated per-request by HMAC-SHA256 over the raw body vs `X-Hub-Signature-256` (`validSignature`). The master secret is stored **encrypted** in `settings`; each project's hook uses a **derived secret** `HMAC-SHA256(master, "project:"+id)`, verified against the projects matching the payload's `full_name` (plus the shared master as a legacy fallback; `PULSENODE_WEBHOOK_LEGACY_SECRET=false` turns that off — hooks installed earlier still use the shared one). Body capped at 5 MB; replays are deduped by delivery id **and** body signature. The handler matches push events to auto-deploy projects by owner/repo + branch and enqueues like the poller. **The branch poller stays on as a fallback** — webhooks just make it instant. Note: the public URL is `https://<host>/go/api/github/webhook` because Caddy strips `/go` before proxying (same reason the documented OAuth callback is `/go/api/github/callback`); the frontend builds the URL from `window.location.origin + NEXT_PUBLIC_GO_API`.
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
- Builder: commands run with the `passEnv` allow-list only (no panel secrets); the GitHub token goes via `gitAuthEnv` (env `http.extraheader`) and **only to `https://github.com`**, never the clone URL. Compose runs with a forced project name `-p pn-<id>`; `composepolicy.go` is an **allow-list** of service/build/deploy keys (unknown keys rejected, e.g. `use_api_socket`, `device_cgroup_rules`, `network_mode` other than `service:`/`none`, image tags outside `pn-<id>`), and symlinks out of the repo are refused. All deployed containers (single, monorepo, every compose service via a generated hardening overlay) get `cap-drop ALL` + a small allow-list, `no-new-privileges`, memory/pids limits (`PULSENODE_APP_*`) and log rotation; managed DBs get limits too (`PULSENODE_DB_*`).
- Sessions carry a random `jti`; logout writes it to `session_revocations` (survives restart). Login lockout is per (account, IP) with an account-wide slow-down, never a hard admin lockout. `db.Decrypt` returns `ErrDecrypt` on key mismatch (deploy fails with "cannot decrypt env: AES key mismatch") instead of passing ciphertext through. The audit log records Bearer users, sensitive GETs and login outcomes.
- Outbound alert/backup requests go through an SSRF guard (private/loopback/metadata blocked at dial time; `PULSENODE_ALERTS_ALLOW_PRIVATE`, `PULSENODE_BACKUPS_ALLOW_PRIVATE`); Slack/Discord hosts are pinned. Webhook URLs and secrets are never returned by the API; changing a destination requires re-entering its secret.

### Built-in proxy + wildcard DNS (`backend/internal/proxy/`, `api/proxy_handler.go`, `domain_handler.go`)
- `resolveTraefikNetwork` order: `TRAEFIK_NETWORK` env → `.env.local` → a running external Traefik → our managed proxy → **start** the managed proxy (`pulsenode-traefik` on network `pulsenode-proxy`, `traefik:v3.6`, ports 80/443, Let's Encrypt HTTP challenge, read-only docker socket, no dashboard) unless `PULSENODE_MANAGED_PROXY=false`. An external Traefik always wins. If 80/443 are taken it fails with a typed "ports 80/443 are in use" error and never touches the other service (on this box it was a stock **nginx**, now disabled).
- DNS is **not** managed: the user adds one wildcard `*.<root> → server IP` record. `GET /api/domains/wildcard` probes a random label (`pn-probe-…`) and reports ok / proxied (Cloudflare ranges count as fine) / missing / wrong; deploy logs add a non-fatal DNS note. A wildcard covers one label only.

### Alerts, scanners, backups
- **Alerts** (`internal/alerts`): evaluator every 15s for host CPU/memory/disk (with duration), container down (clean exit 0 and compose one-offs ignored), deploy failed (stored already resolved). Notifiers: webhook (HMAC), Slack, Discord, Telegram, SMTP. The hub sends the real `alert:count` on connect and on every change.
- **Scanners** (`internal/security`): Trivy/Syft are in the go-api image; one scan at a time (409 busy), `status:"unavailable"` when a tool is missing — **never fabricate numbers**. The Trivy cache is its own volume (`pn-trivy-cache`). go-api memory defaults to 768M (`PULSENODE_API_MEMORY`) with `GOMEMLIMIT`.
- **Backups** (`internal/backups`, Backups page): hourly/daily/weekly schedules per managed DB and for the panel; local + S3-compatible destinations; the panel archive = DB snapshot + keys + `.env.local`, encrypted with a user passphrase; offline `pulsenode restore-panel` / `verify-backup`. Recovery steps are in `docs/backups.md`.

### CI / release (`.github/workflows/ci.yml`, `release.yml`)
- Push to `main` → reusable CI (go vet, `go test -race`, gofmt on changed files, govulncheck report-only, vitest + tsc + lint + build, compose validation, docker smoke test) → native amd64 + arm64 image builds → publish to GHCR → **then** create the tag/release (so a release implies its images exist) → Trivy report (report-only, pinned binary). Every push to `main` is a release, so batch CI-only fixes where possible.

### UI / design system (see docs/design-system.md)
- **Tailwind 4 + shadcn/ui on base-ui** (no `asChild` — use the `render` prop). Tokens live in `app/theme.css` (light on `:root`, dark on `[data-theme="dark"]`, theme via `next-themes`: light/dark/system, key `pn-theme`). `AppShell` tags the content with `data-area` (monitor/resource/deploy/security/neutral → `--hue`), derived from `lib/nav.ts` — the same file drives the sidebar, breadcrumb and Ctrl+K palette, so add new pages there.
- Page = `PageHeader` + `PageBody` (`components/pn/*`), shadcn `Table`/`Dialog`/`Sheet`/`Tabs`, `ConfirmDialog` instead of `confirm()`, sonner `toast` instead of `alert()`. No hard-coded hex colours; status colours (`success/warning/danger/info`) always come with text or an icon.
- Add shadcn components with `npx shadcn@latest add <name>`; check the diff afterwards (it can overwrite files).
- Long values (ports, images, commands, domains, endpoints) use `components/pn/Truncate.tsx` (ellipsis + full value in a tooltip on hover/focus); the cell/flex parent needs `max-w-*` / `min-w-0`. Don't put it inside links/buttons.
- Gotchas found here: base-ui sets `data-orientation="horizontal"`, so tab classes must use `data-[orientation=horizontal]:` (Tailwind's `data-horizontal:` never matched and laid Tabs out as a row); this shadcn `CommandDialog` needs a cmdk `<Command>` inside it or the palette crashes on open; Go list endpoints must return `[]`, not `null`.
- The Coolify integration was **removed** (page, routes, installer prompts); don't reintroduce it.

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
