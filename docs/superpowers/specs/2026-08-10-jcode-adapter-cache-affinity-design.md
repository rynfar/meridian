# Jcode adapter and cache affinity design

## Goal

Give Jcode retained sessions native Meridian session continuity and high prompt-cache reuse without changing generic OpenAI-compatible client behavior or risking cross-conversation state reuse.

## Verified wire behavior

A local fake OpenAI-compatible endpoint captured two retained Jcode 0.74.0 turns without contacting a model:

- endpoint: `POST /v1/chat/completions`
- User-Agent: `jcode/0.1.0`
- no `prompt_cache_key` or session header
- first request roles: `system, user, user`
- second request roles: `system, user, user, assistant, user`
- the earlier message hashes were unchanged on the second request
- the working directory was present in the request context

Jcode therefore sends safe append-only history, but Meridian currently destroys that structure by packing prior turns into one changing `<conversation_history>` system string. The internal request then has one message, no stable session identity, and every tool round starts a new SDK session. This explains the low cache-hit floor observed in live telemetry.

## Architecture

### Jcode

Jcode's OpenAI-compatible transport will attach an opaque `x-jcode-session` header to every chat-completions request. The value is the durable Jcode session identifier already used by `--resume`. It must be dynamic per retained session, never provider-global, and must remain unchanged across tool-loop requests and resumed CLI invocations.

The header carries no prompt content and is used only as an affinity key. Other provider transports remain unchanged.

### Meridian

Meridian will add a dedicated `jcode` adapter rather than extending generic OpenAI behavior.

The outer `/v1/chat/completions` route will identify Jcode by its `jcode/` User-Agent and require a non-empty `x-jcode-session` before enabling Jcode session continuity. It will forward the value to the internal `/v1/messages` hop, tag that hop as `x-meridian-agent: jcode`, and preserve existing authentication and profile headers.

The Jcode adapter will:

- inherit the generic OpenAI adapter's preset-off and tool behavior
- return `x-jcode-session` from `getSessionId`
- extract the client working directory from Jcode's request context
- keep Jcode-specific behavior inside the adapter boundary

For Jcode requests, OpenAI-to-Anthropic translation will preserve the full converted conversation turn list and keep the original system prompt stable. Meridian's existing lineage verifier can then classify the second request as an append-only continuation and send only the delta to the resumed SDK session.

Generic OpenAI clients, including keyed or headerless clients that are not identified as Jcode, retain the existing history-packing behavior byte-for-byte.

## Safety and fallback behavior

- Jcode User-Agent without `x-jcode-session`: use generic OpenAI behavior and a fresh SDK session.
- `x-jcode-session` from a non-Jcode User-Agent: do not activate the Jcode adapter.
- Empty or malformed session header: ignore it.
- Changed history under the same key: Meridian's existing lineage verification rejects resume and fresh-replays safely.
- Different Jcode session keys: never share a Meridian session.
- No static global affinity header or prompt-derived identity is permitted.

## Tests

### Jcode

- each OpenAI-compatible request carries the current durable Jcode session ID
- retained tool-loop requests keep the same header
- a different Jcode session gets a different header
- non-OpenAI-compatible providers are unchanged

### Meridian

- adapter detection selects `jcode` only for the verified Jcode identity
- the route forwards a valid `x-jcode-session` and tags the internal request as Jcode
- Jcode translation preserves full append-only history and stable system context
- same key resumes the prior mocked SDK session on turn two
- different keys remain isolated
- missing/empty key and generic OpenAI requests preserve current behavior

## Verification

1. Run focused Jcode transport tests and Meridian adapter/OpenAI endpoint tests.
2. Run targeted builds/typechecks in both repositories.
3. Start a separate patched Meridian instance on an unused loopback port.
4. Run one minimal retained Jcode session for two or three turns.
5. Confirm telemetry shows `adapter=jcode`, first lineage `new`, later lineage `continuation`, the same SDK session, sharply reduced cache creation, and materially increased cache reads.
6. Only after that proof, replace the current Meridian process used for Pylon implementation.
