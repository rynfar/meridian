# End-to-End Testing

Live tests against the real proxy + Claude Max SDK. These verify the full request cycle that unit tests (mocked SDK) cannot cover.

**Prerequisites:** Claude Max subscription, `claude auth status` shows `loggedIn: true`, `opencode` installed.

> **Droid tests (D1–D10)** additionally require `droid` installed (`droid --version` ≥ 0.89.0) and a Factory AI account for BYOK configuration.

## Quick Start

```bash
# 1. Build and start the proxy
npm run build
CLAUDE_PROXY_PORT=3456 bun run ./bin/cli.ts &

# 2. Wait for ready
curl -s http://127.0.0.1:3456/health | jq .status   # → "healthy"

# 3. Run tests (pick a section below)
# 4. Kill proxy when done
kill $(lsof -ti :3456)
```

## Test Index

| ID | Section | What It Proves | Verified |
|----|---------|----------------|----------|
| E1 | [Basic Request/Response](#e1-basic-requestresponse) | Proxy starts, routes to SDK, returns valid Anthropic response | 2026-03-24 |
| E2 | [Streaming SSE](#e2-streaming-sse) | SSE event format correct, events arrive in order | 2026-03-24 |
| E3 | [Tool Use Loop](#e3-tool-use-loop) | MCP tools (read/write/bash) execute through SDK | 2026-03-24 |
| E4 | [Session Continuation](#e4-session-continuation) | Same session header → `lineage=continuation`, SDK session reused | 2026-03-24 |
| E5 | [Undo with Rollback](#e5-undo-with-rollback) | Shorter/diverged suffix → `lineage=undo`, rollback UUID emitted | 2026-03-24 |
| E6 | [Compaction](#e6-compaction) | Summarized prefix + preserved suffix → `lineage=compaction` | 2026-03-24 |
| E7 | [Diverged Detection](#e7-diverged-detection) | Completely unrelated messages → `lineage=new`, fresh session | 2026-03-24 |
| E8 | [Cross-Proxy Resume](#e8-cross-proxy-resume) | Kill proxy → restart → session resumes from file store | 2026-03-24 |
| E9 | [Fingerprint Fallback](#e9-fingerprint-fallback) | No session header → fingerprint-based session lookup works | 2026-03-24 |
| E10 | [Coding Task (opencode)](#e10-coding-task-via-opencode) | Full round-trip: opencode → proxy → SDK → tool use → file modified | 2026-03-24 |
| E11 | [Telemetry](#e11-telemetry) | Dashboard HTML, `/requests`, `/summary`, `/logs` return data | 2026-03-24 |
| E12 | [Health Check](#e12-health-check) | `/health` returns auth status and mode | 2026-03-24 |
| E13 | [Concurrent Requests](#e13-concurrent-requests) | Parallel requests don't deadlock; active count increments | 2026-03-24 |
| E14 | [Model Routing](#e14-model-routing) | haiku/sonnet/opus model strings map correctly in proxy logs | 2026-03-24 |
| E15 | [Non-Streaming](#e15-non-streaming) | `stream:false` → JSON response with Content-Type, session header | 2026-03-24 |
| E16 | [Error Handling](#e16-error-handling) | Malformed JSON, missing fields, bad endpoints → structured errors | 2026-03-24 |
| E17 | [Passthrough Mode](#e17-passthrough-mode) | `CLAUDE_PROXY_PASSTHROUGH=1` → tool_use forwarded, not executed | 2026-03-24 |
| E18 | [Multimodal Content](#e18-multimodal-content) | Image blocks preserved, structured message path used | 2026-03-24 |
| E19 | [Subagent / Task Tool](#e19-subagent--task-tool) | Task tool agent definitions extracted, request processes correctly | 2026-03-24 |
| E20 | [Env Stripping](#e20-env-stripping) | ANTHROPIC_* vars don't leak to SDK subprocess | 2026-03-24 |
| E21 | [Session Store Pruning](#e21-session-store-pruning) | File store respects count cap, oldest entries evicted | 2026-03-24 |
| D1 | [Droid: Basic Response](#d1-droid-basic-response) | Proxy accepts Droid User-Agent, routes via droid adapter, returns valid response | 2026-03-29 |
| D2 | [Droid: MCP Server Name](#d2-droid-mcp-server-name) | Tools use `mcp__droid__` prefix, not `mcp__opencode__` | 2026-03-29 |
| D3 | [Droid: OpenCode Backward Compat](#d3-droid-opencode-backward-compat) | Requests without Droid UA still use opencode adapter | 2026-03-29 |
| D4 | [Droid: CWD from system-reminder](#d4-droid-cwd-from-system-reminder) | Working directory extracted from `<system-reminder>` block | 2026-03-29 |
| D5 | [Droid: Fingerprint Session Resume](#d5-droid-fingerprint-session-resume) | Session continues via fingerprint (no session header needed) | 2026-03-29 |
| D6 | [Droid: Real Binary Basic](#d6-droid-real-binary-basic) | Live `droid exec` → proxy → Claude Max returns correct response | 2026-03-29 |
| D7 | [Droid: Real Binary Tool Use](#d7-droid-real-binary-tool-use) | Live `droid exec` reads file via `mcp__droid__read` | 2026-03-29 |
| D8 | [Droid: exec Session Isolation](#d8-droid-exec-session-isolation) | Each `droid exec` call is a fresh session (expected — no history passed) | 2026-03-29 |
| D9 | [Droid: Streaming SSE](#d9-droid-streaming-sse) | SSE stream correct format with Droid User-Agent | 2026-03-29 |
| D10 | [Droid: OpenCode Session Unaffected](#d10-droid-opencode-session-unaffected) | OpenCode header-based session tracking still works alongside Droid | 2026-03-29 |

---

## Conventions

**Proxy log verification.** Most tests check proxy stderr for structured log lines:
```
[PROXY] <uuid> model=<m> stream=<bool> tools=<n> lineage=<type> session=<id|new> active=<n>/<max> msgCount=<n>
```

Extract these with:
```bash
cat /tmp/proxy-e2e.log | strings | grep "\[PROXY\]" | tail -5
```

**Session header.** All curl tests use `x-opencode-session` to control session identity. This is the header the OpenCode adapter reads.

**Cleanup.** Each test section is independent. Kill the proxy and clear the session store between sections if you need isolation:
```bash
kill $(lsof -ti :3456) 2>/dev/null
rm -f ~/.cache/opencode-claude-max-proxy/sessions.json
```

---

## E1: Basic Request/Response

**Verifies:** Proxy accepts Anthropic API format, routes to SDK, returns valid JSON response.

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-basic-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Respond with exactly: E2E_OK"}]
  }'
```

**Pass criteria:**
- Response has `"type": "message"`, `"role": "assistant"`
- Content includes a text block
- `stop_reason` is `"end_turn"`
- Proxy log shows `lineage=new session=new`

---

## E2: Streaming SSE

**Verifies:** SSE event stream has correct format, events arrive in proper order.

```bash
curl -sN http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-stream-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 50,
    "stream": true,
    "messages": [{"role": "user", "content": "Say hello in one word"}]
  }' | head -30
```

**Pass criteria:**
- First event is `event: message_start` with a `message` object
- At least one `event: content_block_start` with `type: "text"`
- At least one `event: content_block_delta` with `type: "text_delta"`
- Final events include `event: message_stop`
- No `mcp__opencode__*` tool blocks leak through

---

## E3: Tool Use Loop

**Verifies:** SDK MCP tools execute and produce correct results.

```bash
# Setup
echo "CANARY_12345" > /tmp/e2e-canary.txt

# Test via opencode (tools are registered by opencode, not by curl)
cd /tmp && opencode run --model anthropic/claude-sonnet-4-5 --format json \
  "What are the contents of /tmp/e2e-canary.txt?" 2>/dev/null

# Cleanup
rm /tmp/e2e-canary.txt
```

**Pass criteria:**
- Response text includes `CANARY_12345`
- Proxy log shows `tools=76` (or similar — opencode registers its full tool set)

### Variant: Write + Read

```bash
rm -f /tmp/e2e-write-test.txt
cd /tmp && opencode run --model anthropic/claude-sonnet-4-5 --format json \
  "Write 'WRITE_OK' to /tmp/e2e-write-test.txt then read it back and confirm." 2>/dev/null

# Verify on disk
cat /tmp/e2e-write-test.txt   # → WRITE_OK
rm /tmp/e2e-write-test.txt
```

---

## E4: Session Continuation

**Verifies:** Appending messages with the same session header resumes the SDK session.

```bash
# Turn 1: Create session
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-cont-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 100,
    "stream": false,
    "messages": [{"role": "user", "content": "Remember: DELTA_99"}]
  }' > /dev/null

# Turn 2: Continue (prefix preserved, new message appended)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-cont-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 100,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Remember: DELTA_99"},
      {"role": "assistant", "content": [{"type":"text","text":"Noted: DELTA_99."}]},
      {"role": "user", "content": "What was the code?"}
    ]
  }'
```

**Pass criteria:**
- Turn 2 proxy log: `lineage=continuation session=<8-char-id>` (not `new`)
- Response mentions `DELTA_99`

---

## E5: Undo with Rollback

**Verifies:** When the message suffix changes (user edited/undid), proxy detects undo and emits rollback UUID.

**Prerequisite:** Run E4 first (builds a 3+ message session with `e2e-cont-001`).

```bash
# Send same prefix but DIFFERENT last message (undo turn 2, ask something else)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-cont-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 100,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Remember: DELTA_99"},
      {"role": "assistant", "content": [{"type":"text","text":"Noted: DELTA_99."}]},
      {"role": "user", "content": "Actually, forget that. Tell me a joke."}
    ]
  }'
```

**Pass criteria:**
- Proxy log: `lineage=undo session=<same-id> rollback=<uuid>`
- `Undo detected` message in proxy stderr
- Response is valid (not an error)

---

## E6: Compaction

**Verifies:** When the agent summarizes early messages but preserves recent ones, proxy detects compaction and resumes.

```bash
# Step 1: Seed a 7-message conversation (≥6 required for compaction detection)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-compact-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 50,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Message one"},
      {"role": "assistant", "content": "Reply one"},
      {"role": "user", "content": "Message two"},
      {"role": "assistant", "content": "Reply two"},
      {"role": "user", "content": "Message three"},
      {"role": "assistant", "content": "Reply three"},
      {"role": "user", "content": "Message four"}
    ]
  }' > /dev/null

# Step 2: Simulate compaction — early messages replaced, recent suffix preserved
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-compact-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 50,
    "stream": false,
    "messages": [
      {"role": "user", "content": "[Summary of earlier conversation]"},
      {"role": "assistant", "content": "[Summary of replies]"},
      {"role": "user", "content": "Message three"},
      {"role": "assistant", "content": "Reply three"},
      {"role": "user", "content": "Message four"},
      {"role": "assistant", "content": "Reply four"},
      {"role": "user", "content": "Continuing after compaction"}
    ]
  }'
```

**Pass criteria:**
- Step 2 proxy log: `lineage=compaction session=<same-id>` (not `new`)
- `Compaction detected` message in proxy stderr
- Response is valid (session was resumed, not restarted)

**Key constants:** `MIN_SUFFIX_FOR_COMPACTION = 2`, `MIN_STORED_FOR_COMPACTION = 6` (in `session/lineage.ts`)

---

## E7: Diverged Detection

**Verifies:** Completely unrelated messages with the same session header start a fresh session.

**Prerequisite:** Run E6 first (session `e2e-compact-001` exists).

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-compact-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 50,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Completely unrelated topic about quantum physics"},
      {"role": "assistant", "content": "Quantum physics is fascinating"},
      {"role": "user", "content": "Tell me about entanglement"}
    ]
  }'
```

**Pass criteria:**
- Proxy log: `lineage=new session=new` (old session discarded)

---

## E8: Cross-Proxy Resume

**Verifies:** Sessions survive proxy restart via the shared file store (`~/.cache/opencode-claude-max-proxy/sessions.json`).

```bash
# Step 1: Create a session
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-persist-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Remember: PHOENIX_42"}]
  }' > /dev/null

# Verify stored in file
cat ~/.cache/opencode-claude-max-proxy/sessions.json | python3 -m json.tool | grep -A3 "e2e-persist"

# Step 2: Kill and restart proxy (in-memory caches wiped)
kill $(lsof -ti :3456); sleep 2
CLAUDE_PROXY_PORT=3456 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &
sleep 5  # Wait for startup

# Step 3: Resume the session
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-persist-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 100,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Remember: PHOENIX_42"},
      {"role": "assistant", "content": [{"type":"text","text":"Got it — PHOENIX_42."}]},
      {"role": "user", "content": "What was the code?"}
    ]
  }'
```

**Pass criteria:**
- Step 3 proxy log: `lineage=continuation session=<same-8-char-id>` (not `new`)
- Response mentions `PHOENIX_42`
- SDK session was genuinely resumed (not a fresh start with flat text replay)

---

## E9: Fingerprint Fallback

**Verifies:** When no `x-opencode-session` header is sent, sessions are matched by fingerprint (hash of first user message + working directory).

```bash
# Turn 1: No session header
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Unique fingerprint test message 98765"}]
  }' > /dev/null

# Turn 2: Same first message, no header — should match by fingerprint
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 50,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Unique fingerprint test message 98765"},
      {"role": "assistant", "content": "Acknowledged."},
      {"role": "user", "content": "Continue the conversation"}
    ]
  }'
```

**Pass criteria:**
- Turn 1 proxy log: `lineage=new`
- Turn 2 proxy log: `lineage=continuation` (fingerprint matched, not `new`)

---

## E10: Coding Task via opencode

**Verifies:** Full opencode → proxy → SDK → tool execution → file modification loop.

```bash
# Setup
mkdir -p /tmp/e2e-coding-test
cat > /tmp/e2e-coding-test/buggy.js << 'EOF'
function add(a, b) {
  return a - b  // BUG: should be +
}
module.exports = { add }
EOF

# Run
cd /tmp/e2e-coding-test && opencode run --model anthropic/claude-sonnet-4-5 \
  "There's a bug in buggy.js. Find and fix it." 2>/dev/null

# Verify
cat /tmp/e2e-coding-test/buggy.js   # Should show "a + b"

# Cleanup
rm -rf /tmp/e2e-coding-test
```

**Pass criteria:**
- `buggy.js` now contains `a + b` (not `a - b`)
- Proxy log shows tool execution (multiple `[PROXY]` lines for the session)

### Variant: Multi-turn via opencode

```bash
SESSION_OUT=$(opencode run --model anthropic/claude-sonnet-4-5 --format json \
  "Remember the code ALPHA_42. Just confirm." 2>/dev/null)
SESSION_ID=$(echo "$SESSION_OUT" | grep -o '"sessionID":"[^"]*"' | head -1 | cut -d'"' -f4)

opencode run --model anthropic/claude-sonnet-4-5 --session "$SESSION_ID" --format json \
  "What was the code?" 2>/dev/null
```

**Pass criteria:**
- Second response includes `ALPHA_42`

---

## E11: Telemetry

**Verifies:** Telemetry dashboard and API endpoints return data after requests.

```bash
# Dashboard HTML
curl -s http://127.0.0.1:3456/telemetry | head -3
# → <!DOCTYPE html> ...

# Recent requests
curl -s http://127.0.0.1:3456/telemetry/requests?limit=5 | python3 -m json.tool | head -20

# Aggregate summary
curl -s http://127.0.0.1:3456/telemetry/summary | python3 -m json.tool

# Diagnostic logs
curl -s http://127.0.0.1:3456/telemetry/logs?limit=5 | python3 -m json.tool | head -20
```

**Pass criteria:**
- `/telemetry` returns HTML with `<title>Claude Max Proxy`
- `/telemetry/requests` returns an array of request metrics with `requestId`, `model`, `lineageType`
- `/telemetry/summary` returns `totalRequests > 0`, `errorCount`, percentile latencies
- `/telemetry/logs` returns an array with `level`, `category`, `message` fields

---

## E12: Health Check

**Verifies:** `/health` endpoint returns auth and mode status.

```bash
curl -s http://127.0.0.1:3456/health | python3 -m json.tool
```

**Pass criteria:**
- `status: "healthy"`
- `auth.loggedIn: true`
- `auth.subscriptionType: "max"`
- `mode: "internal"` (or `"passthrough"` if `CLAUDE_PROXY_PASSTHROUGH` is set)

---

## E13: Concurrent Requests

**Verifies:** Multiple simultaneous requests are queued, not dropped or deadlocked.

```bash
# Fire 3 requests in parallel
for i in 1 2 3; do
  curl -s http://127.0.0.1:3456/v1/messages \
    -H "Content-Type: application/json" \
    -H "x-api-key: dummy" \
    -H "x-opencode-session: e2e-concurrent-$i" \
    -d "{
      \"model\": \"claude-sonnet-4-5-20250514\",
      \"max_tokens\": 30,
      \"stream\": false,
      \"messages\": [{\"role\": \"user\", \"content\": \"Say $i\"}]
    }" &
done
wait
```

**Pass criteria:**
- All 3 responses return valid JSON with `"type": "message"`
- Proxy log shows `active=` counts incrementing (e.g. `active=1/10`, `active=2/10`, `active=3/10`)
- No errors or deadlocks

---

## E14: Model Routing

**Verifies:** Different model strings map to the correct SDK model.

```bash
# Haiku
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{"model":"claude-haiku-4-5-20250929","max_tokens":10,"stream":false,"messages":[{"role":"user","content":"Hi"}]}' > /dev/null

# Opus
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{"model":"claude-opus-4-20250514","max_tokens":10,"stream":false,"messages":[{"role":"user","content":"Hi"}]}' > /dev/null

# Sonnet (default)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{"model":"claude-sonnet-4-5-20250514","max_tokens":10,"stream":false,"messages":[{"role":"user","content":"Hi"}]}' > /dev/null
```

**Pass criteria:**
- Proxy log shows `model=haiku` for the first request
- Proxy log shows `model=opus` (or `model=opus[1m]`) for the second
- Proxy log shows `model=sonnet[1m]` for the third

---

## E15: Non-Streaming

**Verifies:** `stream: false` returns a complete JSON response with correct headers.

```bash
curl -s -D /tmp/e2e-headers.txt http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-nonstream-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Say exactly: NONSTREAM_OK"}]
  }'
cat /tmp/e2e-headers.txt
rm /tmp/e2e-headers.txt
```

**Pass criteria:**
- Response body: `"type": "message"`, `"stop_reason": "end_turn"`
- Response header: `Content-Type: application/json`
- Response header: `x-claude-session-id: <uuid>` present
- Content includes text block

---

## E16: Error Handling

**Verifies:** Invalid requests return structured error responses, not crashes.

```bash
# Malformed JSON
curl -s -w "\n%{http_code}" http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: dummy" \
  -d 'not json'

# Missing messages
curl -s -w "\n%{http_code}" http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: dummy" \
  -d '{"model":"claude-sonnet-4-5-20250514","stream":false}'

# Unknown endpoint
curl -s -w "\n%{http_code}" http://127.0.0.1:3456/v1/nonexistent

# Wrong HTTP method
curl -s -w "\n%{http_code}" http://127.0.0.1:3456/v1/messages
```

**Pass criteria:**
- Malformed JSON → HTTP 500, `{"type":"error","error":{"type":"api_error",...}}`
- Missing messages → HTTP 500, structured error
- Unknown endpoint → HTTP 404, `{"error":{"type":"not_found",...}}`
- GET on POST endpoint → HTTP 404, `{"error":{"type":"not_found",...}}`
- Proxy does NOT crash on any of these

---

## E17: Passthrough Mode

**Verifies:** With `CLAUDE_PROXY_PASSTHROUGH=1`, the SDK returns tool_use blocks to the client instead of executing them internally.

**Requires proxy restart with env var:**
```bash
kill $(lsof -ti :3456) 2>/dev/null; sleep 1
CLAUDE_PROXY_PORT=3456 CLAUDE_PROXY_PASSTHROUGH=1 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &
# Wait for ready...
```

### Non-streaming

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-passthrough-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 200,
    "stream": false,
    "messages": [{"role": "user", "content": "Read the file /tmp/test.txt"}],
    "tools": [
      {
        "name": "Read",
        "description": "Read a file from disk",
        "input_schema": {
          "type": "object",
          "properties": {"file_path": {"type": "string"}},
          "required": ["file_path"]
        }
      }
    ]
  }'
```

**Pass criteria:**
- `"stop_reason": "tool_use"` — SDK didn't execute the tool
- Content includes a `tool_use` block with `"name": "Read"` and correct `input`
- Tool name is clean (no `mcp__passthrough__` prefix)
- `/health` shows `"mode": "passthrough"`

### Streaming

```bash
curl -sN http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-passthrough-stream-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 200,
    "stream": true,
    "messages": [{"role": "user", "content": "Read the file /tmp/test.txt"}],
    "tools": [{"name":"Read","description":"Read a file","input_schema":{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}}]
  }' | grep -E "tool_use|stop_reason"
```

**Pass criteria:**
- Stream contains `content_block_start` with `type: "tool_use"`, `name: "Read"`
- `message_delta` has `stop_reason: "tool_use"`

**After testing, restart proxy in normal mode:**
```bash
kill $(lsof -ti :3456) 2>/dev/null; sleep 1
CLAUDE_PROXY_PORT=3456 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &
```

---

## E18: Multimodal Content

**Verifies:** Image content blocks are preserved and passed through the structured message path.

```bash
# 1x1 red PNG pixel
IMG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="

curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-multimodal-001" \
  -d "{
    \"model\": \"claude-sonnet-4-5-20250514\",
    \"max_tokens\": 100,
    \"stream\": false,
    \"messages\": [{
      \"role\": \"user\",
      \"content\": [
        {\"type\": \"image\", \"source\": {\"type\": \"base64\", \"media_type\": \"image/png\", \"data\": \"$IMG_B64\"}},
        {\"type\": \"text\", \"text\": \"What color is this image? Reply with just the color name.\"}
      ]
    }]
  }"
```

**Pass criteria:**
- Response contains a text block with a color name
- Proxy log shows `msgs=user[image,text]` — image content type was detected
- No errors about unsupported content types

---

## E19: Subagent / Task Tool

**Verifies:** When the request includes a Task tool with agent descriptions, the proxy extracts agent definitions and processes the request through the agent routing path.

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-task-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 100,
    "stream": false,
    "messages": [{"role": "user", "content": "Just say hello"}],
    "tools": [
      {
        "name": "Task",
        "description": "Launch a sub-agent. Available agents:\n- coder: Writes code\n- reviewer: Reviews code\n- explorer: Explores codebase",
        "input_schema": {
          "type": "object",
          "properties": {
            "description": {"type": "string"},
            "subagent_type": {"type": "string"}
          },
          "required": ["description"]
        }
      },
      {
        "name": "Read",
        "description": "Read a file",
        "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}}}
      }
    ]
  }'
```

**Pass criteria:**
- Response is `"type": "message"` (no error)
- Proxy log shows `tools=2` — both tools were seen
- No crash from agent definition parsing

---

## E20: Env Stripping

**Verifies:** The proxy strips `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN` from the environment before spawning SDK subprocesses, preventing the SDK from looping back through the proxy.

```bash
ANTHROPIC_API_KEY=should-be-stripped ANTHROPIC_BASE_URL=http://should-be-stripped:9999 \
  curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-envstrip-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 20,
    "stream": false,
    "messages": [{"role": "user", "content": "Say OK"}]
  }'
```

**Pass criteria:**
- Response is a valid message with text content (request succeeded)
- If env vars leaked, the SDK would try to call `http://should-be-stripped:9999` and fail

**Note:** This test verifies the client-side env doesn't matter (the proxy runs in its own process). The actual env stripping happens inside `server.ts` before spawning the SDK. All prior tests implicitly prove this works (they'd fail if the SDK looped back), but this makes the verification explicit.

---

## E21: Session Store Pruning

**Verifies:** The file-based session store (`~/.cache/opencode-claude-max-proxy/sessions.json`) evicts the oldest entries when the count exceeds `CLAUDE_PROXY_MAX_STORED_SESSIONS`.

**Requires proxy restart with env var:**
```bash
kill $(lsof -ti :3456) 2>/dev/null; sleep 1
rm -f ~/.cache/opencode-claude-max-proxy/sessions.json
CLAUDE_PROXY_PORT=3456 CLAUDE_PROXY_MAX_STORED_SESSIONS=3 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &
# Wait for ready...
```

```bash
# Create 5 sessions
for i in 1 2 3 4 5; do
  curl -s http://127.0.0.1:3456/v1/messages \
    -H "Content-Type: application/json" \
    -H "x-api-key: dummy" \
    -H "x-opencode-session: e2e-prune-$i" \
    -d "{\"model\":\"claude-sonnet-4-5-20250514\",\"max_tokens\":10,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Session $i\"}]}" > /dev/null
  sleep 1  # ensure distinct timestamps for deterministic eviction
done

# Verify the store is bounded
cat ~/.cache/opencode-claude-max-proxy/sessions.json | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'Entries: {len(d)} (should be <= 3)')
"
```

**Pass criteria:**
- File store contains at most 3 entries
- Oldest sessions (lowest `lastUsedAt`) were evicted

**After testing, restart proxy in normal mode (no cap).**

---

## Adding New E2E Tests

When extending this document:

1. **Assign an ID** — sequential `E22`, `E23`, etc.
2. **Add to the index table** at the top with the date verified.
3. **Include the exact curl/opencode command** — tests must be copy-pasteable.
4. **Define pass criteria** — what to check in the response AND in the proxy log.
5. **Note prerequisites** — if the test depends on a prior test's session state, say so.
6. **Note env vars** — if the test requires a proxy restart with special env vars (E17, E21), say so explicitly.
7. **Keep tests independent where possible** — use unique session IDs (`e2e-<test>-<nnn>`).

### Session ID Convention

Use `e2e-<feature>-<nnn>` format: `e2e-cont-001`, `e2e-compact-001`, `e2e-persist-001`.

### Checking Proxy Logs

The proxy writes structured log lines to stderr. When running as a background process:
```bash
CLAUDE_PROXY_PORT=3456 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &

# Read logs (binary-safe — the log may contain emoji)
cat /tmp/proxy-e2e.log | strings | grep "\[PROXY\]"
cat /tmp/proxy-e2e.log | strings | grep -E "Compaction|Undo|diverged"
```

### Tests That Require Proxy Restart

Some tests need specific env vars. Group these at the end of a run to minimize restarts:

| Test | Env Var | Value |
|------|---------|-------|
| E17 | `CLAUDE_PROXY_PASSTHROUGH` | `1` |
| E21 | `CLAUDE_PROXY_MAX_STORED_SESSIONS` | `3` |

### Relationship to Unit/Integration Tests

```
Unit tests (bun test)          → Pure functions, no SDK, no network
Integration tests (bun test)   → HTTP layer with mocked SDK (fast, deterministic)
E2E tests (this document)      → Real proxy + real SDK + real Claude Max (slow, non-deterministic)
```

Unit and integration tests run in CI. E2E tests run manually before releases or after major refactors. They require an active Claude Max subscription.

### Coverage Map

Which proxy modules each E2E test exercises:

| Module | Tests |
|--------|-------|
| `server.ts` (orchestration) | All |
| `session/lineage.ts` | E4, E5, E6, E7, E8, E9 |
| `session/cache.ts` | E4, E5, E6, E7, E8, E9 |
| `session/fingerprint.ts` | E9 |
| `sessionStore.ts` | E8, E21 |
| `query.ts` | All (builds SDK options) |
| `adapter.ts` + `adapters/opencode.ts` | All E-tests, D3, D10 |
| `adapters/droid.ts` | D1, D2, D4, D5, D6, D7, D8, D9 |
| `adapters/detect.ts` | D1, D2, D3, D6, D7, D9, D10 |
| `errors.ts` | E16 |
| `models.ts` | E14 |
| `messages.ts` | E4, E5, E6 (content normalization for hashing) |
| `tools.ts` | E3, E17, E19 |
| `agentDefs.ts` | E19 |
| `agentMatch.ts` | E19 (fuzzy matching in PreToolUse hook) |
| `passthroughTools.ts` | E17 |
| `mcpTools.ts` | E3, E10 |
| `telemetry/` | E11 |

---

## Droid (Factory AI) Tests

These tests verify the Droid adapter added in the Droid support release. They require `droid` CLI installed and a Factory AI account.

### Droid BYOK Setup

Droid connects to the proxy via its BYOK (Bring Your Own Key) feature. Configure once before running D6–D8:

```bash
# 1. Back up Droid settings
cp ~/.factory/settings.json ~/.factory/settings.json.backup

# 2. Register all model tiers pointing at the proxy
# Model names drive mapModelToClaudeModel():
#   "4-6" in name → 1M context for Max users
#   "haiku" in name → haiku tier (no 1M)
#   "4-5" in name → base tier (no 1M)
python3 -c "
import json
with open('$HOME/.factory/settings.json') as f:
    s = json.load(f)
s['customModels'] = [
    {'model':'claude-sonnet-4-6',          'name':'Sonnet 4.6 (1M — Claude Max)', 'provider':'anthropic','baseUrl':'http://127.0.0.1:3457','apiKey':'sk-proxy'},
    {'model':'claude-opus-4-6',            'name':'Opus 4.6 (1M — Claude Max)',   'provider':'anthropic','baseUrl':'http://127.0.0.1:3457','apiKey':'sk-proxy'},
    {'model':'claude-haiku-4-5-20251001',  'name':'Haiku 4.5 (Claude Max)',       'provider':'anthropic','baseUrl':'http://127.0.0.1:3457','apiKey':'sk-proxy'},
    {'model':'claude-sonnet-4-5-20250929', 'name':'Sonnet 4.5 (Claude Max)',      'provider':'anthropic','baseUrl':'http://127.0.0.1:3457','apiKey':'sk-proxy'},
]
with open('$HOME/.factory/settings.json', 'w') as f:
    json.dump(s, f, indent=2)
"

# 3. Verify Droid sees the model
droid exec --model "custom:claude-sonnet-4-5-20250514" --list-tools 2>&1 | head -3
# → Available tools for claude-sonnet-4-5-20250514

# After all Droid tests, restore:
# cp ~/.factory/settings.json.backup ~/.factory/settings.json
```

### Droid Proxy Quick Start

Use port 3457 to avoid conflicts with any existing proxy service on 3456:

```bash
# Note: if you have an existing proxy service with CLAUDE_PROXY_PASSTHROUGH=1
# (e.g., a launchd service), use a different port
CLAUDE_PROXY_DEBUG=1 CLAUDE_PROXY_PORT=3457 bun run ./bin/cli.ts > /tmp/proxy-droid-e2e.log 2>&1 &
sleep 5
curl -s http://127.0.0.1:3457/health | python3 -m json.tool
# → {"status":"healthy","mode":"internal",...}

# Check logs
cat /tmp/proxy-droid-e2e.log | grep "\[PROXY\]"
```

---

## D1: Droid Basic Response

**Verifies:** Proxy detects `factory-cli/` User-Agent, selects droid adapter, returns valid Anthropic-format response.

```bash
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Respond with exactly: DROID_E2E_OK"}]
  }' | python3 -m json.tool
```

**Pass criteria:**
- `"type": "message"`, `"role": "assistant"`
- Content includes text block with `DROID_E2E_OK`
- `"stop_reason": "end_turn"`
- Proxy log: `lineage=new session=new` (no prior session)

---

## D2: Droid MCP Server Name

**Verifies:** When Droid requests a tool execution, the proxy uses `mcp__droid__*` tool names (not `mcp__opencode__*`). Confirmed by observing the tool name in the response content block.

```bash
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 200,
    "stream": false,
    "messages": [{"role": "user", "content": "List the current directory. Use the Bash tool."}],
    "tools": [
      {"name": "Bash", "description": "Run a shell command", "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}
    ]
  }' | python3 -c "
import json, sys
d = json.load(sys.stdin)
for block in d['content']:
    if block['type'] == 'tool_use':
        print('Tool name in response:', block['name'])
"
```

**Pass criteria:**
- Tool block name is `mcp__droid__bash` (internal SDK MCP name — confirms droid adapter selected)
- NOT `mcp__opencode__bash`

**What's happening:** The Droid adapter sets `getMcpServerName() = "droid"`, so the SDK registers MCP tools as `mcp__droid__*`. The proxy strips these prefixes before returning to Droid, but the pre-strip name confirms adapter selection.

---

## D3: Droid OpenCode Backward Compat

**Verifies:** Requests without Droid User-Agent still use the OpenCode adapter. All existing OpenCode behavior preserved.

```bash
# No User-Agent → OpenCode adapter
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: d3-compat-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 30,
    "stream": false,
    "messages": [{"role": "user", "content": "Say: OC_COMPAT_OK"}]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][0]['text'])"

# With opencode User-Agent → still OpenCode adapter
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: opencode/1.0" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 30,
    "stream": false,
    "messages": [{"role": "user", "content": "Say: OC_UA_OK"}]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][0]['text'])"
```

**Pass criteria:**
- Both responses return valid messages
- No errors
- Proxy log: `lineage=new session=new` for both (both are first requests with those sessions)

---

## D4: Droid CWD from system-reminder

**Verifies:** Proxy extracts the working directory from Droid's `<system-reminder>` block in the first user message content, not from a `system` field (which OpenCode uses).

```bash
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 30,
    "stream": false,
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "<system-reminder>\nUser system info\n% pwd\n/Users/dev/my-project\n% ls\nsrc\n</system-reminder>"},
        {"type": "text", "text": "Say: CWD_EXTRACTED_OK"}
      ]
    }]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][-1]['text'])"
```

**Pass criteria:**
- Response contains `CWD_EXTRACTED_OK`
- Proxy log: `msgs=user[text,text]` — multiple content blocks received

**What's happening internally:** `droidAdapter.extractWorkingDirectory()` matches `% pwd\n<path>` inside `<system-reminder>` and returns `/Users/dev/my-project` as the `cwd` passed to the SDK. Different first messages will fingerprint to different sessions.

---

## D5: Droid Fingerprint Session Resume

**Verifies:** Without a session header, Droid sessions are resumed via fingerprint (hash of first user message + CWD). Same first message = same fingerprint = resumed session.

```bash
# Turn 1: Establish session
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 50,
    "stream": false,
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "<system-reminder>\n% pwd\n/Users/dev/my-project\n</system-reminder>"},
        {"type": "text", "text": "Remember the code: DROID_FINGERPRINT_88"}
      ]
    }]
  }' > /dev/null

# Turn 2: Same first message → fingerprint resume
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 80,
    "stream": false,
    "messages": [
      {"role": "user", "content": [
        {"type": "text", "text": "<system-reminder>\n% pwd\n/Users/dev/my-project\n</system-reminder>"},
        {"type": "text", "text": "Remember the code: DROID_FINGERPRINT_88"}
      ]},
      {"role": "assistant", "content": [{"type": "text", "text": "Got it — DROID_FINGERPRINT_88."}]},
      {"role": "user", "content": [{"type": "text", "text": "What was the code?"}]}
    ]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][-1]['text'][:80])"
```

**Pass criteria:**
- Turn 2 proxy log: `lineage=continuation session=<8-char-id>` — fingerprint matched, session resumed
- Response includes `DROID_FINGERPRINT_88`

---

## D6: Droid Real Binary Basic

**Prerequisites:** Droid BYOK configured (see [Droid BYOK Setup](#droid-byok-setup)). Proxy running on port 3457.

**Verifies:** Live `droid exec` binary successfully routes through the proxy and receives a valid Claude Max response.

```bash
droid exec \
  --model "custom:claude-sonnet-4-5-20250514" \
  --skip-permissions-unsafe \
  --cwd /tmp \
  "Reply with exactly: REAL_DROID_OK. Nothing else."
```

**Pass criteria:**
- Output: `REAL_DROID_OK` (printed to stdout by droid)
- Proxy log: `model=sonnet stream=true tools=<n> lineage=new session=new` — request received and processed
- No `"isByok": false` errors — authentication via BYOK succeeded
- No 402 Payment Required errors

---

## D7: Droid Real Binary Tool Use

**Prerequisites:** Droid BYOK configured, proxy on port 3457.

**Verifies:** Live `droid exec` can read a file using the `mcp__droid__read` MCP tool registered by the droid adapter.

```bash
# Setup canary file
echo "DROID_CANARY_E2E_42" > /tmp/droid-canary.txt

# Droid reads it via proxy
droid exec \
  --model "custom:claude-sonnet-4-5-20250514" \
  --auto medium \
  --cwd /tmp \
  "Read the file /tmp/droid-canary.txt and tell me what it contains. Just the content, nothing else."

# Verify
rm /tmp/droid-canary.txt
```

**Pass criteria:**
- Output: `DROID_CANARY_E2E_42` (droid read the file successfully)
- Proxy log shows `tools=<n>` for the request — Droid sent its tool definitions
- Multi-turn exchange visible in proxy logs (tool call + result + final response)

---

## D8: Droid exec Session Isolation

**Verifies:** Each `droid exec` invocation is a fresh independent session. This is expected behavior — `droid exec` does not pass previous conversation history (unlike interactive TUI mode). Session continuity in interactive mode works via fingerprint resume (D5).

```bash
# Turn 1 — set a secret
droid exec \
  --model "custom:claude-sonnet-4-5-20250514" \
  --skip-permissions-unsafe \
  --cwd /tmp \
  "Remember the code: DROID_SECRET_99. Just say 'noted'."

# Turn 2 — separate exec, no shared history
droid exec \
  --model "custom:claude-sonnet-4-5-20250514" \
  --skip-permissions-unsafe \
  --cwd /tmp \
  "What was the secret code?"
```

**Pass criteria:**
- Turn 1 output: `noted` (or similar)
- Turn 2 output: model says it has no record of any secret code — **this is correct behavior**
- Proxy log: both show `lineage=new session=new` — each exec is a fresh session
- No errors or crashes

**Why this is correct:** `droid exec` is a one-shot command that sends only the current prompt as the message. It does not replay prior conversation history. For multi-turn continuity in interactive mode, fingerprint-based resume (D5) kicks in because Droid sends the full message history including the same first-message content.

---

## D9: Droid Streaming SSE

**Verifies:** When Droid requests streaming, the proxy returns correct SSE format with proper event ordering.

```bash
curl -sN http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 50,
    "stream": true,
    "messages": [{"role": "user", "content": "Say: STREAM_DROID_OK"}]
  }' | head -25
```

**Pass criteria:**
- First event: `event: message_start` with a valid `message` object
- At least one `event: content_block_delta` with `type: "text_delta"` containing the response text
- Final event: `event: message_stop`
- No `mcp__droid__*` tool blocks leak to the client
- Proxy log: `stream=true`

---

## D10: Droid OpenCode Session Unaffected

**Verifies:** Adding Droid support does not break OpenCode session tracking. The `x-opencode-session` header is still used by the OpenCode adapter for session continuity.

```bash
# OpenCode Turn 1
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: d10-oc-backcompat-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Remember: OPENCODE_BACKCOMPAT_55"}]
  }' > /dev/null

# OpenCode Turn 2 — same session header → continuation
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: d10-oc-backcompat-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 80,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Remember: OPENCODE_BACKCOMPAT_55"},
      {"role": "assistant", "content": [{"type": "text", "text": "Got it."}]},
      {"role": "user", "content": "What was the code?"}
    ]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][-1]['text'][:80])"
```

**Pass criteria:**
- Response includes `OPENCODE_BACKCOMPAT_55`
- Proxy log Turn 2: `lineage=continuation session=<id>` — OpenCode header session resumed correctly
- Droid requests in D1–D9 did not corrupt the OpenCode session cache

---

## Droid Cleanup

```bash
# Restore Droid settings (if BYOK was configured)
cp ~/.factory/settings.json.backup ~/.factory/settings.json 2>/dev/null

# Kill the test proxy
kill $(lsof -ti :3457) 2>/dev/null
```
