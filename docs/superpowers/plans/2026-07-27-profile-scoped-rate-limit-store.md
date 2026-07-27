# Profile-Scoped Rate-Limit Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make priority routing's exhaustion cooldown derive from the failing profile's own quota reset instead of whichever profile last wrote to a global singleton.

**Architecture:** Add a profile dimension to `RateLimitStore` (`Map<profileId, Map<bucket, entry>>`) so every read is explicitly per-account, then resolve a failing profile's cooldown from three sources in order: its own scoped `five_hour` entry, a non-blocking authoritative `fetchOAuthUsage` call for that account, and the existing 10-minute default.

**Tech Stack:** TypeScript, Hono, Bun test, `@anthropic-ai/claude-agent-sdk`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-profile-scoped-rate-limit-store-design.md`.
- Branch is `fix/profile-scoped-rate-limit-store`. **Never** `git push origin main`.
- No `as any`, `@ts-ignore`, `@ts-expect-error`, or empty catch blocks. (Existing `(event as any)` casts at the SDK-event call sites are pre-existing and stay as-is; do not add new ones.)
- `npx tsc --noEmit` must pass — `bun test` and `tsup` skip type errors in tests, CI runs typecheck separately.
- Tests run with `bun test`. Bun's `noUncheckedIndexedAccess` strictness applies: do not index into arrays directly in assertions, map and compare sequences instead (see the existing pattern in `rate-limit-store.test.ts:82-87`).
- `profileId` is **required** on `record`/`getAll`/`get`. Do not make it optional — an optional parameter would let a call site silently read across accounts again, which is the exact failure being fixed.
- Commits use Conventional Commits (`fix:`, `test:`, `refactor:`, `docs:`) with no AI attribution lines. Use `git -c commit.gpgsign=false`.
- Module boundaries: `rateLimitStore.ts` gains no new imports. `routing.ts` and `session/lineage.ts` are not touched.

---

### Task 1: Profile-scope `RateLimitStore`

Self-contained module change plus its unit tests. Nothing outside `rateLimitStore.ts` compiles against the new signatures yet — that is Task 2.

**Files:**
- Modify: `src/proxy/rateLimitStore.ts` (whole class + module doc comment)
- Test: `src/__tests__/rate-limit-store.test.ts` (rewrite call sites, add isolation cases)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  record(profileId: string, info: SDKRateLimitInfo | undefined | null, observedAt?: number): void
  getAll(profileId: string): RateLimitEntry[]
  get(profileId: string, key: RateLimitBucketKey): RateLimitEntry | undefined
  clear(profileId?: string): void
  size(profileId?: string): number   // NOTE: method, not a getter
  ```
  `RateLimitEntry` and `RateLimitBucketKey` are unchanged.

- [ ] **Step 1: Write the failing tests**

Replace the entire `describe("rateLimitStore", ...)` block in `src/__tests__/rate-limit-store.test.ts` with the version below. Keep lines 1-25 (the header comment, imports, and the `FIVE_HOUR` / `SEVEN_DAY` fixtures) exactly as they are.

