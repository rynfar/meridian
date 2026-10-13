import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, readFile, symlink, chmod, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detachedPaths, parseDetachedRecord, publishDetachedRecord, readDetachedRecord, removeDetachedRecord } from "../cli/detachedStore"
import type { DetachedRecord } from "../cli/detachedStore"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "meridian-detached-store-"))
  roots.push(root)
  const paths = await detachedPaths(join(root, "config"), "127.0.0.1", 3456, true)
  if (!paths) throw new Error("Missing test paths")
  return { root, paths }
}
function record(): DetachedRecord {
  return { version: 1, instanceId: "12".repeat(16), nonce: "ab".repeat(32), host: "127.0.0.1", port: 3456, startedAt: 1000,
    owner: { version: 1, pid: 999, hostId: "0".repeat(64), bootId: "11111111-1111-1111-1111-111111111111", startId: "1", startIdKind: "linux-proc-start-ticks" } }
}

test("missing configuration is read-only for stop; start creates private endpoint state", async () => {
  const { root, paths } = await fixture()
  expect(await detachedPaths(join(root, "absent"), "127.0.0.1", 3456)).toBeUndefined()
  expect(await readdir(root)).toEqual(["config"])
  const other = await detachedPaths(join(root, "config"), "127.0.0.1", 3457, true)
  expect(other?.key).not.toBe(paths.key)
  expect(other?.log).not.toBe(paths.log)
})

test("valid private records roundtrip and only matching identity can retire them", async () => {
  const { paths } = await fixture()
  await publishDetachedRecord(paths, record())
  expect(await readDetachedRecord(paths)).toEqual(record())
  await expect(removeDetachedRecord(paths, { ...record(), nonce: "cd".repeat(32) })).rejects.toThrow("changed")
  expect(await readDetachedRecord(paths)).toEqual(record())
  await removeDetachedRecord(paths, record())
  expect(await readDetachedRecord(paths)).toBeUndefined()
  expect(await readdir(paths.root)).toEqual([])
})

test("unknown process incarnation is not permission to replace a published owner", async () => {
  const { paths } = await fixture()
  await publishDetachedRecord(paths, record())
  await expect(publishDetachedRecord(paths, { ...record(), instanceId: "34".repeat(16) })).rejects.toThrow("not confirmed dead")
  expect((await readDetachedRecord(paths))?.instanceId).toBe(record().instanceId)
  expect(await readdir(paths.root)).toEqual([paths.key + ".json"])
})

test("endpoint mismatches and unsupported records are rejected without overwriting", async () => {
  const { paths } = await fixture()
  await expect(publishDetachedRecord(paths, { ...record(), port: 3457 })).rejects.toThrow("Invalid")
  await writeFile(paths.record, JSON.stringify({ ...record(), port: 3457 }), { mode: 0o600 })
  await expect(readDetachedRecord(paths)).rejects.toThrow("mismatched")
  for (const value of [null, [], { ...record(), port: 0 }, { ...record(), host: "../other" }, { ...record(), command: "kill" }, { ...record(), nonce: "short" }]) {
    expect(parseDetachedRecord(value)).toBeUndefined()
  }
})

test("ownership records cannot follow a symlink or allocate an unbounded body", async () => {
  const { root, paths } = await fixture()
  const target = join(root, "retain")
  await writeFile(target, "untouched", { mode: 0o600 })
  await symlink(target, paths.record)
  await expect(readDetachedRecord(paths)).rejects.toThrow()
  await expect(publishDetachedRecord(paths, record())).rejects.toThrow()
  expect(await readFile(target, "utf8")).toBe("untouched")
  await rm(paths.record)
  await writeFile(paths.record, "x".repeat(4097), { mode: 0o600 })
  await expect(readDetachedRecord(paths)).rejects.toThrow("Invalid detached ownership file")
})

test.skipIf(process.platform === "win32")("broadly accessible state is refused rather than silently adopted", async () => {
  const { root, paths } = await fixture()
  await chmod(paths.root, 0o755)
  await expect(detachedPaths(join(root, "config"), "127.0.0.1", 3456, true)).rejects.toThrow("not private")
})

test("the real lifetime lease excludes a second supervisor and releases its exact record", async () => {
  const { DetachedOwnerLease } = await import("../cli/detachedStore")
  const { paths } = await fixture()
  const first = await DetachedOwnerLease.acquire(paths)
  try {
    const published = await first.publish(record())
    expect(published.owner.pid).toBe(process.pid)
    await expect(DetachedOwnerLease.acquire(paths, undefined, 50)).rejects.toThrow("Timed out")
    expect((await readDetachedRecord(paths))?.instanceId).toBe(published.instanceId)
  } finally { await first.release() }
  expect(await readDetachedRecord(paths)).toBeUndefined()
  await first.release()
  const replacement = await DetachedOwnerLease.acquire(paths)
  try { expect((await replacement.publish({ ...record(), instanceId: "34".repeat(16) })).owner.pid).toBe(process.pid) }
  finally { await replacement.release() }
})

test("release joins in-flight publication and refuses a second identity", async () => {
  const { DetachedOwnerLease } = await import("../cli/detachedStore")
  const { paths } = await fixture()
  const lease = await DetachedOwnerLease.acquire(paths)
  const publishing = lease.publish(record())
  await expect(lease.publish({ ...record(), instanceId: "34".repeat(16) })).rejects.toThrow("already publishing")
  const releasing = lease.release()
  await publishing
  await releasing
  expect(await readDetachedRecord(paths)).toBeUndefined()
  await expect(lease.publish(record())).rejects.toThrow("released")
})
