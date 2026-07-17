# Design: OpenAI Responses API endpoint (`/v1/responses`) for Codex

**Issue:** #475 · **Date:** 2026-07-08 · **Status:** approved, pre-implementation

## Goal

Add `POST /v1/responses` so the Codex CLI/app (≥ 0.96, verified against 0.143.0)
can run on Claude via a Claude Max subscription through Meridian. Codex speaks
only OpenAI's Responses API; Meridian has `/v1/messages` and
`/v1/chat/completions` but not `/v1/responses`, so Codex currently gets a 404.

## Non-goals

- Full fidelity with every OpenAI Responses feature. We target the subset Codex
  actually sends (verified by capturing real 0.143 traffic).
- Image/audio input, background mode, `previous_response_id` server-side state
  (Codex runs `store: false` / stateless).
- Perfect reasoning continuity in phase 1 (see Phasing).

## Verified wire format (captured from Codex 0.143)

Request Codex sends to `/v1/responses`:

```
model: "gpt-5.5"
instructions: <~21KB system prompt string>
input: [ {type:"message", role:"developer"|"user"|"assistant", content:[{type:"input_text"|"output_text", text}]},
         {type:"function_call", name, arguments, call_id},              # on tool turns
         {type:"function_call_output", call_id, output},                # on tool turns
         {type:"reasoning", ...} ]                                      # when reasoning enabled
tools: [ {type:"function", name, description, strict, parameters:<JSON schema>} ]
tool_choice: "auto"        parallel_tool_calls: true
reasoning: { effort: "low"|... }        text: { verbosity }
stream: true               store: false        include: ["reasoning.encrypted_content"]
prompt_cache_key, client_metadata          # ignorable passthrough
Headers: authorization: Bearer <env_key>, accept: text/event-stream, x-codex-* metadata
```

Response SSE event shapes Codex accepts (confirmed — a stand-in server emitting
these drove a clean turn in real Codex 0.143):

```
response.created            → { response: {id, object:"response", model, status:"in_progress", output:[]} }
response.in_progress
response.output_item.added  → { output_index, item: {type:"message"|"function_call"|"reasoning", id, ...} }
response.content_part.added → { item_id, output_index, content_index, part:{type:"output_text", text:""} }
response.output_text.delta  → { item_id, output_index, content_index, delta }
response.output_text.done   → { item_id, output_index, content_index, text }
response.content_part.done
response.output_item.done   → { output_index, item }
response.completed          → { response: {..., status:"completed", output:[...], usage:{input_tokens,output_tokens,total_tokens}} }
# tool calls: output_item.added(function_call) + response.function_call_arguments.delta/.done + output_item.done
```

