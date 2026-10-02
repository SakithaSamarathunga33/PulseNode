# PulseNode — UI Redesign Brief

You are a senior product designer and front-end engineer. Design a **brand-new visual design** for the web app described below. Keep every feature, page, data field and action listed here; change the look, layout, hierarchy, components and interaction polish as much as you like. Don't port the current styling over; treat the description of it as a reference only.

---

## 1. Product

**PulseNode** is a self-hosted VPS control panel, roughly "Portainer + Vercel + Uptime Kuma + Trivy" in one dashboard. One admin runs it on their own Linux server to:

- monitor the host (CPU, RAM, disk, network, processes) live
- manage Docker containers, images, networks and database containers
- deploy apps from GitHub repos (push-to-deploy, build logs, rollback, domains)
- review security (vulnerability scans, SBOMs, alerts, suspicious process detection)

The users are developers and solo operators: technical, keyboard-friendly, scanning dense data. The app is open most of the day as a "mission control" tab. Tagline: **"Infrastructure at a glance."** Logo: a helmet mark plus a "PulseNode" wordmark (dark and light variants exist).

**Tech constraints for your output:** Next.js (App Router) + React + TypeScript, Tailwind CSS, shadcn/ui (Radix) primitives, lucide-react icons, uPlot for time-series charts. Fonts: Geist Sans and Geist Mono (you may propose others). It must support **dark mode (default) and light mode** through CSS variables, with a theme toggle. Desktop-first; it must still be usable on a tablet and phone.

---

## 2. Current design system (for reference only; replace it)

- **Mood:** near-black "Linear/Vercel-style" dark UI. Violet accent, hairline borders, very small type, monospace for all numbers and IDs, a subtle violet radial glow in the top-right of the page background.
- **Dark palette:**
  - Background levels: `#08080b` (bg), `#0c0c10`, `#111116`, `#16161d`; card `#0e0e13`.
  - Borders: white at 6%, 10% and 16% opacity.
  - Text: `#ededf2`, `#c8c8d2`, `#8a8a96`, `#5a5a64`.
  - Accent: violet `#8b7cff`, secondary `#6d5cff`.
  - Status: ok `#22c55e`, warn `#f59e0b`, bad `#ef4444`, info `#06b6d4`, each with a 14% tint.
- **Light palette:** white surfaces, slate text, accent `#6d5cff`.
- **Other colors:**
  - Severity: critical red, high orange `#f97316`, medium amber, low blue.
  - Database brands: postgres `#336791`, redis `#dc382d`, mysql `#00758f`, mongo `#47a248`, clickhouse `#fbcd1c`.
  - Package ecosystems: go `#00ADD8`, npm `#cb3837`, debian `#a81d33`.
- **Radii:** 6, 8, 10, 14 and 18px. **Motion:** 120–360ms, eased.
- **Recurring components:**
  - StatCard: label, big value, unit, sub-text, sparkline, delta chip.
  - Pill (status badge with a dot): tones ok, warn, bad, info, accent, outline.
  - VulnBar: C/H/M/L severity counts.
  - ProgressBar: 3px; green, then amber above 70%, then red above 85%.
  - Underline tabs with count chips.
  - Segmented controls.
  - Filter chips ("Label: Value ▾").
  - Dense tables: 12.5px text, sticky right-hand action column.
  - Right-side drawers.
  - Destructive-confirm dialogs: a tinted hero area with a big icon, a strip identifying the target, then Cancel and a solid red button.
  - Toasts.
  - A "TerminalWindow" with macOS traffic-light dots for log output.
  - A pulsing green "Live · Ns" indicator.
- **Flourishes in use:**
  - Staggered fade-up entrance on every page.
  - "BorderBeam": a light travelling around the active nav item and the login card.
  - NumberTicker count-up on values.
  - Typed-terminal animation for streamed command output.
  - A circle-reveal animation on the theme toggle.
