# Keyless Priority-Pool Affinity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give conversations from clients that send no session header a stable priority-pool assignment, so they stop bouncing back to the preferred profile (and replaying their whole history) the moment its cooldown expires.

**Architecture:** A pure helper in `session/fingerprint.ts` falls back to the existing conversation fingerprint when the adapter yields no session id. The priority dispatch block calls it. Separately, the assignment map moves from FIFO to LRU eviction by extracting a small `AssignmentStore` class into `routing.ts`.

**Tech Stack:** TypeScript, Hono, Bun test, `@anthropic-ai/claude-agent-sdk`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-keyless-priority-affinity-design.md`.
- Branch is `fix/keyless-priority-affinity`. **Never** `git push origin main`.
- No `as any`, `@ts-ignore`, `@ts-expect-error`. No empty catch blocks.
- `npx tsc --noEmit` must pass before any commit — CI runs typecheck separately from `bun test`.
- Bun's `noUncheckedIndexedAccess` strictness applies: never index into an array directly in an assertion — map and compare sequences instead.
- Module boundaries: `routing.ts` is a leaf and **must not import from `session/` or `server.ts`**. `session/lineage.ts` stays pure. `server.ts` orchestrates, it does not compute.
- An explicit session id must always win over the fingerprint. Keyed clients must be byte-identical to today.
- Conventional Commits, no AI attribution lines. Commit with `git -c commit.gpgsign=false`.

## Test-suite facts you need

- Full suite baseline on this branch: **2112 pass, 2 fail**. The 2 failures are pre-existing and fail identically on `main`:
  - `Integration: sticky profile routing (#383) > GOLDEN: without MERIDIAN_ROUTING every session lands on the first profile (current behavior)`
  - `priority routing > mode OFF is byte-identical: no failover, error surfaces from the default profile`
  They are caused by the suite reading the developer's real `~/.config/meridian/settings.json` (tracked in issue #698), NOT by anything in this plan. If ANY other test fails, that is a regression you introduced — diagnose it. Do not dismiss a new failure as "pre-existing flakiness"; verify against `main` first.
- **Existing priority tests are already keyless.** `post(app)` in `src/__tests__/priority-routing-integration.test.ts` sends no session header, so those conversations will now acquire `fp:` assignments where before they had none. Each test calls `createTestApp()`, which builds a fresh proxy instance with its own `priorityAssignments`, so assignments cannot bleed between tests. Existing tests are expected to still pass — but if one changes behavior, understand why before touching it.

---

### Task 1: `getPriorityAssignmentKey` helper

Pure function plus unit tests. Nothing calls it yet.

**Files:**
- Modify: `src/proxy/session/fingerprint.ts` (append)
- Create: `src/__tests__/priority-assignment-key.test.ts`

**Interfaces:**
- Consumes: `getConversationFingerprint(messages, workingDirectory?)`, already exported from the same file.
- Produces:
  ```ts
  getPriorityAssignmentKey(
    sessionId: string | undefined,
    messages: Array<{ role: string; content: any }>,
    workingDirectory?: string,
  ): string | null
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/priority-assignment-key.test.ts`:

```ts
/**
 * Unit tests for the priority-pool assignment key.
 *
 * An explicit session id always wins. Without one, the conversation
 * fingerprint stands in — that is what gives keyless clients (Pylon's main
 * process, OpenCode setups that omit x-opencode-session) pool affinity.
 */

import { describe, expect, it } from "bun:test"
import { getPriorityAssignmentKey } from "../proxy/session/fingerprint"

const MESSAGES = [{ role: "user", content: "first message" }]

describe("getPriorityAssignmentKey", () => {
  it("returns the session id verbatim when one is present", () => {
    expect(getPriorityAssignmentKey("sess-1", MESSAGES, "/proj")).toBe("sess-1")
  })

  it("returns a session id verbatim even when it looks like a fingerprint key", () => {
    // Collision in this direction is impossible, but the passthrough must be
    // unconditional — never re-derive a key for an already-keyed client.
    expect(getPriorityAssignmentKey("fp:deadbeef", MESSAGES, "/proj")).toBe("fp:deadbeef")
  })

  it("falls back to a namespaced fingerprint when there is no session id", () => {
    const key = getPriorityAssignmentKey(undefined, MESSAGES, "/proj")
    expect(key).toStartWith("fp:")
    expect(key?.length).toBeGreaterThan(3)
  })

  it("is stable across calls for the same conversation", () => {
    const a = getPriorityAssignmentKey(undefined, MESSAGES, "/proj")
    const b = getPriorityAssignmentKey(undefined, MESSAGES, "/proj")
    expect(a).toBe(b)
  })

  it("uses the FIRST user message, so later turns of one conversation share a key", () => {
    const turn1 = [{ role: "user", content: "first message" }]
    const turn2 = [
      { role: "user", content: "first message" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "a follow-up question" },
    ]
    expect(getPriorityAssignmentKey(undefined, turn2, "/proj"))
      .toBe(getPriorityAssignmentKey(undefined, turn1, "/proj"))
  })

  it("distinguishes conversations with different first messages", () => {
    const other = [{ role: "user", content: "a different opening" }]
    expect(getPriorityAssignmentKey(undefined, other, "/proj"))
      .not.toBe(getPriorityAssignmentKey(undefined, MESSAGES, "/proj"))
  })

  it("distinguishes the same first message in different working directories", () => {
    expect(getPriorityAssignmentKey(undefined, MESSAGES, "/proj-a"))
      .not.toBe(getPriorityAssignmentKey(undefined, MESSAGES, "/proj-b"))
  })

  it("returns null when there is no user message", () => {
    expect(getPriorityAssignmentKey(undefined, [{ role: "assistant", content: "hi" }], "/proj")).toBeNull()
  })

  it("returns null when the first user message has no text content", () => {
    const noText = [{ role: "user", content: [{ type: "image", source: {} }] }]
    expect(getPriorityAssignmentKey(undefined, noText, "/proj")).toBeNull()
  })

  it("returns null for an empty message list rather than inventing a key", () => {
    expect(getPriorityAssignmentKey(undefined, [], "/proj")).toBeNull()
  })

  it("still derives a key when no working directory is available", () => {
    expect(getPriorityAssignmentKey(undefined, MESSAGES, undefined)).toStartWith("fp:")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/__tests__/priority-assignment-key.test.ts
```

Expected: FAIL — `getPriorityAssignmentKey is not a function` (the export does not exist yet).

- [ ] **Step 3: Implement the helper**

Append to `src/proxy/session/fingerprint.ts`, after `getConversationFingerprint`:

```ts
/**
 * Key a conversation for priority-pool assignment.
 *
 * An explicit session id always wins — keyed clients behave exactly as before.
 * Without one, the conversation fingerprint stands in, which is what gives
 * keyless clients pool affinity: Pylon's main process deliberately sends no
 * session key (its provider headers are per-process, so one key would merge
 * every open chat into a single meridian session), and without a fallback
 * such a conversation re-picks its account every turn — bouncing back to the
 * preferred profile the moment its cooldown expires and replaying its whole
 * history against a cold cache.
 *
 * The `fp:` prefix namespaces fingerprint-derived keys so they can never
 * collide with a real session id. An empty fingerprint returns null rather
 * than inventing a key, preserving today's no-affinity behavior for requests
 * we cannot identify.
 *
 * NOTE: this is only ever an ACCOUNT key, never a session key. Two unrelated
 * conversations that share a first message and working directory will share
 * an assignment — that costs nothing, because it selects a profile and never
 * a resumable SDK session.
 */
export function getPriorityAssignmentKey(
  sessionId: string | undefined,
  messages: Array<{ role: string; content: any }>,
  workingDirectory?: string,
): string | null {
  if (sessionId) return sessionId
  const fingerprint = getConversationFingerprint(messages, workingDirectory)
  return fingerprint ? `fp:${fingerprint}` : null
}
```

- [ ] **Step 4: Run tests and typecheck to verify they pass**

```bash
bun test src/__tests__/priority-assignment-key.test.ts && npx tsc --noEmit
```

Expected: 11 tests PASS, `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git -c commit.gpgsign=false add src/proxy/session/fingerprint.ts src/__tests__/priority-assignment-key.test.ts
git -c commit.gpgsign=false commit -m "feat: add priority-pool assignment key with fingerprint fallback"
```

---

### Task 2: Wire the fallback into priority dispatch

This is the behavior fix.

**Files:**
- Modify: `src/proxy/server.ts` (the priority dispatch block, around lines 757-777)
- Test: `src/__tests__/priority-routing-integration.test.ts`

**Interfaces:**
- Consumes: `getPriorityAssignmentKey(sessionId, messages, workingDirectory?)` from Task 1.
- Produces: no new exports. `dispatchPriority`'s `sessionKey` parameter is unchanged (`string | null`).

Background: `adapter.extractClientWorkingDirectory?.(body)` is the client-local path used for conversation fingerprinting; `adapter.extractWorkingDirectory(body)` is the required fallback (it is non-optional on the `AgentIdentity` interface). Resolve the cwd the same way here so the assignment key buckets per client project exactly as the session fingerprint already does.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `src/__tests__/priority-routing-integration.test.ts`, after the existing blocks. It needs the same isolation the other blocks use.

```ts
describe("keyless priority affinity", () => {
  beforeEach(() => {
    capturedEnvs = []
    failingDirs = new Set()
    clearSessionCache()
    resetActiveProfile()
    rateLimitStore.clear()
    // Mirror the existing blocks exactly — MERIDIAN_PROFILE_ORDER matters,
    // and the shared `savedEnv` object is restored wholesale in afterEach.
    savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
    savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
  })

  afterEach(() => {
    rateLimitStore.clear()
    // Same restore loop the other describe blocks use — copy it verbatim from
    // the "priority routing" block's afterEach rather than hand-rolling one.
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v
      else delete process.env[k]
    }
  })

  it("keeps a KEYLESS conversation on its failed-over profile after the preferred one recovers", async () => {
    // A 50ms-out reset makes work's exhaustion mark expire almost immediately,
    // so "the cooldown elapsed" is testable without a long sleep. The gate
    // added in #697 requires status "rejected" (or utilization >= 1) for the
    // entry to be trusted as the cooldown source.
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: Date.now() + 50,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()

    // Turn 1 — no session header of any kind. Fails over to personal.
    const r1 = await post(app, {}, "keyless conversation")
    expect(r1.status).toBe(200)

    // work recovers AND its exhaustion mark expires.
    failingDirs.delete("prof-work")
    await Bun.sleep(70)
    capturedEnvs = []

    // Turn 2 of the SAME conversation. getConversationFingerprint keys off the
    // FIRST user message, so re-sending it is a faithful stand-in for a longer
    // turn-2 payload that opens with the same message.
    const r2 = await post(app, {}, "keyless conversation")
    expect(r2.status).toBe(200)
    expect(capturedEnvs.every((e) => e.includes("prof-personal"))).toBe(true)
  }, 20_000)

  it("gives two keyless conversations independent assignments", async () => {
    // MUST be recorded BEFORE the failing request. ProfileExhaustion.mark only
    // ever EXTENDS a mark, so recording this after the failure would leave the
    // 10-minute default in place and work would never come back inside the test.
    rateLimitStore.record("work", {
      status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: Date.now() + 50,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    // Conversation A fails over to personal and is assigned there.
    expect((await post(app, {}, "conversation A")).status).toBe(200)

    // work recovers and its mark expires, so a DIFFERENT conversation is free
    // to use it — proving the assignment is per-conversation, not global.
    failingDirs.delete("prof-work")
    await Bun.sleep(70)
    capturedEnvs = []
    expect((await post(app, {}, "conversation B")).status).toBe(200)
    expect(capturedEnvs.some((e) => e.includes("prof-work"))).toBe(true)
  }, 20_000)

  it("lands a keyless fork on the same account as its parent", async () => {
    failingDirs.add("prof-work")
    const app = createTestApp()
    // Parent fails over to personal.
    expect((await post(app, {}, "shared opening")).status).toBe(200)

    failingDirs.delete("prof-work")
    await Bun.sleep(70)
    capturedEnvs = []
    // A fork shares the parent's first message, so it shares the fingerprint
    // and therefore the account. This deliberately diverges from the session
    // RESUME independence guard: an assignment picks an account, never a
    // session, so sharing costs nothing and preserves a warm cache.
    const fork = await post(app, { "x-meridian-source": "fork-memory-extract" }, "shared opening")
    expect(fork.status).toBe(200)
    expect(capturedEnvs.every((e) => e.includes("prof-personal"))).toBe(true)
  }, 20_000)
})
```

Note: the fork test relies on `work`'s exhaustion mark still being live (the default 10-minute cooldown, since no `rateLimitStore` entry was recorded for it), so the 70ms sleep does not expire it. That is intentional — this test isolates *assignment sharing*, and the previous test already covers mark expiry.

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/__tests__/priority-routing-integration.test.ts
```

Expected: the first test FAILS — turn 2 goes to `prof-work` because no assignment was ever stored for a keyless conversation. The other two may pass incidentally; the first is the regression gate.

- [ ] **Step 3: Wire the helper into the dispatch block**

In `src/proxy/server.ts`, add `getPriorityAssignmentKey` to the existing import from `./session/fingerprint` (check the current import line and extend it rather than adding a second import statement).

Then replace this line in the priority dispatch block:

```ts
            const sessionKey = adapter.getSessionId(c, body) || null
```

with:

```ts
            // Keyless clients (pylon's main process, OpenCode setups that omit
            // x-opencode-session) fall back to the conversation fingerprint —
            // without it they re-pick an account every turn and bounce back to
            // the preferred profile the moment its cooldown expires, replaying
            // the whole history against a cold cache.
            const assignmentCwd = adapter.extractClientWorkingDirectory?.(body)
              ?? adapter.extractWorkingDirectory(body)
            const sessionKey = getPriorityAssignmentKey(
              adapter.getSessionId(c, body),
              body.messages,
              assignmentCwd,
            )
```

Leave the rest of the block unchanged — `assigned`, `first`, `candidates`, and the `dispatchPriority` call all already handle a `string | null` key.

- [ ] **Step 4: Run tests and typecheck to verify they pass**

```bash
bun test src/__tests__/priority-routing-integration.test.ts && npx tsc --noEmit
```

Expected: all cases in the file pass except the one pre-existing `mode OFF` failure. `tsc` silent.

Then run the full suite before committing:

```bash
npm test
```

Expected: exactly the 2 pre-existing failures named in "Test-suite facts" above and no others.

- [ ] **Step 5: Commit**

```bash
git -c commit.gpgsign=false add src/proxy/server.ts src/__tests__/priority-routing-integration.test.ts
git -c commit.gpgsign=false commit -m "fix: give keyless conversations priority-pool affinity"
```

---

### Task 3: LRU eviction for assignments

Extracts the assignment map into a small testable class and fixes the eviction order.

**Files:**
- Modify: `src/proxy/routing.ts` (append the class)
- Modify: `src/proxy/server.ts` (replace the raw `Map` and inline eviction)
- Test: `src/__tests__/routing-unit.test.ts` if it exists, otherwise create `src/__tests__/assignment-store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  class AssignmentStore {
    constructor(max: number)
    get(key: string): string | undefined
    set(key: string, value: string): void
    readonly size: number
  }
  ```

Background — why this is needed: `priorityAssignments` currently evicts via `keys().next().value`, which is insertion order. Re-`set`ting an existing key does **not** move it in a JS `Map`, so a long-lived active conversation stays at the front of the eviction queue and is dropped ahead of a newer idle one. Task 2 gives nearly every conversation a key, which raises map pressure and makes this fire in practice.

First check whether a routing unit test file already exists:

```bash
ls src/__tests__/ | grep -i routing
```

If a unit-test file for `routing.ts` exists, add the `describe` block below to it. Otherwise create `src/__tests__/assignment-store.test.ts` with the standard header comment style used by neighboring test files.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "bun:test"
import { AssignmentStore } from "../proxy/routing"

describe("AssignmentStore", () => {
  it("stores and returns assignments", () => {
    const store = new AssignmentStore(10)
    store.set("a", "work")
    expect(store.get("a")).toBe("work")
    expect(store.get("missing")).toBeUndefined()
    expect(store.size).toBe(1)
  })

  it("overwrites an existing key without growing", () => {
    const store = new AssignmentStore(10)
    store.set("a", "work")
    store.set("a", "personal")
    expect(store.get("a")).toBe("personal")
    expect(store.size).toBe(1)
  })

  it("evicts the oldest entry once over capacity", () => {
    const store = new AssignmentStore(2)
    store.set("a", "work")
    store.set("b", "work")
    store.set("c", "work")
    expect(store.size).toBe(2)
    expect(store.get("a")).toBeUndefined()
    expect(store.get("b")).toBe("work")
    expect(store.get("c")).toBe("work")
  })

  it("refreshes recency on WRITE so a re-assigned key is not evicted first", () => {
    // The FIFO bug: a bare Map.set() on an existing key does not reorder it,
    // so "a" would still be evicted despite being the most recently written.
    const store = new AssignmentStore(2)
    store.set("a", "work")
    store.set("b", "work")
    store.set("a", "personal")
    store.set("c", "work")
    expect(store.get("a")).toBe("personal")
    expect(store.get("b")).toBeUndefined()
  })

  it("refreshes recency on READ so an actively used key is not evicted first", () => {
    const store = new AssignmentStore(2)
    store.set("a", "work")
    store.set("b", "work")
    expect(store.get("a")).toBe("work") // "a" is in active use
    store.set("c", "work")
    expect(store.get("a")).toBe("work")
    expect(store.get("b")).toBeUndefined()
  })

  it("does not refresh recency for a missing key", () => {
    const store = new AssignmentStore(2)
    store.set("a", "work")
    store.set("b", "work")
    expect(store.get("nope")).toBeUndefined()
    store.set("c", "work")
    expect(store.get("a")).toBeUndefined()
    expect(store.get("b")).toBe("work")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/__tests__/assignment-store.test.ts
```

(Use the actual path if you added to an existing routing test file.)
Expected: FAIL — `AssignmentStore` is not exported from `routing.ts`.

- [ ] **Step 3: Implement the class**

Append to `src/proxy/routing.ts`, after `ProfileExhaustion`:

```ts
/**
 * Session-to-profile assignments with LRU eviction.
 *
 * A JS Map preserves insertion order and a bare `set()` on an EXISTING key
 * does not reorder it — so a plain map evicts first-inserted, which drops a
 * long-lived active conversation ahead of a newer idle one. Both read and
 * write therefore delete-then-set to refresh recency.
 *
 * Deliberately not persisted: this is routing hygiene, not durable truth.
 * After a restart the next request re-establishes the assignment.
 */
export class AssignmentStore {
  private readonly entries = new Map<string, string>()

  constructor(private readonly max: number) {}

  /** Read an assignment, marking it most-recently-used. */
  get(key: string): string | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  /** Write an assignment, marking it most-recently-used and evicting if over capacity. */
  set(key: string, value: string): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  get size(): number {
    return this.entries.size
  }
}
```

- [ ] **Step 4: Use it in `server.ts`**

Add `AssignmentStore` to the existing import from `./routing`.

Replace the declaration:

```ts
  const priorityAssignments = new Map<string, string>() // sessionKey -> profileId
```

with:

```ts
  const priorityAssignments = new AssignmentStore(PRIORITY_ASSIGNMENTS_MAX)
```

`PRIORITY_ASSIGNMENTS_MAX` is declared a few lines below the map. Move the `const PRIORITY_ASSIGNMENTS_MAX = 5000` line above the `priorityAssignments` declaration so it is initialized before use — `const` is not hoisted, and referencing it first would throw a `ReferenceError` at startup.

Then replace the write block inside `dispatchPriority`:

```ts
        if (sessionKey) {
          priorityAssignments.set(sessionKey, candidate)
          if (priorityAssignments.size > PRIORITY_ASSIGNMENTS_MAX) {
            const oldest = priorityAssignments.keys().next().value
            if (oldest !== undefined) priorityAssignments.delete(oldest)
          }
        }
```

with:

```ts
        if (sessionKey) priorityAssignments.set(sessionKey, candidate)
```

The read site (`priorityAssignments.get(sessionKey)`) needs no change — `AssignmentStore.get` has the same signature and now refreshes recency as a side effect.

- [ ] **Step 5: Run tests and typecheck to verify they pass**

```bash
bun test src/__tests__/assignment-store.test.ts && bun test src/__tests__/priority-routing-integration.test.ts && npx tsc --noEmit
```

Expected: the store's 6 tests pass; the integration file passes except the pre-existing `mode OFF` failure; `tsc` silent.

Then the full suite:

```bash
npm test
```

Expected: exactly the 2 pre-existing failures and no others.

- [ ] **Step 6: Commit**

```bash
git -c commit.gpgsign=false add src/proxy/routing.ts src/proxy/server.ts src/__tests__/assignment-store.test.ts
git -c commit.gpgsign=false commit -m "fix: evict priority assignments least-recently-used"
```

---

### Task 4: Documentation and full verification

**Files:**
- Modify: `docs/profiles.md`
- Test: whole suite

- [ ] **Step 1: Update the user-facing docs**

`docs/profiles.md` currently describes assignment affinity around line 86:

> - **Conversations keep their account** while it's healthy — a session never flips accounts just because the pool preference changed (protects per-account prompt caches). A session on an exhausted account fails over and then stays on its new account.

That bullet is now true for *all* conversations, not only those whose client sends a session header. Check whether the surrounding section states or implies a session-header requirement, and if so correct it — one or two sentences, matching the surrounding voice. Do not restructure the section, and do not pad.

Also confirm nothing in `ARCHITECTURE.md` describes the assignment map as FIFO:

```bash
grep -n "assignment\|FIFO\|5000\|session key" docs/profiles.md ARCHITECTURE.md
```

Update anything inaccurate. If nothing needs changing, say so in your report and skip the commit for that file.

- [ ] **Step 2: Run the full suite**

```bash
npm test
```

Expected: exactly the 2 pre-existing failures named in "Test-suite facts" and no others.

- [ ] **Step 3: Typecheck and build**

```bash
npx tsc --noEmit && npm run build
```

Expected: both silent/successful.

- [ ] **Step 4: Commit and open the PR**

```bash
git -c commit.gpgsign=false add -A
git -c commit.gpgsign=false commit -m "docs: describe pool affinity for keyless conversations"
git push origin fix/keyless-priority-affinity
gh pr create --base main --title "fix: give keyless conversations priority-pool affinity"
```

The PR body must state the behavior change from the spec's Risks section: **all** keyless clients now acquire pool affinity, not only Pylon — any OpenCode setup omitting `x-opencode-session` is affected. It strictly reduces account switching, but it is a real behavior change. Also note that fingerprint collisions between unrelated conversations sharing a first message and cwd are possible and bounded — they share an account, never a session.

- [ ] **Step 5: Wait for CI**

```bash
gh pr checks <PR_NUMBER> --watch
```

Expected: the `test` job passes. Do not merge.

Note: `main` requires signed commits while this project commits with `gpgsign=false`, so the merge will report BLOCKED even with green CI. That is expected — the repo owner merges with `--admin`.

---

## Verification Summary

| Spec requirement | Task |
|---|---|
| `getPriorityAssignmentKey` pure helper in `session/fingerprint.ts` | 1 |
| Explicit session id always wins | 1 |
| `fp:` namespacing | 1 |
| Empty fingerprint returns `null` | 1 |
| Call site resolves cwd via `extractClientWorkingDirectory ?? extractWorkingDirectory` | 2 |
| Keyless conversation stays on its failed-over profile (the regression) | 2 |
| Independent assignments per conversation | 2 |
| Forks share the parent's assignment, commented as a deliberate divergence | 1, 2 |
| LRU eviction on write | 3 |
| LRU eviction on read hit | 3 |
| 5000 cap and evict-oldest preserved | 3 |
| Docs | 4 |

Out of scope per the spec, and deliberately absent from every task: the mid-stream failover gap (`sniffQuotaFailure` inspecting only the first SSE frame), the unavoidable first-failover ramp, priority ordering, and persisting assignments across restarts.
