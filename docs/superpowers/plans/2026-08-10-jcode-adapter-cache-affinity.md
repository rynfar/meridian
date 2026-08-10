# Jcode Adapter Cache Affinity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make retained Jcode sessions resume one Meridian SDK session so tool-heavy Opus turns reuse prompt cache instead of rewriting the full conversation on every request.

**Architecture:** Jcode will send its durable local session ID as `x-jcode-session` on direct OpenAI-compatible chat-completions requests. Meridian will recognize that header only with Jcode's verified `jcode/` User-Agent, route through a dedicated `jcode` adapter, preserve Jcode's append-only message history, and use the header as the existing lineage/session key. Generic OpenAI-compatible behavior remains unchanged.

**Tech Stack:** Rust, async-trait, reqwest, Tokio, Cargo tests, TypeScript, Bun tests, Hono, Claude Agent SDK session cache.

## Global Constraints

- Never use a provider-global or prompt-derived session key.
- Jcode session affinity must be the durable local Jcode session ID used by `--resume`.
- Generic OpenAI-compatible clients must keep current history-packing behavior byte-for-byte.
- Jcode requests missing a valid session header must fall back to generic OpenAI behavior.
- A non-Jcode User-Agent must not activate Jcode behavior even if it sends `x-jcode-session`.
- Session header values must match `^[A-Za-z0-9._:-]{1,256}$`.
- Changed history under a valid key must continue to use Meridian's existing fail-closed lineage verification.
- Implement every behavior test-first and commit each independently reviewable task.
- Do not stop the currently running Meridian process until isolated verification passes.

---

## File Structure

### Jcode

- Modify `crates/jcode-app-core/src/agent/provider.rs`: select the durable local session ID for direct OpenAI-compatible requests while preserving native provider session IDs for every other provider.
- Modify `crates/jcode-app-core/src/agent/turn_loops.rs`: use the selected request session ID in the blocking turn loop.
- Modify `crates/jcode-app-core/src/agent/turn_streaming_mpsc.rs`: use the same selected ID in the streaming MPSC loop.
- Modify `crates/jcode-provider-openrouter-runtime/src/openrouter_provider_impl.rs`: carry the request session ID into the HTTP transport.
- Modify `crates/jcode-provider-openrouter-runtime/src/openrouter_sse_stream.rs`: attach `x-jcode-session` to each direct-compatible request and every retry.
- Modify `crates/jcode-provider-openrouter-runtime/src/openrouter_tests.rs`: prove the header is sent and omitted correctly.

### Meridian

- Create `src/proxy/adapters/jcode.ts`: dedicated Jcode adapter and pure session-header validation.
- Create `src/__tests__/jcode-adapter.test.ts`: adapter validation and session extraction tests.
- Modify `src/proxy/adapters/detect.ts`: register and detect Jcode explicitly.
- Modify `src/proxy/sdkFeatures.ts`: give Jcode the generic OpenAI preset-off default.
- Modify `src/proxy/transforms/opencode.ts`: include Jcode in the shared OpenCode-core transform allow-list.
- Modify `src/proxy/plugins/validation.ts`: accept `jcode` as a known adapter.
- Modify `src/__tests__/adapter-detection.test.ts`: Jcode detection and precedence tests.
- Modify `src/proxy/openai.ts`: add a translation option that preserves full history only for Jcode.
- Modify `src/__tests__/openai.test.ts`: keyed Jcode history-preservation tests and generic regression tests.
- Modify `src/proxy/server.ts`: validate outer Jcode identity, choose the adapter/translation mode, and forward the session/profile headers.
- Modify `src/__tests__/proxy-openai-compat.test.ts`: two-turn session continuity and isolation tests through the HTTP layer.

---

### Task 1: Jcode selects a durable request affinity ID

**Files:**
- Modify: `crates/jcode-app-core/src/agent/provider.rs`
- Modify: `crates/jcode-app-core/src/agent/turn_loops.rs:149-155`
- Modify: `crates/jcode-app-core/src/agent/turn_streaming_mpsc.rs:230-250`

