#!/bin/sh
# Caddy entrypoint for the Traefik overlay (docker-compose.traefik.yml).
#
# Decides whose X-Forwarded-For Caddy may believe. Apps deployed by PulseNode share
# the Traefik network with Caddy and can reach it directly; if every private address
# were trusted they could forge their IP (rate-limit key, audit log). So trust only
# Traefik itself:
#   1. CADDY_TRUSTED_PROXIES set  -> use it verbatim (CIDRs separated by spaces,
#                                    or the word private_ranges to opt back in)
#   2. otherwise resolve the container name(s) in TRAEFIK_CONTAINER (default
#      "traefik"; comma or space separated) on the shared network -> their /32s
#   3. nothing resolved           -> private_ranges with a loud warning, so the
#      panel still works behind an unusually named Traefik until it is configured
#
# Resolution happens at start. If Traefik is recreated with a new address, restart
# Caddy:  docker compose restart caddy
set -u

if [ -z "${CADDY_TRUSTED_PROXIES:-}" ]; then
  trusted=""
  for name in $(printf '%s' "${TRAEFIK_CONTAINER:-traefik}" | tr ',' ' '); do
    for ip in $(getent hosts "$name" 2>/dev/null | awk '{print $1}'); do
      case "$ip" in
        *:*) cidr="$ip/128" ;;
        *) cidr="$ip/32" ;;
      esac
      case " $trusted " in
        *" $cidr "*) ;;
        *) trusted="${trusted:+$trusted }$cidr" ;;
      esac
    done
  done
  if [ -n "$trusted" ]; then
    echo "pulsenode: trusting X-Forwarded-For only from Traefik ($trusted)" >&2
    CADDY_TRUSTED_PROXIES="$trusted"
  else
    echo "pulsenode: WARNING could not resolve Traefik (TRAEFIK_CONTAINER=${TRAEFIK_CONTAINER:-traefik}); trusting ALL private addresses." >&2
    echo "pulsenode: apps on the Traefik network can then spoof their IP. Set TRAEFIK_CONTAINER (or CADDY_TRUSTED_PROXIES) in .env.local — see scripts/trust-traefik.sh" >&2
    CADDY_TRUSTED_PROXIES="private_ranges"
  fi
fi
export CADDY_TRUSTED_PROXIES
exec "$@"
