import { expect, it } from "bun:test"
import { guardUpstreamIdle, UpstreamIdleError } from "../proxy/streamIdleGuard"
import { createSseRelayStream } from "../proxy/sseFailureSniff"

it("keeps downstream SSE alive without extending a ping-only SDK progress deadline", async () => {
  const abort = new AbortController()
  let sdkPings = 0
  let outcome: unknown
  async function* source() {
    // Bound the negative control too: a guard that counts pings as progress ends
    // normally and fails the idle-error assertion rather than hanging this test.
    const end = performance.now() + 250
    while (!abort.signal.aborted && performance.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 5))
      sdkPings++
      yield { type: "stream_event", event: { type: "ping" } }
    }
  }
  const stream = createSseRelayStream(async sink => {
    try {
      for await (const value of guardUpstreamIdle(source(), 80, () => abort.abort())) {
        await sink.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
      }
    } catch (error) {
      outcome = error
      sink.onMeaningfulForwarded()
      await sink.enqueue(new TextEncoder().encode('event: error\ndata: {"error":{"type":"api_error"}}\n\n'))
    }
  }, () => abort.abort(), 5)
  const response = new Response(stream, { headers: { "content-type": "text/event-stream" } })
  expect(response.headers.get("content-type")).toBe("text/event-stream")
  const text = await response.text()
  expect(text.startsWith(": ping\n\n")).toBe(true)
  expect(sdkPings).toBeGreaterThan(0)
  expect(outcome).toBeInstanceOf(UpstreamIdleError)
  expect(text).toContain("event: error\n")
  expect(text).not.toContain('"stream_event"')
  expect(abort.signal.aborted).toBe(true)
}, 3000)
