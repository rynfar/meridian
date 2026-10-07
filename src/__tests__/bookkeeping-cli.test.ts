import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import Database from "libsql"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { runBookkeepingCli } from "../proxy/session/bookkeeping/cli"
import { acquireMaintenanceGuard } from "../proxy/session/bookkeeping/guard"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initializeSessionBookkeeping } from "../proxy/session/bookkeeping/database"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"
import { seedResidueInventory } from "./fixtures/bookkeeping-residue-inventory"
import { buildNodeFixture } from "./fixtures/bookkeeping-support"

let directory: string
beforeAll(() => {
  const build = spawnSync("npm", ["run", "build"], { encoding: "utf8", timeout: 180000 })
  expect(build.status, build.stdout + build.stderr).toBe(0)
}, 190000)
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-cli-")))
  writeFileSync(join(directory, "sessions.json"), "{}", { mode: 0o600 })
  writeFileSync(join(directory, "session-gc.json"), '{"version":1,"resources":{}}', { mode: 0o600 })
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
function cli(command: string, flags: string[] = [], crash?: string) {
  return spawnSync("node", ["dist/session-bookkeeping.js", command, "--session-dir", directory, "--json", ...flags],
    { encoding: "utf8", timeout: 15000, env: { ...process.env,
      ...(crash ? { MERIDIAN_BOOKKEEPING_TEST_CRASH: crash } : {}) } })
}
function success(command: string, flags: string[] = []) {
  const result = cli(command, flags)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}

it("migrate → export in one Node process completes 50 times without a retained inspection reader", async () => {
  const build = join(directory, "build")
  mkdirSync(build, { mode: 0o700 })
  const bundled = await buildNodeFixture("bookkeeping-cli-cycles.ts", "cycles.mjs", build)
  expect(bundled.success).toBe(true)
  const result = spawnSync("node", [join(build, "cycles.mjs"), directory], { encoding: "utf8", timeout: 60000 })
  expect(result.status, result.stdout + result.stderr).toBe(0)
  const rows = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
  expect(rows).toHaveLength(100)
  expect(rows.every((row) => row.exit_code === 0)).toBe(true)
}, 65000)

