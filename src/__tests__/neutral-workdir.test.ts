/**
 * neutralWorkingDirectory — the empty directory the SDK subprocess runs in
 * for clients that execute their own tools (Zed).
 *
 * Unit tests, no mocks. The regressions these guard: the subprocess used to
 * run in process.cwd(), the proxy's checkout, so Claude Code attached that
 * repository's CLAUDE.md and git status to every conversation; and git walks
 * up from any directory, so a home directory under version control showed
 * its untracked files the same way.
 */
import { describe, it, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { neutralWorkingDirectory, resolveSdkWorkingDirectory } from "../proxy/cwd"

describe("neutralWorkingDirectory", () => {
  it("creates `workdir` under the config dir, holding only an empty repository", () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-config-"))
    try {
      const dir = neutralWorkingDirectory(root)
      expect(dir).toBe(join(root, "workdir"))
      expect(existsSync(dir)).toBe(true)
      expect(readdirSync(dir)).toEqual([".git"])
      expect(readFileSync(join(dir, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n")
      expect(neutralWorkingDirectory(root)).toBe(dir)
      expect(readdirSync(dir)).toEqual([".git"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("is accepted as-is by resolveSdkWorkingDirectory (it exists on this host)", () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-config-"))
    try {
      const dir = neutralWorkingDirectory(root)
      const r = resolveSdkWorkingDirectory({ envOverride: undefined, adapterCwd: dir, fallback: process.cwd() })
      expect(r.workingDirectory).toBe(dir)
      expect(r.fellBack).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("stops git from walking up into a repository that encloses it", () => {
    const git = spawnSync("git", ["--version"], { encoding: "utf8" })
    if (git.status !== 0) return // no git here; the skeleton test above still covers the shape
    const root = mkdtempSync(join(tmpdir(), "meridian-config-"))
    try {
      // A parent directory under version control, with an untracked file.
      mkdirSync(join(root, ".git", "objects"), { recursive: true })
      mkdirSync(join(root, ".git", "refs"), { recursive: true })
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/master\n")
      writeFileSync(join(root, "secret-notes.txt"), "private")

      const dir = neutralWorkingDirectory(root)
      const toplevel = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" })
      expect(toplevel.status).toBe(0)
      expect(toplevel.stdout.trim().replace(/\//g, "\\").toLowerCase()).toBe(dir.replace(/\//g, "\\").toLowerCase())
      const status = spawnSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })
      expect(status.status).toBe(0)
      expect(status.stdout).toBe("")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
