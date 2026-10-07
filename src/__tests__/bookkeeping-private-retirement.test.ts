import { expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PrivateIdentityError, retireFile } from "../proxy/session/bookkeeping/privateRetirement"
import { archiveIncompleteDirectory } from "../proxy/session/bookkeeping/residueDirectory"
import { digestBytes, observeSource, readJournal, saveJournal, SOURCE_NAMES } from "../proxy/session/bookkeeping/maintenanceJournal"
import type { ArchivedResidue } from "../proxy/session/bookkeeping/residueTypes"

for (const point of ["beforeRename", "afterRename"] as const) it(`generic file retirement resumes at ${point}`, () => {
  const directory = mkdtempSync(join(tmpdir(), "retirement-"))
  const source = join(directory, "public")
  const id = randomUUID()
  try {
    writeFileSync(source, "owned", { mode: 0o600 })
    const expected = lstatSync(source)
    expect(() => retireFile(source, id, expected, { [point]: () => { throw new Error("interrupt") } }))
      .toThrow("interrupt")
    expect(readdirSync(directory).some((name) => name.includes("deletion-intent"))).toBe(true)
    retireFile(source, id, expected)
    expect(readdirSync(directory)).toEqual([])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it("generic retirement restores a substituted public file without deleting its bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "retirement-"))
  const source = join(directory, "public")
  try {
    writeFileSync(source, "owned", { mode: 0o600 })
    expect(() => retireFile(source, randomUUID(), lstatSync(source), { beforeRename: () => {
      renameSync(source, source + ".original")
      writeFileSync(source, "foreign", { mode: 0o600 })
    } })).toThrow(PrivateIdentityError)
    expect(readFileSync(source, "utf8")).toBe("foreign")
    expect(readFileSync(source + ".original", "utf8")).toBe("owned")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it("directory mismatch keeps the capture, writes before/after evidence, and never restores onto public", () => {
  const directory = mkdtempSync(join(tmpdir(), "residue-directory-"))
  const id = randomUUID()
  const name = `sessions.json.lock.candidate-1-${randomUUID()}`
  const source = join(directory, name)
  const archive = join(directory, "residue")
  let captured = ""
  try {
    mkdirSync(source, { mode: 0o700 })
    mkdirSync(archive, { mode: 0o700 })
    const stat = lstatSync(source)
    const row: ArchivedResidue = { path: name, kind: "incomplete-candidate", verdict: "unknown",
      dev: stat.dev, ino: stat.ino, bytes: 0, digest: digestBytes("") }
    saveJournal(directory, { format: "meridian-bookkeeping-migration", version: 1, targetVersion: 1,
      id, phase: "PREPARED", sources: SOURCE_NAMES.map((path) => observeSource(directory, path).identity), residues: [row] })
    try {
      archiveIncompleteDirectory(directory, source, join(archive, name), row, id, {
        beforeRename: (path) => {
          captured = path
          expect(readJournal(directory)?.residues?.[0]?.archiveName).toBe(row.archiveName)
          renameSync(source, source + ".original")
          mkdirSync(source, { mode: 0o700 })
          writeFileSync(join(source, "foreign"), "captured payload")
        },
        afterRename: () => {
          mkdirSync(source, { mode: 0o700 })
          writeFileSync(join(source, "foreign"), "new public payload")
        },
      })
      throw new Error("mismatch unexpectedly accepted")
    } catch (error) {
      expect(error).toBeInstanceOf(PrivateIdentityError)
      expect((error as PrivateIdentityError).exitCode).toBe(5)
      expect(String(error)).toContain("nothing deleted")
      expect(String(error)).toContain(captured)
    }
    const manifest = JSON.parse(readFileSync(captured + ".manifest.json", "utf8"))
    expect(manifest.source).toBe(source)
    expect(manifest.before.ino).toBe(stat.ino)
    expect(manifest.after.ino).toBe(lstatSync(captured).ino)
    expect(manifest.after.ino).not.toBe(manifest.before.ino)
    expect(manifest.reason).toBe("identity mismatch after move")
    expect(Number.isNaN(Date.parse(manifest.time))).toBe(false)
    expect(readFileSync(join(captured, "foreign"), "utf8")).toBe("captured payload")
    expect(readFileSync(join(source, "foreign"), "utf8")).toBe("new public payload")
    expect(existsSync(source + ".original")).toBe(true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
