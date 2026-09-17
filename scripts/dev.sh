#!/usr/bin/env bash
# Runs the backend (port 3000) and frontend (port 3001) together.
# On Ctrl+C, stops both processes and force-frees their ports so
# reruns never hit "address already in use".
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT=3000
FRONTEND_PORT=3001

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

cleanup() {
  echo ""
  echo "Stopping dev servers..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  kill_port "$BACKEND_PORT"
  kill_port "$FRONTEND_PORT"
  exit 0
}
trap cleanup INT TERM

kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"

(cd "$ROOT_DIR/backend" && npm run start:dev) &
BACKEND_PID=$!

(cd "$ROOT_DIR/frontend" && npm run dev -- -p "$FRONTEND_PORT") &
FRONTEND_PID=$!

while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done
cleanup
