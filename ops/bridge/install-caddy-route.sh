#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo ./install-caddy-route.sh [site] [Caddyfile]" >&2
  exit 1
fi

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SITE=${1:-labcaspian.com}
CADDYFILE=${2:-/etc/caddy/Caddyfile}

python3 "$SOURCE_DIR/caddy-route.py" install --site "$SITE" --caddyfile "$CADDYFILE"
if ! caddy validate --config "$CADDYFILE" --adapter caddyfile; then
  python3 "$SOURCE_DIR/caddy-route.py" rollback --caddyfile "$CADDYFILE"
  caddy validate --config "$CADDYFILE" --adapter caddyfile
  echo "Caddy validation failed; original configuration restored." >&2
  exit 1
fi
if ! systemctl reload caddy; then
  python3 "$SOURCE_DIR/caddy-route.py" rollback --caddyfile "$CADDYFILE"
  caddy validate --config "$CADDYFILE" --adapter caddyfile
  systemctl reload caddy
  echo "Caddy reload failed; original configuration restored and reloaded." >&2
  exit 1
fi

echo "Caddy route installed: /v5-bridge/* -> 127.0.0.1:18785"
echo "No v4 service, container, route, port, or release directory was modified."
