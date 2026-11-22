/**
 * Idle transcript sweep: Claude Code's own retention cleanup, for config roots
 * that no request has given the chance to run it. Runs only where opt-in
 * retention (transcriptRetention.ts) is on. Rationale and limits:
 * `src/proxy/SPEC.md` (Decisions) and `docs/configuration.md`.
 *
 * Claude Code deletes transcripts older than `cleanupPeriodDays` from inside a
 * running CLI process, a few seconds after it starts, at most once a day per
 * config root (`.last-cleanup` records the last run). Meridian only starts CLI
 * processes for requests, so a root that serves no requests, or only requests
 * that end before the cleanup gets going, is never cleaned. Every few hours
 * this module starts one CLI process per such root, sends it nothing, and
 * stops it once `.last-cleanup` advances.
 *
 * Process custody. The caller runs the child on the same gated path as a
 * request (session/sdkProcessGate.ts): it resolves only once the exact CLI
 * process has exited, and the SDK slot is released only then. `stop()` waits
 * for that join, however long it takes; a shutdown deadline reports it.
 *
 * Root reservation. A root is reserved before its login is read and kept until
 * the child is joined. The caller's request admission refuses the reservation
 * while a request runs there, and preempts it when a request arrives: the
 * child is stopped, never started.
 *
 * Starting a CLI process is not free of side effects. An idle process whose
 * stored login is expired or about to expire tries to refresh it; with a valid
 * one it fetches the account profile, remote settings and policy limits. So:
 *
 *   - every outbound connection of the child goes to a loopback proxy that
 *     refuses it (HTTPS_PROXY and friends, NO_PROXY cleared);
 *   - a root whose login would be refreshed within the child's lifetime is
 *     skipped until Meridian's own refresher has rolled it;
 *   - an instance under MERIDIAN_CREDENTIALS_READONLY never starts one;
 *   - the stored login is compared before and after each child. Without the
 *     network the child cannot refresh it, so a login that is still usable and
 *     newer afterwards was renewed elsewhere (Meridian's refresher, a sign-in,
 *     a request that ran there). Any other change stops the sweep for the life
 *     of the process.
 *
 * Transcripts Meridian still needs. Claude Code's cleanup deletes by mtime
 * alone. Before a child runs, every transcript the session store still maps
 * or a request has pinned in that root, and that the cleanup could reach, gets
 * a current mtime (`protectPinnedTranscripts`), so it survives the cleanup the
 * way a conversation still in use does.
 */

import { createHash } from "node:crypto"
import { existsSync, realpathSync, statSync } from "node:fs"
import { readdir, stat, utimes } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { join, resolve } from "node:path"
import type { query } from "@anthropic-ai/claude-agent-sdk"
import { buildQueryOptions, resolveQueryConfigDir } from "./query"
import type { ResolvedProfile } from "./profiles"
import type { TranscriptLocator } from "./session/bookkeeping/locator"
import type { CredentialsFile } from "./tokenRefresh"
import { resolveTranscriptRetention } from "./transcriptRetention"

/** How often idle roots are looked at; MERIDIAN_TRANSCRIPT_SWEEP_INTERVAL_MS, 0 turns it off. */
export const DEFAULT_TRANSCRIPT_SWEEP_INTERVAL_MS = 3 * 60 * 60_000
/** The first look after startup, late enough not to add to a restart under load; sooner only with a shorter interval. */
export const TRANSCRIPT_SWEEP_INITIAL_DELAY_MS = 2 * 60_000
/**
 * The stored access token must stay valid at least this long. Claude Code
 * refreshes within five minutes of expiry and a child lives at most ten.
 */
export const MIN_TOKEN_VALIDITY_MS = 30 * 60_000
/** Claude Code's own throttle: one cleanup per root per day. */
export const CLAUDE_CODE_CLEANUP_EVERY_MS = 24 * 60 * 60_000
const CHILD_TIMEOUT_MS = 10 * 60_000
const POLL_MS = 1_000
const DAY_MS = 24 * 60 * 60_000

/** Never handed to the child: it must find no credential it could use or refresh. */
const CHILD_ENV_DROP = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
  "CLAUDE_CODE_USE_POWERSHELL_TOOL",
  "CLAUDE_CONFIG_DIR",
] as const

const REFUSAL = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"

