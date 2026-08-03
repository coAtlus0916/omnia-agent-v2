#!/usr/bin/env sh
set -eu

INSTALL_ROOT=${OMNIA_V5_BRIDGE_INSTALL_ROOT:-/opt/omnia-agent-v5-bridge}
if [ ! -r "$INSTALL_ROOT/.env" ]; then
  echo "Bridge env file is unavailable: $INSTALL_ROOT/.env" >&2
  exit 1
fi

ADMIN_TOKEN=$(sed -n 's/^OMNIA_V5_BRIDGE_ADMIN_TOKEN=//p' "$INSTALL_ROOT/.env" | head -n 1)
if [ -z "$ADMIN_TOKEN" ]; then
  echo "Bridge admin token is missing." >&2
  exit 1
fi

curl --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Accept: application/json" \
  http://127.0.0.1:18785/v1/admin/pairing-bundles
printf '\n'
unset ADMIN_TOKEN
