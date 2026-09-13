/**
 * Unit tests for the abort-cause registry on RequestAbortLink (FIX A).
 *
 * The registry latches the FIRST classified cause of a request abort so the
 * sdk_termination diagnostic can distinguish "the client hung up" from "the
 * watchdog fired" from "nothing Meridian linked ever aborted" (the latter is
 * `none`, which is the discriminating marker for the uncaptured-tool-turn
 * incident — it is NOT proof that no CLI-internal abort occurred).
 */
import { describe, expect, test } from "bun:test"
import { linkRequestAbort } from "../proxy/requestAbort"

describe("linkRequestAbort cause registry", () => {
  test("no abort — snapshot reports cause none, aborted false", () => {
    const controller = new AbortController()
    const link = linkRequestAbort(controller.signal)
    const snap = link.abortSnapshot()
    expect(snap.aborted).toBe(false)
    expect(snap.cause).toBe("none")
    link.detach()
  })

  test("client_abort classified before forwarding wins as first cause", () => {
    const controller = new AbortController()
    const link = linkRequestAbort(controller.signal)
    link.setCause("client_abort")
    link.abort(new Error("client hung up"))
    const snap = link.abortSnapshot()
    expect(snap.aborted).toBe(true)
    expect(snap.cause).toBe("client_abort")
    expect(link.controller.signal.aborted).toBe(true)
    link.detach()
  })

  test("abort without setCause — snapshot reports unknown_abort", () => {
    const controller = new AbortController()
    const link = linkRequestAbort(controller.signal)
    link.abort(new Error("mystery"))
    const snap = link.abortSnapshot()
    expect(snap.aborted).toBe(true)
    expect(snap.cause).toBe("unknown_abort")
    link.detach()
  })

  test("first cause wins over later labels", () => {
    const controller = new AbortController()
    const link = linkRequestAbort(controller.signal)
    link.setCause("session_watchdog")
    link.setCause("client_abort")
    link.abort(new Error("watchdog elapsed"))
    const snap = link.abortSnapshot()
    expect(snap.cause).toBe("session_watchdog")
    link.detach()
  })

  test("already-aborted signal forwards reason and snapshots unknown_abort", () => {
    const controller = new AbortController()
    controller.abort(new Error("already gone"))
    const link = linkRequestAbort(controller.signal)
    const snap = link.abortSnapshot()
    expect(snap.aborted).toBe(true)
    expect(snap.cause).toBe("unknown_abort")
    // forwardAbort ran for the pre-aborted signal; the linked controller is hot.
    expect(link.controller.signal.aborted).toBe(true)
    expect((link.controller.signal.reason as Error).message).toBe("already gone")
    link.detach()
  })

  test("already-aborted signal with a prior label keeps the label", () => {
    const controller = new AbortController()
    controller.abort(new Error("gone"))
    const link = linkRequestAbort(controller.signal)
    link.setCause("process_shutdown")
    expect(link.abortSnapshot().cause).toBe("process_shutdown")
    link.detach()
  })

  test("direct controller.abort bypassing the helper surfaces as unknown_abort", () => {
    const controller = new AbortController()
    const link = linkRequestAbort(controller.signal)
    link.controller.abort(new Error("third party abort"))
    const snap = link.abortSnapshot()
    expect(snap.aborted).toBe(true)
    expect(snap.cause).toBe("unknown_abort")
    link.detach()
  })

  test("detached link stops forwarding but keeps its snapshot", () => {
    const controller = new AbortController()
    const link = linkRequestAbort(controller.signal)
    link.detach()
    link.setCause("client_abort")
    link.abort(new Error("after detach"))
    expect(link.abortSnapshot().cause).toBe("client_abort")
    expect(link.abortSnapshot().aborted).toBe(true)
  })

  test("signal.reason payload is preserved through abort", () => {
    const controller = new AbortController()
    const link = linkRequestAbort(controller.signal)
    link.setCause("stream_cancel")
    link.abort(new Error("body cancelled"))
    expect((link.controller.signal.reason as Error).message).toBe("body cancelled")
    expect(link.abortSnapshot().cause).toBe("stream_cancel")
    link.detach()
  })

  test("abortSnapshot exposes monotonic elapsedMs between link and abort", () => {
    const controller = new AbortController()
    const link = linkRequestAbort(controller.signal)
    link.abort()
    const snap = link.abortSnapshot()
    expect(snap.elapsedMs).toBeGreaterThanOrEqual(0)
    link.detach()
  })

  test("elapsedMs is undefined when never aborted", () => {
    const controller = new AbortController()
    const link = linkRequestAbort(controller.signal)
    expect(link.abortSnapshot().elapsedMs).toBeUndefined()
    link.detach()
  })
})

/**
 * Maintainer guard. The commit that introduced `abort=<cause>` described all
 * five `formatSdkTermination` call sites as passing the snapshot; one of them —
 * `sdk_termination_recovered` on the captured-tool recovery path — did not, so
 * the field was silently absent from the diagnostic closest to the incident it
 * was written for. Nothing failed, because an omitted context field just does
 * not render.
 *
 * The fixtures in `e2e-capped-turns.mjs` never reach that site, so no live gate
 * covers it. This pins the invariant at the source instead.
 */
describe("every SDK termination diagnostic carries an abort cause", () => {
  test("each formatSdkTermination call site passes the snapshot", async () => {
    const source = await Bun.file(new URL("../proxy/server.ts", import.meta.url)).text()
    const callSites = source.match(/formatSdkTermination\(/g) ?? []
    const snapshots = source.match(/abort: requestAbort\.abortSnapshot\(\)/g) ?? []
    expect(callSites.length).toBeGreaterThan(0)
    expect(snapshots.length).toBe(callSites.length)
  })
})
