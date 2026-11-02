#!/usr/bin/env bash
# Live E2E: priority routing skips a profile holding its weekly reserve.
#
# Real OpenCode V2 client with the Meridian V2 plugin installed by this build's
# `setup --v2`, in disposable client HOME/XDG dirs. Meridian runs from this
# build's dist/ on a separate port with the operator's real profiles and server
# plugins. Two arms on the same pool order (PREFERRED first, FALLBACK second):
#   held:    MERIDIAN_WEEKLY_RESERVE=PREFERRED=<RESERVE>  -> expect FALLBACK
#   control: no reserve                                   -> expect PREFERRED
# Each arm makes one usage read (GET /v1/usage/quota/all) to seed the cache and
# one tiny model call. Requires real credentials, so it is not run in CI.
#
# Usage: scripts/e2e-weekly-reserve-opencode.sh <preferred> <fallback> <reserve%> <outdir>
# Env:   OPENCODE_BIN (default ~/.opencode/bin/opencode), E2E_MODEL, E2E_PORT,
#        E2E_ARMS (default "held control")
set -euo pipefail

PREFERRED=${1:?preferred profile}
FALLBACK=${2:?fallback profile}
RESERVE=${3:?reserve percent}
OUT=${4:?output dir}
REPO=$(cd "$(dirname "$0")/.." && pwd)
OPENCODE_BIN=${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}
MODEL=${E2E_MODEL:-anthropic/claude-haiku-5-5}
PORT=${E2E_PORT:-3477}
REAL_HOME=$HOME

mkdir -p "$OUT"
CLIENT="$OUT/client"
rm -rf "$CLIENT"
mkdir -p "$CLIENT/home" "$CLIENT/project"

client_env() {
  env HOME="$CLIENT/home" XDG_CONFIG_HOME="$CLIENT/home/.config" XDG_DATA_HOME="$CLIENT/home/.local/share" \
    XDG_STATE_HOME="$CLIENT/home/.local/state" XDG_CACHE_HOME="$CLIENT/home/.cache" \
    OPENCODE_DISABLE_AUTOUPDATE=1 "$@"
}

echo "== versions" | tee "$OUT/summary.txt"
{ echo "opencode: $("$OPENCODE_BIN" --version)"; echo "meridian: $(git -C "$REPO" rev-parse HEAD)"; echo "node: $(node --version)"; } | tee -a "$OUT/summary.txt"

echo "== setup --v2 (isolated client)" | tee -a "$OUT/summary.txt"
client_env node "$REPO/dist/cli.js" setup --v2 --opencode-bin "$OPENCODE_BIN" > "$OUT/setup.log" 2>&1
CONFIG="$CLIENT/home/.config/opencode/opencode.json"
python3 - "$CONFIG" "$PORT" "$MODEL" <<'PY'
import json, sys
path, port, model = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(path))
provider_model = model.split("/", 1)[1]
cfg["model"] = model
cfg.setdefault("providers", {})["anthropic"] = {
    "settings": {"apiKey": "x", "baseURL": f"http://127.0.0.1:{port}/v1"},
    "models": {provider_model: {"name": provider_model}},
}
json.dump(cfg, open(path, "w"), indent=2)
plugins = [p for p in cfg.get("plugins", cfg.get("plugin", [])) if "meridian" in json.dumps(p)]
if len(plugins) != 1:
    sys.exit(f"expected exactly one Meridian plugin entry, found {plugins}")
print("plugin entry:", json.dumps(plugins[0]))
print("baseURL:", cfg["providers"]["anthropic"]["settings"]["baseURL"])
PY
python3 - "$CONFIG" "$PORT" "$MODEL" >> "$OUT/summary.txt" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
print("plugin entries:", [p for p in cfg.get("plugins", cfg.get("plugin", [])) if "meridian" in json.dumps(p)])
print("baseURL:", cfg["providers"]["anthropic"]["settings"]["baseURL"])
PY