it("an external child read transaction still refuses export with exit 4 and WAL-lock diagnostics", async () => {
  success("migrate", ["--writers-stopped"])
  const child = spawn("node", ["--input-type=module", "-e", `
    import Database from 'libsql';
    const db = new Database(process.argv[1]);
    db.exec("INSERT INTO fence_slots VALUES('store','ffff',1)");
    db.exec('BEGIN');
    const statement = db.prepare('SELECT * FROM schema_meta'); statement.get();
    if (!db.inTransaction) throw new Error('reader transaction missing');
    console.log('ready'); setInterval(() => { void statement; }, 1000);
  `, join(directory, "session-bookkeeping.sqlite")], { stdio: "pipe" })
  try {
    await once(child.stdout!, "data")
    const refused = cli("export-json")
    expect(refused.status, refused.stdout + refused.stderr).toBe(4)
    const error = JSON.parse(refused.stdout).error
    expect(error).toContain("external database reader/writer holds a WAL lock")
    expect(error).toContain("holder PID unavailable from SQLite")
    expect(error).toContain("local handles=1, local transaction=false")
  } finally {
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
  }
  expect(success("export-json").phase).toBe("exported")
}, 20000)
it("packaged CLI completes legacy → ready → exported → ready with stable inspection", () => {
  const names = readdirSync(directory).sort()
  expect(success("inspect").phase).toBe("legacy")
  expect(readdirSync(directory).sort()).toEqual(names)
  expect(cli("migrate").status).toBe(2)
  expect(cli("export-json").status).toBe(3)
  expect(cli("abort-migration").status).toBe(3)
  expect(readdirSync(directory).sort()).toEqual(names)
  const first = success("migrate", ["--writers-stopped"])
  expect(first.phase).toBe("ready")
  expect(cli("abort-migration").status).toBe(4)
  expect(first.timings.phases.length).toBeGreaterThan(2)
  expect(success("migrate", ["--writers-stopped"]).migration_id).toBe(first.migration_id)
  expect(success("inspect").phase).toBe("ready")
  expect(success("export-json").phase).toBe("exported")
  expect(success("export-json").phase).toBe("exported")
  const second = success("migrate", ["--writers-stopped"])
  expect(second.migration_id).not.toBe(first.migration_id)
  expect(second.archived_cycles).toBe(1)
  expect(second.cycle_number).toBe(2)
})
it("read-only inspect coexists with an actual live runtime guard", () => {
  success("migrate", ["--writers-stopped"])
  const guardName = "session-bookkeeping-maintenance.sqlite"
  const guardBefore = readFileSync(join(directory, guardName)).toString("base64")
  const handle = initializeSessionBookkeeping(directory)
  try {
    const files = readdirSync(directory).sort()
    const before = { [guardName]: guardBefore, ...Object.fromEntries(files
      .filter((name) => !name.endsWith("-shm") && name !== guardName)
      .map((name) => [name, readFileSync(join(directory, name)).toString("base64")])) }
    expect(success("inspect").phase).toBe("ready")
    expect(readdirSync(directory).sort()).toEqual(files)
    // Do not open/close the guard inode in the holder process: POSIX would drop its record locks.
    expect(cli("export-json").status).toBe(4)
    for (const [name, value] of Object.entries(before)) {
      expect(readFileSync(join(directory, name)).toString("base64")).toBe(value)
    }
  } finally { handle.close() }
})
it("aborts a SIGKILL at BARRIERS and starts the next cycle", () => {
  const crashed = cli("migrate", ["--writers-stopped"], "BARRIERS")
  expect(crashed.signal).toBe("SIGKILL")
  expect(success("inspect").phase).toBe("barriers")
  expect(success("abort-migration").phase).toBe("aborted")
  expect(success("inspect").phase).toBe("aborted")
  expect(success("migrate", ["--writers-stopped"]).archived_cycles).toBe(1)
})
it("classifies a foreign barrier as corruption without removing it", () => {
  success("migrate", ["--writers-stopped"])
  writeFileSync(join(directory, "sessions.json.lock"), "foreign")
  expect(cli("export-json").status).toBe(5)
  expect(readFileSync(join(directory, "sessions.json.lock"), "utf8")).toBe("foreign")
})

it("reports candidate incarnation verdicts and refuses a live candidate before migration", () => {
  const incarnation = captureProcessIncarnation()!
  const path = join(directory, "sessions.json.lock.candidate-test")
  const owner = { pid: process.pid, token: "test", hostname: "test", incarnation }
  writeFileSync(path, JSON.stringify(owner), { mode: 0o600 })
  expect(success("inspect").candidates[0].verdict).toBe("live")
  expect(cli("migrate", ["--writers-stopped"]).status).toBe(3)
  expect(readdirSync(directory).some((name) => name.endsWith(".sqlite"))).toBe(false)
  writeFileSync(path, JSON.stringify({ ...owner,
    incarnation: { ...incarnation, bootId: "00000000-0000-0000-0000-000000000001" } }))
  expect(success("inspect").candidates[0].verdict).toBe("dead-incarnation")
  expect(success("migrate", ["--writers-stopped"]).phase).toBe("ready")
  writeFileSync(path, JSON.stringify(owner), { mode: 0o600 })
  expect(success("migrate", ["--writers-stopped"]).phase).toBe("ready")
})

