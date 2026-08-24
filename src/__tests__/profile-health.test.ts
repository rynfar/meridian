/**
 * Refusal bookkeeping: the latest refusal per account, and the event ring a
 * supervisor polls.
 *
 * The event tests are mostly about one property - a consumer that keeps
 * following `nextSince` can never skip an event - because the surface exists
 * precisely to fix `/telemetry/requests`, which has no cursor and therefore
 * cannot tell "nothing happened" from "it scrolled past between polls".
 */
import { describe, it, expect } from "bun:test"
import { SpentStore, FailoverEventLog, type FailoverEvent } from "../proxy/profileHealth"
import type { LimitDiagnosis } from "../proxy/limitDetection"

function diagnosis(over: Partial<LimitDiagnosis> = {}): LimitDiagnosis {
  return {
    bucket: "five_hour",
    reported: true,
    source: "error_message",
    resetsAt: null,
    rationale: "test",
    ...over,
  }
}

describe("SpentStore", () => {
  it("holds a refusal and reports it back", () => {
    let now = 1_000_000
    const store = new SpentStore(() => now)
    store.record("corp4", diagnosis({ resetsAt: now + 60_000 }), "You've hit your session limit")
    const record = store.get("corp4")
    expect(record?.profileId).toBe("corp4")
    expect(record?.until).toBe(now + 60_000)
    expect(record?.diagnosis.bucket).toBe("five_hour")
  })

  it("expires on read once the window is expected back", () => {
    let now = 1_000_000
    const store = new SpentStore(() => now)
    store.record("corp4", diagnosis({ resetsAt: now + 60_000 }), "msg")
    now += 59_000
    expect(store.get("corp4")).toBeDefined()
    now += 2_000
    expect(store.get("corp4")).toBeUndefined()
    expect(store.snapshot()).toHaveLength(0)
  })

  it("falls back to a bounded default when nothing said when the window reopens", () => {
    let now = 1_000_000
    const store = new SpentStore(() => now)
    store.record("corp4", diagnosis({ resetsAt: null }), "msg")
    expect(store.get("corp4")!.until).toBe(now + 10 * 60_000)
  })

  it("caps an implausibly distant reset rather than hiding an account for a day", () => {
    let now = 1_000_000
    const store = new SpentStore(() => now)
    store.record("corp4", diagnosis({ resetsAt: now + 48 * 60 * 60_000 }), "msg")
    expect(store.get("corp4")!.until).toBe(now + 6 * 60 * 60_000)
  })

  it("lets the newest refusal replace an older one, unlike an exhaustion mark", () => {
    let now = 1_000_000
    const store = new SpentStore(() => now)
    store.record("corp4", diagnosis({ bucket: "seven_day", resetsAt: now + 60 * 60_000 }), "weekly")
    now += 1_000
    store.record("corp4", diagnosis({ bucket: "five_hour", resetsAt: now + 60_000 }), "session")
    expect(store.get("corp4")!.diagnosis.bucket).toBe("five_hour")
    expect(store.get("corp4")!.until).toBe(now + 60_000)
  })

  it("keeps accounts apart", () => {
    const store = new SpentStore()
    store.record("corp4", diagnosis(), "msg")
    expect(store.get("corp5")).toBeUndefined()
    expect(store.snapshot().map(r => r.profileId)).toEqual(["corp4"])
  })

  it("truncates the raw message so a huge SDK dump cannot bloat the payload", () => {
    const store = new SpentStore()
    store.record("corp4", diagnosis(), "x".repeat(5000))
    expect(store.get("corp4")!.message.length).toBeLessThanOrEqual(301)
  })
})

function refusal(profile: string): Omit<FailoverEvent, "seq" | "at"> {
  return {
    kind: "refused",
    profile,
    servedBy: null,
    reason: "rate_limit_error",
    routing: "active+priority",
    sessionKey: null,
    internalHop: false,
    until: null,
    limit: null,
  }
}