```ts
const WORK = "work"
const PERSONAL = "personal"

describe("rateLimitStore", () => {
  it("starts empty", () => {
    const store = new _RateLimitStoreForTests()
    expect(store.size()).toBe(0)
    expect(store.getAll(WORK)).toEqual([])
  })

  it("records distinct buckets keyed by rateLimitType", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, FIVE_HOUR)
    store.record(WORK, SEVEN_DAY)
    expect(store.size(WORK)).toBe(2)
    const types = store.getAll(WORK).map(e => e.rateLimitType).sort()
    expect(types).toEqual(["five_hour", "seven_day"])
  })

  it("overwrites on second record for same bucket (last-write-wins)", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, { ...FIVE_HOUR, utilization: 0.42 })
    store.record(WORK, { ...FIVE_HOUR, utilization: 0.55 })
    expect(store.size(WORK)).toBe(1)
    expect(store.get(WORK, "five_hour")?.utilization).toBe(0.55)
  })

  it("buckets entries without rateLimitType under 'default'", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, { status: "allowed", utilization: 0.1 })
    expect(store.size(WORK)).toBe(1)
    expect(store.get(WORK, "default")?.utilization).toBe(0.1)
  })

  it("ignores nullish or non-object input without throwing", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, undefined)
    store.record(WORK, null as unknown as SDKRateLimitInfo)
    store.record(WORK, "nope" as unknown as SDKRateLimitInfo)
    expect(store.size()).toBe(0)
  })

  it("stamps observedAt on each record", () => {
    const store = new _RateLimitStoreForTests()
    const before = Date.now()
    store.record(WORK, FIVE_HOUR)
    const after = Date.now()
    const entry = store.get(WORK, "five_hour")
    expect(entry?.observedAt).toBeGreaterThanOrEqual(before)
    expect(entry?.observedAt).toBeLessThanOrEqual(after)
  })

  it("getAll returns entries newest-first by observedAt", async () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, FIVE_HOUR)
    // Force monotonic observedAt — Bun's `Date.now()` resolution is fine here.
    await Bun.sleep(2)
    store.record(WORK, SEVEN_DAY)
    // Compare the mapped sequence rather than indexing into the array directly
    // so the test stays under TypeScript's `noUncheckedIndexedAccess` strict
    // mode (which CI's `tsc --noEmit` enforces but Bun's lenient default tsc
    // does not).
    const orderedTypes = store.getAll(WORK).map(e => e.rateLimitType)
    expect(orderedTypes).toEqual(["seven_day", "five_hour"])
  })

  it("preserves all SDKRateLimitInfo fields verbatim", () => {
    const store = new _RateLimitStoreForTests()
    const full: SDKRateLimitInfo = {
      status: "allowed_warning",
      rateLimitType: "overage",
      utilization: 0.78,
      resetsAt: 1_730_000_000_000,
      overageStatus: "allowed",
      overageResetsAt: 1_730_100_000_000,
      isUsingOverage: true,
      surpassedThreshold: 0.75,
      overageDisabledReason: "no_limits_configured",
    }
    store.record(WORK, full)
    const got = store.get(WORK, "overage")
    expect(got).toMatchObject(full)
  })

  // --- Profile isolation (the bug this scoping fixes) ---

  it("keeps the same bucket type separate per profile", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, { ...FIVE_HOUR, resetsAt: 1_000 })
    store.record(PERSONAL, { ...FIVE_HOUR, resetsAt: 9_999 })
    expect(store.get(WORK, "five_hour")?.resetsAt).toBe(1_000)
    expect(store.get(PERSONAL, "five_hour")?.resetsAt).toBe(9_999)
    expect(store.size(WORK)).toBe(1)
    expect(store.size(PERSONAL)).toBe(1)
    expect(store.size()).toBe(2)
  })

  it("getAll returns only the requested profile's entries", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, FIVE_HOUR)
    store.record(PERSONAL, SEVEN_DAY)
    expect(store.getAll(WORK).map(e => e.rateLimitType)).toEqual(["five_hour"])
    expect(store.getAll(PERSONAL).map(e => e.rateLimitType)).toEqual(["seven_day"])
  })

  it("getAll for an unseen profile returns an empty array", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, FIVE_HOUR)
    expect(store.getAll("never-seen")).toEqual([])
    expect(store.get("never-seen", "five_hour")).toBeUndefined()
  })

  it("clear(profileId) drops one profile and leaves others intact", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, FIVE_HOUR)
    store.record(PERSONAL, FIVE_HOUR)
    store.clear(WORK)
    expect(store.getAll(WORK)).toEqual([])
    expect(store.getAll(PERSONAL).map(e => e.rateLimitType)).toEqual(["five_hour"])
  })

  it("clear() with no argument drops every profile", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, FIVE_HOUR)
    store.record(PERSONAL, SEVEN_DAY)
    store.clear()
    expect(store.size()).toBe(0)
    expect(store.getAll(WORK)).toEqual([])
    expect(store.getAll(PERSONAL)).toEqual([])
  })

  it("treats 'default' as an ordinary profile key (single-profile setups)", () => {
    const store = new _RateLimitStoreForTests()
    store.record("default", FIVE_HOUR)
    expect(store.getAll("default").map(e => e.rateLimitType)).toEqual(["five_hour"])
    expect(store.get("default", "five_hour")?.utilization).toBe(0.42)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/__tests__/rate-limit-store.test.ts
```

