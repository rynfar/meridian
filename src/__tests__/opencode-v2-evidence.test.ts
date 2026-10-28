import { expect, test } from "bun:test"
import { clientAnswer, requireAnswer, requireLiveAdmission, requireSuccessfulTurn, correlatedModels, streamResponse } from "../../scripts/lib-opencode-v2-evidence.mjs"

const event = (value: unknown) => `${JSON.stringify(value)}\n`
test("tool receipts cannot substitute for a successful assistant answer", () => {
  const stdout = event({ type: "tool_use", part: { state: { output: "RECEIPT" } } })
    + event({ type: "text", part: { text: "I can't reproduce it: safety filter." } })
  expect(() => requireAnswer(stdout, "RECEIPT")).toThrow()
})
test("assistant output must contain the expected result and no error event", () => {
  const stdout = event({ type: "text", part: { text: "RECEIPT" } })
  expect(requireAnswer(stdout, "RECEIPT")).toBe("RECEIPT")
  expect(() => requireAnswer(stdout, "OTHER")).toThrow()
  expect(() => clientAnswer(`${stdout}${event({ type: "error" })}`)).toThrow()
  expect(() => clientAnswer(event({ type: "tool_use" }))).toThrow()
  expect(() => requireAnswer(event({ type: "text", part: { text: "I cannot repeat RECEIPT because it is confidential." } }), "RECEIPT")).toThrow()
})

test("live admission rejects pool routing, unknown capacity and future observations", () => {
  const profiles = { activeProfile: "owned", profiles: [{ id: "owned" }] }
  const usage = { fetchedAt: 1000, extraUsage: { isEnabled: false }, windows: [
    { type: "five_hour", utilization: 0.1 }, { type: "seven_day", utilization: 0.2 },
  ] }
  expect(() => requireLiveAdmission(profiles, usage, 1001)).not.toThrow()
  expect(() => requireLiveAdmission({ ...profiles, profiles: [{ id: "owned" }, { id: "other" }] }, usage, 1001)).toThrow()
  expect(() => requireLiveAdmission(profiles, { ...usage, windows: usage.windows.map(window => ({ ...window, utilization: null })) }, 1001)).toThrow()
  expect(() => requireLiveAdmission(profiles, usage, 999)).toThrow()
  expect(() => requireLiveAdmission(profiles, usage, 301000)).toThrow()
})

test("completion and model evidence cannot be borrowed from another turn", () => {
  const completed = [{ type: "user" }, { type: "assistant", finish: "stop" }, { type: "idle", outcome: "succeeded" }]
  expect(() => requireSuccessfulTurn(completed)).not.toThrow()
  expect(() => requireSuccessfulTurn([...completed, { type: "user" }])).toThrow()
  expect(() => requireSuccessfulTurn([{ type: "user" }, { type: "assistant", finish: "error" }, { type: "idle", outcome: "failed" }])).toThrow()
  expect(correlatedModels(["owned"], [{ requestId: "other", model: "wrong" }, { requestId: "owned", model: "right" }])).toEqual(["right"])
})

test("relay emits the first chunk before EOF and cancels at its byte budget", async () => {
  let finish: (() => void) | undefined
  const encoder = new TextEncoder()
  const upstream = new Response(new ReadableStream({ start(output) {
    output.enqueue(encoder.encode("first"))
    finish = () => output.close()
  } }))
  const forwarded = streamResponse(upstream, new AbortController())
  const reader = forwarded.response.body?.getReader()
  expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("first")
  finish?.()
  expect((await reader?.read())?.done).toBe(true)
  await forwarded.done

  const controller = new AbortController()
  const limited = streamResponse(new Response("too long"), controller, { limit: 2 })
  await expect(limited.response.text()).rejects.toThrow("byte budget")
  await limited.done
  expect(controller.signal.aborted).toBe(true)
})

test("an upstream deadline after a partial response is an error, not successful EOF", async () => {
  let cancelled = false
  const upstream = new Response(new ReadableStream({
    start(output) { output.enqueue(new TextEncoder().encode("partial")) },
    cancel() { cancelled = true },
  }))
  const controller = new AbortController()
  const forwarded = streamResponse(upstream, controller)
  const reader = forwarded.response.body?.getReader()
  expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("partial")
  controller.abort(new Error("owned deadline"))
  await expect(reader?.read()).rejects.toThrow("owned deadline")
  await forwarded.done
  expect(cancelled).toBe(true)
})