**Interfaces:**
- Produces: `select_provider_request_session_id<'a>(native_provider_session_id: Option<&'a str>, local_session_id: &'a str, direct_openai_compatible: bool) -> Option<&'a str>`
- Produces: `Agent::provider_request_session_id(&self) -> Option<&str>`
- Consumes: `Provider::direct_openai_compatible_route_parts()` and `self.session.id`

- [ ] **Step 1: Write failing selector tests**

Add focused unit tests beside the pure selector in `agent/provider.rs`:

```rust
#[cfg(test)]
mod request_session_id_tests {
    use super::select_provider_request_session_id;

    #[test]
    fn direct_compatible_uses_durable_local_session_id() {
        assert_eq!(
            select_provider_request_session_id(Some("native-id"), "session_local_123", true),
            Some("session_local_123"),
        );
    }

    #[test]
    fn native_provider_keeps_native_resume_id() {
        assert_eq!(
            select_provider_request_session_id(Some("native-id"), "session_local_123", false),
            Some("native-id"),
        );
    }

    #[test]
    fn native_provider_without_resume_id_stays_unkeyed() {
        assert_eq!(
            select_provider_request_session_id(None, "session_local_123", false),
            None,
        );
    }
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test -p jcode-app-core request_session_id_tests -- --nocapture
```

Expected: compile failure because `select_provider_request_session_id` does not exist.

- [ ] **Step 3: Implement the selector and Agent helper**

Add:

```rust
fn select_provider_request_session_id<'a>(
    native_provider_session_id: Option<&'a str>,
    local_session_id: &'a str,
    direct_openai_compatible: bool,
) -> Option<&'a str> {
    if direct_openai_compatible {
        Some(local_session_id)
    } else {
        native_provider_session_id
    }
}

impl Agent {
    pub(super) fn provider_request_session_id(&self) -> Option<&str> {
        select_provider_request_session_id(
            self.provider_session_id.as_deref(),
            self.session.id.as_str(),
            self.provider.direct_openai_compatible_route_parts().is_some(),
        )
    }
}
```

Use `self.provider_request_session_id()` in `turn_loops.rs`. In `turn_streaming_mpsc.rs`, clone it before creating the pinned future:

```rust
let resume_session_id = self.provider_request_session_id().map(str::to_owned);
```

Do not change the `Provider` trait signature.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cargo test -p jcode-app-core request_session_id_tests -- --nocapture
```

Expected: all three tests pass.

- [ ] **Step 5: Run the two affected agent test targets**

Run:

```bash
cargo test -p jcode-app-core agent:: -- --nocapture
```

Expected: existing agent tests pass with no new failures.

- [ ] **Step 6: Commit**

```bash
git add crates/jcode-app-core/src/agent/provider.rs \
  crates/jcode-app-core/src/agent/turn_loops.rs \
  crates/jcode-app-core/src/agent/turn_streaming_mpsc.rs
git commit -m "fix: preserve session identity for compatible providers"
```

---

### Task 2: Jcode sends `x-jcode-session` on direct-compatible requests

**Files:**
- Modify: `crates/jcode-provider-openrouter-runtime/src/openrouter_provider_impl.rs:34-350`
- Modify: `crates/jcode-provider-openrouter-runtime/src/openrouter_sse_stream.rs:30-180`
- Modify: `crates/jcode-provider-openrouter-runtime/src/openrouter_tests.rs`

**Interfaces:**
- Consumes: the `resume_session_id` selected in Task 1
- Produces: `run_stream_with_retries(..., jcode_session_id: Option<String>, ...)`
- Produces: `stream_response(..., jcode_session_id: Option<String>, ...)`
- Wire contract: `x-jcode-session: <durable local Jcode session id>`

- [ ] **Step 1: Write the failing HTTP capture test**

Using the existing `spawn_single_response_chat_server()` helper, add:

```rust
#[test]
fn direct_openai_compatible_request_sends_jcode_session_header() {
    let (api_base, request_rx) = spawn_single_response_chat_server();
    let provider = OpenRouterProvider {
        api_base,
        supports_provider_features: false,
        supports_model_catalog: false,
        send_openrouter_headers: false,
        ..make_custom_compatible_provider()
    };
    let messages = vec![Message::user("hello")];
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    rt.block_on(async {
        let mut stream = provider
            .complete(&messages, &[], "", Some("session_local_123"))
            .await
            .expect("request should start");
        while let Some(event) = stream.next().await {
            event.expect("stream event should parse");
        }
    });
    let request = request_rx.recv_timeout(Duration::from_secs(2)).expect("captured request");
    assert!(
        request.to_ascii_lowercase().contains("x-jcode-session: session_local_123"),
        "missing Jcode session header: {request}",
    );
}
```

Add a second test invoking `complete(..., None)` and asserting the raw request does not contain `x-jcode-session:`.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cargo test -p jcode-provider-openrouter-runtime direct_openai_compatible_request_sends_jcode_session_header -- --nocapture
```