- **Known problems to fix in the redesign:**
  - Two styling systems are mixed (inline CSS variables and Tailwind brand classes), so pages feel slightly inconsistent.
  - Runtime has its own stat-card style.
  - Labels are tiny (9–10px).
  - Loading, empty and error states are missing on many pages.
  - Many filter chips are purely decorative.
  - Native `alert()`/`confirm()` are used on the deploy pages.
  - Several "Live · Ns" labels state the wrong interval.

---

## 3. App shell

**Layout:** a full-height sidebar on the left; on the right, a top bar with a scrolling content area below it. The login and GitHub-callback pages are full-screen with no shell.

**Sidebar** (220px; collapses to a 52px icon rail):

- Top: the logo (with a pulsing ring) and the wordmark, captioned "vps · console".
- Nav, in collapsible sections. A count badge (where shown) appears on the right of the item.
  - **Workspace:** Dashboard (`/containers`), Runtime, Stats, Processes, and Coolify (only shown if Coolify is detected).
  - **Resources:** Images [count], Networks [count], Databases [count].
  - **Deploy:** GitHub, Projects [count], Domain.
  - **Security:** Scan History, SBOMs, Alerts [firing count, live].
- Active item: a left accent border, an accent icon and a highlighted background.
- Bottom strip:
  - Live host CPU %, with a thin bar and a count-up number.
  - Host name and IP, with a live green dot.
  - The tagline.
  - A Settings button that shows an amber pulsing dot when an app update is available.
  - A "Collapse" toggle.

**Top bar** (52px):

- Breadcrumb: `production-01 / <Page title>`.
- Center: a page search box ("Search pages…") with a keyboard-navigable dropdown. Each result shows an icon, a title, a description and a chevron, with a ↑↓ / ↵ / Esc hint footer. A ⌘K command palette would be a welcome upgrade.
- Right side:
  - Theme toggle.
  - Refresh.
  - Alerts bell with a red dot.
  - Settings.
  - Log out (only if login protection is on).
  - A user avatar with initials.

---

## 4. Pages: full inventory (keep all of it)

### 4.1 `/login`

- Full-screen background image with a dark overlay.
- A centered logo with "Sign in to your dashboard" below it.
- A card containing Username (autofocus) and Password.
- Error box messages: "Login failed" and "Could not reach server".
- A full-width "Sign in" button with a spinner state.
- A loading spinner shows while auth status is checked.

### 4.2 `/containers` — Dashboard (home; `/` redirects here)

**Header:**
- Title "Dashboard".
- Subtitle: "N containers · N running · N stopped".
- A Refresh button.

**4 stat cards:**
- Host: host name, distro and kernel.
- Apps: container count, a green "N running" pill and a red "N stopped" pill.
- CPU: %, a sparkline, and cores · model.
- Memory: %, a sparkline, and used/total.

**Strip of 3 cells:**
- Disk usage: %, used/total/free, a bar, and a red "Clear Build Cache" button.
- Network (last 60s): ↓RX and ↑TX in KB/s, with a sparkline.
- Load average: 1m, 5m and 15m, with a sparkline.

**Tabs:**
- All, Running (the default), Stopped and Exited, each with a count.
- A "Filter…" input that matches name or image.

**Table:**
- Columns:
  - Checkbox
  - Name: with a "DOCKER" tag and a ports chip
  - Image: with a tech logo (postgres, mysql, redis, mongo, node, python, next, nuxt, nest…; Docker as the fallback)
  - State: running = green, stopped = grey, exited = red, paused = amber
  - Uptime
  - Ports
  - CPU % (live)
  - RAM % (live)
  - Created
  - Actions
- Footer: "Showing X of Y" and "Live · 3s".
- Row actions are icon buttons that show a spinner while busy:
  - Start or Stop
  - Restart
  - Logs
  - Shell (only when the container is running)
  - Stats
  - Remove

