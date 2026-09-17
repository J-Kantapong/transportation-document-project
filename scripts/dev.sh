#!/usr/bin/env bash
# Runs the backend (port 3000) and frontend (port 3001) together.
# On Ctrl+C, stops both process trees and force-frees their ports so
# reruns never hit "address already in use".
set -uo pipefail
set -m # job control: each backgrounded job becomes its own process group

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT=3000
FRONTEND_PORT=3001

# Retries because a process that was still starting up (e.g. mid TypeScript
# compile) at the moment of the process-group kill may bind to its port
# a moment later, after the group kill below already ran.
kill_port() {
  local port="$1"
  local tries=0
  local pids
  while [ "$tries" -lt 5 ]; do
    pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
    if [ -z "$pids" ]; then
      return 0
    fi
    echo "$pids" | xargs kill -9 2>/dev/null || true
    tries=$((tries + 1))
    sleep 1
  done
}

cleanup() {
  echo ""
  echo "Stopping dev servers..."
  # Negative PID targets the whole process group (npm -> nest/next -> compiler/node
  # children) since a plain `kill $PID` only stops the top-level npm process and
  # can leave its children running as orphans.
  kill -TERM -- "-$BACKEND_PID" "-$FRONTEND_PID" 2>/dev/null || true
  sleep 1
  kill -KILL -- "-$BACKEND_PID" "-$FRONTEND_PID" 2>/dev/null || true
  kill_port "$BACKEND_PORT"
  kill_port "$FRONTEND_PORT"
  exit 0
}
trap cleanup INT TERM

kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"

(cd "$ROOT_DIR/backend" && exec npm run start:dev) &
BACKEND_PID=$!

(cd "$ROOT_DIR/frontend" && exec npm run dev -- -p "$FRONTEND_PORT") &
FRONTEND_PID=$!

while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done
cleanup