describe("FailoverEventLog", () => {
  it("numbers events from 1, monotonically", () => {
    const log = new FailoverEventLog()
    expect(log.append(refusal("a")).seq).toBe(1)
    expect(log.append(refusal("b")).seq).toBe(2)
  })

  it("returns everything retained for a cold consumer", () => {
    const log = new FailoverEventLog()
    log.append(refusal("a"))
    log.append(refusal("b"))
    const page = log.since(0)
    expect(page.events.map(e => e.profile)).toEqual(["a", "b"])
    expect(page.nextSince).toBe(2)
    expect(page.dropped).toBe(false)
  })

  it("returns events oldest-first so a consumer can act on them in order", () => {
    const log = new FailoverEventLog()
    log.append(refusal("a"))
    log.append(refusal("b"))
    log.append(refusal("c"))
    expect(log.since(0).events.map(e => e.seq)).toEqual([1, 2, 3])
  })

  it("returns only what is new since the cursor", () => {
    const log = new FailoverEventLog()
    log.append(refusal("a"))
    const first = log.since(0)
    log.append(refusal("b"))
    const second = log.since(first.nextSince)
    expect(second.events.map(e => e.profile)).toEqual(["b"])
  })

  it("reports an empty page without moving the cursor, so nothing is skipped", () => {
    const log = new FailoverEventLog()
    log.append(refusal("a"))
    const first = log.since(0)
    const idle = log.since(first.nextSince)
    expect(idle.events).toHaveLength(0)
    expect(idle.nextSince).toBe(first.nextSince)
  })

  it("MISSES NOTHING when a page is truncated by limit", () => {
    // The property the whole cursor exists for: nextSince is the last RETURNED
    // seq, never the newest held, so a truncated page resumes exactly where it
    // stopped. Returning the newest would silently drop events 2 and 3 here.
    const log = new FailoverEventLog()
    log.append(refusal("a"))
    log.append(refusal("b"))
    log.append(refusal("c"))
    const first = log.since(0, 1)
    expect(first.events.map(e => e.profile)).toEqual(["a"])
    expect(first.nextSince).toBe(1)
    const second = log.since(first.nextSince, 1)
    expect(second.events.map(e => e.profile)).toEqual(["b"])
    const third = log.since(second.nextSince, 1)
    expect(third.events.map(e => e.profile)).toEqual(["c"])
    expect(log.since(third.nextSince).events).toHaveLength(0)
  })

  it("MISSES NOTHING when events arrive between two polls", () => {
    const log = new FailoverEventLog()
    const seen: string[] = []
    let cursor = 0
    for (const batch of [["a", "b"], ["c"], [], ["d", "e", "f"]]) {
      for (const profile of batch) log.append(refusal(profile))
      const page = log.since(cursor)
      for (const e of page.events) seen.push(e.profile)
      cursor = page.nextSince
    }
    expect(seen).toEqual(["a", "b", "c", "d", "e", "f"])
  })

  it("says so when the ring evicted events the consumer had not read", () => {
    const log = new FailoverEventLog(3)
    for (const p of ["a", "b", "c", "d", "e"]) log.append(refusal(p))
    const page = log.since(1)
    expect(page.oldestSeq).toBe(3)
    expect(page.dropped).toBe(true)
    expect(page.events.map(e => e.seq)).toEqual([3, 4, 5])
  })

  it("does not claim a drop for a consumer that is exactly caught up", () => {
    const log = new FailoverEventLog(3)
    for (const p of ["a", "b", "c", "d"]) log.append(refusal(p))
    expect(log.since(1).dropped).toBe(false)
    expect(log.since(0).dropped).toBe(false)
  })

  it("keeps the ring bounded", () => {
    const log = new FailoverEventLog(2)
    for (const p of ["a", "b", "c", "d"]) log.append(refusal(p))
    const page = log.since(0)
    expect(page.events.map(e => e.profile)).toEqual(["c", "d"])
    expect(page.latestSeq).toBe(4)
    expect(page.capacity).toBe(2)
  })

  it("treats a nonsense cursor or limit as a cold start rather than erroring", () => {
    const log = new FailoverEventLog()
    log.append(refusal("a"))
    expect(log.since(Number.NaN).events).toHaveLength(1)
    expect(log.since(-5).events).toHaveLength(1)
    expect(log.since(0, 0).events).toHaveLength(1)
  })
})
