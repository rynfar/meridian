# Priority-Pool Affinity for Keyless Clients — Design

**Status:** Approved (owner decisions: forks share the parent's assignment; the `priorityAssignments` eviction fix is folded in).
**Fixes:** Conversations from clients that send no session header get no priority-pool affinity, so they bounce back to the preferred profile the moment its cooldown expires and pay a second full-history replay.

## Problem

### 1. No affinity without a session header

Priority routing keeps session affinity in `priorityAssignments`, a `Map<sessionKey, profileId>`. The key comes from the adapter:

```ts
const sessionKey = adapter.getSessionId(c, body) || null
const assigned = sessionKey ? priorityAssignments.get(sessionKey) : undefined
```

When `getSessionId` returns nothing, `sessionKey` is `null`, no assignment is ever stored, and every turn independently re-picks the highest-priority profile that is not currently exhausted.

The practical consequence: a conversation that fails over to the secondary profile returns to the primary as soon as the primary's exhaustion mark expires. Because session state is profile-scoped (`profileSessionId = \`${profile.id}:${agentSessionId}\``, and the fingerprint bucket likewise), that return is a cache miss on a fresh SDK session — the entire conversation history replays. So an affected conversation pays the ramp **twice** per exhaustion cycle instead of once.

Measured cost of one ramp, from this instance's telemetry (16 observed switches): the first request after a switch writes 23–47k cache-creation tokens, and the cache hit rate recovers over roughly three requests (0.236 → 0.606 → 0.643 → 0.868 against a steady state near 0.9).

### 2. This is the common case, not an edge case

Pylon's main process deliberately sends no session key. Verified in `extensions/pi-pylon-orchestrator/meridian-source.ts` and locked by a test (`tests/meridian-source.test.ts:171`, *"the main process does NOT stamp x-session-affinity (it serves many conversations)"*).

The reason is correct and should not change: Pylon registers provider headers **once per process** via `registerProvider`, so a process-level key would be shared by every open chat, merging unrelated conversations under one Meridian session entry. That would be worse than having no key.

Pylon subagent children *do* stamp `x-session-affinity: subagent-<name>-<uuid>` (one child process = one conversation) and already get full affinity. **No Pylon change is required or wanted.** The gap is in Meridian.

### 3. Eviction can silently drop an active conversation

`priorityAssignments` evicts at `PRIORITY_ASSIGNMENTS_MAX = 5000` by taking `keys().next().value` — insertion order. Re-`set`ting an existing key does **not** move it in a JS `Map`, so a long-lived active conversation stays at the front of the eviction queue and is dropped ahead of a newer idle one. Losing the entry loses affinity, which costs a replay.

This is latent today because few conversations get keys. Fix 1 gives nearly every conversation a key, which raises map pressure and makes this fire in practice — so shipping Fix 1 alone would ship a known mechanism for undoing it.

## Design

### 1. A pure fallback-key helper

Add to `src/proxy/session/fingerprint.ts`, which already owns conversation fingerprinting:

```ts
export function getPriorityAssignmentKey(
  sessionId: string | undefined,
  messages: Array<{ role: string; content: any }>,
  workingDirectory?: string,
): string | null {
  if (sessionId) return sessionId
  const fp = getConversationFingerprint(messages, workingDirectory)
  return fp ? `fp:${fp}` : null
}
```

- An explicit session id always wins — keyed clients are byte-identical to today.
- The `fp:` prefix namespaces fingerprint-derived keys so they can never collide with a real session id.
- An empty fingerprint (no user message, or no text content) returns `null`, preserving today's no-affinity behavior for those requests rather than inventing a key.

`getConversationFingerprint` hashes the first user message (truncated to 2000 chars) plus the working directory. It is stable across a conversation's turns, agent-agnostic, and profile-independent — exactly the properties an assignment key needs.

**Placement rationale.** This cannot live in `routing.ts`: leaf modules must not import from `session/`. It could live inline in `server.ts`, but a pure function in the module that owns fingerprinting is directly unit-testable and keeps `server.ts` orchestrating rather than computing.

### 2. Call site

At the priority dispatch block in `server.ts`, resolve the client cwd exactly as the existing fingerprint path does — `extractClientWorkingDirectory` when the adapter implements it, else `extractWorkingDirectory`:

```ts
const clientCwd = adapter.extractClientWorkingDirectory?.(body) ?? adapter.extractWorkingDirectory(body)
const sessionKey = getPriorityAssignmentKey(adapter.getSessionId(c, body), body.messages, clientCwd)
```

Nothing downstream changes: `priorityAssignments` already accepts an arbitrary string key, and the assignment/read logic is untouched.

### 3. Forks and subagents share the parent's assignment

Keyless forks and subagents key on the fingerprint alone, so they land on the same account as their parent.

This **deliberately diverges** from the session-resume independence guard at `server.ts:1042`, which forces keyless `fork-`/`subagent-` requests to fresh-replay rather than risk conflating with the parent's session. The two cases carry different risk:

- A **session-resume** collision cross-contaminates conversation history — genuinely destructive.
- An **assignment** collision only pins two conversations to the same account. It picks an account, never a session. The cost is zero, and sharing the parent's account preserves that account's warm prompt cache.

The divergence is intentional and must be commented as such at the call site, so a future reader does not "fix" it into consistency.

### 4. LRU eviction

Make `priorityAssignments` evict least-recently-used rather than first-inserted. A JS `Map` preserves insertion order, so `delete` before `set` moves a key to the back:

- On write (successful candidate): `priorityAssignments.delete(key)` before `set`, so a re-assignment refreshes recency.
- On read hit (an assignment is found and used as `first`): `delete` then `set` the same value. The `delete` is required — a bare `set` on an existing key leaves its position unchanged, which is the whole defect.

The `PRIORITY_ASSIGNMENTS_MAX = 5000` cap and the evict-oldest step are unchanged; only the ordering discipline changes. State remains in-memory with no TTL, lost on restart, as today.

## Testing

**`src/__tests__/` — new unit tests for `getPriorityAssignmentKey`** (pure, no mocks):
- An explicit session id passes through unchanged, even when messages would produce a fingerprint.
- No session id yields `fp:<hash>`.
- The same messages + cwd yield the same key across calls; a different first user message yields a different key; the same first message in a different cwd yields a different key.
- No user message, or a user message with no text content, yields `null`.
- A session id that happens to look like `fp:...` is still returned verbatim (prefix collision is impossible in the other direction).

**`src/__tests__/priority-routing-integration.test.ts` — extend:**
- **The regression this exists to fix:** a keyless conversation (pi adapter, no `x-session-affinity`) fails over to `personal`; `work` recovers and its exhaustion mark expires; the conversation must **stay** on `personal`. This fails on current `main`.
- Two keyless conversations with different first user messages receive independent assignments.
- A keyless fork (`x-meridian-source: fork-…`) lands on the same account as its parent.
- Existing keyed behavior is unchanged (the current stickiness tests must pass untouched).

**Eviction:**
- A unit-level test that re-`set`ting a key moves it to the back of eviction order, and that a read hit does the same — i.e. with a small cap, the least-recently-*used* key is evicted, not the first-inserted one. Test the ordering discipline directly rather than driving 5000 requests through HTTP.

## Out of scope

- **The mid-stream failover gap.** `sniffQuotaFailure` inspects only the first complete SSE frame (`break // first complete frame decides`), so a rate-limit error arriving after any content frame passes through to the client with no failover, and the profile is not marked exhausted. Real, separate, and deliberate in its current form — it must never yank a stream a client is already consuming.
- **The initial ramp.** One full-history replay on first failover is unavoidable: profiles are separate subscriptions with separate `CLAUDE_CONFIG_DIR`s, so there is no cross-account session to resume.
- **Priority order or profile selection.** Unchanged.
- **Persisting assignments across restarts.** Still deliberately in-memory.

## Risks

- **Behavior change for all keyless clients**, not only Pylon. Any client that sends no session header now acquires pool affinity. This is the intended fix, and it strictly reduces account switching, but it is a real behavior change for OpenCode setups that omit `x-opencode-session`.
- **Fingerprint collisions** between genuinely unrelated conversations that share both a first user message and a working directory (e.g. two chats started with "hi" in the same project). The consequence is bounded: they share an account. No session state is shared, because session resume keys are computed separately and are unaffected by this change.
- **Assignments now outlive their usefulness longer** under LRU than FIFO for idle conversations. Bounded by the 5000 cap and cleared on restart.
- **Load stays concentrated on the secondary account after an outage ends.** Once a failover moves keyless conversations off the primary, they stay there after it recovers — only new conversations drain back — so the secondary keeps carrying that load while the primary idles. This is already the documented behavior for keyed clients, and is arguably the intended semantics for an ordered drain pool, but is worth naming explicitly here.
