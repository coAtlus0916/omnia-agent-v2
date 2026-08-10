#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo ./install.sh" >&2
  exit 1
fi

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_ROOT=${OMNIA_V5_BRIDGE_INSTALL_ROOT:-/opt/omnia-agent-v5-bridge}

install -d -m 0750 "$INSTALL_ROOT"
install -m 0644 "$SOURCE_DIR/server.cjs" "$INSTALL_ROOT/server.cjs"
install -m 0644 "$SOURCE_DIR/Dockerfile" "$INSTALL_ROOT/Dockerfile"
install -m 0644 "$SOURCE_DIR/docker-compose.yml" "$INSTALL_ROOT/docker-compose.yml"

if [ ! -f "$INSTALL_ROOT/.env" ]; then
  TOKEN_SECRET=$(od -An -N48 -tx1 /dev/urandom | tr -d ' \n')
  umask 077
  {
    echo "OMNIA_V5_BRIDGE_TOKEN_SECRET=$TOKEN_SECRET"
    echo "OMNIA_V5_BRIDGE_HOST=0.0.0.0"
    echo "OMNIA_V5_BRIDGE_PORT=18785"
  } > "$INSTALL_ROOT/.env"
fi
chmod 0600 "$INSTALL_ROOT/.env"

cd "$INSTALL_ROOT"
docker compose build
# Named volumes are initially owned by root, while the Bridge runs as the
# unprivileged node user (uid/gid 1000). Initialize ownership before startup so
# pairing can persist bindings.json instead of passing health but failing POST.
docker compose run --rm --no-deps --user root --cap-add CHOWN --entrypoint chown \
  omnia-agent-v5-bridge -R 1000:1000 /var/lib/omnia-agent-v5-bridge
docker compose up -d --remove-orphans

attempt=0
until curl --fail --silent --show-error http://127.0.0.1:18785/v1/health >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker compose logs --tail=100 omnia-agent-v5-bridge >&2
    exit 1
  fi
  sleep 1
done

echo "Omnia Agent v5 Bridge is healthy on 127.0.0.1:18785."
echo "This installer only manages container omnia-agent-v5-bridge and $INSTALL_ROOT."
