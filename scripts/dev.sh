#!/usr/bin/env bash
# Restart the app cleanly.
#
#   bash scripts/dev.sh [--wipe]
#
# Why this exists: `pkill -f "node src/main.js"` matches the shell that runs it
# (its own argv contains the pattern), and two app instances can then fight over
# port 8000 -- which silently serves the OLD code and costs an hour of
# confusion. This kills by port owner instead.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

WIPE=0
[ "${1:-}" = "--wipe" ] && WIPE=1
shift || true

echo "== redis =="
# The container is not started automatically on a host reboot (rootless podman
# has no systemd user unit here), so bring it up explicitly. The vector index
# for the semantic tier lives in it.
if podman ps --format '{{.Names}}' | grep -qx llm-redis; then
  echo "  already running"
elif podman ps -a --format '{{.Names}}' | grep -qx llm-redis; then
  podman start llm-redis >/dev/null && echo "  started"
else
  podman run -d --name llm-redis -p 127.0.0.1:6379:6379 \
    --restart unless-stopped --memory 192m --cpus 1.0 \
    docker.io/library/redis:8 redis-server --save "" --appendonly no >/dev/null \
    && echo "  created and started"
fi
for _ in $(seq 1 20); do
  podman exec llm-redis redis-cli ping 2>/dev/null | grep -q PONG && break
  sleep 0.5
done
podman exec llm-redis redis-cli ping 2>/dev/null | grep -q PONG \
  && echo "  PONG" || { echo "  redis did not come up"; exit 1; }

echo "== stopping whatever owns :8000 =="
PIDS="$(ss -tlnpH 'sport = :8000' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)"
if [ -n "$PIDS" ]; then
  # shellcheck disable=SC2086
  kill $PIDS 2>/dev/null && echo "  killed $PIDS"
fi
# any orphaned model workers too (exact comm match, never -f)
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pgrep -x llama-server >/dev/null || break
  pkill -x llama-server 2>/dev/null
  sleep 0.5
done
sleep 1

if [ "$WIPE" = "1" ]; then
  echo "== wiping local state =="
  rm -f data/llm-cache.sqlite data/llm-cache.sqlite-wal data/llm-cache.sqlite-shm
  podman exec llm-redis redis-cli flushall >/dev/null 2>&1 && echo "  sqlite + redis cleared"
fi

echo "== starting =="
# node 20.6+ reads .env natively: no dotenv dependency
ENVARGS=(ALLOW_SEED=1 ADMIN_TOKEN="${ADMIN_TOKEN:-dev-token}" REVIEWER_TOKEN="${REVIEWER_TOKEN:-}")
exec env "${ENVARGS[@]}" node --env-file=.env src/main.js 2>&1