import { createServer, get, type IncomingMessage, type ServerResponse } from "node:http"
import { describe, expect, test } from "bun:test"
import { closeServerWithGracePeriod, joinShutdownCleanup, ShutdownProgress, trackServerConnections, withShutdownDeadline } from "../proxy/shutdown"

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

describe("joinShutdownCleanup", () => {
  test("releases ChatGPT ownership while durable cleanup is still running", async () => {
    let finishDurable = () => {}
    const durableRunning = new Promise<void>((resolve) => { finishDurable = resolve })
    let chatGptReleased!: () => void
    const released = new Promise<void>((resolve) => { chatGptReleased = resolve })

    const joined = joinShutdownCleanup({
      idle: Promise.resolve(),
      durable: () => durableRunning,
      chatGpt: async () => { chatGptReleased() },
    })

    await released
    finishDurable()
    await joined
  })

  test("waits for admitted work before releasing ChatGPT ownership", async () => {
    let finishIdle = () => {}
    const idle = new Promise<void>((resolve) => { finishIdle = resolve })
    const order: string[] = []

    const joined = joinShutdownCleanup({
      idle,
      durable: async () => { order.push("durable") },
      chatGpt: async () => { order.push("chatGpt") },
    })
    await Promise.resolve()
    expect(order).toEqual([])

    finishIdle()
    await joined
    expect(order.sort()).toEqual(["chatGpt", "durable"])
  })

  test("still releases ChatGPT ownership when durable cleanup fails, and reports the failure", async () => {
    let released = false

    const joined = joinShutdownCleanup({
      idle: Promise.resolve(),
      durable: async () => { throw new Error("sweep failed") },
      chatGpt: async () => { released = true },
    })

    await expect(joined).rejects.toThrow("sweep failed")
    expect(released).toBe(true)
  })
})

describe("shutdown cleanup progress", () => {
  test("names the cleanup step still running when the deadline passes", async () => {
    const progress = new ShutdownProgress()
    let finishGc = () => {}
    const gc = new Promise<void>((resolve) => { finishGc = resolve })
    const joined = joinShutdownCleanup({
      idle: Promise.resolve(),
      durable: () => progress.run("session GC sweep", () => gc),
      chatGpt: async () => {},
    }, progress)

    const outcome = await withShutdownDeadline(joined, 50, { describe: () => progress.describe() })
      .then(() => "joined", (error: Error) => error.message)

    expect(outcome).toContain("session GC sweep still running")
    expect(outcome).toMatch(/ChatGPT release [0-9]+ms/)
    finishGc()
    await joined
  })

  test("warns about slow cleanup without failing a shutdown that still joins in time", async () => {
    const warnings: string[] = []
    const progress = new ShutdownProgress()
    let finishBackend = () => {}
    const backend = new Promise<void>((resolve) => { finishBackend = resolve })
    const joined = joinShutdownCleanup({
      idle: Promise.resolve(),
      durable: () => progress.run("backend close", () => backend),
      chatGpt: async () => {},
    }, progress)

    const closing = withShutdownDeadline(joined, 5_000, {
      slowAfterMs: 20,
      describe: () => progress.describe(),
      warn: (message) => {
        warnings.push(message)
        finishBackend()
      },
    })

    await closing
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("backend close still running")
  })
})
