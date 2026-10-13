import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { DetachedLifecycle } from "../cli/detachedProtocol"
import { listenDetachedControl, requestDetachedControl } from "../cli/detachedControl"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function address() {
  const root = await mkdtemp(join(tmpdir(), "md-control-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return process.platform === "win32" ? `\\\\.\\pipe\\meridian-test-${randomBytes(16).toString("hex")}` : join(root, "control.sock")
}
const identity = { instanceId: "ab".repeat(16), nonce: "cd".repeat(32) }
const request = { version: 1 as const, action: "stop" as const, ...identity }

test("real private connections admit only one concurrent graceful stop", async () => {
  const path = await address()
  const lifecycle = new DetachedLifecycle()
  lifecycle.ready()
  let stops = 0
  const errors: Error[] = []
  const server = await listenDetachedControl({ path, identity, lifecycle, onStop: () => { stops++ }, onError: error => errors.push(error) })
  cleanup.push(() => server.close())
  const replies = await Promise.all([requestDetachedControl(path, request), requestDetachedControl(path, request), requestDetachedControl(path, request)])
  expect(replies.filter(reply => reply.accepted)).toHaveLength(1)
  expect(replies.every(reply => reply.phase === "draining")).toBe(true)
  expect(stops).toBe(1)
  expect(errors).toEqual([])
})

test("a stale nonce cannot stop a replacement instance or expose its identity", async () => {
  const path = await address()
  let stops = 0
  const server = await listenDetachedControl({ path, identity, lifecycle: new DetachedLifecycle(), onStop: () => { stops++ }, onError: error => { throw error } })
  cleanup.push(() => server.close())
  await expect(requestDetachedControl(path, { ...request, nonce: "ef".repeat(32) })).rejects.toThrow("mismatch")
  expect(stops).toBe(0)
  const status = await requestDetachedControl(path, { ...request, action: "inspect" })
  expect(status.phase).toBe("starting")
  expect(status.accepted).toBe(false)
})

test("client timeout joins its socket even if the listener never replies", async () => {
  const path = await address()
  let connections = 0
  let peerClosed: (() => void) | undefined
  const joined = new Promise<void>(resolve => { peerClosed = resolve })
  const server = createServer(socket => { connections++; socket.on("data", () => {}); socket.once("close", () => { connections--; peerClosed?.() }) })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve) })
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  await expect(requestDetachedControl(path, request, 30)).rejects.toThrow("timed out")
  await joined
  expect(connections).toBe(0)
})

test("a failed graceful callback is observable and never retried as a force stop", async () => {
  const path = await address()
  let calls = 0
  const errors: Error[] = []
  const lifecycle = new DetachedLifecycle()
  const server = await listenDetachedControl({ path, identity, lifecycle,
    onStop: () => { calls++; throw new Error("fixture stop failure") }, onError: error => errors.push(error) })
  cleanup.push(() => server.close())
  await expect(requestDetachedControl(path, request)).rejects.toThrow("Incomplete")
  expect(errors.map(error => error.message)).toEqual(["fixture stop failure"])
  expect((await requestDetachedControl(path, request)).accepted).toBe(false)
  expect(calls).toBe(1)
})