Codex is a **tool-driving agentic client**: it sends `tools`, expects tool calls
back, executes them locally, and returns `function_call_output`. So this endpoint
must run in **passthrough** mode (tool_use flows back to the client) — the same
mode the client-driven tool-loop fix (PR #571) hardened.

## Architecture

Mirror the existing `/v1/chat/completions` adapter (`src/proxy/openai.ts` +
route in `server.ts`), which forwards **in-process** to `/v1/messages` via
`app.fetch()` and reuses auth, model mapping, session handling, and the
passthrough tool loop.

- **`src/proxy/openaiResponses.ts`** — pure translation module (no HTTP/Hono),
  unit-testable in isolation:
  - `translateResponsesToAnthropic(body): AnthropicRequestBody | null`
  - `translateAnthropicToResponses(anthropicRes, ctx): ResponsesObject` (non-stream)
  - `createResponsesSseTranslator(ctx)` — stateful Anthropic-SSE → Responses-SSE
  - shared types + a `buildResponsesModelList` if needed for any `/models` parity
- **Route `app.post("/v1/responses")`** in `server.ts` (thin; orchestration only):
  1. parse body → `translateResponsesToAnthropic` → 400 if invalid.
  2. build internal `Request("http://internal/v1/messages")` with forwarded auth
     headers and an agent tag that **forces passthrough** (see below).
  3. non-stream: translate the Anthropic JSON → single `response` object.
  4. stream: pipe Anthropic SSE through `createResponsesSseTranslator`, emit
     Responses SSE, terminate on `response.completed`.

### Forcing passthrough

Codex cannot function unless tool_use is returned to it. Tag the internal hop
(e.g. `x-meridian-agent: "codex"` or a dedicated header) and add a small adapter
/ resolution so this endpoint runs passthrough regardless of the global
`MERIDIAN_PASSTHROUGH`. Reuse the existing adapter pattern (the `openai` adapter
already exists for `/v1/chat/completions`; add a `codex`/`responses` variant, or
extend `openai`, that sets `usesPassthrough() => true` and `codeSystemPrompt`
OFF so Codex's own 21KB instructions aren't overridden by the Claude Code
preset). Decision at implementation time: new adapter vs. extend `openai` — new
adapter is cleaner and keeps agent-specific logic isolated per ARCHITECTURE.md.

## Translation detail

### Request (Responses → Anthropic)

| Responses field | Anthropic |
|---|---|
| `instructions` | `system` (string) |
| `input[]` message (role user/assistant) + `input_text`/`output_text` parts | `messages[]` with text content |
| `input[]` message role `developer` | folded into `system` (Codex harness instructions) |
| `input[]` `function_call {name, arguments, call_id}` | assistant `tool_use {id:call_id, name, input:JSON.parse(arguments)}` |
| `input[]` `function_call_output {call_id, output}` | user `tool_result {tool_use_id:call_id, content:output}` |
| `input[]` `reasoning` | phase 1: dropped · phase 2: decoded → Claude `thinking` block |
| `tools[]` `function {name, description, parameters}` | `tools[] {name, description, input_schema:parameters}` |
| `tool_choice` | `tool_choice` (auto/any/tool) |
| `reasoning.effort` | effort → thinking level (reuse existing effort mapping) |
| `max_output_tokens` | `max_tokens` |
| `temperature`, `top_p` | passthrough |
| `stream` | `stream` |
| `model` | via existing `mapModelToClaudeModel` (unknown `gpt-5.5` → default Claude; `x-meridian-profile`/model overrides still apply) |

Consecutive same-role messages merged as Anthropic requires alternating roles;
assistant `tool_use` + following `tool_result` linked by `call_id`.

### Response (Anthropic → Responses)

- Non-stream: assemble one `response` object; `output[]` = message item with
  `output_text` parts (from Anthropic text blocks) + `function_call` items (from
  tool_use blocks); `usage` mapped; `status:"completed"`.
- Stream: the SSE translator maps Anthropic events to the Responses event
  sequence above. Anthropic `content_block_start(text)` → `output_item.added` +
  `content_part.added`; `content_block_delta(text_delta)` → `output_text.delta`;
  tool_use block → `function_call` item + `function_call_arguments.delta/.done`;
  `message_delta(stop_reason)` + `message_stop` → `output_item.done` +
  `response.completed` with usage. Thinking blocks: phase 1 stripped (mirrors
  `openai.ts` behavior for non-native clients).

## Error handling

- Invalid/missing `input` and `model` → 400 `invalid_request_error`, Responses-shaped.
- Upstream `/v1/messages` non-2xx → surface status + message as a Responses error.
- Streaming: on mid-stream upstream error, emit a `response.failed` (or terminate
  cleanly) so Codex doesn't hang; log via existing telemetry.
- Reuse `requireAuth`; forward `authorization`/`x-api-key` on the internal hop.

## Testing

- **Unit** (`src/__tests__/openai-responses*.test.ts`, mirror the 3 existing
  `openai*` test files): request translation (message/function_call/
  function_call_output/tools/instructions), non-stream response assembly, and the
  SSE translator (text + tool-call sequences) — pure, no mocks needed beyond the
  translator input.
- **Integration**: through the HTTP layer with a mocked SDK (mirror existing
  passthrough integration tests) — assert `/v1/responses` forwards, forces
  passthrough, and returns correct Responses SSE.
- **E2E (real Codex 0.143)**: isolated `CODEX_HOME` with a `meridian` provider
  (`wire_api="responses"`, `base_url` → patched Meridian, `env_key`), run
  `codex exec "<prompt>"` and confirm: (a) a plain reply renders, (b) a
  tool-using task (e.g. "list files then summarize") drives exec_command tool
  calls and completes. The capture harness + isolated config are already built.

## Phasing

- **Phase 1 (this spec):** base `/v1/responses` — text + function tool calling,
  streaming + non-streaming, forced passthrough, model mapping. Reasoning items
  **omitted** (verified working). Ships Codex-on-Claude end to end.
- **Phase 2 (fast-follow):** encrypted-envelope reasoning continuity. Pack
  Claude's `{thinking, signature}` into `reasoning.encrypted_content` (opaque to
  Codex), round-trip it, and unpack on the next turn to restore Claude's signed
  thinking. Requires empirical verification that Codex echoes the blob byte-for-
  byte and that Claude accepts the reconstructed signature under fresh-replay
  (no session resume). Fallback: reasoning-as-plain-text summary (display only,
  no continuity).

## Stable API contract note

`/v1/responses` becomes a new public endpoint. Add it to the endpoints list in
the `/` root response and document the Codex `config.toml` provider setup in the
README. No changes to existing endpoints or the plugin-facing contract.
