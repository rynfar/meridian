---
id: adapters
type: module-design
status: active
title: Client adapters and transforms
parent: architecture
depends-on: [session, profiles-routing]
---

## Responsibility

Describe the **client** side of each request so the core never hardcodes one
client's behavior:

- `detect.ts` picks the adapter by an ordered list of signals — explicit
  `x-meridian-agent` (built-in or a named instance), native Polytoken headers,
  adapter-instance match rules, `x-opencode-session`, Jcode, User-Agent rules,
  …, then `MERIDIAN_DEFAULT_AGENT`. Instance match rules deliberately outrank
  User-Agent heuristics: redirecting a known client to a custom configuration
  is what they exist for. Full order: `docs/development.md` → *Agent
  Detection*.
- Each `AgentAdapter` supplies session identity (including agent-scoped and
  root-session keys), working-directory extraction, content normalization for
  lineage, tool blocking/allow-lists, passthrough policy and SDK feature
  defaults.
- `transforms/` holds each adapter's built-in transforms; `transform.ts` is the
  shared `Transform` interface and pipeline runner that user
  [`plugins`](../plugins/SPEC.md) extend.

Code: `src/proxy/adapters/`, `src/proxy/transforms/`, `adapter.ts`,
`adapterInstances.ts`, `transform.ts`.

## Boundary

- `adapter.ts` is an **interface only**; implementations live in `adapters/`.
- Client-specific logic stays here (marked with `NOTE:` where it must remain
  elsewhere); leaf modules never gain agent-specific branches.
- Adapters may import `session/fingerprint` and the core's leaf modules
  (`messages`, `tools`, `fileChanges`, `sdkFeatures`), never `server.ts`.
- Adapter selection does not by itself create reliable session identity; a
  client without a session key gets the generic headerless behavior.
- Known split: `AgentAdapter extends AgentIdentity` but still carries behavior
  methods, while the server also drives behavior through
  `transforms/registry.ts` — the identity/behavior separation is partial.

Session-identity rules for OpenCode agents, Claude Code subagents and
Polytoken are in [`architecture`](../../../ARCHITECTURE.md) → *Session
Management*; per-client setup is in `docs/agents.md`.

## Decisions

- **Codex gets a dedicated adapter** (not an extension of `openai`): always
  passthrough, with the coding preset off so Codex's own instructions are not
  overridden.
- **Jcode is detected only by both** a `jcode/` User-Agent **and** a valid
  `x-jcode-session`; it reuses the OpenAI adapter with the preset off and an
  append-only history so lineage can resume. Global or prompt-derived identity
  is never used — cross-conversation state reuse is the risk being avoided.
- **Prime Agent gets its own adapter** rather than widening Pi (different tool
  surface — a single `ipython` tool). There is deliberately **no User-Agent
  rule**: it sends the generic `Anthropic/JS` agent shared by other clients.
  The preset is off (measured), and the session key is
  `x-session-affinity ?? metadata.user_id`.
- **`<thinking>` stripping is opt-in** (`MERIDIAN_STRIP_THINKING=1`, global, not
  per adapter): silently deleting user-authored prompt text is worse than
  echoing a stray tag. `thinking` is no longer an orchestration tag; scoping
  the stripper to assistant content was rejected because it would undo #167.
  (Implemented in the core's `sanitize.ts`.)

## Known limitations

- **Backgrounded Claude Code sessions replay once.** A backgrounded main session
  (or fork-of-main subagent) gets a fresh agent id but carries the whole
  transcript, so its first request under the new key is a full-history replay.
- **Headerless concurrent client-driven loops** run independent (never resumed),
  because concurrent children would otherwise resume each other's sessions; the
  fix is a client-supplied session key.
- **Subagent extraction** parses the client's Task tool description; a
  non-standard format disables automatic subagent routing.
- **Prime Agent file-change tracking** covers `%%bash`, `!` escapes and
  `edit(...)` only, not arbitrary Python writes.
