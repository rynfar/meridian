import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile, symlink, link, rename } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { finished } from "node:stream/promises"
import { DetachedLog } from "../cli/detachedLog"

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "meridian-detached-log-"))
  directories.push(root)
  return { root, path: join(root, "service.log") }
}
async function append(path: string, text: string, limit = 8) {
  const log = await DetachedLog.create(path, limit)
  const complete = finished(log)
  log.end(text)
  await complete
}

test("rotation retains only the newest two bounded files, including across launches", async () => {
  const { path } = await fixture()
  await append(path, "1111111122222222333333334444")
  expect(await readFile(path + ".1", "utf8")).toBe("33333333")
  expect(await readFile(path, "utf8")).toBe("4444")
  await append(path, "55556666")
  expect(await readFile(path + ".1", "utf8")).toBe("44445555")
  expect(await readFile(path, "utf8")).toBe("6666")
  expect((await stat(path)).size + (await stat(path + ".1")).size).toBeLessThanOrEqual(16)
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o077).toBe(0)
})

test("alternating streams preserve observed write order and propagate backpressure", async () => {
  const { path } = await fixture()
  const log = await DetachedLog.create(path, 128 * 1024)
  const complete = finished(log)
  expect(log.write(Buffer.alloc(80 * 1024, 65))).toBe(false)
  log.write("stderr-tail")
  log.end("stdout-tail")
  await complete
  const data = await readFile(path)
  expect(data.subarray(-22).toString()).toBe("stderr-tailstdout-tail")
  expect(data.byteLength).toBe(80 * 1024 + 22)
})

test("symlinks and hard links never become writable log files", async () => {
  const { root, path } = await fixture()
  const target = join(root, "untouched")
  await writeFile(target, "retain", { mode: 0o600 })
  await symlink(target, path)
  await expect(DetachedLog.create(path, 8)).rejects.toThrow("regular file")
  await rm(path)
  await link(target, path)
  await expect(DetachedLog.create(path, 8)).rejects.toThrow("regular file")
  await rm(path)
  await symlink(target, path + ".1")
  await expect(DetachedLog.create(path, 8)).rejects.toThrow("regular file")
  expect(await readFile(target, "utf8")).toBe("retain")
})

test("refuses oversized historical files instead of adopting an unbounded log", async () => {
  const { path } = await fixture()
  await writeFile(path, "123456789", { mode: 0o600 })
  await expect(DetachedLog.create(path, 8)).rejects.toThrow("storage limit")
  expect(await readFile(path, "utf8")).toBe("123456789")
})

test("a replaced active file is not rotated or modified", async () => {
  const { path } = await fixture()
  const log = await DetachedLog.create(path, 8)
  const complete = finished(log)
  await new Promise<void>((resolve, reject) => log.write("12345678", error => error ? reject(error) : resolve()))
  await rename(path, path + ".owned")
  await writeFile(path, "foreign", { mode: 0o600 })
  log.end("x")
  await expect(complete).rejects.toThrow("changed before rotation")
  expect(await readFile(path, "utf8")).toBe("foreign")
  expect(await readFile(path + ".owned", "utf8")).toBe("12345678")
})
