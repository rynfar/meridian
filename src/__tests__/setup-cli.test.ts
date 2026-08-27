/**
 * CLI boundary tests for OpenCode generation selection and fail-closed setup.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir, platform } from "os"
import { join } from "path"
import { spawnSync } from "child_process"

const repoRoot = join(import.meta.dir, "../..")
const cliPath = join(repoRoot, "bin", "cli.ts")

function writeVersionCommand(dir: string, output: string): string {
  const windows = platform() === "win32"
  const path = join(dir, windows ? "fake-opencode.cmd" : "fake-opencode")
  const script = windows
    ? `@echo off
echo ${output}
`
    : `#!/bin/sh
printf '%s\n' '${output}'
`
  writeFileSync(path, script)
  if (!windows) chmodSync(path, 0o755)
  return path
}

describe("meridian setup CLI", () => {
  let root: string
  let configDir: string
  let configPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "meridian-setup-cli-test-"))
    configDir = join(root, "config")
    mkdirSync(configDir)
    configPath = join(configDir, "opencode.json")
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function runSetup(args: string[]) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FORCE_COLOR: "0",
      OPENCODE_CONFIG_DIR: configDir,
    }
    delete env.OPENCODE_BIN
    return spawnSync(process.execPath, [cliPath, "setup", ...args], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    })
  }

  test("installs the V2 source plugin for the exact beta through an npm-style shim", () => {
    const binary = writeVersionCommand(root, "opencode2 v0.0.0-beta-18314")
    const result = runSetup(["--v2", "--opencode-bin", binary])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("configured for OpenCode V2")
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    expect(config.plugins).toHaveLength(1)
    expect(config.plugins[0]).toEndWith(join("plugin", "meridian-v2.ts"))
  })

  test("preserves the V1 setup path when explicitly selected", () => {
    const binary = writeVersionCommand(root, "1.18.11")
    const result = runSetup(["--opencode-bin", binary])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("configured for OpenCode V1")
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    expect(config.plugin[0]).toEndWith(join("plugin", "meridian.ts"))
  })

  test("rejects an invalid explicit version probe without touching config", () => {
    const binary = writeVersionCommand(root, "OpenCode 2 beta unknown")
    const original = '{"plugin":["keep-me"]}\n'
    writeFileSync(configPath, original, { flag: "wx" })
    const result = runSetup(["--opencode-bin", binary])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Could not read a supported OpenCode version")
    expect(readFileSync(configPath, "utf8")).toBe(original)
  })

  test("rejects beta API churn without touching config", () => {
    const binary = writeVersionCommand(root, "opencode2 v0.0.0-beta-18371")
    const original = '{"plugin":["keep-me"]}\n'
    writeFileSync(configPath, original, { flag: "wx" })
    const result = runSetup(["--v2", "--opencode-bin", binary])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("0.0.0-beta-18371 is not supported")
    expect(readFileSync(configPath, "utf8")).toBe(original)
  })

  test("rejects a Meridian entry in the sibling JSONC document without touching either file", () => {
    const binary = writeVersionCommand(root, "opencode2 v0.0.0-beta-18314")
    const original = '{"plugins":["keep-me"]}\n'
    const siblingPath = join(configDir, "opencode.jsonc")
    const sibling = '{\n  "plugins": ["/old/meridian-v2.js"]\n}\n'
    writeFileSync(configPath, original)
    writeFileSync(siblingPath, sibling)

    const result = runSetup(["--v2", "--opencode-bin", binary])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("other OpenCode config file")
    expect(result.stderr).toContain("Both files were left untouched")
    expect(readFileSync(configPath, "utf8")).toBe(original)
    expect(readFileSync(siblingPath, "utf8")).toBe(sibling)
  })

  test("rejects conflicting generation flags before writing config", () => {
    const result = runSetup(["--v1", "--v2"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Choose only one OpenCode generation")
    expect(() => readFileSync(configPath, "utf8")).toThrow()
  })
})
