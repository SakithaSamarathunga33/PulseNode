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
- **Brute force:** login is limited to 10 attempts per minute per IP.
- **Secrets:** missing or placeholder `JWT_SECRET` / `AES_KEY` values are replaced by random keys; stored tokens, env vars and DB passwords are AES-256-GCM encrypted.
- **Deploys:** a repo's `docker-compose.yml` may not use `privileged`, host or other containers' namespaces, `cap_add`, devices, host bind mounts (including the Docker socket), external or explicitly named volumes, Traefik router labels, or files outside the repo. Builds never see PulseNode's own environment, and your GitHub token is never written into clone URLs or logs.
- **Headers:** Caddy sends CSP, `X-Frame-Options: DENY`, HSTS, `nosniff` and a strict referrer policy.

## Hardening checklist for your install

- **Use a domain and HTTPS.** `install.sh` offers HTTPS automatically when you enter a domain whose DNS points at the server. Over plain HTTP your password and session cookie cross the network unencrypted.
- **Firewall the host — and know that Docker bypasses UFW.** Ports published by Docker (80/443 here) are opened in iptables before UFW's rules, so `ufw deny` does not block them. To restrict who can reach PulseNode, add rules to the `DOCKER-USER` chain, use your provider's cloud firewall, or reach the dashboard only over a VPN/Tailscale.
- **Only connect repositories you trust to auto-deploy.** Anyone who can push to a deployed branch can run code in a container on your server (without host access, thanks to the compose policy above).
- **Behind Traefik?** Caddy trusts forwarded client IPs from private ranges by default (`CADDY_TRUSTED_PROXIES`). If untrusted apps share Traefik's network, set it to Traefik's own IP so they can't spoof their IP past the login rate limit.
- **Keep `.env.local` private** (`chmod 600`, done by the installer) and never commit it.
- **Keep PulseNode updated** — releases ship continuously.
