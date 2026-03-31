#!/bin/sh
# Auto-restart supervisor for Meridian
#
# The Claude Agent SDK's cli.js subprocess can crash during cleanup of
# concurrent streaming responses. All responses are delivered correctly;
# the crash only occurs after response completion.
#
# This supervisor runs the proxy in a subshell with signal isolation,
# detects crashes, and restarts in ~1 second.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# Auto-detect: compiled dist (Docker/npm) or TypeScript source (local dev)
if [ -f dist/cli.js ]; then
  PROXY_CMD="node dist/cli.js"
else
  # bun preferred (native TS execution), tsx fallback (no build step)
  if command -v bun >/dev/null 2>&1; then
    PROXY_CMD="bun run ./bin/cli.ts"
  elif command -v tsx >/dev/null 2>&1; then
    PROXY_CMD="tsx ./bin/cli.ts"
  else
    PROXY_CMD="npx tsx ./bin/cli.ts"
  fi
fi

SHUTTING_DOWN=0
trap 'SHUTTING_DOWN=1' TERM INT
trap '' PIPE

RESTART_COUNT=0
MAX_RAPID_RESTARTS=50
RAPID_WINDOW=60
LAST_START=0

while true; do
  NOW=$(date +%s)

  if [ $((NOW - LAST_START)) -gt $RAPID_WINDOW ]; then
    RESTART_COUNT=0
  fi

  if [ $RESTART_COUNT -ge $MAX_RAPID_RESTARTS ]; then
    echo "[supervisor] Too many restarts ($RESTART_COUNT in ${RAPID_WINDOW}s). Stopping."
    exit 1
  fi

  LAST_START=$NOW
  RESTART_COUNT=$((RESTART_COUNT + 1))

  if [ $RESTART_COUNT -gt 1 ]; then
    echo "[supervisor] Restarting proxy (restart #$RESTART_COUNT)..."
  else
    echo "[supervisor] Starting proxy..."
  fi

  # Run in subshell so crashes don't kill the supervisor
  (exec $PROXY_CMD)
  EXIT_CODE=$?

  if [ $SHUTTING_DOWN -eq 1 ] || [ $EXIT_CODE -eq 0 ]; then
    echo "[supervisor] Proxy exited cleanly."
    break
  fi

  # Signal-based exits (128+signal)
  if [ $EXIT_CODE -gt 128 ]; then
    SIG=$((EXIT_CODE - 128))
    echo "[supervisor] Proxy killed by signal $SIG. Restarting in 1s..."
  else
    echo "[supervisor] Proxy exited (code $EXIT_CODE). Restarting in 1s..."
  fi

  sleep 1
done
