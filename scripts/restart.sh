#!/usr/bin/env bash
# Restart the bridge. Matches on the listening port rather than a process-name
# pattern: a pgrep pattern also matches the shell running this script.
set -uo pipefail
PORT="${HERDR_TERM_PORT:-8790}"
LOG="${1:-/tmp/herdr-term.log}"
cd "$(dirname "$0")/.."

pid=$(ss -lptnH "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "${pid:-}" ]; then
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
fi

setsid node server/index.mjs >"$LOG" 2>&1 &
for _ in $(seq 1 20); do
  curl -sf --max-time 1 "http://127.0.0.1:$PORT/healthz" >/dev/null && { echo "bridge up on $PORT"; exit 0; }
  sleep 0.25
done
echo "bridge failed to start; log:"; tail -20 "$LOG"; exit 1
