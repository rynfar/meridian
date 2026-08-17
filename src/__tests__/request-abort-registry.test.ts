import { describe, expect, test } from "bun:test"
import { createRequestAbortRegistry, linkRequestAbort } from "../proxy/requestAbort"

describe("linkRequestAbort", () => {
  test("forwards a later HTTP abort to the SDK controller", () => {
    const httpAbort = new AbortController()
    const link = linkRequestAbort(httpAbort.signal)

    expect(link.controller.signal.aborted).toBe(false)
    httpAbort.abort("client went away")
    expect(link.controller.signal.aborted).toBe(true)
    expect(link.controller.signal.reason).toBe("client went away")
  })

  test("propagates an already-aborted signal immediately", () => {
    const httpAbort = new AbortController()
    httpAbort.abort("gone")
    const link = linkRequestAbort(httpAbort.signal)
    expect(link.controller.signal.aborted).toBe(true)
  })
})

describe("createRequestAbortRegistry", () => {
  test("aborts every tracked link once and reports how many it aborted", () => {
    const registry = createRequestAbortRegistry()
    const first = registry.link(new AbortController().signal)
    const second = registry.link(new AbortController().signal)

    expect(registry.size()).toBe(2)
    expect(registry.abortAll("shutting down")).toBe(2)
    expect(first.controller.signal.aborted).toBe(true)
    expect(second.controller.signal.aborted).toBe(true)
    expect(first.controller.signal.reason).toBe("shutting down")

    // Already-aborted links are not counted a second time.
    expect(registry.abortAll("shutting down")).toBe(0)
  })

  test("skips a link that already aborted on its own", () => {
    const registry = createRequestAbortRegistry()
    const clientGone = new AbortController()
    registry.link(clientGone.signal)
    const live = registry.link(new AbortController().signal)

    clientGone.abort("client cancelled")
    expect(registry.abortAll("shutting down")).toBe(1)
    expect(live.controller.signal.reason).toBe("shutting down")
  })

  test("detach untracks the link so a finished request cannot be aborted later", () => {
    const registry = createRequestAbortRegistry()
    const link = registry.link(new AbortController().signal)
    expect(registry.size()).toBe(1)

    link.detach()
    expect(registry.size()).toBe(0)
    expect(registry.abortAll("shutting down")).toBe(0)
    expect(link.controller.signal.aborted).toBe(false)
  })

  test("detach untracks a link created from an already-aborted signal", () => {
    // linkRequestAbort never attaches a listener in this case, so its own
    // detach() is a no-op — the registry must still drop the entry or a
    // pre-aborted request would leak for the lifetime of the process.
    const registry = createRequestAbortRegistry()
    const gone = new AbortController()
    gone.abort("already gone")
    const link = registry.link(gone.signal)
    expect(registry.size()).toBe(1)

    link.detach()
    expect(registry.size()).toBe(0)
  })

  test("registries are independent: one instance's shutdown cannot abort another's", () => {
    const a = createRequestAbortRegistry()
    const b = createRequestAbortRegistry()
    const linkA = a.link(new AbortController().signal)
    const linkB = b.link(new AbortController().signal)

    expect(a.abortAll("shutting down")).toBe(1)
    expect(linkA.controller.signal.aborted).toBe(true)
    expect(linkB.controller.signal.aborted).toBe(false)
  })
})
