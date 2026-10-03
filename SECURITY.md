# Security Policy

PulseNode has privileged access to the host it runs on (Docker socket, host PID namespace, deployment controls), so security reports are taken seriously.

## Supported versions

Only the latest release is supported. Update with:

```bash
curl -fsSL https://raw.githubusercontent.com/SakithaSamarathunga33/PulseNode/main/install.sh | bash
```

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

- Preferred: [report privately via GitHub](https://github.com/SakithaSamarathunga33/PulseNode/security/advisories/new) (Security → Report a vulnerability)
- Or email: sakithaudarashmika63@gmail.com

Include what you found, steps to reproduce, and the impact you believe it has. You'll get an acknowledgement within a few days, and a fix will be prioritized based on severity.

## Trust model

PulseNode's API container holds the Docker socket and shares the host PID namespace, so **anyone who is logged in to the dashboard is effectively root on the server**. Everything below exists to keep that login — and the deploy pipeline — from being reachable by anyone else.

What PulseNode does for you:

- **Login is mandatory.** Until an admin exists, every API route is locked; creating the first admin needs a one-time setup token (the installer handles this). `PULSENODE_INSECURE_NO_AUTH=true` is the only way to turn it off.
- **Sessions** are httpOnly, `SameSite=Lax` and `Secure` on HTTPS; they expire after 30 idle minutes and 12 hours after login, and changing your password signs out every other session.
- **Cross-site requests** that change state are rejected unless they come from the dashboard's own origin (this also covers apps you deploy on sibling subdomains).
- **Brute force:** login is limited to 10 attempts per minute per IP, and failed logins are also counted per account (slowing unfamiliar IPs rather than locking you out).
- **Secrets:** missing or placeholder `JWT_SECRET` / `AES_KEY` values are replaced by random keys; stored tokens, env vars and DB passwords are AES-256-GCM encrypted.
- **Deploys:** a repo's `docker-compose.yml` may not use `privileged`, host or other containers' namespaces, `cap_add`, devices, host bind mounts (including the Docker socket), external or explicitly named volumes, Traefik router labels, or files outside the repo. Builds never see PulseNode's own environment, and your GitHub token is never written into clone URLs or logs.
- **Resource limits for what you deploy:** every deployed app — single container, monorepo component or each service of a compose file — runs with all Linux capabilities dropped except a small allow-list, `no-new-privileges`, a memory limit (default 1 GB), a process limit (1024) and rotated logs (10 MB × 3). For compose services PulseNode only fills in what the service does not set itself (a `mem_limit`, `deploy.resources.limits`, `cap_drop` or `logging` of your own wins). Tune with `PULSENODE_APP_MEMORY`, `PULSENODE_APP_PIDS` and `PULSENODE_APP_CPUS` in `.env.local` (`0` or `unlimited` switches one off). Managed databases get the same treatment when they are created (memory 1 GB, 512 MB for Redis, 2 GB for ClickHouse/Cassandra/Elasticsearch; 4096 processes; tune with `PULSENODE_DB_MEMORY` / `PULSENODE_DB_PIDS`).
- **Environment variables** you set on a project must have plain names (`[A-Za-z_][A-Za-z0-9_]*`) and values without newlines — a newline would otherwise add variables to the compose `.env` file.
- **Webhooks and alert channels:** each project gets its own GitHub webhook secret (derived from an encrypted master secret); hooks installed before this change keep the shared secret, which stays accepted unless you set `PULSENODE_WEBHOOK_LEGACY_SECRET=false`. Alert webhook URLs are never returned in full by the API, and changing a channel's destination requires re-entering its secret. Outgoing alert requests are refused for private, loopback, link-local and metadata addresses (`PULSENODE_ALERTS_ALLOW_PRIVATE=true` lifts this); Slack and Discord channels must use their real hosts (`PULSENODE_ALERTS_ALLOW_ANY_WEBHOOK_HOST=true` lifts this, e.g. for Mattermost).
- **Scheduled backups:** the panel backup (database snapshot, `aes-key`, `jwt-secret`, `.env.local`) is *always* encrypted with a passphrase you choose (scrypt + AES-256-GCM, authenticated in chunks, so truncation and tampering are detected); managed-database dumps are encrypted with a key derived from the panel's AES key unless you turn that off. Destination credentials are stored encrypted, are never returned by the API, and cannot be reused for a different endpoint/bucket without re-entering them. S3 endpoints that resolve to private or reserved addresses are refused (`PULSENODE_BACKUPS_ALLOW_PRIVATE=true` allows e.g. MinIO on your LAN); local destinations must live inside the data directory or a directory you list in `PULSENODE_BACKUPS_EXTRA_DIRS`. Anyone holding a panel backup *and* its passphrase can read every secret in the panel — store the passphrase away from the server. See [docs/backups.md](docs/backups.md) for the recovery steps.
- **Secrets and sessions:** if the AES key does not match the database, PulseNode fails the deploy with "cannot decrypt env: AES key mismatch" instead of passing encrypted text to your apps. Logging out revokes the session in the database, so it survives restarts. Known limit: the AES key uses the first 32 characters of the configured key (about 128 bits when it is 64 hex characters); changing that needs a versioned re-encryption.
- **Headers:** Caddy sends CSP, `X-Frame-Options: DENY`, HSTS, `nosniff` and a strict referrer policy.

## Hardening checklist for your install

- **Use a domain and HTTPS.** `install.sh` offers HTTPS automatically when you enter a domain whose DNS points at the server. Over plain HTTP your password and session cookie cross the network unencrypted.
- **Firewall the host — and know that Docker bypasses UFW.** Ports published by Docker (80/443 here) are opened in iptables before UFW's rules, so `ufw deny` does not block them. To restrict who can reach PulseNode, add rules to the `DOCKER-USER` chain, use your provider's cloud firewall, or reach the dashboard only over a VPN/Tailscale.
- **Only connect repositories you trust to auto-deploy.** Anyone who can push to a deployed branch can run code in a container on your server (without host access, thanks to the compose policy above).
- **Behind Traefik?** Apps you deploy share Traefik's network and can reach Caddy directly, so Caddy must believe `X-Forwarded-For` only from Traefik itself — otherwise an app can forge its IP past the rate limiter and into the audit log. The Traefik overlay now does this for you: at start it resolves the container named by `TRAEFIK_CONTAINER` (default `traefik`) and trusts only that address (Caddy then reads the header right to left and ignores any client-supplied prefix). If your Traefik container has another name, run `scripts/trust-traefik.sh` on the host (it writes `TRAEFIK_CONTAINER` to `.env.local`) or pin addresses with `CADDY_TRUSTED_PROXIES="<ip>/32 …"`, then `docker compose restart caddy`. If Traefik cannot be resolved, Caddy falls back to trusting all private addresses and logs a warning — check `docker compose logs caddy` for `pulsenode: trusting X-Forwarded-For only from Traefik`. If Traefik is recreated with a new address, restart Caddy.
- **Keep `.env.local` private** (`chmod 600`, done by the installer) and never commit it.
- **Keep PulseNode updated** — releases ship continuously.