it("archives synthetic legacy residues with an explicit stop/drain attestation", () => {
  const names = seedResidueInventory(directory)
  const original = Object.fromEntries(names.map((name) => [name, readFileSync(join(directory, name), "utf8")]))
  const before = success("inspect")
  expect(before.candidates).toHaveLength(4)
  expect(before.candidates.every((row: { verdict: string }) => row.verdict === "dead-incarnation")).toBe(true)
  expect(before.gates).toHaveLength(15)
  expect(before.gates.every((row: { verdict: string }) => row.verdict === "unknown")).toBe(true)
  expect(before.temporary).toHaveLength(5)
  expect(before.temporary.every((row: { verdict: string }) => row.verdict === "unknown")).toBe(true)
  const after = success("migrate", ["--writers-stopped"])
  expect(after.phase).toBe("ready")
  expect(after.archived_cycles).toBe(0)
  expect(after.result.residues).toHaveLength(24)
  const journal = JSON.parse(readFileSync(join(directory, "session-bookkeeping-migration.json"), "utf8"))
  expect(journal.residues).toEqual(after.result.residues)
  for (const name of names) {
    expect(readFileSync(join(directory, "bookkeeping-cycles", after.migration_id, "residue", name), "utf8"))
      .toBe(original[name]!)
  }
  expect(after.candidates).toEqual([])
  expect(after.gates).toEqual([])
  expect(after.temporary).toEqual([])
  expect(readdirSync(join(directory, "turn-locks"))).toHaveLength(42)
  for (let i = 0; i < 42; i++) expect(readFileSync(join(directory, "turn-locks", `${i}.lock`), "utf8"))
    .toBe(`turn-${i}`)
  success("export-json")
  expect(success("migrate", ["--writers-stopped"]).archived_cycles).toBe(1)
})

it("refuses an actual child candidate with exit 3 and its address", async () => {
  const child = spawn("node", ["-e", "console.log('ready');setInterval(()=>{},1000)"], { stdio: "pipe" })
  try {
    await once(child.stdout!, "data")
    const incarnation = captureProcessIncarnation(child.pid)
    expect(incarnation).toBeDefined()
    const name = `sessions.json.lock.candidate-${child.pid}-00000000-0000-4000-8000-000000000001`
    writeFileSync(join(directory, name), JSON.stringify({ incarnation }), { mode: 0o600 })
    expect(success("inspect").candidates).toEqual([{ path: name, verdict: "live" }])
    const refused = cli("migrate", ["--writers-stopped"])
    expect(refused.status, refused.stdout + refused.stderr).toBe(3)
    expect(JSON.parse(refused.stdout).error).toContain(name)
    expect(readdirSync(directory).some((path) => path.endsWith(".sqlite"))).toBe(false)
  } finally {
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
  }
})

for (const operation of ["linked", "moved"]) it(`resumes residue ${operation} without losing inventory`, () => {
  const names = seedResidueInventory(directory)
  const cut = `residue:${operation}:${names[0]}`
  expect(cli("migrate", ["--writers-stopped"], cut).signal).toBe("SIGKILL")
  const resumed = success("migrate", ["--writers-stopped"])
  expect(resumed.phase).toBe("ready")
  expect(resumed.result.residues).toHaveLength(24)
  expect(success("inspect").candidates).toEqual([])
})

it("archives an unknown candidate and nonempty legacy temporary files only with attestation", () => {
  const candidate = "sessions.json.lock.candidate-1-00000000-0000-4000-8000-000000000001"
  const temporary = "session-gc.json.tmp-2147483647-00000000-0000-4000-8000-000000000002"
  writeFileSync(join(directory, candidate), "unknown owner", { mode: 0o600 })
  writeFileSync(join(directory, temporary), "not empty", { mode: 0o600 })
  expect(success("inspect").candidates).toEqual([{ path: candidate, verdict: "unknown" }])
  expect(success("inspect").temporary).toMatchObject([{ path: temporary, verdict: "unknown", bytes: 9 }])
  expect(cli("migrate").status).toBe(2)
  expect(readFileSync(join(directory, candidate), "utf8")).toBe("unknown owner")
  const after = success("migrate", ["--writers-stopped"])
  expect(after.result.residues).toHaveLength(2)
  expect(after.result.residues[0].verdict).toBe("unknown")
  expect(readFileSync(join(directory, "bookkeeping-cycles", after.migration_id, "residue", temporary), "utf8"))
    .toBe("not empty")
})

