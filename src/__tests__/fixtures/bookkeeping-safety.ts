import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import { captureProcessIncarnation } from "../../proxy/session/processIncarnation"
import {
  initializeSessionBookkeeping, BookkeepingMaintenanceRequiredError, withBookkeepingWrite,
} from "../../proxy/session/bookkeeping/database"
import { cleanupBootstrapOrphans } from "../../proxy/session/bookkeeping/bootstrapOwner"

const [mode, directory] = process.argv.slice(2)
assert(directory)
if (mode === "startup") {
  try {
    initializeSessionBookkeeping(directory).close()
    process.exitCode = 1
  } catch (error) {
    assert.match(String(error), /not an owned regular path/)
  }
} else if (mode === "orphan") {
  const owner = captureProcessIncarnation()
  assert(owner)
  const main = join(directory, "session-bookkeeping.sqlite")
  for (const [suffix, linked] of [[randomUUID(), false], [randomUUID(), true]] as const) {
    const temporary = `${main}.tmp-${process.pid}-${suffix}`
    fs.writeFileSync(`${temporary}.owner.json`, JSON.stringify(owner), { mode: 0o600 })
    if (linked) fs.linkSync(main, temporary)
    else fs.writeFileSync(temporary, "", { mode: 0o600 })
  }
} else if (mode === "no-open") {
  const handle = initializeSessionBookkeeping(directory)
  const owner = captureProcessIncarnation()
  assert(owner)
  const temporary = `${handle.path}.tmp-${process.pid}-${randomUUID()}`
  fs.writeFileSync(`${temporary}.owner.json`, JSON.stringify({
    ...owner, startId: owner.startIdKind === "darwin-ps-lstart"
      ? "Mon Jan  1 00:00:00 2001" : owner.startId === "1" ? "2" : "1",
  }), { mode: 0o600 })
  process.kill(owner.pid, 0)
  fs.linkSync(handle.path, temporary)
  const protectedInodes = new Set(fs.readdirSync(directory).filter((name) => /\.sqlite(?:-wal|-shm|-journal)?$/.test(name))
    .map((name) => { const stat = fs.lstatSync(join(directory, name)); return `${stat.dev}:${stat.ino}` }))
  const original = fs.openSync
  fs.openSync = (...args: Parameters<typeof fs.openSync>) => {
    const path = String(args[0])
    // File names of durable deletion intents contain '.sqlite', but their inodes are not SQLite aliases.
    if (fs.existsSync(path)) {
      const stat = fs.lstatSync(path)
      assert(!protectedInodes.has(`${stat.dev}:${stat.ino}`), `unexpected SQLite inode open: ${path}`)
    }
    return original(...args)
  }
  syncBuiltinESMExports()
  try {
    cleanupBootstrapOrphans(handle.path)
    assert.equal(fs.existsSync(temporary), false)
    const other = initializeSessionBookkeeping(directory)
    other.close()
  } finally {
    fs.openSync = original
    syncBuiltinESMExports()
    handle.close()
  }
} else if (mode === "close-fault" || mode === "close-direct-fault") {
  let closes = 0
  const handle = initializeSessionBookkeeping(directory, {
    executeTransaction(db, sql) {
      if (sql === "COMMIT") throw new Error("commit failure")
      db.exec(sql)
    },
    closeDatabase() { closes++; throw new Error("close refusal") },
  })
  if (mode === "close-fault") {
    assert.throws(() => withBookkeepingWrite(directory, {}, () => true), /outcome unknown/)
  } else {
    assert.throws(() => handle.close(), BookkeepingMaintenanceRequiredError)
  }
  assert.equal(closes, 1)
  assert.throws(() => withBookkeepingWrite(directory, {}, () => true), BookkeepingMaintenanceRequiredError)
  assert.throws(() => initializeSessionBookkeeping(directory), BookkeepingMaintenanceRequiredError)
  if (mode === "close-fault") assert.throws(() => handle.close(), BookkeepingMaintenanceRequiredError)
  assert.equal(closes, 1)
} else {
  throw new Error(`unknown mode: ${mode}`)
}
