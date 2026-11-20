#!/usr/bin/env bash
# Live: a conversation whose turn lock a host crash tore must not wedge.
#
# Real proxy (bun bin/cli.ts, real Claude Max credentials, read-only) and the
# real Claude Code CLI against a real model. Turn 1 runs and its turn lock's
# name is recorded. Then the crash is staged: the proxy stops, and the lock is
# left as a host crash left it on 2026-09-29, an owner.json of 338 NUL bytes,
# with every mtime an hour before the current boot. The proxy starts again and
# turn 2 continues the same conversation.
#
# Pass: turn 2 answers within TURN2_LIMIT seconds, the proxy logs the reclaim
# and no lock is left. Before the fix every later turn waited out the acquire
# timeout and failed, until the directory was deleted by hand.
#
#   bash scripts/e2e-torn-turn-lock.sh       # from the repository root
#   E2E_MODEL=haiku CLAUDE_BIN=/path/to/claude bash scripts/e2e-torn-turn-lock.sh
#   E2E_REPO=/path/to/other/checkout bash scripts/e2e-torn-turn-lock.sh   # baseline
set -u
REPO=${E2E_REPO:-$(cd "$(dirname "$0")/.." && pwd)}
MODEL=${E2E_MODEL:-sonnet}
CLAUDE=${CLAUDE_BIN:-$(command -v claude)}
PORT=${E2E_PORT:-3593}
TURN2_LIMIT=${TURN2_LIMIT:-60}
[ -n "$CLAUDE" ] || { echo "SKIP: the claude CLI is not on PATH"; exit 0; }
[ -r /proc/uptime ] || { echo "SKIP: needs /proc/uptime to date the lock before this boot"; exit 0; }
W=$(mktemp -d "${TMPDIR:-/tmp}/meridian-torn-lock-XXXXXX")
mkdir -p "$W/project" "$W/sessions" "$W/mconfig" "$W/ccconfig" "$W/home"
LOCKS=$W/sessions/turn-locks
P=
stop_proxy() { [ -n "$P" ] && { kill "$P" 2>/dev/null; wait "$P" 2>/dev/null; P=; }; }
trap stop_proxy EXIT
start_proxy() {
  (cd "$REPO" && MERIDIAN_PORT=$PORT MERIDIAN_CONFIG_DIR=$W/mconfig MERIDIAN_SESSION_DIR=$W/sessions \
    MERIDIAN_TELEMETRY_DB=$W/telemetry.db MERIDIAN_UPDATE_CHECK=0 MERIDIAN_CREDENTIALS_READONLY=1 \
    exec bun bin/cli.ts) >> "$W/proxy.log" 2>&1 &
  P=$!
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/livez" >/dev/null && return; sleep 1; done
}

cd "$W/project"
client() {
  env -i PATH="$PATH" HOME="$W/home" CLAUDE_CONFIG_DIR="$W/ccconfig" ANTHROPIC_API_KEY=dummy \
    ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 "$@"
}

start_proxy
client timeout 300 "$CLAUDE" -p --model "$MODEL" \
  "Write a 300-word short story about a lighthouse keeper. End with the line TOKEN-ONE." > "$W/turn1.out" 2>&1 &
C1=$!
lock=
for _ in $(seq 1 1200); do
  lock=$(cd "$LOCKS" 2>/dev/null && ls -d *.lock 2>/dev/null | head -1)
  [ -n "$lock" ] && break
  sleep 0.1
done
wait $C1; t1=$?
stop_proxy

# The crash: what an unflushed lock looked like after the 2026-09-29 reboot.
booted=$(( $(date +%s) - $(cut -d. -f1 /proc/uptime) ))
if [ -n "$lock" ]; then
  mkdir -p "$LOCKS/$lock"
  head -c 338 /dev/zero > "$LOCKS/$lock/owner.json"
  : > "$LOCKS/$lock/heartbeat-unknown-token"
  touch -d "@$(( booted - 3600 ))" "$LOCKS/$lock/owner.json" "$LOCKS/$lock/heartbeat-unknown-token" "$LOCKS/$lock"
fi

start_proxy
start=$(date +%s)
client timeout 120 "$CLAUDE" -p --continue --model "$MODEL" "Reply with only: TOKEN-TWO" > "$W/turn2.out" 2>&1; t2=$?
took=$(( $(date +%s) - start ))
sleep 3
left=$(cd "$LOCKS" && ls -d *.lock 2>/dev/null | wc -l)

grep -E 'lineage=|reclaimed turn lock|Timed out acquiring' "$W/proxy.log" | cut -c1-200
echo "lock=${lock:-none} turn1_exit=$t1 turn2_exit=$t2 turn2_seconds=$took locks_after_turn2=$left"
fail=0
check() { if eval "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=1; fi; }
check "turn 1 answered and took a turn lock" '[ "$t1" = 0 ] && grep -q TOKEN-ONE "$W/turn1.out" && [ -n "$lock" ]'
check "the torn lock was reclaimed" 'grep -q "reclaimed turn lock $lock with no readable owner" "$W/proxy.log"'
check "turn 2 answered within ${TURN2_LIMIT}s" '[ "$t2" = 0 ] && [ "$took" -le "$TURN2_LIMIT" ] && grep -q TOKEN-TWO "$W/turn2.out"'
check "turn 2 continued the conversation" '[ "$(grep -c "lineage=continuation" "$W/proxy.log")" -ge 1 ]'
check "no turn lock is left behind" '[ "$left" = 0 ]'
[ $fail = 0 ] && echo "PASS" || echo "FAIL (workdir kept: $W)"
[ $fail = 0 ] && rm -rf "$W"
exit $fail
