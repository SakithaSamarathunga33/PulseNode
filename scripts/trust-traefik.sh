#!/usr/bin/env bash
# Find the Traefik container on the shared proxy network and record its name in
# .env.local as TRAEFIK_CONTAINER, so Caddy (docker-compose.traefik.yml) trusts
# X-Forwarded-For only from Traefik instead of every private address.
#
#   scripts/trust-traefik.sh [env-file]        # default: .env.local
#
# Network: TRAEFIK_NETWORK from the environment or the env file (default
# vps-monitor_proxy). Run it on the host, then:
#   docker compose --env-file .env.local -f docker-compose.yml -f docker-compose.traefik.yml up -d caddy
set -euo pipefail

ENV_FILE="${1:-.env.local}"
get() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true; }

NET="${TRAEFIK_NETWORK:-$(get TRAEFIK_NETWORK)}"
NET="${NET:-vps-monitor_proxy}"

if ! docker network inspect "$NET" >/dev/null 2>&1; then
  echo "trust-traefik: Docker network '$NET' not found (set TRAEFIK_NETWORK)" >&2
  exit 1
fi

# Running containers on that network whose image looks like Traefik.
names=()
while IFS=$'\t' read -r name image; do
  [[ "${image,,}" == *traefik* ]] && names+=("$name")
done < <(docker ps --filter "network=$NET" --format $'{{.Names}}\t{{.Image}}')

if [[ ${#names[@]} -eq 0 ]]; then
  echo "trust-traefik: no Traefik container found on '$NET'." >&2
  echo "  Set TRAEFIK_CONTAINER=<container name> in $ENV_FILE yourself." >&2
  exit 1
fi

value="$(IFS=,; echo "${names[*]}")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
if grep -qE '^TRAEFIK_CONTAINER=' "$ENV_FILE"; then
  sed -i "s|^TRAEFIK_CONTAINER=.*|TRAEFIK_CONTAINER=${value}|" "$ENV_FILE"
else
  printf '\nTRAEFIK_CONTAINER=%s\n' "$value" >> "$ENV_FILE"
fi
echo "trust-traefik: TRAEFIK_CONTAINER=$value written to $ENV_FILE (network $NET)"
