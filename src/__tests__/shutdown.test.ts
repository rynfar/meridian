import { createServer, get, type IncomingMessage, type ServerResponse } from "node:http"
import { describe, expect, test } from "bun:test"
import {
  closeServerWithGracePeriod,
  computeSettleReserveMs,
  SHUTDOWN_ABORT_REASON,
  trackServerConnections,
} from "../proxy/shutdown"

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP server address")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

describe("closeServerWithGracePeriod", () => {
  test("allows an active request to finish naturally within the grace period", async () => {
    let releaseResponse = () => {}
    let markStarted = () => {}
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const release = new Promise<void>((resolve) => { releaseResponse = resolve })
    const warnings: string[] = []
    let inFlight = 1
    const { server, url } = await listen(async (request, response) => {
      if (request.url === "/health") {
        response.end("draining")
        return
      }
      markStarted()
      await release
      inFlight = 0
      response.end("ok")
    })

    const responseP = fetch(url)
    await started
    const closeP = closeServerWithGracePeriod(server, {
      graceMs: 500,
      getInFlightCount: () => inFlight,
      warn: (message) => warnings.push(message),
    })
    expect(await (await fetch(`${url}/health`)).text()).toBe("draining")
    releaseResponse()

    await closeP
    expect(await (await responseP).text()).toBe("ok")
    expect(warnings).toEqual([])
  })

  test("forcibly closes a stuck connection when the grace period elapses", async () => {
    let markStarted = () => {}
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const warnings: string[] = []
    const { server, url } = await listen((_request, response) => {
      response.writeHead(200)
      response.write("still running")
      markStarted()
    })
    const connectionTracker = trackServerConnections(server)
    const request = get(url)
    request.on("error", () => {})
    request.on("response", (response) => response.on("error", () => {}))
    await started

    const beganAt = Date.now()
    await closeServerWithGracePeriod(server, {
      graceMs: 20,
      getInFlightCount: () => 1,
      warn: (message) => warnings.push(message),
      forceCloseConnections: () => connectionTracker.forceCloseAll(),
    })

    expect(Date.now() - beganAt).toBeLessThan(500)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("forcing remaining HTTP connections closed")
    connectionTracker.dispose()
    request.destroy()
  })
})

describe("computeSettleReserveMs", () => {
  test("reserves a tenth of the grace window, capped at 2s", () => {
    expect(computeSettleReserveMs(30_000)).toBe(2_000)
    expect(computeSettleReserveMs(5_000)).toBe(500)
    expect(computeSettleReserveMs(0)).toBe(0)
  })

  test("never reserves more than the whole budget, however it is asked for", () => {
    // The reserve is carved OUT of graceMs; returning more than the budget
    // would push the abort before the close even began.
    expect(computeSettleReserveMs(100, 5_000)).toBe(100)
    expect(computeSettleReserveMs(100, -1)).toBe(0)
    expect(computeSettleReserveMs(100, Number.NaN)).toBe(0)
    expect(computeSettleReserveMs(100, Number.POSITIVE_INFINITY)).toBe(0)
    expect(computeSettleReserveMs(100, 40)).toBe(40)
  })
})

describe("closeServerWithGracePeriod — request settlement", () => {
  test("does not abort anything when requests drain naturally", async () => {
    const { server } = await listen((_request, response) => response.end("ok"))
    let inFlight = 1
    setTimeout(() => { inFlight = 0 }, 10).unref?.()
    let abortCalls = 0
    const warnings: string[] = []

    await closeServerWithGracePeriod(server, {
      graceMs: 500,
      getInFlightCount: () => inFlight,
      warn: (message) => warnings.push(message),
      abortInFlight: () => { abortCalls++; return 0 },
    })

    expect(abortCalls).toBe(0)
    expect(warnings).toEqual([])
  })

  test("aborts in-flight requests and waits for them to settle before resolving", async () => {
    // The ordering this pins is the whole point of the fix: bin/cli.ts calls
    // process.exit(0) the instant close() resolves, so "aborted" and "drained"
    // must both happen strictly before that resolution.
    const { server } = await listen((_request, response) => response.end("ok"))
    const order: string[] = []
    const warnings: string[] = []
    let inFlight = 1
    let abortReason: unknown

    const closeP = closeServerWithGracePeriod(server, {
      graceMs: 400,
      settleReserveMs: 300,
      getInFlightCount: () => inFlight,
      warn: (message) => warnings.push(message),
      abortInFlight: (reason) => {
        abortReason = reason
        order.push("aborted")
        // Settling is async in production too (SDK generator cleanup, session
        // store write), so the abort only STARTS the unwind.
        setTimeout(() => {
          inFlight = 0
          order.push("settled")
        }, 30).unref?.()
        return 1
      },
    })
    await closeP
    order.push("closed")

    expect(order).toEqual(["aborted", "settled", "closed"])
    expect(abortReason).toBe(SHUTDOWN_ABORT_REASON)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("Aborting 1 in-flight request(s)")
    // Settled inside the budget, so the forced-teardown path never ran.
    expect(warnings.join("\n")).not.toContain("forcing remaining HTTP connections closed")
  })

  test("a request that refuses to settle still cannot hang shutdown past the deadline", async () => {
    let markStarted = () => {}
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const warnings: string[] = []
    const { server, url } = await listen((_request, response) => {
      response.writeHead(200)
      response.write("still running")
      markStarted()
    })
    const connectionTracker = trackServerConnections(server)
    const request = get(url)
    request.on("error", () => {})
    request.on("response", (response) => response.on("error", () => {}))
    await started

    let abortCalls = 0
    const beganAt = Date.now()
    await closeServerWithGracePeriod(server, {
      graceMs: 120,
      settleReserveMs: 60,
      // Never drops to 0: the request ignores its abort entirely.
      getInFlightCount: () => 1,
      warn: (message) => warnings.push(message),
      forceCloseConnections: () => connectionTracker.forceCloseAll(),
      abortInFlight: () => { abortCalls++; return 1 },
    })
    const elapsed = Date.now() - beganAt

    expect(abortCalls).toBe(1)
    // Bounded by the SAME graceMs budget the abort was carved out of — the
    // settlement wait must not stack a second timeout on top of the deadline.
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(elapsed).toBeLessThan(1_000)
    expect(warnings.some((message) => message.includes("Aborting 1 in-flight request(s)"))).toBe(true)
    expect(warnings.some((message) => message.includes("forcing remaining HTTP connections closed"))).toBe(true)
    connectionTracker.dispose()
    request.destroy()
  })
})