for (const source of ["sessions", "session-gc"]) for (const bytes of ["", "not empty"]) {
  it(`refuses ${source} temporary residue with a live filename PID (${bytes.length} bytes)`, () => {
    const name = `${source}.json.tmp-${process.pid}-00000000-0000-4000-8000-000000000002`
    writeFileSync(join(directory, name), bytes, { mode: 0o600 })
    expect(success("inspect").temporary).toMatchObject([{ path: name, verdict: "live", bytes: bytes.length }])
    const refused = cli("migrate", ["--writers-stopped"])
    expect(refused.status, refused.stdout + refused.stderr).toBe(3)
    expect(JSON.parse(refused.stdout).error).toContain(name)
    expect(readFileSync(join(directory, name), "utf8")).toBe(bytes)
  })
}

it("inspects and archives an incomplete directory candidate without inventing an owner", () => {
  const name = "sessions.json.lock.candidate-1-00000000-0000-4000-8000-000000000001"
  mkdirSync(join(directory, name), { mode: 0o700 })
  expect(success("inspect").candidates).toEqual([{ path: name, verdict: "unknown", kind: "incomplete-candidate" }])
  expect(readdirSync(join(directory, name))).toEqual([])
  const result = success("migrate", ["--writers-stopped"])
  expect(result.phase).toBe("ready")
  expect(result.result.residues[0].kind).toBe("incomplete-candidate")
  const archived = join(directory, "bookkeeping-cycles", result.migration_id, "residue",
    result.result.residues[0].archiveName)
  const manifest = JSON.parse(readFileSync(archived + ".manifest.json", "utf8"))
  expect(manifest.reason).toBeNull()
  expect(manifest.before.ino).toBe(lstatSync(archived).ino)
  expect(readdirSync(directory)).not.toContain(name)
})

it("refuses a foreign SQLite before guard creation without changing files or inodes", async () => {
  const path = join(directory, "session-bookkeeping.sqlite")
  const child = spawn("node", ["--input-type=module", "-e", `
    import Database from 'libsql';
    const db = new Database(${JSON.stringify(path)});
    db.pragma('journal_mode=WAL');
    db.exec("CREATE TABLE foreign_authority(value TEXT); INSERT INTO foreign_authority VALUES ('kept')");
    process.send('ready');
    process.on('disconnect', () => { db.close(); process.exit(0); });
  `], { stdio: ["ignore", "pipe", "pipe", "ipc"] })
  let stderr = ""
  child.stderr!.on("data", (chunk) => { stderr += String(chunk) })
  try {
    await Promise.race([once(child, "message"), once(child, "exit").then(([code]) => {
      throw new Error(`foreign WAL holder exited before ready: ${code}: ${stderr}`)
    })])
    for (const suffix of ["", "-wal", "-shm"]) expect(lstatSync(path + suffix).size).toBeGreaterThan(0)
    const snapshot = () => readdirSync(directory).sort().map((name) => {
      const stat = lstatSync(join(directory, name))
      return { name, ino: stat.ino, dev: stat.dev, mode: stat.mode,
        bytes: readFileSync(join(directory, name)).toString("hex") }
    })
    const before = snapshot()
    const refused = cli("migrate", ["--writers-stopped"])
    expect(refused.status, refused.stdout + refused.stderr).toBe(3)
    expect(snapshot()).toEqual(before)
    await expect(migrateBookkeeping(directory, { writersStopped: true })).rejects.toThrow("without migration journal")
    expect(snapshot()).toEqual(before)
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit")
      child.disconnect()
      await exited
    }
  }
})

it("resumes an archived incomplete candidate after SIGKILL", () => {
  const name = "sessions.json.lock.candidate-1-00000000-0000-4000-8000-000000000003"
  mkdirSync(join(directory, name), { mode: 0o700 })
  expect(cli("migrate", ["--writers-stopped"], `residue:moved:${name}`).signal).toBe("SIGKILL")
  expect(success("migrate", ["--writers-stopped"]).phase).toBe("ready")
})

