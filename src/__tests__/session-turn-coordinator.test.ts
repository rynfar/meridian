import { describe, expect, test } from "bun:test"
import { SessionTurnCoordinator } from "../proxy/session/turnCoordinator"

describe("session turn coordinator", () => {
  test("serializes the same key but not different keys", async () => {
    const coordinator = new SessionTurnCoordinator()
    const first = await coordinator.acquire("id:a")
    let sameResolved = false
    const sameP = coordinator.acquire("id:a").then(lease => { sameResolved = true; return lease })
    const other = await coordinator.acquire("id:b")
    await Promise.resolve()
    expect(sameResolved).toBe(false)
    other.release()
    first.release()
    const same = await sameP
    same.release()
  })

  test("reports advancement only after a preceding committed turn", async () => {
    const coordinator = new SessionTurnCoordinator()
    const first = await coordinator.acquire("id:a")
    const secondP = coordinator.acquire("id:a")
    // Twice on purpose: silent-turn recovery re-stores the same turn, which
    // must count as one advancement, not two.
    first.markCommitted("work:a")
    first.markCommitted("work:a")
    first.release()
    const second = await secondP
    expect(second.advancedWhileWaiting("work:a")).toBe(true)
    second.release()

    const failed = await coordinator.acquire("id:a")
    const afterFailureP = coordinator.acquire("id:a")
    failed.release()
    const afterFailure = await afterFailureP
    expect(afterFailure.advancedWhileWaiting("work:a")).toBe(false)
    afterFailure.release()
  })

  test("reports advancement per scope, not across scopes", async () => {
    // One client session id backing two profiles is two independent
    // conversations: a commit under one must not invalidate the other.
    const coordinator = new SessionTurnCoordinator()
    const first = await coordinator.acquire("id:a")
    const secondP = coordinator.acquire("id:a")
    first.markCommitted("work:a")
    first.release()

    const second = await secondP
    expect(second.advancedWhileWaiting("work:a")).toBe(true)
    expect(second.advancedWhileWaiting("personal:a")).toBe(false)
    second.release()
  })

  test("cancelled waiter does not block following waiter and state is cleaned", async () => {
    const coordinator = new SessionTurnCoordinator()
    const first = await coordinator.acquire("id:a")
    const controller = new AbortController()
    const cancelled = coordinator.acquire("id:a", controller.signal)
    const nextP = coordinator.acquire("id:a")
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" })
    first.release()
    const next = await nextP
    next.release()
    expect(coordinator.size).toBe(0)
  })
})
