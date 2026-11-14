#!/usr/bin/env bash
# Live: a conversation whose turn lock failed to release must not wedge.
#
# Real proxy (bun bin/cli.ts, real Claude Max credentials, read-only) and the
# real Claude Code CLI against a real model. While turn 1 streams, the
# turn-locks directory is made read-only, so the lock's release (a rename out
# of that directory) fails, as it did with ENOSPC on a full disk. Write access
# is restored after turn 1, then turn 2 continues the same conversation.
#
# Pass: turn 2 answers within TURN2_LIMIT seconds and the abandoned lock is
# gone. Before the fix turn 2 queued behind the lock until the client gave up.
#
#   bash scripts/e2e-abandoned-turn-lock.sh       # from the repository root
#   E2E_MODEL=haiku CLAUDE_BIN=/path/to/claude bash scripts/e2e-abandoned-turn-lock.sh
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
MODEL=${E2E_MODEL:-sonnet}
CLAUDE=${CLAUDE_BIN:-$(command -v claude)}
PORT=${E2E_PORT:-3592}
TURN2_LIMIT=${TURN2_LIMIT:-30}
[ -n "$CLAUDE" ] || { echo "SKIP: the claude CLI is not on PATH"; exit 0; }
[ "$(id -u)" != 0 ] || { echo "SKIP: root ignores the read-only directory"; exit 0; }
W=$(mktemp -d "${TMPDIR:-/tmp}/meridian-turn-lock-XXXXXX")
mkdir -p "$W/project" "$W/sessions" "$W/mconfig" "$W/ccconfig" "$W/home"
LOCKS=$W/sessions/turn-locks
cleanup() { chmod 755 "$LOCKS" 2>/dev/null; kill "$P" 2>/dev/null; wait "$P" 2>/dev/null; }
trap cleanup EXIT

(cd "$REPO" && MERIDIAN_PORT=$PORT MERIDIAN_CONFIG_DIR=$W/mconfig MERIDIAN_SESSION_DIR=$W/sessions \
  MERIDIAN_TELEMETRY_DB=$W/telemetry.db MERIDIAN_UPDATE_CHECK=0 MERIDIAN_CREDENTIALS_READONLY=1 \
  exec bun bin/cli.ts) > "$W/proxy.log" 2>&1 &
P=$!
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/livez" >/dev/null && break; sleep 1; done

cd "$W/project"
client() {
  env -i PATH="$PATH" HOME="$W/home" CLAUDE_CONFIG_DIR="$W/ccconfig" ANTHROPIC_API_KEY=dummy \
    ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 "$@"
}

client timeout 300 "$CLAUDE" -p --model "$MODEL" \
  "Write a 900-word short story about a lighthouse keeper. End with the line TOKEN-ONE." > "$W/turn1.out" 2>&1 &
C1=$!
staged=no
for _ in $(seq 1 1200); do
  if ls "$LOCKS"/*.lock >/dev/null 2>&1; then chmod 555 "$LOCKS"; staged=yes; break; fi
  sleep 0.1
done
wait $C1; t1=$?
held=$(ls -d "$LOCKS"/*.lock 2>/dev/null | wc -l)
chmod 755 "$LOCKS"

start=$(date +%s)
client timeout 120 "$CLAUDE" -p --continue --model "$MODEL" "Reply with only: TOKEN-TWO" > "$W/turn2.out" 2>&1; t2=$?
took=$(( $(date +%s) - start ))
sleep 3
left=$(ls -d "$LOCKS"/*.lock 2>/dev/null | wc -l)

grep -E 'lineage=|release failed' "$W/proxy.log" | cut -c1-200
echo "staged=$staged turn1_exit=$t1 locks_after_turn1=$held turn2_exit=$t2 turn2_seconds=$took locks_after_turn2=$left"
fail=0
check() { if eval "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=1; fi; }
check "the release failure was staged during turn 1" '[ "$staged" = yes ] && [ "$held" -ge 1 ] && grep -q "release failed" "$W/proxy.log"'
check "turn 1 answered" '[ "$t1" = 0 ] && grep -q TOKEN-ONE "$W/turn1.out"'
check "turn 2 answered within ${TURN2_LIMIT}s" '[ "$t2" = 0 ] && [ "$took" -le "$TURN2_LIMIT" ] && grep -q TOKEN-TWO "$W/turn2.out"'
check "turn 2 continued the conversation" '[ "$(grep -c "lineage=continuation" "$W/proxy.log")" -ge 1 ]'
check "no turn lock is left behind" '[ "$left" = 0 ]'
[ $fail = 0 ] && echo "PASS" || echo "FAIL (workdir kept: $W)"
[ $fail = 0 ] && rm -rf "$W"
exit $fail