Expected: assertion failure because the header is absent.

- [ ] **Step 3: Thread the ID through retries and attach the header**

Rename `_resume_session_id` to `resume_session_id` in the OpenRouter `Provider` implementation. Convert it to an owned string before `tokio::spawn`, pass it through `run_stream_with_retries` and `stream_response`, and apply it after authentication headers:

```rust
if let Some(session_id) = jcode_session_id.as_deref() {
    req = req.header("x-jcode-session", session_id);
}
```

Pass the same owned value to every retry so reconnects do not lose affinity. Do not put the session ID in the JSON body or logs.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cargo test -p jcode-provider-openrouter-runtime direct_openai_compatible_request_ -- --nocapture
```

Expected: both header-present and header-absent tests pass.

- [ ] **Step 5: Run the OpenRouter runtime test target**

Run:

```bash
cargo test -p jcode-provider-openrouter-runtime --lib -- --nocapture
```

Expected: all library tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/jcode-provider-openrouter-runtime/src/openrouter_provider_impl.rs \
  crates/jcode-provider-openrouter-runtime/src/openrouter_sse_stream.rs \
  crates/jcode-provider-openrouter-runtime/src/openrouter_tests.rs
git commit -m "fix: send Jcode session affinity to compatible gateways"
```

---

### Task 3: Add Meridian's dedicated Jcode adapter

**Files:**
- Create: `src/proxy/adapters/jcode.ts`
- Create: `src/__tests__/jcode-adapter.test.ts`
- Modify: `src/proxy/adapters/detect.ts`
- Modify: `src/proxy/sdkFeatures.ts`
- Modify: `src/proxy/transforms/opencode.ts`
- Modify: `src/proxy/plugins/validation.ts`
- Modify: `src/__tests__/adapter-detection.test.ts`

**Interfaces:**
- Produces: `normalizeJcodeSessionId(value: string | undefined): string | undefined`
- Produces: `extractJcodeWorkingDirectory(body: unknown): string | undefined`
- Produces: `jcodeAdapter: AgentAdapter`
- Wire input: `x-jcode-session`

- [ ] **Step 1: Write failing adapter tests**

Create tests that require:

```ts
expect(normalizeJcodeSessionId("session_local_123")).toBe("session_local_123")
expect(normalizeJcodeSessionId(" ")).toBeUndefined()
expect(normalizeJcodeSessionId("bad session")).toBeUndefined()
expect(normalizeJcodeSessionId("a".repeat(257))).toBeUndefined()
expect(extractJcodeWorkingDirectory({ system: "Host: macOS\nWorking directory: /repo/project\nGit branch: main" }))
  .toBe("/repo/project")
expect(extractJcodeWorkingDirectory({ system: "no directory marker" })).toBeUndefined()
expect(jcodeAdapter.getSessionId(makeContext({ "x-jcode-session": "session_local_123" })))
  .toBe("session_local_123")
```

Add detection tests for explicit `x-meridian-agent: jcode`, `jcode/0.1.0` User-Agent plus a valid session header, and precedence showing a non-Jcode User-Agent with only `x-jcode-session` remains on its normal adapter.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test src/__tests__/jcode-adapter.test.ts src/__tests__/adapter-detection.test.ts
```

Expected: missing module/export failures for the new adapter.

- [ ] **Step 3: Implement the adapter and registries**

Create `jcode.ts` as a thin specialization of `openAiAdapter`:

```ts
const JCODE_SESSION_ID = /^[A-Za-z0-9._:-]{1,256}$/

export function normalizeJcodeSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && JCODE_SESSION_ID.test(trimmed) ? trimmed : undefined
}

