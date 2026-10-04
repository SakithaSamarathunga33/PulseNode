<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.png">
  <img src="docs/images/logo-light.png" alt="PulseNode" width="420">
</picture>

**Open-source VPS control panel — monitor your server, manage Docker, deploy GitHub projects with automatic HTTPS, back up everything, and secure containers from one dashboard.**

[![Release](https://img.shields.io/github/v/release/SakithaSamarathunga33/PulseNode?color=2563eb&label=release)](https://github.com/SakithaSamarathunga33/PulseNode/releases/latest)
[![Build](https://github.com/SakithaSamarathunga33/PulseNode/actions/workflows/release.yml/badge.svg)](https://github.com/SakithaSamarathunga33/PulseNode/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Go](https://img.shields.io/badge/backend-Go-00ADD8?logo=go&logoColor=white)](backend/)
[![Next.js](https://img.shields.io/badge/frontend-Next.js%2015-black?logo=next.js)](app/)
[![Images](https://img.shields.io/badge/images-amd64%20%7C%20arm64-2496ED?logo=docker&logoColor=white)](https://github.com/SakithaSamarathunga33?tab=packages&repo_name=PulseNode)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Install](#one-command-install) · [Features](#features) · [Architecture](#how-it-works) · [Deploying projects](#deploying-projects) · [Configuration](#configuration) · [Roadmap](#roadmap) · [Contributing](#contributing)

![PulseNode dashboard](docs/images/pulsenode-dashboard.png)

</div>

---

## One-command install

```bash
curl -fsSL https://raw.githubusercontent.com/SakithaSamarathunga33/PulseNode/main/install.sh | bash
```

The script:
1. Checks Docker and Docker Compose v2 are installed
2. Clones the repo into `~/pulsenode` (or `/opt/pulsenode` when run as root)
3. Detects your server's public IP — one prompt to confirm
4. **Asks you to create an admin login** so your dashboard isn't left open to the internet
5. Writes the config, pulls the pre-built images for your CPU (amd64 or arm64) — or builds from source — and starts everything behind Caddy
6. Polls until services are ready, then prints your clickable dashboard URL

When it finishes you'll see:

```
  ✓  PulseNode is live!

  Open in browser  →  http://YOUR_IP/
```

**Re-running the same command updates an existing install** (your login and data are kept).

### Requirements

| Requirement | Version |
|------------|---------|
| Docker | 24+ |
| Docker Compose plugin (v2) | 2.20+ |
| git | any |
| Linux VPS | Any distro with Docker, amd64 or arm64 |
| RAM | 2 GB+ recommended (vulnerability scans are memory hungry) |
| Open ports | 80 for the dashboard; 80 + 443 free if you deploy projects (see [Deploying projects](#deploying-projects)) |

---

## Features

**Monitor**
- 📊 **Live system metrics** — CPU, RAM, disk I/O and network streamed over WebSocket/SSE, read straight from `/proc`
- ⏱️ **Runtime & uptime** — per-container CPU/RAM and 24h / 3d / 7d up-down history
- 📈 **Process explorer** — live host processes with per-process CPU/memory, suspend/kill, and suspicious-process detection (miners, `/tmp` binaries, piped base64…)
- 🔔 **Alerts** — rules for CPU, memory, disk, container down and failed deploys, sent to **Slack, Discord, Telegram, email or a signed webhook**

**Resources**
- 🐳 **Full Docker management** — containers, images, networks, logs, stats and an in-browser shell
- 🗄️ **Databases** — provision PostgreSQL, MySQL, MongoDB and Redis (bound to `127.0.0.1`), browse tables, run queries, view metrics, or connect existing databases
- 💾 **Scheduled backups** — hourly/daily/weekly backups of your databases and of the panel itself (settings + keys), encrypted, to a local folder or any S3-compatible bucket (AWS S3, Backblaze B2, Cloudflare R2, MinIO), with retention, failure alerts and offline recovery — see [docs/backups.md](docs/backups.md)

**Deploy**
- 🚀 **Deploy from GitHub** — Dockerfile, Docker Compose, Nixpacks auto-builds, and `frontend/` + `backend/` monorepos on one domain
- ⚡ **Push-to-deploy** — the GitHub webhook is installed for you; a branch poller is the fallback
- 🔄 **Zero-downtime deploys with rollback** — new containers are health-checked before the old ones are removed; one click rolls back to any previous build
- 🌐 **Automatic HTTPS for your apps** — uses your existing Traefik, or starts its own with Let's Encrypt; a built-in check tells you whether your wildcard DNS record is right
- 🌍 **Domains** — DNS checker that understands Cloudflare-proxied records, plus an overview of every hostname in use

**Security**
- 🛡️ **Vulnerability scanning** — Trivy scans and Syft SBOMs for your images (real results only — "unavailable" when a scanner isn't installed)
- 🔐 **Hardened by default** — mandatory login with lockout, revocable sessions, audit log, encrypted secrets, and every deployed app runs with dropped capabilities, memory/process limits and rotated logs
- 🧱 **Compose sandbox** — a repo's `docker-compose.yml` is checked against an allow-list, so a pushed commit can't take over the host or the panel
- ♻️ **Safe self-update** — one click from Settings: database snapshot first, pinned release, health check afterwards, automatic rollback if the new version doesn't come up

---

## Why PulseNode?

Running a single VPS usually means juggling three or four tools — one for metrics, one for Docker, one for deployments, one for backups. PulseNode is one dashboard for the whole box.

| | PulseNode | Portainer | Netdata | Coolify |
|---|:---:|:---:|:---:|:---:|
| Live host metrics (CPU/RAM/disk/net) | ✅ | ❌ | ✅ | ➖ basic |
| Docker containers / images / networks | ✅ | ✅ | ➖ view only | ➖ |
| Git push-to-deploy with rollback | ✅ | ➖ stacks | ❌ | ✅ |
| Automatic HTTPS for deployed apps | ✅ | ❌ | ❌ | ✅ |
| Container vulnerability scanning + SBOMs | ✅ | ❌ | ❌ | ❌ |
| Database provisioning & scheduled backups | ✅ | ❌ | ❌ | ✅ |
| Alerts to Slack / Discord / Telegram / email | ✅ | ❌ | ✅ | ✅ |
| Single-command install | ✅ | ➖ | ✅ | ✅ |

PulseNode doesn't try to manage a fleet of a hundred nodes — it's built to be *the* dashboard for the one or two servers you actually run.

---

## How it works

![PulseNode system architecture — users and internet services on the left, the VPS with Traefik, the PulseNode panel (Caddy, Next.js web, Go API, SQLite), Docker Engine, deployed apps and managed databases in the middle, and the CI/release pipeline along the bottom](docs/PulseNode%20VPS%20Architecture%20Infographic.png)

**The panel** is a small Docker Compose stack:

```
Browser
  │
  ▼
Caddy  (port 80, or 443 with auto-TLS — the panel's only public entry point)
  ├─ /go/*     ──▶  go-api :4002   REST API (Docker, metrics, auth, projects, databases, backups…)
  ├─ /ws       ──▶  go-api :4002   WebSocket — live metrics and alerts
  ├─ /events   ──▶  go-api :4002   Server-Sent Events
  ├─ /health   ──▶  go-api :4002   health check
  └─ /*        ──▶  web    :3000   Next.js dashboard
```

- **go-api** (Go) talks to Docker through `/var/run/docker.sock` and runs in the host PID namespace to read real CPU, RAM, disk and network stats from `/proc`. It also runs the deploy queue and builder, the alert evaluator, the vulnerability scanner, the backup scheduler and the proxy manager.
- **Data** lives in one SQLite database (WAL mode) — projects, deployments and logs, alerts, audit log, backup history and the admin account. Secrets in it (env vars, tokens, database passwords) are AES-GCM encrypted; the keys live in a separate data volume.
- **Your deployed apps** are separate containers routed by **Traefik** with automatic HTTPS — see [Deploying projects](#deploying-projects).
- **Releases** are built by GitHub Actions: tests and checks → amd64 + arm64 images → published to GHCR → Trivy report → tagged release. The in-app updater only installs a release whose images are already published.

---

## Deploying projects

Connect GitHub on the **GitHub** page (OAuth app or a personal access token with `repo` scope), then **Projects → New project**: pick a repo and branch, set a domain and port, add environment variables, deploy. PulseNode auto-detects Docker Compose → Dockerfile → Nixpacks, and splits `frontend/` + `backend/` repos into two services on one domain (backend under `/api`).

### Routing and HTTPS (built-in proxy)

Deployed apps are routed by Traefik. PulseNode picks what to use in this order:

1. `TRAEFIK_NETWORK` from `.env.local`, if set.
2. A Traefik container that is already running on the server (used untouched).
3. Otherwise PulseNode **starts its own Traefik** (`pulsenode-traefik`, `traefik:v3.6`) on ports 80 and 443 with automatic Let's Encrypt certificates. The first deploy does this for you; the **Domain** page shows its status and lets you set the Let's Encrypt e-mail, enable or disable it.

Things to know:

- **Ports 80 and 443 must be free.** If something else holds them (a default nginx or Apache install is the usual culprit), the deploy stops with `ports 80/443 are in use`. PulseNode never stops other services — free the ports yourself, e.g. `sudo systemctl disable --now nginx`.
- **DNS:** add one wildcard record, `*.example.com` → your server IP (proxied through Cloudflare is fine). PulseNode doesn't edit your DNS; it checks the record and shows the status on the Domain and project pages and in the deploy log. A wildcard covers one level: `app.example.com` yes, `a.b.example.com` no.
- **Opt out:** set `PULSENODE_MANAGED_PROXY=false` or press Disable on the Domain page.

### Limits for deployed apps

Every app runs with all Linux capabilities dropped except a small allow-list, `no-new-privileges`, a 1 GB memory limit, a 1024-process limit and rotated logs (10 MB × 3). Tune in `.env.local` with `PULSENODE_APP_MEMORY`, `PULSENODE_APP_PIDS`, `PULSENODE_APP_CPUS` (`0` or `unlimited` switches one off). A compose service's own `mem_limit`, `deploy.resources.limits`, `cap_drop` or `logging` wins.

---

## Manual deploy

```bash
git clone https://github.com/SakithaSamarathunga33/PulseNode.git ~/pulsenode
cd ~/pulsenode
./deploy.sh
```

`deploy.sh` prompts for your IP/domain and optional HTTPS, writes `.env.local`, then runs `docker compose up -d --build`.

Or configure manually:

```bash
cp .env.example .env.local
nano .env.local
docker compose -f docker-compose.yml -f docker-compose.standalone.yml up -d --build
```

---

## Configuration

All settings live in `.env.local` (created by the installer or `deploy.sh`):

```bash
# Required
NEXT_PUBLIC_ORIGIN=http://YOUR_IP_OR_DOMAIN
NEXT_PUBLIC_GO_API=http://YOUR_IP_OR_DOMAIN/go

# Caddy site address — :80 for IP, domain.com for HTTPS auto-TLS
CADDY_SITE_ADDRESS=:80

# Internal ports (usually no need to change)
WEB_PORT=127.0.0.1:3000
GO_PORT=127.0.0.1:4002

# Security — auto-generated by the installer (or by PulseNode on first start if empty)
JWT_SECRET=<auto-generated>
AES_KEY=<auto-generated>
MASTER_ENCRYPTION_KEY=<auto-generated>
```

Optional knobs:

| Variable | Default | What it does |
|---|---|---|
| `PULSENODE_MANAGED_PROXY` | `true` | Start the built-in Traefik when none exists |
| `PULSENODE_APP_MEMORY` / `_PIDS` / `_CPUS` | `1g` / `1024` / off | Limits for deployed apps |
| `PULSENODE_DB_MEMORY` / `_PIDS` | per engine / `4096` | Limits for managed databases |
| `PULSENODE_API_MEMORY` | `768M` | Memory limit of the go-api container (scans need room) |
| `PULSENODE_ALERTS_ALLOW_PRIVATE` | `false` | Allow alert webhooks to private/LAN addresses |
| `PULSENODE_ALERTS_ALLOW_ANY_WEBHOOK_HOST` | `false` | Allow Slack/Discord-type channels on other hosts (e.g. Mattermost) |
| `PULSENODE_BACKUPS_ALLOW_PRIVATE` | `false` | Allow S3 endpoints on private addresses (e.g. MinIO on your LAN) |
| `PULSENODE_BACKUPS_EXTRA_DIRS` | — | Extra host folders allowed as local backup destinations |
| `PULSENODE_WEBHOOK_LEGACY_SECRET` | `true` | Keep accepting the old shared GitHub webhook secret |

---

## Login / Security

PulseNode controls Docker, host processes, databases and deployments, so **login is always required**. The installer creates the admin account for you; until one exists, the dashboard and API stay locked.

If you deployed manually (or the installer couldn't create the account):

1. Get the one-time setup token: `docker compose logs go-api | grep setup_token`
2. Open the dashboard — you'll be sent to a **Create your admin account** form
3. Paste the token, choose a username and password (minimum 8 characters)

Good to know:
- Passwords are bcrypt-hashed; sessions are httpOnly JWT cookies that refresh while you're active (30 minutes idle, 12 hours max). Logging out or changing your password revokes the session, even across restarts.
- Repeated failed logins slow down guessing per account and per IP, without locking you out of your own account.
- Sensitive actions and reads (credentials, backup downloads, shell sessions, logins) are recorded in the audit log.
- Change your password in **Settings → Security**.
- Running PulseNode only on a private network/VPN and really want no login? Set `PULSENODE_INSECURE_NO_AUTH=true`. Anyone who can reach the dashboard then controls your server.

See [SECURITY.md](SECURITY.md) for the full model and a hardening checklist. Found a vulnerability? Please report it privately there.

---

## HTTPS / custom domain for the dashboard

Run `deploy.sh`, answer **y** to the HTTPS question, and enter your domain. Caddy handles TLS automatically via Let's Encrypt.

Requirements: the domain's DNS must already point to the VPS, and port 443 must be open.

## Behind an existing Traefik proxy

If your VPS already runs Traefik, put the dashboard behind it with the overlay:

```bash
# Add to your .env.local:
TRAEFIK_HOST=vps.example.com
TRAEFIK_NETWORK=traefik   # name of the Traefik Docker network

docker compose \
  -f docker-compose.yml \
  -f docker-compose.standalone.yml \
  -f docker-compose.traefik.yml \
  up -d --build
```

The overlay attaches Caddy to the Traefik network and adds the router labels; Caddy keeps the internal routing and trusts forwarded client IPs only from Traefik itself. If your Traefik container isn't named `traefik`, run `scripts/trust-traefik.sh` once. Deployed projects will use the same Traefik.

---

## Project structure

```
pulsenode/
├─ app/                       Next.js 15 app router pages
│   ├─ containers/            Dashboard — host health + container table, logs, shell
│   ├─ runtime/  stats/       Per-container usage, uptime history, host charts
│   ├─ processes/             Host processes + suspicious-activity detection
│   ├─ images/  networks/     Docker images and networks
│   ├─ databases/  backups/   Managed databases and scheduled backups
│   ├─ projects/  github/     Deploy from GitHub, connect an account
│   ├─ domain/                DNS checks, wildcard status, built-in proxy
│   ├─ alerts/                Alert history, rules, notification channels
│   ├─ scan-history/  sbom-history/   Vulnerability scans and SBOMs
│   ├─ settings/              Version, safe self-update, snapshots, security
│   └─ login/                 Login and first-run setup
├─ backend/                   Go API (chi router, gorilla/websocket)
│   ├─ cmd/pulsenode/         Entry point + CLI (updater, restore-panel, verify-backup)
│   └─ internal/
│       ├─ api/               HTTP handlers, auth, audit, update, webhooks
│       ├─ builder/           Dockerfile / Nixpacks / Compose / monorepo builds, compose policy
│       ├─ queue/             Deploy queue (one deploy per project), branch poller
│       ├─ proxy/             Built-in Traefik manager
│       ├─ alerts/            Evaluator + Slack/Discord/Telegram/SMTP/webhook notifiers
│       ├─ backups/           Scheduler, encryption, local + S3 storage
│       ├─ security/          Trivy / Syft scanning
│       ├─ docker/  proc/     Docker client, /proc reader
│       ├─ hub/               WebSocket/SSE fan-out
│       ├─ db/  auth/         SQLite store, JWT
│       └─ github/            GitHub API client
├─ components/  lib/          UI (shadcn/ui on Base UI), API client, nav
├─ docs/                      Backups guide, design system, architecture image
├─ .github/workflows/         CI + multi-arch release pipeline
├─ Caddyfile                  Panel routing
├─ docker-compose*.yml        Base stack + standalone / no-SSL / Traefik / GHCR overlays
├─ install.sh  deploy.sh      One-command installer, interactive deploy
└─ scripts/                   Caddy entrypoint, Traefik trust helper
```

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, React 19, TypeScript, Tailwind CSS 4 |
| UI components | shadcn/ui on Base UI, cmdk palette, sonner toasts |
| Charts / tables | uPlot, TanStack Table |
| Real-time | WebSocket / Server-Sent Events |
| Backend API | Go, chi router, gorilla/websocket |
| System metrics | Go — reads `/proc` directly |
| Database | SQLite (modernc.org/sqlite, WAL) |
| Auth | HMAC-SHA256 JWT, httpOnly cookie, bcrypt |
| Panel proxy | Caddy v2 (auto-TLS) |
| App routing | Traefik v3 (yours, or PulseNode's built-in) + Let's Encrypt |
| Builds | Docker BuildKit, Nixpacks, Docker Compose |
| Security scanning | Trivy, Syft |
| Backups | AES-GCM encryption, MinIO client (S3-compatible) |
| CI / images | GitHub Actions, GHCR (amd64 + arm64) |

---

## Updating

Use the built-in updater: **Settings → Update**. It snapshots the database, installs the pinned release, checks that the new version is healthy and rolls back automatically if not. Snapshots can be restored from the same page.

Or from the shell:

```bash
# Re-run the installer:
curl -fsSL https://raw.githubusercontent.com/SakithaSamarathunga33/PulseNode/main/install.sh | bash

# Or manually:
cd ~/pulsenode
git pull
docker compose -f docker-compose.yml -f docker-compose.standalone.yml up -d --build
```

---

## Roadmap

- [x] Scheduled database backups (local + S3)
- [x] Alert channels: Slack, Discord, Telegram, email, webhook
- [x] Pre-built ARM64 images
- [x] Automatic HTTPS for deployed projects
- [ ] Two-factor authentication (TOTP)
- [ ] API tokens for CI / scripts
- [ ] Per-project HTTP health checks
- [ ] Multi-server monitoring from one dashboard
- [ ] Metrics history retention settings

Have an idea? [Open an issue](https://github.com/SakithaSamarathunga33/PulseNode/issues/new/choose) — roadmap priorities follow community demand.

---

## Contributing

Contributions are welcome — from typo fixes to new features. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, the CI checks and PR guidelines, and check the [good first issues](https://github.com/SakithaSamarathunga33/PulseNode/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

- 🐛 [Report a bug](https://github.com/SakithaSamarathunga33/PulseNode/issues/new/choose)
- 💡 [Request a feature](https://github.com/SakithaSamarathunga33/PulseNode/issues/new/choose)
- 🔐 [Report a security issue](SECURITY.md)

---

## License

PulseNode is open source under the [MIT License](LICENSE).

---

<div align="center">

**If PulseNode saves you time, [give it a star ⭐](https://github.com/SakithaSamarathunga33/PulseNode) — it helps other self-hosters find it.**

</div>