export interface SweepRoot {
  /** Absolute config root: the directory Claude Code cleans. */
  readonly configDir: string
  /**
   * Whether the child is started with CLAUDE_CONFIG_DIR. False for the default
   * ~/.claude, where naming it explicitly moves .claude.json and the Keychain
   * entry (#453), which a request never does there either.
   */
  readonly explicitConfigDir: boolean
  /** Profiles served from this root, for the log. */
  readonly profileIds: readonly string[]
}

/** The distinct config roots the given profiles' requests run in. */
export function listSweepRoots(
  profiles: readonly ResolvedProfile[],
  processEnv: NodeJS.ProcessEnv,
): SweepRoot[] {
  const roots = new Map<string, { configDir: string; explicitConfigDir: boolean; profileIds: string[] }>()
  for (const profile of profiles) {
    const env: Record<string, string | undefined> = { ...processEnv, ...profile.env }
    const configDir = resolveQueryConfigDir(env, false)
    const key = canonicalConfigDir(configDir)
    const known = roots.get(key)
    if (known) known.profileIds.push(profile.id)
    else roots.set(key, { configDir, explicitConfigDir: Boolean(env.CLAUDE_CONFIG_DIR), profileIds: [profile.id] })
  }
  return [...roots.values()]
}

export type StoredLogin =
  /** No refresh token: there is nothing Claude Code could refresh. */
  | "no-login"
  /** Valid well past the child's lifetime. */
  | "valid"
  /** Claude Code would try to refresh it while the child runs. */
  | "refresh-due"
  | "unreadable"

export function classifyStoredLogin(
  credentials: CredentialsFile | null | undefined,
  now: number,
  minValidityMs: number = MIN_TOKEN_VALIDITY_MS,
): StoredLogin {
  if (!credentials) return "unreadable"
  const oauth = credentials.claudeAiOauth
  if (!oauth || typeof oauth.refreshToken !== "string" || oauth.refreshToken === "") return "no-login"
  if (typeof oauth.accessToken !== "string" || oauth.accessToken === "") return "refresh-due"
  if (typeof oauth.expiresAt !== "number" || !Number.isFinite(oauth.expiresAt)) return "refresh-due"
  return oauth.expiresAt - now >= minValidityMs ? "valid" : "refresh-due"
}

/**
 * What a change of the stored login while the child ran says. Identity is the
 * tokens and their expiry, never logged, only compared: not the file's
 * metadata, since a root can also be someone's interactive ~/.claude.
 */
export type LoginChange = "none" | "renewed-elsewhere" | "unexplained"

export function classifyLoginChange(
  before: CredentialsFile | null | undefined,
  after: CredentialsFile | null | undefined,
  now: number,
): LoginChange {
  if (loginFingerprint(before) === loginFingerprint(after)) return "none"
  // The child has no network, so it cannot obtain a token. A login that is
  // usable afterwards and expires no earlier than before came from elsewhere.
  const next = after?.claudeAiOauth
  const previousExpiry = before?.claudeAiOauth?.expiresAt
  const usable = classifyStoredLogin(after, now, 0) === "valid"
  const notOlder = typeof next?.expiresAt === "number"
    && (typeof previousExpiry !== "number" || next.expiresAt >= previousExpiry)
  return usable && notOlder ? "renewed-elsewhere" : "unexplained"
}

function loginFingerprint(credentials: CredentialsFile | null | undefined): string {
  if (credentials === undefined) return "unreadable"
  const oauth = credentials?.claudeAiOauth
  return createHash("sha256")
    .update(JSON.stringify([oauth?.accessToken, oauth?.refreshToken, oauth?.expiresAt]))
    .digest("hex")
}

function mtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

/** When Claude Code last ran its cleanup in this root, if ever. */
export function lastCleanupAt(configDir: string): number | undefined {
  const times = [join(configDir, ".last-cleanup"), join(configDir, "state", "last-cleanup")]
    .map(mtimeMs)
    .filter((time): time is number => time !== undefined)
  return times.length > 0 ? Math.max(...times) : undefined
}

/** Whether Claude Code's next process in this root runs its cleanup. */
export function cleanupDue(configDir: string, now = Date.now()): boolean {
  const last = lastCleanupAt(configDir)
  return last === undefined || now - last >= CLAUDE_CODE_CLEANUP_EVERY_MS
}

function cleanupAdvanced(configDir: string, before: number | undefined): boolean {
  const after = lastCleanupAt(configDir)
  return after !== undefined && (before === undefined || after > before)
}