run_arm() {
  local arm=$1 reserve_env=$2 expect=$3
  local log="$OUT/meridian-$arm.log"
  echo "== arm $arm (MERIDIAN_WEEKLY_RESERVE=${reserve_env:-<unset>}, expect $expect)" | tee -a "$OUT/summary.txt"
  env HOME="$REAL_HOME" MERIDIAN_PORT="$PORT" MERIDIAN_ROUTING=priority OPENCODE_CLAUDE_PROVIDER_DEBUG=1 \
    MERIDIAN_PROFILE_ORDER="$PREFERRED,$FALLBACK" MERIDIAN_WEEKLY_RESERVE="$reserve_env" \
    node "$REPO/dist/cli.js" > "$log" 2>&1 &
  local pid=$!
  trap "kill $pid 2>/dev/null || true" RETURN
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/health" > /dev/null && break; sleep 1; done
  # A cold instance has no usage yet and the endpoint rate-limits per token,
  # so retry the read (bounded) until the preferred profile reports a weekly window.
  local attempt usage=""
  for attempt in 1 2 3 4 5 6; do
    usage=$(curl -sf -m 60 "http://127.0.0.1:$PORT/v1/usage/quota/all" | python3 -c "
import json, sys
body = json.load(sys.stdin)
for entry in body.get('profiles', []):
    pid = entry.get('profileId') or entry.get('id') or entry.get('profile')
    if pid not in ('$PREFERRED', '$FALLBACK'): continue
    weekly = [w for w in entry.get('windows') or [] if w.get('type') == 'seven_day']
    print(f'usage {pid}: seven_day', weekly[0] if weekly else 'unreported', 'error', entry.get('error'))
" || true)
    if grep -q "usage $PREFERRED: seven_day {" <<<"$usage"; then break; fi
    [[ $attempt -lt 6 ]] && sleep 90
  done
  echo "$usage (usage read attempts: $attempt)" | tee -a "$OUT/summary.txt"
  if [[ "$arm" == held ]] && ! grep -q "usage $PREFERRED: seven_day {" <<<"$usage"; then
    echo "RESULT $arm: INCONCLUSIVE (no weekly reading for $PREFERRED; nothing to hold on)" | tee -a "$OUT/summary.txt"
    kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
    return 0
  fi
  (cd "$CLIENT/project" && client_env "$OPENCODE_BIN" run --standalone -m "$MODEL" "Reply with the single word: ok") \
    > "$OUT/opencode-$arm.log" 2>&1 &
  local client=$!
  ( sleep "${E2E_CLIENT_TIMEOUT:-300}"; kill "$client" 2>/dev/null ) &
  local watchdog=$!
  wait "$client" || echo "opencode exited $? (killed after ${E2E_CLIENT_TIMEOUT:-300}s if 143)" | tee -a "$OUT/summary.txt"
  kill "$watchdog" 2>/dev/null || true
  sleep 1
  local line
  line=$(grep -E "^\[PROXY\] .*adapter=opencode.* profile=.* agent=primary" "$log" | tail -1 || true)
  echo "request: ${line:-<none>}" | tee -a "$OUT/summary.txt"
  grep -E "weekly_reserve|plugin is missing|plugin not" "$log" | sed 's/^/log: /' | tee -a "$OUT/summary.txt" || true
  echo "client reply: $(grep -v '^\s*$' "$OUT/opencode-$arm.log" | tail -1)" | tee -a "$OUT/summary.txt"
  # " agent=" only appears when the client plugin sent its agent-mode header.
  if [[ "$line" == *" profile=$expect"* && "$line" == *" agent="* ]]; then echo "RESULT $arm: PASS" | tee -a "$OUT/summary.txt"
  else echo "RESULT $arm: FAIL" | tee -a "$OUT/summary.txt"; fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

ARMS=${E2E_ARMS:-held control}
[[ " $ARMS " == *" held "* ]] && run_arm held "$PREFERRED=$RESERVE" "$FALLBACK"
[[ " $ARMS " == *" control "* ]] && run_arm control "" "$PREFERRED"
exit 0
