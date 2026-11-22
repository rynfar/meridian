import { describe, expect, test } from "bun:test"
import { FACTS_REFRESH_FAILURE_TTL_MS, ProfileFactsRefresh } from "../proxy/profileFactsRefresh"

function deferred() {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe("ProfileFactsRefresh", () => {
  test("a profile is updating from the moment the run starts until its reads finish", async () => {
    let now = 1_000
    const tracker = new ProfileFactsRefresh(() => now)
    const gate = deferred()
    const done = tracker.run("work", () => gate.promise)
    // Synchronous: the sign-in route answers after this, so no poll can see
    // the profile in between.
    expect(tracker.view("work")).toEqual({ state: "updating", since: 1_000 })
    gate.resolve()
    await done
    expect(tracker.view("work")).toBeNull()
  })

  test("a failure stays readable with its reason, then expires", async () => {
    let now = 1_000
    const tracker = new ProfileFactsRefresh(() => now)
    await tracker.run("work", async () => { now = 1_500; throw new Error("Anthropic did not answer") })
    expect(tracker.view("work")).toEqual({ state: "failed", since: 1_000, at: 1_500, error: "Anthropic did not answer" })
    now = 1_500 + FACTS_REFRESH_FAILURE_TTL_MS
    expect(tracker.view("work")).toBeNull()
  })

  test("a newer login supersedes an older run's outcome", async () => {
    const tracker = new ProfileFactsRefresh(() => 1)
    const first = deferred()
    const second = deferred()
    const a = tracker.run("work", () => first.promise)
    const b = tracker.run("work", () => second.promise)
    first.reject(new Error("stale"))
    await a
    expect(tracker.view("work")?.state).toBe("updating")
    second.resolve()
    await b
    expect(tracker.view("work")).toBeNull()
  })

  test("profiles are tracked independently", async () => {
    const tracker = new ProfileFactsRefresh(() => 1)
    const gate = deferred()
    const pending = tracker.run("a", () => gate.promise)
    await tracker.run("b", async () => {})
    expect(tracker.view("a")?.state).toBe("updating")
    expect(tracker.view("b")).toBeNull()
    gate.resolve()
    await pending
  })

  test("a removed or renamed profile is forgotten, and its run's outcome dropped", async () => {
    const tracker = new ProfileFactsRefresh(() => 1)
    const gate = deferred()
    const pending = tracker.run("old-name", () => gate.promise)
    tracker.forget("old-name")
    expect(tracker.view("old-name")).toBeNull()
    gate.reject(new Error("late"))
    await pending
    expect(tracker.view("old-name")).toBeNull()
  })
})