/** One key per directory, however a profile spells it: symlinks resolved. */
export function canonicalConfigDir(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

/**
 * Give every transcript Meridian still needs in `configDir`, that a cleanup
 * with `retentionDays` could reach before its next refresh here, a current
 * mtime: the transcript file and everything under its sidecar directory.
 * Claude Code keeps transcripts by mtime, so a pinned one now survives the
 * cleanup like any conversation in use. Files are found by session id under
 * `projects/`, without decoding Claude Code's directory naming. Returns how
 * many transcripts were refreshed. Throws when a pinned transcript could not be
 * found or touched for any reason other than its absence: the caller then
 * runs no cleanup there.
 */
export async function protectPinnedTranscripts(
  configDir: string,
  pins: readonly TranscriptLocator[],
  retentionDays: number,
  now = Date.now(),
): Promise<number> {
  const root = canonicalConfigDir(configDir)
  const sessionIds = new Set(pins.filter((pin) => canonicalConfigDir(pin.configDir) === root).map((pin) => pin.sessionId))
  if (sessionIds.size === 0 || retentionDays <= 0) return 0
  // A file this close to the period could be deleted before the next look.
  const period = retentionDays * DAY_MS
  const reachableBefore = now - Math.max(period - DAY_MS, period / 2)
  const projects = join(configDir, "projects")
  let projectDirs: string[]
  try {
    projectDirs = (await readdir(projects, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => join(projects, entry.name))
  } catch (error) {
    if (isMissing(error)) return 0
    throw error
  }
  const at = new Date(now)
  let refreshed = 0
  for (const projectDir of projectDirs) {
    let names: string[]
    try {
      names = await readdir(projectDir)
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue
      const sessionId = name.slice(0, -".jsonl".length)
      if (!sessionIds.has(sessionId)) continue
      const transcript = join(projectDir, name)
      const info = await stat(transcript).catch((error: unknown) => {
        if (isMissing(error)) return undefined
        throw error
      })
      if (!info || info.mtimeMs >= reachableBefore) continue
      await utimes(transcript, at, at)
      await touchTree(join(projectDir, sessionId), at)
      refreshed++
    }
  }
  return refreshed
}

async function touchTree(path: string, at: Date): Promise<void> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await touchTree(child, at)
    else await utimes(child, at, at)
  }
  await utimes(path, at, at)
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "<token>").slice(0, 200)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export interface RefusingProxy {
  readonly env: Readonly<Record<string, string>>
  readonly refused: number
  close(): Promise<void>
}

/** A loopback HTTP proxy that refuses every request without reading it. */
export async function openRefusingProxy(): Promise<RefusingProxy> {
  let refused = 0
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    refused++
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => socket.destroy())
    socket.setTimeout(5_000, () => socket.destroy())
    // Answered once the request arrives and never kept: a plain-HTTP request
    // sent through a proxy carries its headers here.
    socket.once("data", () => socket.end(REFUSAL))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    server.close()
    throw new Error("transcript sweep: the refusing proxy has no TCP address")
  }
  const url = `http://127.0.0.1:${address.port}`
  return {
    env: {
      HTTPS_PROXY: url, HTTP_PROXY: url, ALL_PROXY: url,
      https_proxy: url, http_proxy: url, all_proxy: url,
      NO_PROXY: "", no_proxy: "",
    },
    get refused() { return refused },
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

async function* untilAborted(signal: AbortSignal): AsyncGenerator<never, void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

function childEnv(root: SweepRoot, processEnv: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...processEnv }
  for (const key of CHILD_ENV_DROP) delete env[key]
  if (root.explicitConfigDir) env.CLAUDE_CONFIG_DIR = root.configDir
  return env
}

/**
 * The query for one idle Claude Code process in `root`, isolated like a
 * request's (no settings file, the resolved `cleanupPeriodDays`), with no
 * prompt, no session persistence and no network. It runs until `abort` fires.
 * The caller runs it on its gated path and joins the process.
 */