**Right drawer (Logs):**
- Header: container name chip, a lines select (50–1000), refresh and close.
- A "Live" strip.
- An auto-scrolling monospace log.
- States: loading, "(no output)" and an error.

**Right drawer (Terminal):**
- Header: "Clear" and close.
- Output: commands shown with a `$` prefix in accent, grey output, red errors, and a "running…" state.
- A `$` input with a send button; Enter runs the command.

**Dialogs:**
- Remove container: destructive confirm.
- Clear Docker Build Cache: streamed terminal output starting with `$ docker builder prune -f`, ending in ✔ or ✗, with a blinking cursor while it runs; the button reads Cancel, then Close.

### 4.3 `/runtime` — Runtime Monitor

**Header:**
- The subtitle changes by tab.
- Right side: "Live · refreshes every 3s · HH:MM:SS" (Resources tab) or "History recorded every 60s" (Uptime tab).

**Tab: Resources**
- 4 stats: Running containers, Avg CPU (with "Total: X%"), Total RAM used, Highest CPU (with the container's name).
- Table "Containers · N running", with a "Manage →" link to `/containers`:
  - Container: name plus short ID
  - Image
  - CPU %: bar and value
  - RAM: bar and MB/GB
  - RAM %: "of limit"
  - Status
- Container, CPU % and RAM are sortable.
- Thresholds: at 60% amber, at 80% red.
- Empty state: "No running containers".
- A full-page spinner on first load.

**Tab: Uptime** (Uptime Kuma style)
- Header: "Uptime · X / Y up" and a 24h / 3d / 7d segmented control.
- One row per container:
  - A status dot.
  - Name and uptime.
  - A heartbeat strip of 50 bars: green = up, red = down, grey = no data.
  - Uptime %: green at 99% or above, amber at 90% or above, red below that.

### 4.4 `/stats` — System Stats

**Header:**
- Subtitle: "hostname · region · ip".
- A time range control: 5m / 1h / 6h (default) / 24h / 7d.
- An Export button.
- A pulsing "Auto · 5s" indicator.

**4 stat cards** (count-up values, sparklines, delta chips):
- CPU: with the CPU model.
- Memory: used/total.
- Disk: free.
- Network RX: with TX.

**2×2 chart grid** (live, up to 180 points, 200px tall). Each card header has a title, the current value, the unit and a "⋯" menu.
- CPU Usage: area chart, 0–100%.
- Memory Usage: area chart.
- Disk I/O: bars for Read and Write in MB/s.
- Network: lines for RX and TX.

**3 detail cards:**
- Host Info: Hostname, Distro, Kernel, Uptime, IP, Region, CPU Model, Swap.
- Memory Breakdown:
  - A large "used / total GB".
  - A segmented bar: Used, Cached, Buffers, Free.
  - A legend with GB and %.
  - A swap bar.
- Disk:
  - A large "% used" with a bar.
  - Tiles: Used, Free, Total, Type.
  - I/O Rate: Read and Write.
  - A "Clear Build Cache" button, which opens the same streamed dialog as on the Dashboard.

### 4.5 `/processes` — Processes

**Header:**
- A pulsing red "🛡 N suspicious" pill when anything is flagged.
- Subtitle: "N processes", plus "· N suspended" when any are suspended.

**CPU Cores · live:**
- A grid of up to 8 columns.
- Each core shows "CPUn", its %, and a bar.

**Tab: All Processes**
- Search: matches command, user or PID.
- Filter chips: User and State.
- Sort control: CPU / MEM / PID.
- Table columns:
  - PID (sortable)
  - User
  - Command: name, the full command below it in mono, and a "PM2" tag plus an accent left border for PM2 processes
  - State: Running or Sleep
  - CPU % (mini bar)
  - MEM (mini bar)
  - RES
  - "Actions ▾"
- The Actions dropdown has a "PID n · name" header and two items:
  - Suspend: SIGSTOP, amber.
  - Kill process: SIGKILL, red.
- Footer: "Showing X of Y" and "Live".
- **Suspended Processes card** (amber; shown only when any are suspended):
  - Columns: PID, User, Command, State ("SIGSTOP · paused"), and a "▶ Unblock" button.

**Tab: 🛡 Suspicious Activity**
- Empty state: a green shield, "No suspicious activity detected", and "All N processes look normal".
- When something is flagged:
  - A red summary banner with counts by risk.
  - Table columns:
    - Risk: Critical, High or Medium
    - PID
    - Process: name and command
    - User
    - CPU %
    - Why flagged: a stack of amber reason pills, for example "mining keyword", "runs from /tmp", "base64 piped to shell", "curl|sh", "random-looking name", "high CPU, unrecognised"
    - Actions: "✓ Release" (false positive) plus the same Actions dropdown
  - Rows have a left border colored by risk.
  - A "Released (false positives)" card lists PID chips, each with × to re-flag, and a "Clear all" link.

**Confirm dialog:** Kill (red) or Suspend (amber), showing a strip with the PID, the name and "user · cmd".

**Toast:** bottom-right, for example "Killed X (PID n)" or "Released PID n — marked as safe".

### 4.6 `/coolify` — Coolify

Shown only when Coolify is detected; read-only.

**Header:**
- Title with a "LABELS" badge.
- Subtitle: "Self-hosted deployment platform · Docker label detection".
- Buttons: Refresh and "Open Dashboard".

**4 stats:** Total Apps, Running Services, Managed Databases, Deployments.

**Accordion, one item per Coolify project:**
- The header shows the name and count chips: "N apps", "N dbs", "N services".
- Inside are three sub-tables:
  - Applications: Name, Domains (chips), Status, Last Deployed, Branch, Container.
  - Databases: Name, Engine (a brand-colored pill), Status, Size, Connections.
  - Services: Name, Type, Status, Ports.

**Recent Deployments table:**
- Columns: App, Branch, Status (success, failed or running with a live dot), Duration, Triggered By, Timestamp.

**Footer badge:** "Data source: Docker Labels".

### 4.7 `/images` — Images

**Header:**
- Subtitle: "N images · X MB · N unused".
- A transient chip after pruning, such as "Pruned · X MB reclaimed".
- Buttons: "Prune unused" and "Pull image" (primary).

**4 stats:** Total images, Disk used, Vulnerabilities (crit + high), Avg layers.

**Filter row:**
- Search: matches repo or tag.
- Chips: Registry, Status, Sort.
- "last sync · N min ago".

**Table:**
- Columns:
  - Checkbox
  - Repository: with a brand icon
  - Tag: a code chip
  - Digest: 12 characters plus "…"
  - Size
  - Layers
  - Vulnerabilities: VulnBar
  - Used by: "N containers" (green) or "unused" (outline)
  - Created
  - Actions
- Row actions: Pull, Scan, SBOM, Remove (red).

**Dialogs:**
- Remove image: destructive confirm.
- Pull image:
  - A mono "image:tag" input; Enter submits.
  - Example chips: `nginx:latest` and `postgres:16-alpine`.
  - An inline result message.
  - Cancel, and Pull with a spinner.

### 4.8 `/networks` — Networks

**Header:**
- Subtitle: "N networks · N container attachments".
- A Refresh button.

**4 stats:** Networks, Throughput (KB/s, live sparkline), Active connections, Dropped.

**2 live charts, side by side:**
- Ingress: RX KB/s.
- Egress: TX KB/s.
- Each keeps the last 60 points.

**Table:**
- Columns:
  - Name: with a colored dot
  - Driver: a pill, for example bridge, host or overlay
  - Scope
  - Subnet
  - Gateway
  - Containers
  - Flags: "attachable" and "internal" chips
  - Actions
- Row actions: Inspect, Connect, Remove.

**Network Topology card:**
- A hub-and-spoke diagram: the network in the center, connected containers around it.
- Container-name chips below.

### 4.9 `/databases` — Databases

This is the most complex page.

**Header:**
- "Databases" with a "Live" badge.
- Subtitle: "N databases · N connections · N QPS".
- Buttons: "Create database" (secondary) and "Connect database" (primary).

**4 KPI tiles:**
- Databases.
- Connections: with "N peak".
- Queries/sec.
- Slow queries: amber when above 0, otherwise green "healthy".

**Main table:**
- Toolbar:
  - Search: matches database, engine or host.
  - Status segmented control: all / ok / warn / bad.
  - Chips: "Rows N" and "Storage".
- Columns:
  - Expand chevron
  - Database: an engine logo tile, the name, an optional "Coolify" tag, engine and version
  - State
  - Size
  - Connections: "N / max" and a bar
  - QPS
  - Slow: a warning icon and count
  - Endpoint: host:port in mono
  - Activity: a sparkline in the engine's color
  - Actions: a sticky right-hand column
- Row actions: "Query", "Metrics", Backup, Restore, Delete.
- Clicking a row expands an inline panel with three tabs: **Overview / Query / Metrics**.

**Overview tab:**
- Left, Tables list:
  - A database select and an "N objects" count.
  - A "Filter tables…" input.
  - Rows show: table icon, name, "N rows" and size.
  - Clicking a row opens the **Table Data modal**:
    - Header: "N rows · N cols · Nms" and Export CSV.
    - A grid with a sticky header, zebra rows and italic "null" values.
    - Pagination: Prev, Next and "Page N".
- Right:
  - Connection string card: a mono box with a copy button.
  - Slow queries card: "N flagged"; a mini table of Query and Duration.

**Query tab:**
- Controls:
  - A DB select and a Table (or Collection) select.
  - A "● connected" or "● error" status.
  - Close.
- Editor:
  - A monospace editor with an engine-aware placeholder (SQL, Redis or Mongo).
  - Buttons: Run (Ctrl+↵) and Clear.
- Results:
  - "✓ Query executed · Nms", or "✓ N rows affected".
  - Or a result grid with "N rows · ms · N cols", Export CSV and **Expand** (a fullscreen results overlay).
- Banners: red for errors; amber for "duplicate / already exists".
- When browsing a table: a paging bar.
- **Destructive-query alert** for DROP, TRUNCATE, or DELETE/UPDATE without WHERE, with a red "Run anyway" button.

**Metrics tab:**
- "live · refreshes every 5s".
- A grid of 2–5 columns of metric tiles, each with a label and a value colored by tone.

**Backup modal:**
- Fields: a Database select and an optional Table select.
- A streamed progress box: "Preparing…" or "Dumping data…", a byte counter and the file name, ending in a ✓ or ✗ state.
- Buttons per phase: Start backup, then Running…, then Download or New backup, or Try again.

**Restore modal:**
- A target database select.
- A file input accepting .sql, .archive or .rdb.
- A Redis warning: the container will be stopped and dump.rdb replaced.
- A success box with the command output.

**Create Database modal (wizard):**
1. Pick:
   - A 2×2 grid of engine cards: PostgreSQL 16, MySQL 8, Redis 7, MongoDB 7.
   - An optional name.
   - A note: "first pull may take 1–5 min".
2. Provisioning: a spinner and a progress line.
3. Done:
   - Copyable Connection String and Password fields.
   - User and Port tiles.
4. Error: shown with "Try again".

**Connect External Database modal:**
1. A connection string textarea, with example chips for postgres, mysql, redis and mongodb.
2. An optional display name.
3. "Test Connection" → "✓ Connected · engine vX · host:port" → "Save to monitoring".

**Delete dialog:** destructive confirm.

### 4.10 `/projects` — Projects

**Header:** "N projects" and "+ New Project".

**Cards:**
- Icon: a repo icon, or a server icon for "Hosted on VPS" apps that weren't deployed through PulseNode.
- Name, with tags: "Hosted on VPS", "frontend" or "backend".
- `owner/repo` or the image name.
- Status: running = green, building or queued = accent, failed = red, idle = grey.
- Meta: branch, domain and build method.

**Repo groups:** a repo deployed as separate frontend and backend projects shows as an expandable group:
- "Deployed separately · X of 2 services", with a status per member.
- If one side is missing, a dashed "+ Add frontend" or "+ Add backend" card.

**States:**
- Empty: "No projects yet" with "+ Deploy a project".
- Loading: a spinner.

### 4.11 `/projects/new` — New Project wizard

**Stepper:** 1 Repository → 2 Configure → 3 Deploy.

**Step 1 — Repository:**
- A searchable repo list. Each row shows `owner/repo` and "Private/Public · default branch"; the selected row gets a check.
- A Branch select.
- Continue.

**Step 2 — Configure:**
- If the repo has `frontend/` and `backend/` folders, a choice tile:
  - **One project:** shared domain; frontend serves `/`, backend serves `/api`.
  - **Separate projects:** each gets its own domain; pick frontend or backend.
  - An explainer callout for each choice.
- Project Name.
- Domain:
  - Mono input.
  - A 🔀 button that generates a random subdomain such as `swift-wave-123.root.com`.
  - Hint: "must point to this server via DNS".
- Container Port. Combined mode has both a Frontend port and a Backend port.
- Build Method, as 4 tiles:
  - Auto-detect (Compose → Dockerfile → Nixpacks)
  - Docker Compose
  - Dockerfile
  - Nixpacks
- Environment Variables: a KEY=VALUE textarea. Combined mode has two, Frontend env and **Backend env** (secrets stay out of the frontend).
- Back, and "Review & Deploy".

**Step 3 — Deploy:**
- A summary of every choice.
- An error banner when needed.
- Back, and "Deploy Project" with a spinner. It then redirects to the project.

### 4.12 `/projects/[id]` — Project detail

**Header:**
- "< Projects".
- Name and status.
- Branch and domain (an external link).
- "Redeploy" (primary). Tooltip: "Redeploy the latest commit on <branch>".
- Delete (icon button).

**Tabs:** Settings / Logs / History.

**Settings tab:**
- Read-only card:
  - Project ID
  - Repository
  - "Deploys from: x/" (when applicable)
  - Last deployed commit SHA
- **Auto-deploy webhook** card:
  - Installed (green) or Not installed (amber).
  - An explainer.
  - "Install webhook", or "Re-check / repair" when installed.
- Editable config:
  - An auto-deploy toggle.
  - Name, Branch, Domain, Container Port.
  - Build Method tiles.
  - Env vars, plus Backend env vars for monorepos.
- Buttons: Save, "Save & Redeploy", and a full-width red "Delete Project".

**Logs tab:**
- A deployment select: "<id> — <status> — <age>".
- A full-height **terminal window**:
  - Title "<depId> — pulsenode build".
  - Each line has a timestamp.
  - Error lines (error, failed, fatal, panic, "exit status") are red; system lines are violet.
  - **Lines stream in live over a websocket** and the view auto-scrolls.
  - Empty state: "Waiting for logs…".

**History tab:**
- A list of deployment cards; clicking one opens its logs.
- Each card has:
  - A status: success, failed, building, queued or running.
  - A relative age.
  - A trigger tag: "⚡ auto", "⟲ rollback" or "manual".
  - The 7-character SHA and the commit message.
  - A **Rollback** button on successful deploys that have an image ("Roll back to <sha>? zero downtime").

**External app variant** (read-only):
- Buttons: Restart and Stop (or Start).
- Info grid: Image, Ports, Container, Created.
- A terminal window with the container logs (the last 300 lines).

### 4.13 `/github` — GitHub

Subtitle: "Connect your GitHub account to deploy projects from private and public repositories."

**Account section:**
- When connected:
  - Avatar, login, and "via Personal Access Token" or "via GitHub OAuth".
  - A "Connected" pill.
  - Buttons: "Deploy a project >" and Disconnect.
- When not connected:
  - A "Continue with GitHub" OAuth card.
  - A **Personal Access Token** card:
    - Scope help: classic → `repo`; fine-grained → Contents (read), Metadata (read), Webhooks (read/write).
    - A password input, "ghp_…".
    - A Connect button that reads "Validating…" while checking.

**OAuth App Settings** (collapsible):
- The callback URL in a code chip.
- Client ID.
- Client Secret, showing "(already set)" when a secret exists.
- Save, which reads "Saving…" and then "Saved!".
- A 4-step "How OAuth works" card.

**Deploy Webhook (manual fallback):**
- Payload URL, with a copy button.
- Secret, masked, with reveal and copy buttons.
- Notes: content type application/json, push event only, and the poller stays on as a fallback.

### 4.14 `/github/app/callback`

A centered card with three states:
- Loading: "Registering installation…".
- Success: "Installation registered for <login>", then "Redirecting…".
- Error: an error message, then "Redirecting to GitHub settings…".

### 4.15 `/domain` — Domain

Subtitle: "Save the domains you use, verify their DNS, and see what each container is serving."

**1. Saved domains:**
- An input and "+ Save".
- Rows:
  - The host.
  - A "PRIMARY" tag.
  - A status: Proxied (Cloudflare), Pointed, Not pointed, Unchecked or Error.
  - The resolved IPs.
  - Actions: Re-check, Make primary (★) and Delete.
- Empty state: "No saved domains yet."

**2. DNS records:** "Point these records to this VPS IP", then A-record rows with a copy button and an "EXPECTED IP" box.

**3. In use on this server:**
- Hostnames found from containers, projects and Caddy, each with its "source:ref (status)".
- Each shows "Saved" or "+ Save".
- A refresh button.

**4. Check DNS:**
- An input and Check.
- A result panel:
  - A ✓ or ✗ with a headline: "proxied through Cloudflare", "pointed correctly" or "not pointed to this VPS".
  - Expected IP and Resolved IPs tiles.

### 4.16 `/scan-history` — Scan History

**Header:**
- Subtitle: "N scans · N succeeded · N failed".
- "Scan now", which opens a modal with an "image:tag" input.

**4 stats:** Critical, High, Medium and Low, each "across all scans".

**"Vulnerability Trend · 30d":** 30 stacked severity bars with a legend.

**Table:**
- Filters: search, plus Severity ≥, Status and Scanner chips.
- Columns:
  - Scan ID
  - Image
  - Scanner
  - Status: Done (✓), Failed (✗) or Running (spinner)
  - Started
  - Duration
  - Findings: VulnBar
  - Actions: View, Download, Re-scan

**Side drawer "Scan Report: <id>"** (opened by clicking a row):
- CRIT, HIGH, MED and LOW tiles.
- CVE findings rows: a severity pill, the CVE id, the package, and "fix: version".
- Buttons: Export report and Re-scan.

### 4.17 `/sbom-history` — SBOMs

**Header:** "Software bills of materials · N images · N packages tracked".

**4 stats:** SBOMs, Packages total, Unique licenses, EOL packages (warn).

**Filters:**
- Search.
- Format and Ecosystem chips.
- A segmented control: SPDX / CycloneDX / JSON.

**Card grid,** one card per image:
- The image name.
- Generated time and a format badge.
- Download and open buttons.
- A big package count and "+ N licenses".
- A segmented ecosystem bar for Go, npm, Debian and Other, with a legend and counts.

### 4.18 `/alerts` — Alerts

**Header:**
- Subtitle: "N firing · N ack · N resolved · N rules".
- Buttons: "Mute all" and "+ New rule" (plus "Simulate Alert" in dev).

**4 stats:** Firing, Acknowledged, Resolved 24h, MTTR 7d.

**History tab:**
- Filters:
  - Search.
  - Segmented: All / Firing / Ack / Resolved.
  - Severity and Range chips.
  - "Mark all read".
- Rows:
  - A severity icon: critical, warning, info or ok.
  - The title, with "target · rule expression" below it.
  - Relative time.
  - State: Firing, Acknowledged or Resolved.
  - Buttons: Ack and Resolve.
- New alerts arrive live and animate in at the top.
- Empty state: "No alerts match your filter".

**Rules tab:**
- Columns: On (toggle), Rule, Expression (code chip), Severity, Channels (pills), Actions (Edit, Copy, Delete).

**Channels tab:**
- Cards for Email, Slack and PagerDuty. Each shows: Connected, a description, "N routes" and Configure.
- A dashed "+ Add channel" card.

### 4.19 `/settings` — Settings

The page has two columns.

**Version card:**
- Tiles: Installed vX and Latest vX.
- Banners: amber "Update available — vX" or green "You're on the latest version".
- A "What's new" changelog with a release-notes link.
- Buttons: "Check for updates" and "Update to vX".

**Update progress** (replaces the version buttons while updating):
- "Updating PulseNode" or "Reconnecting…".
- "Restart expected in ~Ns".
- A live log console, color-coded: section headers, ✓ green, ⚠ amber, ✕ red, build lines.
- "The dashboard is restarting. Do not close this tab." with a progress bar.
- The page reloads automatically once the server is back.

**"How updates work":** 4 numbered steps (git pull, compose down, compose up --build, auto-reconnect).

**Security card:**
- Status: "Protected · <user>" or "Off".
- When off:
  - A warning that anyone with the URL can access the dashboard.
  - Username, Password (8+ characters) and Confirm.
  - "Enable login protection".
- When on:
  - Change password: Current, New and Confirm.
  - Sign out.
  - "Disable login": an inline danger panel that asks for the password before "Confirm disable".

---

## 5. Real-time behaviour the design must support

- Values update every 2–5s from a websocket and polling: container CPU and RAM, host metrics, process list, cores, and DB metrics.
- Live charts append new points.
- Build logs and backup progress stream line by line.
- Alerts arrive live, and nav badge counts update.
- Every live surface needs a clear "live / last updated" affordance. Number changes should feel smooth, never jumpy (use tabular numerals).

---

## 6. What I want from you

1. **A design direction:** name it, give 3–5 principles, and explain why it fits a developer ops console.
2. **A design system:**
   - Color tokens for dark and light, including status, severity and chart palettes. Check contrast against WCAG AA.
   - A type scale, with nothing below 11px for body text or labels.
   - Spacing, radii, elevation and motion tokens.
3. **A component library:**
   - Buttons (primary, secondary, ghost, danger, icon).
   - Inputs, select, textarea, toggle, segmented control, tabs, filter chips.
   - Stat card, status pill, severity badge, progress bar, sparkline, chart card.
   - Data table: sort, sticky actions, row expansion, selection with **bulk actions**, and skeleton, empty and error states.
   - Drawer, modal, destructive confirm, toast, command palette (⌘K).
   - Terminal/log viewer: streaming, search, wrap toggle, copy.
   - Stepper, empty-state illustration pattern, live indicator.
4. **The redesigned app shell:** sidebar (expanded and collapsed), top bar, ⌘K, and mobile navigation.
5. **High-fidelity layouts for every page in section 4.** Show every state: loading (skeletons), empty, error, populated, and live.
6. **Working code:** a Tailwind config and a `globals.css` with CSS variables, plus React/TSX components that use shadcn/ui and lucide-react. Keep page and route names, and all data fields, the same.

**Constraints:**
- Don't drop features.
- Don't invent new backend data.
- Make it fast and dense, but readable.
- Use animation with purpose, not decoration. Respect `prefers-reduced-motion`.
- Fully keyboard-accessible.
