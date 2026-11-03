/**
 * Meridian setup — Pi extension installation and checks.
 *
 * `meridian setup --client pi` copies the extension source shipped in
 * `plugin/pi/` into Pi's user extensions directory, where Pi loads it as
 * `extensions/meridian/index.ts`. A copy Meridian wrote is replaced wholesale
 * on every run; anything else at that path is moved aside first.
 *
 *   - `meridian setup --client pi` — installs the extension
 *   - `meridian` startup          — warns if it is missing or out of date
 *   - `GET /health`               — reports whether it is installed
 *   - every request               — warns once when a Pi client sends no
 *                                   session identity (notePluginlessPiRequest)
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { ensurePriorityAttestationKey } from "./priorityAttestation"

/** Pi 1.0 renamed the package to `@earendil-works/pi-coding-agent`; the extension imports that name. */
export const MINIMUM_PI_MAJOR_VERSION = 1

const ENTRY_POINT = 'export { default } from "./pi/index"\n'

export class UnsupportedPiVersionError extends Error {
  constructor(public readonly version: string) {
    super(`Pi ${version} is not supported; the Meridian extension requires Pi 1.0 or newer`)
    this.name = "UnsupportedPiVersionError"
  }
}

/**
 * Pi's agent directory: `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`. Pi
 * expands a leading `~` in the variable itself, so a literal `~/…` (common in
 * launchd plists and env files) must name the same directory here.
 */
export function piAgentDirectory(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env.PI_CODING_AGENT_DIR
  if (!configured) return join(home, ".pi", "agent")
  if (configured === "~") return home
  if (configured.startsWith("~/") || (process.platform === "win32" && configured.startsWith("~\\"))) {
    return join(home, configured.slice(2))
  }
  return resolve(configured)
}

export function piExtensionDirectory(agentDirectory: string = piAgentDirectory()): string {
  return join(agentDirectory, "extensions", "meridian")
}

/**
 * The shipped `plugin/` directory, from any entry point. `bin/cli.ts` (source)
 * and `dist/cli.js` (npm) both sit one level below the package root, and the
 * npm package ships `plugin/` as TypeScript.
 */
export function findPluginRoot(fromUrl: string): string {
  return join(dirname(fileURLToPath(fromUrl)), "..", "plugin")
}

/**
 * Every file the installed extension consists of, keyed by its path inside the
 * extension directory. The priority attestation signer is shared with the
 * OpenCode plugins, so it is copied beside the Pi sources at the relative path
 * they import it from.
 */
export function piExtensionFiles(pluginRoot: string): Map<string, Buffer> {
  const source = join(pluginRoot, "pi")
  const files = new Map<string, Buffer>()
  for (const name of readdirSync(source).sort()) {
    if (name.endsWith(".ts")) files.set(join("pi", name), readFileSync(join(source, name)))
  }
  if (!files.has(join("pi", "index.ts"))) throw new Error(`Pi extension source not found in ${source}; reinstall Meridian`)
  files.set("priority-attestation.ts", readFileSync(join(pluginRoot, "priority-attestation.ts")))
  files.set("index.ts", Buffer.from(ENTRY_POINT))
  return files
}

export function parsePiVersion(output: string): string | undefined {
  return output.match(/\b(\d+)\.(\d+)\.(\d+)\b/)?.[0]
}

/**
 * The installed Pi version, or undefined when `pi` cannot be run or reports
 * nothing recognizable. Setup refuses only a version it could actually read.
 */
export function detectPiVersion(run: () => string = () => execFileSync("pi", ["--version"], {
  encoding: "utf8",
  timeout: 10_000,
  stdio: ["ignore", "pipe", "pipe"],
})): string | undefined {
  try {
    return parsePiVersion(run())
  } catch {
    return undefined
  }
}

export function assertSupportedPiVersion(version: string | undefined): void {
  if (version === undefined) return
  if (Number(version.split(".")[0]) < MINIMUM_PI_MAJOR_VERSION) throw new UnsupportedPiVersionError(version)
}

export interface PiSetupResult {
  extensionPath: string
  replaced: boolean
  /** Where a directory Meridian did not install was moved, if there was one. */
  backupPath?: string
}

/** True when `directory` holds a copy this installer wrote: its entry point is Meridian's. */
function isMeridianInstalledCopy(directory: string): boolean {
  try {
    return readFileSync(join(directory, "index.ts"), "utf8") === ENTRY_POINT
  } catch {
    return false
  }
}