export function idleSweepQuery(input: {
  readonly root: SweepRoot
  readonly retentionDays: number
  readonly claudeExecutable: string
  readonly abort: AbortController
  readonly proxyEnv: Readonly<Record<string, string>>
  readonly processEnv?: NodeJS.ProcessEnv
}): Parameters<typeof query>[0] {
  const { prompt, options } = buildQueryOptions({
    prompt: untilAborted(input.abort.signal),
    model: "sonnet",
    workingDirectory: input.root.configDir,
    systemContext: "",
    claudeExecutable: input.claudeExecutable,
    passthrough: true,
    stream: false,
    sdkAgents: {},
    cleanEnv: childEnv(input.root, input.processEnv ?? process.env),
    envOverrides: input.proxyEnv,
    hasDeferredTools: false,
    isUndo: false,
    blockedTools: [],
    incompatibleTools: [],
    mcpServerName: "meridian-transcript-sweep",
    allowedMcpTools: [],
    settingSources: [],
    transcriptRetentionDays: input.retentionDays,
  }, input.abort)
  return { prompt, options: { ...options, persistSession: false } }
}

export interface IdleChildOutcome {
  /** Outbound connections the child attempted; every one was refused. */
  readonly refusedConnections: number
  readonly error?: string
}

/** A free SDK slot. Released once; later calls do nothing. */
export interface SweepSlot {
  release(): void
}

export interface RootReservation {
  /** Aborts when a request arrives in the root: the child must stop. */
  readonly preempted: AbortSignal
  release(): void
}

export type SweepSkipReason =
  /** Retention resolves to no period for this root. */
  | "off"
  | "missing"
  /** Claude Code cleaned this root within the last day. */
  | "fresh"
  | "draining"
  /** A request's Claude Code process runs, or arrived, in this root. */
  | "busy"
  | "login-unreadable"
  | "refresh-due"
  | "no-slot"

export type SweepOutcome =
  | { readonly kind: "skipped"; readonly reason: SweepSkipReason }
  | {
    readonly kind: "swept" | "timed-out" | "stopped" | "preempted"
    readonly durationMs: number
    readonly refusedConnections: number
    readonly pinsProtected: number
  }
  | { readonly kind: "failed"; readonly durationMs: number; readonly error: string }
  | { readonly kind: "login-changed"; readonly durationMs: number }

export interface SweepRootResult {
  readonly configDir: string
  readonly profileIds: readonly string[]
  readonly outcome: SweepOutcome
}

export interface TranscriptSweepOptions {
  listRoots(): readonly SweepRoot[]
  /**
   * Reserve `configDir` for one child, atomically with request admission:
   * undefined while a request runs there or another reservation is held.
   */
  reserveRoot(configDir: string): RootReservation | undefined
  isDraining(): boolean
  credentialsReadOnly(): boolean
  /** A free SDK slot, or undefined; must never queue. */
  tryAcquireSlot(): SweepSlot | undefined
  /** The stored login Claude Code will find in this root; null when unreadable. */
  readCredentials(root: SweepRoot): Promise<CredentialsFile | null>
  /** Transcripts Meridian still needs: durable mappings and in-flight pins. */
  pinnedTranscripts(): readonly TranscriptLocator[]
  /**
   * Run one child holding `slot` until `signal` aborts. Must resolve only
   * after the child process has been joined, and release `slot` only then.
   */
  runChild(root: SweepRoot, retentionDays: number, slot: SweepSlot, signal: AbortSignal): Promise<IdleChildOutcome>
  log(line: string): void
  intervalMs?: number
  initialDelayMs?: number
  childTimeoutMs?: number
  pollMs?: number
  minTokenValidityMs?: number
  now?(): number
}

export interface TranscriptSweep {
  start(): void
  /** Stops scheduling and waits for a running child to be joined. */
  stop(): Promise<void>
  /** One pass over every root, one at a time; joins a pass already running. */
  runPass(): Promise<readonly SweepRootResult[]>
  /** True once a stored login changed unexplained while a child ran; nothing runs again. */
  readonly disabled: boolean
}

/**
 * The sweep of each server createProxyServer built, for startProxyServer and
 * tests. Kept here rather than on ProxyServer: it is not part of the plugin
 * contract.
 */
export const idleTranscriptSweeps = new WeakMap<object, TranscriptSweep>()

const skipped = (reason: SweepSkipReason): SweepOutcome => ({ kind: "skipped", reason })

/** A slot that can be released from both the runner and the sweep, once. */
function releaseOnce(slot: SweepSlot): SweepSlot {
  let released = false
  return {
    release() {
      if (released) return
      released = true
      slot.release()
    },
  }
}