Expected: FAIL. Errors along the lines of `store.size is not a function` and records landing in the wrong bucket, because `record` still treats its first argument as the `SDKRateLimitInfo`.

- [ ] **Step 3: Implement the scoped store**

In `src/proxy/rateLimitStore.ts`, replace the singleton paragraph of the module doc comment (currently the block beginning `* Singleton — one Meridian process holds one snapshot at a time.`) with:

```
 * Entries are scoped per profile. Each profile is a separate Claude Max
 * subscription with separate quotas, so a flat store would let one account's
 * reset time be read as another's — which is exactly how priority routing
 * (`routing: "priority"`) mis-derived exhaustion cooldowns before this was
 * scoped. Every read names its profile explicitly; single-profile setups
 * simply use the literal `"default"` key.
 *
 * State resets on proxy restart — that's fine because the SDK pushes a fresh
 * event on the next request. `clear(profileId)` drops one account (wired into
 * `POST /auth/refresh`, which re-authenticates one credential); `clear()`
 * drops everything and is used by tests.
```

Then replace the class body:

```ts
class RateLimitStore {
  /** profileId -> (bucket key -> entry). One inner map per configured profile. */
  private byProfile = new Map<string, Map<RateLimitBucketKey, RateLimitEntry>>()

  /**
   * Record a rate-limit info snapshot for a specific profile.
   * Last-write-wins per (profileId, rateLimitType). Older entries for the
   * same pair are overwritten — clients should treat the latest as canonical.
   *
   * `observedAt` defaults to the current wall clock but may be supplied
   * explicitly so callers (and tests) can control the capture timestamp used
   * for newest-first ordering in {@link getAll}.
   */
  record(profileId: string, info: SDKRateLimitInfo | undefined | null, observedAt: number = Date.now()): void {
    if (!info || typeof info !== "object") return
    const key: RateLimitBucketKey = info.rateLimitType ?? "default"
    let buckets = this.byProfile.get(profileId)
    if (!buckets) {
      buckets = new Map<RateLimitBucketKey, RateLimitEntry>()
      this.byProfile.set(profileId, buckets)
    }
    buckets.set(key, { ...info, observedAt })
  }

  /** Snapshot one profile's entries, newest-first by observedAt. */
  getAll(profileId: string): RateLimitEntry[] {
    const buckets = this.byProfile.get(profileId)
    if (!buckets) return []
    return Array.from(buckets.values()).sort((a, b) => b.observedAt - a.observedAt)
  }

  /** Snapshot a single bucket for one profile, or undefined if not yet seen. */
  get(profileId: string, key: RateLimitBucketKey): RateLimitEntry | undefined {
    return this.byProfile.get(profileId)?.get(key)
  }

  /** Bucket count for one profile, or across all profiles when omitted. */
  size(profileId?: string): number {
    if (profileId !== undefined) return this.byProfile.get(profileId)?.size ?? 0
    let total = 0
    for (const buckets of this.byProfile.values()) total += buckets.size
    return total
  }

  /**
   * Drop stored entries for one profile, or every profile when `profileId`
   * is omitted. Wired into the `POST /auth/refresh` handler so a refreshed
   * credential's stale quotas can't linger. Also used by tests for isolation.
   */
  clear(profileId?: string): void {
    if (profileId !== undefined) this.byProfile.delete(profileId)
    else this.byProfile.clear()
  }
}
```