it("retains an occupied private directory with mismatch evidence without deleting the source", () => {
  const name = "sessions.json.lock.candidate-1-00000000-0000-4000-8000-000000000004"
  mkdirSync(join(directory, name), { mode: 0o700 })
  expect(cli("migrate", ["--writers-stopped"], `residue:intent:${name}`).signal).toBe("SIGKILL")
  const journal = JSON.parse(readFileSync(join(directory, "session-bookkeeping-migration.json"), "utf8"))
  const target = join(directory, "bookkeeping-cycles", journal.id, "residue", journal.residues[0].archiveName)
  mkdirSync(target, { recursive: true, mode: 0o700 })
  expect(cli("migrate", ["--writers-stopped"]).status).toBe(5)
  expect(readdirSync(join(directory, name))).toEqual([])
  expect(readdirSync(target)).toEqual([])
  expect(JSON.parse(readFileSync(target + ".manifest.json", "utf8")).reason).toBe("identity mismatch after move")
})

for (const preexisting of [false, true]) it(`foreign SQLite race preserves files with preexisting guard=${preexisting}`, async () => {
  if (preexisting) acquireMaintenanceGuard(directory).close()
  const snapshot = () => readdirSync(directory).sort().map((name) => ({ name,
    ino: lstatSync(join(directory, name)).ino, bytes: readFileSync(join(directory, name)).toString("hex") }))
  let before: ReturnType<typeof snapshot> | undefined
  const code = await runBookkeepingCli(["migrate", "--session-dir", directory, "--writers-stopped", "--json"], () => {
    const db = new Database(join(directory, "session-bookkeeping.sqlite"))
    db.exec("CREATE TABLE foreign_authority(value TEXT)")
    db.close()
    before = snapshot()
  })
  expect(code).toBe(3)
  expect(before).toBeDefined()
  // A missing guard beside existing authority cannot be replaced; an already
  // published guard is permanent. Neither refusal may retire a coordination inode.
  expect(snapshot()).toEqual(before!)
  expect(existsSync(join(directory, "session-bookkeeping-maintenance.sqlite"))).toBe(preexisting)
  expect(cli("migrate", ["--writers-stopped"]).status).toBe(3)
  expect(snapshot()).toEqual(before!)
})

for (const scenario of ["occupied-private", "replaced-public", "resume-linked"]) {
  it(`packaged export release ${scenario} preserves foreign data or resumes its own inode`, () => {
    success("migrate", ["--writers-stopped"])
    const point = scenario === "occupied-private" ? "intent" : "captured"
    expect(cli("export-json", [], `barrier:${point}:sessions.json`).signal).toBe("SIGKILL")
    const journal = JSON.parse(readFileSync(join(directory, "session-bookkeeping-migration.json"), "utf8"))
    const privatePath = join(directory, journal.releases["sessions.json"].name)
    const publicPath = join(directory, "sessions.json.lock")
    if (scenario === "occupied-private") {
      writeFileSync(privatePath, "foreign", { mode: 0o600 })
      expect(cli("export-json").status).toBe(5)
      expect(readFileSync(privatePath, "utf8")).toBe("foreign")
    } else if (scenario === "replaced-public") {
      writeFileSync(publicPath, "foreign", { mode: 0o600 })
      expect(cli("export-json").status).toBe(5)
      expect(readFileSync(publicPath, "utf8")).toBe("foreign")
      expect(readdirSync(directory)).toContain(journal.releases["sessions.json"].name)
    } else {
      expect(lstatSync(privatePath).ino).toBe(journal.releases["sessions.json"].ino)
      expect(readdirSync(directory)).not.toContain("sessions.json.lock")
      expect(success("export-json").phase).toBe("exported")
      expect(readdirSync(directory)).not.toContain("sessions.json.lock")
      expect(readdirSync(directory)).not.toContain(journal.releases["sessions.json"].name)
    }
  })
}