export function createTranscriptSweep(options: TranscriptSweepOptions): TranscriptSweep {
  const now = options.now ?? Date.now
  const intervalMs = options.intervalMs ?? DEFAULT_TRANSCRIPT_SWEEP_INTERVAL_MS
  const initialDelayMs = options.initialDelayMs ?? TRANSCRIPT_SWEEP_INITIAL_DELAY_MS
  const childTimeoutMs = options.childTimeoutMs ?? CHILD_TIMEOUT_MS
  const pollMs = options.pollMs ?? POLL_MS
  const minTokenValidityMs = options.minTokenValidityMs ?? MIN_TOKEN_VALIDITY_MS

  let disabled = false
  let stopping = false
  let initialTimer: ReturnType<typeof setTimeout> | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let pass: Promise<readonly SweepRootResult[]> | undefined
  let currentChild: AbortController | undefined

  async function readOrUndefined(root: SweepRoot): Promise<CredentialsFile | null | undefined> {
    try {
      return await options.readCredentials(root)
    } catch {
      return undefined
    }
  }

  /** Runs the child to its join; the slot is released by then. */
  async function runChildUntilCleaned(
    root: SweepRoot,
    retentionDays: number,
    slot: SweepSlot,
    reservation: RootReservation,
    before: number | undefined,
    startedAt: number,
    pinsProtected: number,
  ): Promise<SweepOutcome> {
    const controller = new AbortController()
    currentChild = controller
    const stopChild = (): void => controller.abort()
    reservation.preempted.addEventListener("abort", stopChild, { once: true })
    let finished = false
    const child = options.runChild(root, retentionDays, slot, controller.signal)
      .catch((error: unknown): IdleChildOutcome => ({ refusedConnections: 0, error: errorText(error) }))
      .finally(() => { finished = true })
    let advanced = false
    let timedOut = false
    try {
      while (!finished && !stopping && !controller.signal.aborted) {
        if (cleanupAdvanced(root.configDir, before)) {
          advanced = true
          break
        }
        if (now() - startedAt >= childTimeoutMs) {
          timedOut = true
          break
        }
        await Promise.race([child, delay(pollMs)])
      }
    } finally {
      controller.abort()
      reservation.preempted.removeEventListener("abort", stopChild)
    }
    // Custody: no bounded wait. The runner resolves once the process is joined.
    const result = await child
    slot.release()
    currentChild = undefined
    advanced ||= cleanupAdvanced(root.configDir, before)
    const durationMs = now() - startedAt
    const refusedConnections = result.refusedConnections
    if (advanced) return { kind: "swept", durationMs, refusedConnections, pinsProtected }
    if (timedOut) return { kind: "timed-out", durationMs, refusedConnections, pinsProtected }
    if (reservation.preempted.aborted) return { kind: "preempted", durationMs, refusedConnections, pinsProtected }
    if (stopping) return { kind: "stopped", durationMs, refusedConnections, pinsProtected }
    return { kind: "failed", durationMs, error: result.error ?? "Claude Code exited before its cleanup ran" }
  }

  async function sweepRoot(root: SweepRoot): Promise<SweepOutcome> {
    const { days } = resolveTranscriptRetention(root.configDir)
    if (days === 0) return skipped("off")
    if (!existsSync(root.configDir)) return skipped("missing")
    const before = lastCleanupAt(root.configDir)
    if (before !== undefined && now() - before < CLAUDE_CODE_CLEANUP_EVERY_MS) return skipped("fresh")
    if (options.isDraining()) return skipped("draining")
    // Reserved before the login is read and kept until the child is joined.
    const reservation = options.reserveRoot(root.configDir)
    if (!reservation) return skipped("busy")
    try {
      const credentials = await readOrUndefined(root)
      if (reservation.preempted.aborted) return skipped("busy")
      const login = classifyStoredLogin(credentials, now(), minTokenValidityMs)
      if (login === "unreadable") return skipped("login-unreadable")
      if (login === "refresh-due") return skipped("refresh-due")
      const acquired = options.tryAcquireSlot()
      if (!acquired) return skipped("no-slot")
      const slot = releaseOnce(acquired)
      const startedAt = now()
      let pinsProtected = 0
      try {
        pinsProtected = await protectPinnedTranscripts(root.configDir, options.pinnedTranscripts(), days, now())
      } catch (error) {
        slot.release()
        return { kind: "failed", durationMs: now() - startedAt, error: `pins not protected: ${errorText(error)}` }
      }
      if (reservation.preempted.aborted || stopping) {
        slot.release()
        return skipped("busy")
      }
      const outcome = await runChildUntilCleaned(root, days, slot, reservation, before, startedAt, pinsProtected)
      const change = classifyLoginChange(credentials, await readOrUndefined(root), now())
      if (change === "unexplained" && !reservation.preempted.aborted) {
        disabled = true
        return { kind: "login-changed", durationMs: now() - startedAt }
      }
      if (change !== "none") {
        options.log(`[PROXY] transcript sweep: the stored login for ${root.profileIds.join(",")} was renewed elsewhere while the idle process ran`)
      }
      return outcome
    } finally {
      reservation.release()
    }
  }

  function report(root: SweepRoot, outcome: SweepOutcome): void {
    const who = root.profileIds.join(",")
    const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`
    switch (outcome.kind) {
      case "swept":
        options.log(`[PROXY] transcript sweep: ${who} cleaned in ${seconds(outcome.durationMs)} (${outcome.refusedConnections} outbound connections refused, ${outcome.pinsProtected} pinned transcripts kept)`)
        break
      case "timed-out":
        options.log(`[PROXY] transcript sweep: ${who} stopped after ${seconds(outcome.durationMs)} without a cleanup; the next pass retries`)
        break
      case "preempted":
        options.log(`[PROXY] transcript sweep: ${who} stopped after ${seconds(outcome.durationMs)}: a request arrived there; the next pass retries`)
        break
      case "failed":
        options.log(`[PROXY] transcript sweep: ${who} failed after ${seconds(outcome.durationMs)}: ${outcome.error}`)
        break
      case "login-changed":
        options.log(
          `[PROXY] transcript sweep STOPPED: the stored login for ${who} changed while an idle Claude Code process ran there, ` +
          `and not to a renewed login. No idle sweep runs again until restart; requests still clean up as before. Please report this.`,
        )
        break
      case "skipped":
      case "stopped":
        break
    }
  }

  async function runOnePass(): Promise<readonly SweepRootResult[]> {
    const results: SweepRootResult[] = []
    if (disabled || stopping || options.credentialsReadOnly()) return results
    for (const root of options.listRoots()) {
      if (disabled || stopping) break
      let outcome: SweepOutcome
      try {
        outcome = await sweepRoot(root)
      } catch (error) {
        outcome = { kind: "failed", durationMs: 0, error: errorText(error) }
      }
      results.push({ configDir: root.configDir, profileIds: root.profileIds, outcome })
      report(root, outcome)
    }
    const waiting = results.filter((result) => result.outcome.kind === "skipped"
      && ["refresh-due", "busy", "no-slot", "login-unreadable"].includes(result.outcome.reason))
    if (waiting.length > 0) {
      options.log(`[PROXY] transcript sweep: not cleaned this pass: ${waiting.map((result) =>
        `${result.profileIds.join(",")} (${result.outcome.kind === "skipped" ? result.outcome.reason : ""})`).join(", ")}`)
    }
    return results
  }

  function runPass(): Promise<readonly SweepRootResult[]> {
    pass ??= runOnePass().finally(() => { pass = undefined })
    return pass
  }

  function scheduledPass(): void {
    runPass().catch((error: unknown) => options.log(`[PROXY] transcript sweep failed: ${errorText(error)}`))
  }

  return {
    start() {
      if (initialTimer || interval || stopping || intervalMs <= 0) return
      if (options.credentialsReadOnly()) {
        options.log("[PROXY] transcript sweep off: MERIDIAN_CREDENTIALS_READONLY is set, so idle profiles are left to the instance that owns their logins")
        return
      }
      // A period shorter than the initial delay starts the first pass sooner.
      initialTimer = setTimeout(() => {
        initialTimer = undefined
        scheduledPass()
      }, Math.min(initialDelayMs, intervalMs))
      initialTimer.unref?.()
      interval = setInterval(scheduledPass, intervalMs)
      interval.unref?.()
    },
    async stop() {
      stopping = true
      if (initialTimer) clearTimeout(initialTimer)
      if (interval) clearInterval(interval)
      initialTimer = undefined
      interval = undefined
      currentChild?.abort()
      if (pass) await pass.catch(() => [])
    },
    runPass,
    get disabled() { return disabled },
  }
}
