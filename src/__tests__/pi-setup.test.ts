/**
 * Tests for `meridian setup --client pi` and the Pi extension checks:
 * installation layout, replacement, version gating, the startup warnings and
 * the per-request warning for Pi clients without the extension.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  UnsupportedPiVersionError,
  assertSupportedPiVersion,
  checkPiExtensionConfigured,
  clearPluginlessPiWarning,
  detectPiVersion,
  findPluginRoot,
  installPiExtension,
  isPiExtensionOutdated,
  notePluginlessPiRequest,
  parsePiVersion,
  piAgentDirectory,
  piExtensionDirectory,
  piExtensionFiles,
  piStartupWarning,
} from "../proxy/piSetup"
import { priorityAttestationKeyPath } from "../proxy/priorityAttestation"

const REPO = resolve(import.meta.dir, "..", "..")
const PLUGIN_ROOT = join(REPO, "plugin")

let agentDirectory: string

beforeEach(() => {
  agentDirectory = join(mkdtempSync(join(tmpdir(), "meridian-pi-setup-")), "agent")
  mkdirSync(agentDirectory, { recursive: true })
})

afterEach(() => {
  rmSync(dirname(agentDirectory), { recursive: true, force: true })
})

describe("Pi setup paths", () => {
  test("uses PI_CODING_AGENT_DIR, otherwise ~/.pi/agent", () => {
    expect(piAgentDirectory({ PI_CODING_AGENT_DIR: "/tmp/pi-agent" })).toBe("/tmp/pi-agent")
    expect(piAgentDirectory({})).toMatch(/\.pi\/agent$/)
    expect(piExtensionDirectory("/tmp/pi-agent")).toBe("/tmp/pi-agent/extensions/meridian")
  })

  test("expands a leading ~ in PI_CODING_AGENT_DIR the way Pi does", () => {
    expect(piAgentDirectory({ PI_CODING_AGENT_DIR: "~/pi-agent" }, "/home/u")).toBe(join("/home/u", "pi-agent"))
    expect(piAgentDirectory({ PI_CODING_AGENT_DIR: "~" }, "/home/u")).toBe("/home/u")
    expect(piAgentDirectory({ PI_CODING_AGENT_DIR: "pi-~agent" }, "/home/u")).toBe(resolve("pi-~agent"))
  })

  test("finds the shipped plugin directory from the source and the npm entry points", () => {
    expect(findPluginRoot(pathToFileURL(join(REPO, "bin", "cli.ts")).href)).toBe(PLUGIN_ROOT)
    expect(findPluginRoot(pathToFileURL(join(REPO, "dist", "cli.js")).href)).toBe(PLUGIN_ROOT)
  })

  test("the npm package ships the extension sources", () => {
    const files: string[] = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).files
    expect(files).toContain("plugin/")
  })
})

describe("Pi extension installation", () => {
  test("copies the extension, its shared signer and an entry point Pi loads", () => {
    const result = installPiExtension(PLUGIN_ROOT, agentDirectory)
    const target = piExtensionDirectory(agentDirectory)

    expect(result).toEqual({ extensionPath: target, replaced: false })
    expect(readFileSync(join(target, "index.ts"), "utf8")).toBe('export { default } from "./pi/index"\n')
    expect(readFileSync(join(target, "priority-attestation.ts"))).toEqual(readFileSync(join(PLUGIN_ROOT, "priority-attestation.ts")))
    for (const name of readdirSync(join(PLUGIN_ROOT, "pi"))) {
      expect(readFileSync(join(target, "pi", name))).toEqual(readFileSync(join(PLUGIN_ROOT, "pi", name)))
    }
    expect(readdirSync(agentDirectory).filter(name => name.startsWith(".meridian-extension-"))).toEqual([])
  })

  test("every relative import in the installed copy resolves inside it", () => {
    installPiExtension(PLUGIN_ROOT, agentDirectory)
    const target = piExtensionDirectory(agentDirectory)
    for (const path of piExtensionFiles(PLUGIN_ROOT).keys()) {
      const source = readFileSync(join(target, path), "utf8")
      for (const [, specifier] of source.matchAll(/from "(\.{1,2}\/[^"]+)"/g)) {
        const resolved = resolve(dirname(join(target, path)), specifier!)
        expect(existsSync(`${resolved}.ts`) || existsSync(resolved)).toBe(true)
      }
    }
  })

  test("replaces an earlier Meridian copy wholesale", () => {
    installPiExtension(PLUGIN_ROOT, agentDirectory)
    const target = piExtensionDirectory(agentDirectory)
    writeFileSync(join(target, "pi", "leftover.ts"), "stale\n")
    writeFileSync(join(target, "pi", "headers.ts"), "// edited\n")

    const result = installPiExtension(PLUGIN_ROOT, agentDirectory)
    expect(result).toEqual({ extensionPath: target, replaced: true })
    expect(existsSync(join(target, "pi", "leftover.ts"))).toBe(false)
    expect(isPiExtensionOutdated(PLUGIN_ROOT, agentDirectory)).toBe(false)
    expect(readdirSync(agentDirectory).filter(name => name.startsWith("meridian-extension-backup-"))).toEqual([])
  })

  test("moves a directory Meridian did not install aside instead of deleting it", () => {
    const target = piExtensionDirectory(agentDirectory)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "index.ts"), "export default function mine() {}\n")
    writeFileSync(join(target, "notes.md"), "keep me\n")

    const result = installPiExtension(PLUGIN_ROOT, agentDirectory)
    expect(result.replaced).toBe(true)
    expect(result.backupPath).toBeDefined()
    expect(dirname(result.backupPath!)).toBe(agentDirectory)
    expect(readFileSync(join(result.backupPath!, "index.ts"), "utf8")).toBe("export default function mine() {}\n")
    expect(readFileSync(join(result.backupPath!, "notes.md"), "utf8")).toBe("keep me\n")
    expect(existsSync(join(target, "notes.md"))).toBe(false)
    expect(isPiExtensionOutdated(PLUGIN_ROOT, agentDirectory)).toBe(false)
  })

  test("names the backup when setup fails after moving a directory aside", () => {
    const target = piExtensionDirectory(agentDirectory)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "index.ts"), "export default function mine() {}\n")
    const previousKey = process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
    process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = "not-a-key"
    try {
      expect(() => installPiExtension(PLUGIN_ROOT, agentDirectory)).toThrow(/meridian-extension-backup-/)
    } finally {
      if (previousKey === undefined) delete process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
      else process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = previousKey
    }
    const [backup] = readdirSync(agentDirectory).filter(name => name.startsWith("meridian-extension-backup-"))
    expect(readFileSync(join(agentDirectory, backup!, "index.ts"), "utf8")).toBe("export default function mine() {}\n")
  })

  test("provisions the attestation key the extension signs with", () => {
    rmSync(priorityAttestationKeyPath(), { force: true })
    installPiExtension(PLUGIN_ROOT, agentDirectory)
    expect(existsSync(priorityAttestationKeyPath())).toBe(true)
  })
})

describe("Pi version gate", () => {
  test("reads the version Pi prints", () => {
    expect(parsePiVersion("1.3.0\n")).toBe("1.3.0")
    expect(parsePiVersion("pi 0.72.1")).toBe("0.72.1")
    expect(parsePiVersion("unknown")).toBeUndefined()
  })

  test("refuses only a pre-1.0 Pi it could actually read", () => {
    expect(() => assertSupportedPiVersion("0.72.1")).toThrow(UnsupportedPiVersionError)
    expect(() => assertSupportedPiVersion("1.0.0")).not.toThrow()
    expect(() => assertSupportedPiVersion("2.4.1")).not.toThrow()
    expect(() => assertSupportedPiVersion(undefined)).not.toThrow()
  })

  test("treats a missing or failing pi executable as unknown", () => {
    expect(detectPiVersion(() => { throw new Error("spawn pi ENOENT") })).toBeUndefined()
    expect(detectPiVersion(() => "1.3.0\n")).toBe("1.3.0")
  })
})

describe("Pi startup checks", () => {
  test("say nothing when Pi is not installed", () => {
    rmSync(agentDirectory, { recursive: true })
    expect(piStartupWarning(PLUGIN_ROOT, agentDirectory)).toBeUndefined()
    expect(checkPiExtensionConfigured(agentDirectory)).toBe(false)
  })

  test("warn when Pi is installed without the extension", () => {
    expect(checkPiExtensionConfigured(agentDirectory)).toBe(false)
    expect(piStartupWarning(PLUGIN_ROOT, agentDirectory)?.[0]).toContain("Meridian extension not found in Pi")
  })

  test("say nothing for an up-to-date copy", () => {
    installPiExtension(PLUGIN_ROOT, agentDirectory)
    expect(checkPiExtensionConfigured(agentDirectory)).toBe(true)
    expect(piStartupWarning(PLUGIN_ROOT, agentDirectory)).toBeUndefined()
  })

  test("warn when the copy differs from the shipped extension", () => {
    installPiExtension(PLUGIN_ROOT, agentDirectory)
    writeFileSync(join(piExtensionDirectory(agentDirectory), "pi", "headers.ts"), "// older release\n")
    expect(isPiExtensionOutdated(PLUGIN_ROOT, agentDirectory)).toBe(true)
    expect(piStartupWarning(PLUGIN_ROOT, agentDirectory)?.[0]).toContain("out of date")
    rmSync(join(piExtensionDirectory(agentDirectory), "priority-attestation.ts"))
    expect(isPiExtensionOutdated(PLUGIN_ROOT, agentDirectory)).toBe(true)
  })
})

describe("Pi requests without the extension", () => {
  beforeEach(() => clearPluginlessPiWarning())

  test("warn once per process when a Pi request carries no session identity", () => {
    expect(notePluginlessPiRequest({ adapterName: "pi", sessionId: undefined })).toContain("meridian setup --client pi")
    expect(notePluginlessPiRequest({ adapterName: "pi", sessionId: undefined })).toBeUndefined()
  })

  test("say nothing for keyed Pi requests or other adapters", () => {
    expect(notePluginlessPiRequest({ adapterName: "pi", sessionId: "019a-session" })).toBeUndefined()
    expect(notePluginlessPiRequest({ adapterName: "opencode", sessionId: undefined })).toBeUndefined()
    expect(notePluginlessPiRequest({ adapterName: "pi", sessionId: undefined })).toBeDefined()
  })
})