Leave the `RateLimitEntry` interface, the `RateLimitBucketKey` type, the exported `rateLimitStore` singleton, and the `_RateLimitStoreForTests` export unchanged.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/__tests__/rate-limit-store.test.ts
```

Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git -c commit.gpgsign=false add src/proxy/rateLimitStore.ts src/__tests__/rate-limit-store.test.ts
git -c commit.gpgsign=false commit -m "fix: scope rate-limit store entries per profile"
```

Note: `npx tsc --noEmit` will still fail at this point — `server.ts` has not been updated. That is expected and is fixed in Task 2.

---

### Task 2: Update `server.ts` call sites

Makes the tree compile again and fixes the same wrong-profile bug in `GET /v1/usage/quota`.

**Files:**
- Modify: `src/proxy/server.ts` (lines ~484, ~1617, ~2331, ~3676, ~3747, ~4043)
- Test: `src/__tests__/proxy-usage-quota-route.test.ts`

**Interfaces:**
- Consumes: `record(profileId, info)`, `getAll(profileId)`, `clear(profileId?)` from Task 1.
- Produces: nothing new. `priorityCooldownUntil` keeps its current `(now: number)` signature in this task; Task 3 changes it.

- [ ] **Step 1: Write the failing test**

Append this test inside the existing `describe("GET /v1/usage/quota", ...)` block in `src/__tests__/proxy-usage-quota-route.test.ts`. Match the surrounding tests' setup style — read the existing `beforeEach` to see how `__setFetchOAuthUsageOverride` and `rateLimitStore` are reset, and how an app is created, then follow it exactly.

```ts
  it("reports the requested profile's SDK buckets, not another profile's", async () => {
    // Both accounts have recorded a five_hour bucket. Asking for `personal`
    // must never surface `work`'s numbers.
    rateLimitStore.record("work", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.99,
      resetsAt: 1_111_111_111_111,
    })
    rateLimitStore.record("personal", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.10,
      resetsAt: 2_222_222_222_222,
    })
    __setFetchOAuthUsageOverride(async () => null)

    const { app } = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      profiles: [
        { id: "work", claudeConfigDir: "/tmp/meridian-quota-work" },
        { id: "personal", claudeConfigDir: "/tmp/meridian-quota-personal" },
      ],
      defaultProfile: "work",
    })

    const res = await app.fetch(new Request("http://localhost/v1/usage/quota?profile=personal"))
    expect(res.status).toBe(200)
    const body = await res.json() as QuotaResponse
    const fiveHour = body.buckets.filter(b => b.type === "five_hour")
    expect(fiveHour.map(b => b.resetsAt)).toEqual([2_222_222_222_222])
    expect(fiveHour.map(b => b.utilization)).toEqual([0.10])
  })
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/__tests__/proxy-usage-quota-route.test.ts
```

Expected: FAIL. Either a TypeScript/runtime error from `rateLimitStore.record` now requiring a profile id, or the assertion failing because `work`'s `resetsAt` (`1111111111111`) is reported under `personal`.

- [ ] **Step 3: Update the six call sites**

**3a.** `src/proxy/server.ts:484`, inside `priorityCooldownUntil`. This is a compile fix only; the real change lands in Task 3. Replace:

```ts
    const fiveHour = rateLimitStore.getAll().find(e => e.rateLimitType === "five_hour" && (e.resetsAt ?? 0) > now)
```

with:

```ts
    const fiveHour = rateLimitStore.getAll(profileId).find(e => e.rateLimitType === "five_hour" && (e.resetsAt ?? 0) > now)
```

and change the enclosing signature from `function priorityCooldownUntil(now: number): number {` to:

```ts
  function priorityCooldownUntil(profileId: string, now: number): number {
```

Then update its two call sites at `server.ts:567-568` (inside `dispatchPriority`), which currently compute the value twice:

```ts
      const cooldownUntil = priorityCooldownUntil(candidate, Date.now())
      priorityExhaustion.mark(candidate, cooldownUntil, "rate_limit_error")
      claudeLog("priority.exhausted", { profile: candidate, until: cooldownUntil })
```