export function extractJcodeWorkingDirectory(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined
  const system = (body as { system?: unknown }).system
  const text = typeof system === "string"
    ? system
    : Array.isArray(system)
      ? system
          .filter((part): part is { type: "text"; text: string } =>
            part?.type === "text" && typeof part.text === "string")
          .map(part => part.text)
          .join("\n")
      : ""
  return text.match(/(?:^|\n)Working directory:\s*([^\n]+)/)?.[1]?.trim() || undefined
}

export const jcodeAdapter: AgentAdapter = {
  ...openAiAdapter,
  name: "jcode",
  getSessionId(c) {
    return normalizeJcodeSessionId(c.req.header("x-jcode-session"))
  },
  extractWorkingDirectory(body) {
    return extractJcodeWorkingDirectory(body)
  },
}
```

Register `jcode` in `ADAPTER_MAP`, detect `jcode/` only when the validated session header exists, add the OpenAI preset-off defaults, include `jcode` in the shared transform allow-list, and add it to plugin validation.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
bun test src/__tests__/jcode-adapter.test.ts src/__tests__/adapter-detection.test.ts src/__tests__/transform-parity.test.ts src/__tests__/plugin-validation.test.ts
```

Expected: all focused adapter tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/proxy/adapters/jcode.ts src/__tests__/jcode-adapter.test.ts \
  src/proxy/adapters/detect.ts src/proxy/sdkFeatures.ts \
  src/proxy/transforms/opencode.ts src/proxy/plugins/validation.ts \
  src/__tests__/adapter-detection.test.ts
git commit -m "feat: add dedicated Jcode adapter"
```

---

### Task 4: Preserve Jcode history and route its session key

**Files:**
- Modify: `src/proxy/openai.ts:70-84,421-570`
- Modify: `src/proxy/server.ts:3962-4025`
- Modify: `src/__tests__/openai.test.ts`
- Modify: `src/__tests__/proxy-openai-compat.test.ts`

**Interfaces:**
- Produces: `OpenAiTranslationOptions { preserveConversationHistory?: boolean }`
- Updates: `translateOpenAiToAnthropic(body, options?)`
- Consumes: `normalizeJcodeSessionId` and `jcodeAdapter`

- [ ] **Step 1: Write failing pure translation tests**

Add one test with `system, user, assistant, user` input and `{ preserveConversationHistory: true }`. Assert:

```ts
expect(result?.system).toBe("stable system")
expect(result?.messages.map(message => message.role)).toEqual(["user", "assistant", "user"])
expect(result?.system).not.toContain("<conversation_history>")
```

Retain or add a generic test calling without options and asserting only the latest turn is sent and `<conversation_history>` remains in `system`.

- [ ] **Step 2: Run the pure tests and verify RED**

Run:

```bash
bun test src/__tests__/openai.test.ts
```

Expected: TypeScript/test failure because the translation options parameter does not exist.

- [ ] **Step 3: Implement the narrow translation option**

Add the options interface and change only the existing packing condition:

```ts
if (turns.length > 1 && !options.preserveConversationHistory) {
  // existing history-packing block unchanged
}
```

Default `options` to `{}` so every existing caller remains byte-compatible.

- [ ] **Step 4: Run pure tests and verify GREEN**

Run:

```bash
bun test src/__tests__/openai.test.ts
```

Expected: all OpenAI translation tests pass.

- [ ] **Step 5: Write failing HTTP continuity tests**

Extend the HTTP helper so tests can pass request headers. Add tests proving:

1. `User-Agent: jcode/0.1.0` plus `x-jcode-session: session-a` forwards full history and resumes the same mocked SDK session on turn two.
2. `session-a` and `session-b` create distinct SDK sessions.
3. Jcode User-Agent without the session header keeps generic history packing and does not resume.
4. A non-Jcode User-Agent with `x-jcode-session` does not activate Jcode behavior.

Use these exact continuity assertions, matching the existing Responses endpoint contract:

```ts
expect(capturedOptions).toHaveLength(2)
expect(capturedOptions[0].resume).toBeUndefined()
expect(capturedOptions[1].resume).toBe("sdk-1")
```

For different keys and both fallback cases, assert `capturedOptions[1].resume` is `undefined`.

- [ ] **Step 6: Run HTTP tests and verify RED**

Run:

```bash
bun test src/__tests__/proxy-openai-compat.test.ts
```

Expected: `capturedOptions[1].resume` is `undefined` and the captured system prompt contains `<conversation_history>`, proving the new Jcode path is not implemented yet.

- [ ] **Step 7: Implement route selection and forwarding**

In `/v1/chat/completions`:

```ts
const userAgent = c.req.header("user-agent") ?? ""
const jcodeSessionId = userAgent.startsWith("jcode/")
  ? normalizeJcodeSessionId(c.req.header("x-jcode-session"))
  : undefined
