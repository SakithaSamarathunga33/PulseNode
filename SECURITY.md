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

## Hardening checklist for your install

- Create the admin login — the installer does this; for manual installs, the dashboard stays locked until you create it with the setup token from `docker compose logs go-api | grep setup_token`
- Serve over HTTPS (`deploy.sh` → answer **y** to HTTPS, or put PulseNode behind your existing proxy)
- Don't expose port 80/443 more widely than needed — a VPN or IP allowlist is even better
- Keep PulseNode updated — releases ship continuously
