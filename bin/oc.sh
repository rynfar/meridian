#!/bin/bash
# Per-terminal proxy launcher for OpenCode.
#
# Starts a dedicated proxy on a random port, launches OpenCode pointed at it,
# and cleans up when OpenCode exits. Each terminal gets its own proxy — no
# concurrent request issues, no shared port conflicts.
#
# Session resume works across terminals via the shared session file store.
#
# Usage: ./bin/oc.sh [opencode args...]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_SCRIPT="$SCRIPT_DIR/cli.ts"

if [ ! -f "$PROXY_SCRIPT" ]; then
  echo "❌ Proxy script not found: $PROXY_SCRIPT" >&2
  exit 1
fi

# Pick a random free port
PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()' 2>/dev/null \
  || ruby -e 'require "socket"; s = TCPServer.new("127.0.0.1", 0); puts s.addr[1]; s.close' 2>/dev/null \
  || echo $((RANDOM + 10000)))

# Start proxy in background
CLAUDE_PROXY_PORT=$PORT \
CLAUDE_PROXY_WORKDIR="$PWD" \
CLAUDE_PROXY_PASSTHROUGH="${CLAUDE_PROXY_PASSTHROUGH:-1}" \
  bun run "$PROXY_SCRIPT" > /dev/null 2>&1 &
PROXY_PID=$!

# Ensure proxy is cleaned up on exit
cleanup() {
  kill $PROXY_PID 2>/dev/null
  wait $PROXY_PID 2>/dev/null
}
trap cleanup EXIT INT TERM

# Wait for proxy to be ready (up to 10 seconds)
for i in $(seq 1 100); do
  if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    break
  fi
  if ! kill -0 $PROXY_PID 2>/dev/null; then
    echo "❌ Proxy failed to start" >&2
    exit 1
  fi
  sleep 0.1
done

# Verify proxy is healthy
if ! curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
  echo "❌ Proxy didn't become healthy within 10 seconds" >&2
  exit 1
fi

# Launch OpenCode
ANTHROPIC_API_KEY=dummy \
ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
  opencode "$@"