**3b.** `src/proxy/server.ts:1617` and `src/proxy/server.ts:2331` — the two SDK-event capture sites. `profile` is already in scope in both generators. Replace both occurrences of:

```ts
                      rateLimitStore.record((event as any).rate_limit_info)
```

with:

```ts
                      rateLimitStore.record(profile.id, (event as any).rate_limit_info)
```

Preserve each site's existing indentation — the two differ.

**3c.** `src/proxy/server.ts:3676`, in `POST /profiles/active`. **Delete** the `rateLimitStore.clear()` line and rewrite the comment above it. Replace:

```ts
    // Evict all cached SDK sessions — they were started under the old profile's
    // credentials and cannot be reused with different auth. Also drop the
    // rate-limit snapshot so /v1/usage/quota doesn't return the previous
    // profile's quotas under the new profile's identity.
    clearSessionCache()
    rateLimitStore.clear()
```

with:

```ts
    // Evict all cached SDK sessions — they were started under the old profile's
    // credentials and cannot be reused with different auth. The rate-limit
    // store is NOT cleared: entries are profile-scoped, so the new profile
    // can no longer read the old one's quotas, and other profiles' snapshots
    // stay valid (consumers judge staleness from `observedAt`).
    clearSessionCache()
```

**3d.** `src/proxy/server.ts:3747`, in `POST /auth/refresh`. Replace:

```ts
      // Drop the rate-limit snapshot — old quotas were observed under the
      // previous credential and may belong to a different account if the
      // refresh swapped profiles. The next SDK call repopulates.
      rateLimitStore.clear()
```

with:

```ts
      // Drop this profile's rate-limit snapshot — its quotas were observed
      // under the previous credential. Scoped to the profile actually
      // refreshed; other accounts' snapshots are untouched. The next SDK
      // call repopulates.
      rateLimitStore.clear(profile.id)
```

**3e.** `src/proxy/server.ts:4043`, in `GET /v1/usage/quota`. The `targetProfileId` resolution currently happens *below* this line — move the `sdkEntries` declaration so it comes after `targetProfileId` is assigned, then replace:

```ts
    const sdkEntries = rateLimitStore.getAll().filter(entry => entry.rateLimitType !== undefined)
```

with:

```ts
    const sdkEntries = rateLimitStore.getAll(targetProfileId ?? "default")
      .filter(entry => entry.rateLimitType !== undefined)
```

Update the comment block above it (the paragraph starting `// Filter out the internal "default" bucket`) by appending:

```
    // Entries are read for the resolved target profile only — a multi-account
    // setup must never render one account's SDK buckets under another's
    // identity.
```

- [ ] **Step 4: Run tests and typecheck to verify they pass**

```bash
bun test src/__tests__/proxy-usage-quota-route.test.ts && npx tsc --noEmit
```

Expected: tests PASS, and `tsc --noEmit` produces no output (the tree compiles again).

- [ ] **Step 5: Commit**

```bash
git -c commit.gpgsign=false add src/proxy/server.ts src/__tests__/proxy-usage-quota-route.test.ts
git -c commit.gpgsign=false commit -m "fix: read rate-limit entries per profile in quota route and cooldown"
```

---

### Task 3: Three-tier cooldown resolution

The reliability fix. Adds the authoritative OAuth fallback without putting a network call in the failover path.

**Files:**
- Modify: `src/proxy/server.ts` (the priority block, ~lines 468-582)
- Test: `src/__tests__/priority-routing-integration.test.ts`

**Interfaces:**
- Consumes: `priorityCooldownUntil(profileId, now)` from Task 2; `rateLimitStore.getAll(profileId)` from Task 1; existing `fetchOAuthUsage`, `getEffectiveProfiles`, `priorityExhaustion`, `PRIORITY_DEFAULT_COOLDOWN_MS`, `PRIORITY_COOLDOWN_CAP_MS`, `claudeLog`.
- Produces: `refinePriorityCooldown(profileId: string): void` — fire-and-forget, returns immediately.