const isJcode = jcodeSessionId !== undefined
const anthropicBody = translateOpenAiToAnthropic(rawBody, {
  preserveConversationHistory: isJcode,
})
```

Set `x-meridian-agent` to `jcode` only when `isJcode`, forward `x-jcode-session`, and also forward `x-meridian-profile` consistently with `/v1/responses`. Resolve SDK features using the selected adapter name rather than hard-coding `openai`.

- [ ] **Step 8: Run HTTP tests and verify GREEN**

Run:

```bash
bun test src/__tests__/proxy-openai-compat.test.ts src/__tests__/openai.test.ts
```

Expected: all focused OpenAI and Jcode continuity tests pass.

- [ ] **Step 9: Run targeted build/type verification**

Run:

```bash
bun test src/__tests__/jcode-adapter.test.ts \
  src/__tests__/adapter-detection.test.ts \
  src/__tests__/openai.test.ts \
  src/__tests__/proxy-openai-compat.test.ts \
  src/__tests__/transform-parity.test.ts \
  src/__tests__/plugin-validation.test.ts
npm test
npm run build
```

Expected: the full Meridian test suite passes and the build completes without TypeScript errors.

- [ ] **Step 10: Commit**

```bash
git add src/proxy/openai.ts src/proxy/server.ts \
  src/__tests__/openai.test.ts src/__tests__/proxy-openai-compat.test.ts
git commit -m "fix: resume keyed Jcode chat sessions"
```

---

### Task 5: Prove the complete cache-affinity workflow

**Files:**
- No production files unless verification exposes a specific failing test first.
- Record results in: `docs/superpowers/specs/2026-08-10-jcode-adapter-cache-affinity-design.md` under a new `## Verification results` section.

**Interfaces:**
- Consumes: Jcode canary binary with `x-jcode-session`
- Consumes: isolated patched Meridian instance
- Produces: telemetry evidence of `new` then `continuation` on one SDK session

- [ ] **Step 1: Build and use the Jcode canary through self-dev mode**

Run the repository's focused build/test workflow from the self-dev checkout. Do not replace the stable installed binary yet.

- [ ] **Step 2: Verify the header without model usage**

Point the canary Jcode build at a local fake OpenAI-compatible endpoint and run two retained turns. Assert both requests contain the same `x-jcode-session`, and a new Jcode session contains a different value.

- [ ] **Step 3: Start isolated patched Meridian**

Use an unused loopback port and a disposable config/state path. Track the exact spawned PID. Do not stop or reuse the current port 3458 process.

- [ ] **Step 4: Run a minimal live retained session**

Use one tiny Jcode session with the minimal tool profile needed to force at least two provider rounds. Stop after two or three rounds.

- [ ] **Step 5: Inspect telemetry acceptance criteria**

Require all of:

- `adapter=jcode`
- first request `lineage=new`
- later request `lineage=continuation`
- later request uses the same `sdkSessionId`
- no session recovery/divergence warning
- second/third request cache creation is materially lower than the current fresh-replay baseline
- cache reads materially exceed the static-prefix-only floor

If any criterion fails, write a failing automated test for the observed behavior before editing production code.

- [ ] **Step 6: Record results and commit**

Append exact commands and summarized telemetry counters without prompts, credentials, or full session IDs, then commit:

```bash
git add docs/superpowers/specs/2026-08-10-jcode-adapter-cache-affinity-design.md
git commit -m "docs: verify Jcode cache affinity"
```

- [ ] **Step 7: Switch the implementation workflow only after proof**

Restart the Meridian instance used by the Pylon implementation only after isolated verification passes. Stop only the PID captured for that instance, never a process found by name matching.