/**
 * Install the extension into `<agentDirectory>/extensions/meridian/`.
 *
 * The new copy is staged in the agent directory, outside `extensions/` so a Pi
 * starting meanwhile cannot load it, and swapped in by rename, so an
 * interrupted setup never leaves Pi a half-written extension. A previous
 * Meridian copy is replaced wholesale. Anything else at that path is the
 * user's own and is moved beside `extensions/`, where Pi does not load it,
 * rather than deleted.
 */
export function installPiExtension(
  pluginRoot: string,
  agentDirectory: string = piAgentDirectory(),
): PiSetupResult {
  const files = piExtensionFiles(pluginRoot)
  const target = piExtensionDirectory(agentDirectory)
  const staging = join(agentDirectory, `.meridian-extension-${randomUUID()}.tmp`)
  mkdirSync(dirname(target), { recursive: true })
  try {
    for (const [path, contents] of files) {
      mkdirSync(dirname(join(staging, path)), { recursive: true })
      writeFileSync(join(staging, path), contents)
    }
    const replaced = existsSync(target)
    let backupPath: string | undefined
    if (replaced && !isMeridianInstalledCopy(target)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-")
      backupPath = join(agentDirectory, `meridian-extension-backup-${stamp}-${randomUUID().slice(0, 8)}`)
      renameSync(target, backupPath)
    } else {
      rmSync(target, { recursive: true, force: true })
    }
    try {
      renameSync(staging, target)
      ensurePriorityAttestationKey()
    } catch (error) {
      if (!backupPath) throw error
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Pi extension setup failed after moving ${target} to ${backupPath}: ${reason}`, { cause: error })
    }
    return backupPath ? { extensionPath: target, replaced, backupPath } : { extensionPath: target, replaced }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export function checkPiExtensionConfigured(agentDirectory: string = piAgentDirectory()): boolean {
  return existsSync(join(piExtensionDirectory(agentDirectory), "index.ts"))
}

/** True when an installed copy differs from the extension this Meridian ships. */
export function isPiExtensionOutdated(pluginRoot: string, agentDirectory: string = piAgentDirectory()): boolean {
  const target = piExtensionDirectory(agentDirectory)
  for (const [path, contents] of piExtensionFiles(pluginRoot)) {
    const installed = join(target, path)
    if (!existsSync(installed) || !readFileSync(installed).equals(contents)) return true
  }
  return false
}

/**
 * Startup warning lines for Pi, or undefined when there is nothing to say.
 * Gated on Pi's agent directory existing, like the OpenCode check is gated on
 * its config file, so Meridian stays quiet on machines without Pi.
 */
export function piStartupWarning(pluginRoot: string, agentDirectory: string = piAgentDirectory()): string[] | undefined {
  if (!existsSync(agentDirectory)) return undefined
  if (!checkPiExtensionConfigured(agentDirectory)) {
    return [
      "⚠ Meridian extension not found in Pi.",
      "  Session tracking, subagent model selection and priority failback won't work.",
      "  Fix: meridian setup --client pi",
    ]
  }
  if (isPiExtensionOutdated(pluginRoot, agentDirectory)) {
    return [
      "⚠ Meridian's Pi extension is out of date.",
      `  ${piExtensionDirectory(agentDirectory)} differs from the extension this Meridian ships.`,
      "  Fix: meridian setup --client pi",
    ]
  }
  return undefined
}

let pluginlessPiWarned = false

/** Reset the warned flag. Used by tests. */
export function clearPluginlessPiWarning(): void {
  pluginlessPiWarned = false
}

/**
 * NOTE: agent-specific (pi) — warn once per process when a request selected
 * the Pi adapter but carries no session identity at all: no
 * `x-session-affinity` and no `metadata.user_id` session.
 *
 * That is the shape of Pi pointed at Meridian through `models.json` without
 * the extension. Every request then falls back to fingerprint matching, side
 * calls bind to the conversation, children share the primary model tier, and
 * priority failback can never move the conversation. Oh My Pi (body session ID) and orchestrators
 * that supply their own affinity key are not affected.
 *
 * Returns the message to log, or undefined when there is nothing to say.
 */
export function notePluginlessPiRequest(input: {
  adapterName: string
  sessionId: string | undefined
}): string | undefined {
  if (input.adapterName !== "pi" || input.sessionId || pluginlessPiWarned) return undefined
  pluginlessPiWarned = true
  return (
    "Pi request without a session identity: the Meridian Pi extension is not installed. " +
    "Meridian falls back to fingerprint matching, cannot keep side calls out of the " +
    "conversation or give subagents the base model tier, and cannot apply " +
    "next-user-turn priority failback. " +
    "Fix: meridian setup --client pi, then select a model under the meridian provider."
  )
}
