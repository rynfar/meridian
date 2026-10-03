import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { publishProfileConfig, readProfileConfigForUpdate, withProfileConfigLock, withProfileConfigLockSync } from "../proxy/profileConfigStore"

let root: string
let file: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "profile-config-store-")); file = join(root, "profiles.json") })
afterEach(() => rmSync(root, { recursive: true, force: true }))

test("publication replaces a complete snapshot and restricts the new file", () => {
  writeFileSync(file, '[{"id":"old"}]', { mode: 0o644 })
  withProfileConfigLockSync(file, () => publishProfileConfig(file, [{ id: "new" }]))
  expect(readProfileConfigForUpdate(file)).toEqual([{ id: "new" }])
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(existsSync(`${file}.lock`)).toBe(false)
})

test("throwing work releases the writer lock and leaves the prior file intact", () => {
  writeFileSync(file, '[{"id":"old"}]')
  expect(() => withProfileConfigLockSync(file, () => { throw new Error("fixture failure") })).toThrow("fixture failure")
  expect(existsSync(`${file}.lock`)).toBe(false)
  expect(readProfileConfigForUpdate(file)).toEqual([{ id: "old" }])
})

test.each(['not json', '{}', '[{"wrong":"shape"}]'])("a writer refuses malformed configuration: %s", bytes => {
  writeFileSync(file, bytes)
  expect(() => withProfileConfigLockSync(file, () => readProfileConfigForUpdate(file))).toThrow()
  expect(readFileSync(file, "utf8")).toBe(bytes)
  expect(existsSync(`${file}.lock`)).toBe(false)
})

test("a browser writer yields while another process owns the lock", async () => {
  writeFileSync(`${file}.lock`, "fixture owner")
  let heartbeat = false
  const writer = withProfileConfigLock(file, () => {
    expect(heartbeat).toBe(true)
    publishProfileConfig(file, [{ id: "new" }])
  })
  const release = setTimeout(() => { heartbeat = true; unlinkSync(`${file}.lock`) }, 30)
  try { await writer } finally { clearTimeout(release) }
  expect(readProfileConfigForUpdate(file)).toEqual([{ id: "new" }])
  expect(existsSync(`${file}.lock`)).toBe(false)
})
