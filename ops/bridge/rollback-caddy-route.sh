#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo ./rollback-caddy-route.sh [Caddyfile]" >&2
  exit 1
fi

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CADDYFILE=${1:-/etc/caddy/Caddyfile}
python3 "$SOURCE_DIR/caddy-route.py" rollback --caddyfile "$CADDYFILE"
caddy validate --config "$CADDYFILE" --adapter caddyfile
systemctl reload caddy
echo "Caddy v5 Bridge route rolled back."