Background for the implementer: `ProfileExhaustion.mark` (`src/proxy/routing.ts:145-149`) ignores any `until` that is not strictly later than the existing mark. That is what makes the late refinement safe — it can only extend a cooldown, never end one early. Exhaustion marks are observable in tests through `GET /profiles/list`, which returns `exhausted: [{ id, until, reason }]` when routing mode is `priority` (`src/proxy/server.ts:3635`). That route sits behind `requireAuth` (`server.ts:454`), but so does `/v1/messages`, which the existing tests already call without credentials — `requireAuth` passes through when no API key is configured, so no auth setup is needed.

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/priority-routing-integration.test.ts`.

First, at the top of the file with the other dynamic imports (near `const { createProxyServer, clearSessionCache } = await import("../proxy/server")`), add:

```ts
const { __setFetchOAuthUsageOverride } = await import("../proxy/oauthUsage")
const { rateLimitStore } = await import("../proxy/rateLimitStore")
```

Then add this helper next to the file's existing `createTestApp` / `post` helpers:

```ts
async function exhaustedMarks(app: { fetch: (r: Request) => Promise<Response> }) {
  const res = await app.fetch(new Request("http://localhost/profiles/list"))
  const body = await res.json() as { exhausted?: Array<{ id: string; until: number; reason: string }> }
  return body.exhausted ?? []
}
```

Then add a new `describe` block. Note the `beforeEach` must reset both the OAuth override and the store, or state bleeds between these cases.

```ts
describe("priority cooldown resolution", () => {
  const WORK_RESET = Date.now() + 4 * 60 * 60_000      // 4h out
  const PERSONAL_RESET = Date.now() + 30 * 60_000      // 30m out

  beforeEach(() => {
    rateLimitStore.clear()
    __setFetchOAuthUsageOverride(async () => null)
  })

  afterEach(() => {
    rateLimitStore.clear()
    __setFetchOAuthUsageOverride(null)
  })

  it("uses the failing profile's OWN five_hour reset, not another profile's", async () => {
    // personal has a much later reset on record. work is the one that fails.
    // The old global-singleton bug would hand work personal's number.
    rateLimitStore.record("personal", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.5,
      resetsAt: Date.now() + 5 * 60 * 60_000,
    })
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: WORK_RESET,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    await post(app)

    const marks = await exhaustedMarks(app)
    expect(marks.map(m => m.id)).toEqual(["work"])
    expect(marks.map(m => m.until)).toEqual([WORK_RESET])
  }, 20_000)

  it("falls back to the 10-minute default when the profile has no entry of its own", async () => {
    rateLimitStore.record("personal", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.5,
      resetsAt: Date.now() + 5 * 60 * 60_000,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    const before = Date.now()
    await post(app)
    const after = Date.now()

    const marks = await exhaustedMarks(app)
    const until = marks.map(m => m.until)
    expect(until).toHaveLength(1)
    expect(until.every(u => u >= before + 10 * 60_000 && u <= after + 10 * 60_000)).toBe(true)
  }, 20_000)

  it("refines a default-length mark with the authoritative OAuth reset", async () => {
    __setFetchOAuthUsageOverride(async (opts) => {
      if (opts?.profileId !== "work") return null
      return { windows: [{ type: "five_hour", utilization: 1, resetsAt: WORK_RESET }], extraUsage: null, fetchedAt: Date.now() }
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    await post(app)
    // The refinement is deliberately not awaited by the request path.
    await Bun.sleep(20)

    const marks = await exhaustedMarks(app)
    expect(marks.map(m => m.until)).toEqual([WORK_RESET])
  }, 20_000)

  it("never shortens an existing mark with an earlier OAuth reset", async () => {
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: WORK_RESET,
    })
    __setFetchOAuthUsageOverride(async () => ({
      windows: [{ type: "five_hour", utilization: 1, resetsAt: PERSONAL_RESET }],
      extraUsage: null,
      fetchedAt: Date.now(),
    }))
    failingDirs.add("prof-work")
    const app = createTestApp()
    await post(app)
    await Bun.sleep(20)

    const marks = await exhaustedMarks(app)
    expect(marks.map(m => m.until)).toEqual([WORK_RESET])
  }, 20_000)

  it("leaves the mark unchanged when the OAuth fetch returns null or rejects", async () => {
    __setFetchOAuthUsageOverride(async () => { throw new Error("upstream 503") })
    failingDirs.add("prof-work")
    const app = createTestApp()
    const before = Date.now()
    const res = await post(app)
    await Bun.sleep(20)

    expect(res.status).toBe(200) // failover still succeeded
    const marks = await exhaustedMarks(app)
    const until = marks.map(m => m.until)
    expect(until).toHaveLength(1)
    expect(until.every(u => u <= before + 10 * 60_000 + 5_000)).toBe(true)
  }, 20_000)

  it("does not block failover on the OAuth fetch", async () => {
    // A fetch that never settles must not stall the request. The explicit
    // type parameter matters: a bare `new Promise(() => {})` infers
    // `Promise<unknown>`, which does not satisfy the override's signature
    // and fails `tsc --noEmit`.
    __setFetchOAuthUsageOverride(() => new Promise<null>(() => {}))
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await post(app)
    expect(res.status).toBe(200)
    expect(capturedEnvs.some(e => e.includes("prof-personal"))).toBe(true)
  }, 20_000)
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/__tests__/priority-routing-integration.test.ts
```

Expected: the two tier-1 tests may already pass from Task 2's scoping; the three refinement tests FAIL because `refinePriorityCooldown` does not exist yet and the mark is never extended (`expected [WORK_RESET], got [<now+10min>]`).

- [ ] **Step 3: Implement the tiering**

In `src/proxy/server.ts`, replace the whole `priorityCooldownUntil` function (as left by Task 2) with the two functions below. Place them in the same spot, immediately after `priorityProfileOrderSetting`.

```ts
  /** Tier 1 + 3: this profile's own observed five_hour reset, else a
   *  conservative default so a mis-mark self-heals. Never blocks. */
  function priorityCooldownUntil(profileId: string, now: number): number {
    const fiveHour = rateLimitStore.getAll(profileId)
      .find(e => e.rateLimitType === "five_hour" && (e.resetsAt ?? 0) > now)
    const until = fiveHour?.resetsAt ?? now + PRIORITY_DEFAULT_COOLDOWN_MS
    return Math.min(until, now + PRIORITY_COOLDOWN_CAP_MS)
  }

  /** Tier 2: the authoritative per-account reset from Anthropic's usage
   *  endpoint. Deliberately fire-and-forget — the failover path has already
   *  burned one failed request and must not also wait on a network call.
   *  `ProfileExhaustion.mark` ignores an `until` that isn't later than the
   *  existing one, so a late refinement can only EXTEND a cooldown, never
   *  un-suppress a profile early. A null/failed fetch changes nothing. */
  function refinePriorityCooldown(profileId: string): void {
    const target = getEffectiveProfiles(finalConfig.profiles).find(p => p.id === profileId)
    void fetchOAuthUsage({ profileId, claudeConfigDir: target?.claudeConfigDir })
      .then(usage => {
        if (!usage) return
        const now = Date.now()
        const resetsAt = usage.windows.find(w => w.type === "five_hour")?.resetsAt
        if (!resetsAt || resetsAt <= now) return
        const until = Math.min(resetsAt, now + PRIORITY_COOLDOWN_CAP_MS)
        priorityExhaustion.mark(profileId, until, "rate_limit_error")
        claudeLog("priority.cooldown_refined", { profile: profileId, until, source: "oauth_usage" })
      })
      .catch(err => {
        claudeLog("priority.cooldown_refine_failed", {
          profile: profileId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }
```

Then in `dispatchPriority`, extend the mark block written in Task 2 (`server.ts:567-569`) to schedule the refinement:

```ts
      const cooldownUntil = priorityCooldownUntil(candidate, Date.now())
      priorityExhaustion.mark(candidate, cooldownUntil, "rate_limit_error")
      claudeLog("priority.exhausted", { profile: candidate, until: cooldownUntil })
      refinePriorityCooldown(candidate)
```

`fetchOAuthUsage` and `getEffectiveProfiles` are already imported in `server.ts` — verify with `grep -n "fetchOAuthUsage\|getEffectiveProfiles" src/proxy/server.ts | head -4` and add to the existing import statement only if missing.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/__tests__/priority-routing-integration.test.ts && npx tsc --noEmit
```

Expected: all tests PASS (the file's pre-existing cases plus the six new ones), `tsc --noEmit` silent.

- [ ] **Step 5: Commit**

```bash
git -c commit.gpgsign=false add src/proxy/server.ts src/__tests__/priority-routing-integration.test.ts
git -c commit.gpgsign=false commit -m "fix: resolve priority cooldown from the failing profile's own quota reset"
```

---

### Task 4: Documentation and full verification

**Files:**
- Modify: `docs/profiles.md`
- Test: whole suite

- [ ] **Step 1: Check whether the docs describe the old behavior**

```bash
grep -n "rate-limit\|rateLimitStore\|cooldown\|10 min\|exhaust" docs/profiles.md ARCHITECTURE.md
```

If a passage states that the rate-limit snapshot is cleared on profile switch, or describes the cooldown as coming from a single global snapshot, update it to describe per-profile scoping and the three-tier resolution (own entry → OAuth usage → 10-minute default). If no such passage exists, skip to Step 2 and note that in the commit.

- [ ] **Step 2: Run the full suite**

```bash
npm test
```

Expected: PASS. Pay particular attention to `proxy-usage-quota-route.test.ts`, `priority-routing-integration.test.ts`, `rate-limit-store.test.ts`, and `oauth-usage.test.ts` (the last must be unaffected — the `_testOverride` seam is bypassed when a test passes `store` or `fetchImpl`).

- [ ] **Step 3: Typecheck and build**

```bash
npx tsc --noEmit && npm run build
```

Expected: both silent/successful.

- [ ] **Step 4: Commit and open the PR**

```bash
git -c commit.gpgsign=false add -A
git -c commit.gpgsign=false commit -m "docs: describe per-profile rate-limit scoping"
git push origin fix/profile-scoped-rate-limit-store
gh pr create --base main --title "fix: scope rate-limit store per profile so priority cooldowns use the right account's reset"
```

The PR body must call out the user-visible behavior change flagged in the spec's Risks section: a profile with no recorded SDK events now returns OAuth-only buckets from `GET /v1/usage/quota` where it previously showed another profile's SDK data, and the rate-limit snapshot now survives a profile switch.

- [ ] **Step 5: Wait for CI**

```bash
gh pr checks <PR_NUMBER> --watch
```

Expected: the `test` job passes. Do not merge until it is green.

---

## Verification Summary

| Spec requirement | Task |
|---|---|
| Nested `Map<profileId, Map<bucket, entry>>` storage | 1 |
| `profileId` required on `record`/`getAll`/`get` | 1 |
| `clear(profileId?)` scoped or global | 1 |
| `size` getter → method | 1 |
| Module doc comment corrected | 1 |
| `record(profile.id, …)` at both SDK-event sites | 2 |
| `/v1/usage/quota` reads scoped entries | 2 |
| `POST /profiles/active` clear removed | 2 |
| `POST /auth/refresh` clear scoped | 2 |
| Tier 1 — own scoped `five_hour` entry | 3 |
| Tier 2 — non-blocking `fetchOAuthUsage` refinement | 3 |
| Tier 3 — 10-minute default | 3 |
| Refinement can only extend, never shorten | 3 |
| 6h cap preserved on both paths | 3 |
| Cross-profile regression test | 3 |
| Docs | 4 |

Out of scope per the spec, and deliberately absent from every task: threshold steering (priority spec §5), the `priorityAssignments` FIFO eviction quirk, and persisting rate-limit state across restarts.
