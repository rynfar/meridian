import { expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { BookkeepingBarrierReplacedError, releaseOwnBarrier } from "../proxy/session/bookkeeping/barrier"
import { barrierBytes, observeSource, readJournal, saveJournal, SOURCE_NAMES } from "../proxy/session/bookkeeping/maintenanceJournal"

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "barrier-test-"))
  const id = randomUUID()
  const path = join(directory, "sessions.json.lock")
  saveJournal(directory, { format: "meridian-bookkeeping-migration", version: 1, targetVersion: 1,
    id, phase: "PREPARED", sources: SOURCE_NAMES.map((name) => observeSource(directory, name).identity) })
  writeFileSync(path, barrierBytes(id), { mode: 0o600 })
  return { directory, id, path }
}
function assertRefusal(operation: () => void) {
  try { operation(); throw new Error("release unexpectedly succeeded") } catch (error) {
    expect(error).toBeInstanceOf(BookkeepingBarrierReplacedError)
    expect((error as BookkeepingBarrierReplacedError).exitCode).toBe(5)
  }
}

it("never overwrites an occupied private release name", () => {
  const { directory, id, path } = setup()
  let privatePath = ""
  try {
    assertRefusal(() => releaseOwnBarrier(directory, "sessions.json", id, { beforeRename: (target) => {
      privatePath = target
      expect(readJournal(directory)?.releases?.["sessions.json"]?.name).toBe(target.slice(directory.length + 1))
      writeFileSync(target, "foreign", { mode: 0o600 })
    } }))
    expect(readFileSync(privatePath, "utf8")).toBe("foreign")
    expect(readFileSync(path, "utf8")).toBe(barrierBytes(id))
    assertRefusal(() => releaseOwnBarrier(directory, "sessions.json", id))
    expect(readFileSync(privatePath, "utf8")).toBe("foreign")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it("restores the file substituted between descriptor check and rename", () => {
  const { directory, id, path } = setup()
  try {
    assertRefusal(() => releaseOwnBarrier(directory, "sessions.json", id, { beforeRename: () => {
      renameSync(path, path + ".original")
      writeFileSync(path, "foreign", { mode: 0o600 })
    } }))
    expect(readFileSync(path, "utf8")).toBe("foreign")
    expect(readdirSync(directory).filter((name) => name.includes(".releasing-"))).toEqual([])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it("refuses a foreign public barrier before recording an intent", () => {
  const { directory, id, path } = setup()
  try {
    writeFileSync(path, "foreign")
    assertRefusal(() => releaseOwnBarrier(directory, "sessions.json", id))
    expect(readJournal(directory)?.releases).toBeUndefined()
    expect(existsSync(path)).toBe(true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it("resume leaves a replacement public inode alone and retains the private capture", () => {
  const { directory, id, path } = setup()
  let privatePath = ""
  try {
    expect(() => releaseOwnBarrier(directory, "sessions.json", id, { afterRename: (target) => {
      privatePath = target
      throw new Error("interrupt after rename")
    } })).toThrow("interrupt after rename")
    writeFileSync(path, "foreign", { mode: 0o600 })
    assertRefusal(() => releaseOwnBarrier(directory, "sessions.json", id))
    expect(readFileSync(path, "utf8")).toBe("foreign")
    expect(existsSync(privatePath)).toBe(true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it("occupied restoration name preserves both the captured foreign file and the new public file", () => {
  const { directory, id, path } = setup()
  let privatePath = ""
  try {
    assertRefusal(() => releaseOwnBarrier(directory, "sessions.json", id, {
      beforeRename: () => { renameSync(path, path + ".original"); writeFileSync(path, "foreign moved") },
      afterRename: (target) => { privatePath = target; writeFileSync(path, "foreign public") },
    }))
    expect(readFileSync(privatePath, "utf8")).toBe("foreign moved")
    expect(readFileSync(path, "utf8")).toBe("foreign public")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
