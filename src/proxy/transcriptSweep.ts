/**
 * Idle transcript sweep: Claude Code's own retention cleanup, for config roots
 * that no request has given the chance to run it.
 *
 * Claude Code deletes transcripts older than `cleanupPeriodDays` from inside a
 * running CLI process, a few seconds after it starts, at most once a day per
 * config root (`.last-cleanup` records the last run). Meridian only starts CLI
 * processes for requests, so a root that serves no requests, or only requests
 * that end before the cleanup gets going, is never cleaned. Every few hours
 * this module starts one CLI process per such root through the same options
 * builder a request uses, sends it nothing, and stops it once `.last-cleanup`
 * advances.
 *
 * Starting a CLI process is not free of side effects. Measured against Claude
 * Code 2.1.284, an idle process whose stored login is expired or about to
 * expire tries to refresh it at platform.claude.com; with a valid login it
 * fetches the account profile, remote settings and policy limits from
 * api.anthropic.com. A refresh rotates the token server-side and rewrites the
 * credential file, and this module must never cause either. So:
 *
 *   - every outbound connection of the child goes to a loopback proxy that
 *     refuses it (HTTPS_PROXY and friends, NO_PROXY cleared). Under strace,
 *     every connect() of the process tree landed there, and the credential
 *     file stayed byte-identical even with an expired token;
 *   - a root whose login would be refreshed within the child's lifetime is
 *     skipped until Meridian's own refresher has rolled it;
 *   - an instance under MERIDIAN_CREDENTIALS_READONLY never starts one;
 *   - the stored login is fingerprinted before and after each child, and any
 *     change stops the idle sweep for the life of the process.
 *
 * One root at a time, never while a request runs in that root, and only when
 * an SDK slot is free with nobody queued for one; it never queues itself.
 */

import { createHash } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { buildQueryOptions, resolveQueryConfigDir } from "./query"
import type { ResolvedProfile } from "./profiles"
import type { CredentialsFile } from "./tokenRefresh"
import { resolveTranscriptRetention } from "./transcriptRetention"

/** How often idle roots are looked at; MERIDIAN_TRANSCRIPT_SWEEP_INTERVAL_MS, 0 turns it off. */
export const DEFAULT_TRANSCRIPT_SWEEP_INTERVAL_MS = 3 * 60 * 60_000
/** The first look after startup, late enough not to add to a restart under load. */
export const TRANSCRIPT_SWEEP_INITIAL_DELAY_MS = 2 * 60_000
/**
 * The stored access token must stay valid at least this long. Claude Code
 * refreshes within five minutes of expiry and a child lives at most ten.
 */
export const MIN_TOKEN_VALIDITY_MS = 30 * 60_000
/** Claude Code's own throttle: one cleanup per root per day. */
const CLAUDE_CODE_SWEEP_EVERY_MS = 24 * 60 * 60_000
const CHILD_TIMEOUT_MS = 10 * 60_000
const POLL_MS = 1_000
const SETTLE_MS = 15_000

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
  const roots = new Map<string, { explicitConfigDir: boolean; profileIds: string[] }>()
  for (const profile of profiles) {
    const env: Record<string, string | undefined> = { ...processEnv, ...profile.env }
    const configDir = resolveQueryConfigDir(env, false)
    const known = roots.get(configDir)
    if (known) known.profileIds.push(profile.id)
    else roots.set(configDir, { explicitConfigDir: Boolean(env.CLAUDE_CONFIG_DIR), profileIds: [profile.id] })
  }
  return [...roots].map(([configDir, root]) => ({ configDir, ...root }))
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

function cleanupAdvanced(configDir: string, before: number | undefined): boolean {
  const after = lastCleanupAt(configDir)
  return after !== undefined && (before === undefined || after > before)
}

/**
 * Identity of the stored login, never logged, only compared: the tokens and
 * their expiry, which a refresh rotates. Not the file's metadata: a root can
 * also be someone's interactive ~/.claude, and Claude Code rewriting the same
 * login there is not something the idle process did.
 */
function loginFingerprint(credentials: CredentialsFile | null | undefined): string {
  if (credentials === undefined) return "unreadable"
  const oauth = credentials?.claudeAiOauth
  return createHash("sha256")
    .update(JSON.stringify([oauth?.accessToken, oauth?.refreshToken, oauth?.expiresAt]))
    .digest("hex")
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

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, delay(ms).then(() => undefined)])
}

interface RefusingProxy {
  readonly env: Readonly<Record<string, string>>
  readonly refused: number
  close(): Promise<void>
}

/** A loopback HTTP proxy that refuses every request without reading it. */
async function openRefusingProxy(): Promise<RefusingProxy> {
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

export interface IdleChildOutcome {
  /** Outbound connections the child attempted; every one was refused. */
  readonly refusedConnections: number
  readonly error?: string
}

/**
 * One Claude Code process in `root`, isolated like a request's (no settings
 * file, the resolved `cleanupPeriodDays`), with no prompt, no session
 * persistence and no network. Runs until `signal` aborts.
 */
export async function runIdleSweepChild(input: {
  readonly root: SweepRoot
  readonly retentionDays: number
  readonly claudeExecutable: string
  readonly signal: AbortSignal
  readonly processEnv?: NodeJS.ProcessEnv
}): Promise<IdleChildOutcome> {
  const proxy = await openRefusingProxy()
  const abortController = new AbortController()
  const forwardAbort = (): void => abortController.abort()
  input.signal.addEventListener("abort", forwardAbort, { once: true })
  if (input.signal.aborted) forwardAbort()
  let sdkQuery: ReturnType<typeof query> | undefined
  let error: string | undefined
  try {
    const { prompt, options } = buildQueryOptions({
      prompt: untilAborted(abortController.signal),
      model: "sonnet",
      workingDirectory: input.root.configDir,
      systemContext: "",
      claudeExecutable: input.claudeExecutable,
      passthrough: true,
      stream: false,
      sdkAgents: {},
      cleanEnv: childEnv(input.root, input.processEnv ?? process.env),
      envOverrides: proxy.env,
      hasDeferredTools: false,
      isUndo: false,
      blockedTools: [],
      incompatibleTools: [],
      mcpServerName: "meridian-transcript-sweep",
      allowedMcpTools: [],
      settingSources: [],
      transcriptRetentionDays: input.retentionDays,
    }, abortController)
    sdkQuery = query({ prompt, options: { ...options, persistSession: false } })
    for await (const _message of sdkQuery) {
      // Nothing is asked, so nothing worth reading arrives.
    }
  } catch (caught) {
    if (!abortController.signal.aborted) error = errorText(caught)
  } finally {
    input.signal.removeEventListener("abort", forwardAbort)
    if (typeof sdkQuery?.close === "function") sdkQuery.close()
    await proxy.close()
  }
  return { refusedConnections: proxy.refused, ...(error === undefined ? {} : { error }) }
}

export type SweepSkipReason =
  /** Retention resolves to no period for this root. */
  | "off"
  | "missing"
  /** Claude Code cleaned this root within the last day. */
  | "fresh"
  | "draining"
  /** A request's Claude Code process is running in this root. */
  | "busy"
  | "login-unreadable"
  | "refresh-due"
  | "no-slot"

export type SweepOutcome =
  | { readonly kind: "skipped"; readonly reason: SweepSkipReason }
  | { readonly kind: "swept" | "timed-out" | "stopped"; readonly durationMs: number; readonly refusedConnections: number }
  | { readonly kind: "failed"; readonly durationMs: number; readonly error: string }
  | { readonly kind: "login-changed"; readonly durationMs: number }

export interface SweepRootResult {
  readonly configDir: string
  readonly profileIds: readonly string[]
  readonly outcome: SweepOutcome
}

export interface TranscriptSweepOptions {
  listRoots(): readonly SweepRoot[]
  isRootBusy(configDir: string): boolean
  isDraining(): boolean
  credentialsReadOnly(): boolean
  /** A free SDK slot, or undefined; must never queue. */
  tryAcquireSlot(): { release(): void } | undefined
  /** The stored login Claude Code will find in this root; null when unreadable. */
  readCredentials(root: SweepRoot): Promise<CredentialsFile | null>
  runChild(root: SweepRoot, retentionDays: number, signal: AbortSignal): Promise<IdleChildOutcome>
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
  stop(): Promise<void>
  /** One pass over every root, one at a time; joins a pass already running. */
  runPass(): Promise<readonly SweepRootResult[]>
  /** True once a stored login changed while a child ran; nothing runs again. */
  readonly disabled: boolean
}

const skipped = (reason: SweepSkipReason): SweepOutcome => ({ kind: "skipped", reason })

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

  async function runChildUntilCleaned(
    root: SweepRoot,
    retentionDays: number,
    before: number | undefined,
    startedAt: number,
  ): Promise<SweepOutcome> {
    const controller = new AbortController()
    currentChild = controller
    let finished = false
    const child = options.runChild(root, retentionDays, controller.signal)
      .catch((error: unknown): IdleChildOutcome => ({ refusedConnections: 0, error: errorText(error) }))
      .finally(() => { finished = true })
    let advanced = false
    let timedOut = false
    try {
      while (!finished && !stopping) {
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
      currentChild = undefined
    }
    const result = await settleWithin(child, SETTLE_MS)
    advanced ||= cleanupAdvanced(root.configDir, before)
    const durationMs = now() - startedAt
    const refusedConnections = result?.refusedConnections ?? 0
    if (advanced) return { kind: "swept", durationMs, refusedConnections }
    if (timedOut) return { kind: "timed-out", durationMs, refusedConnections }
    if (stopping) return { kind: "stopped", durationMs, refusedConnections }
    const error = result === undefined
      ? `Claude Code did not stop within ${SETTLE_MS / 1000}s`
      : result.error ?? "Claude Code exited before its cleanup ran"
    return { kind: "failed", durationMs, error }
  }

  async function sweepRoot(root: SweepRoot): Promise<SweepOutcome> {
    const { days } = resolveTranscriptRetention(root.configDir)
    if (days === 0) return skipped("off")
    if (!existsSync(root.configDir)) return skipped("missing")
    const before = lastCleanupAt(root.configDir)
    if (before !== undefined && now() - before < CLAUDE_CODE_SWEEP_EVERY_MS) return skipped("fresh")
    if (options.isDraining()) return skipped("draining")
    if (options.isRootBusy(root.configDir)) return skipped("busy")
    const credentials = await readOrUndefined(root)
    const login = classifyStoredLogin(credentials, now(), minTokenValidityMs)
    if (login === "unreadable") return skipped("login-unreadable")
    if (login === "refresh-due") return skipped("refresh-due")
    const slot = options.tryAcquireSlot()
    if (!slot) return skipped("no-slot")
    const startedAt = now()
    try {
      const fingerprintBefore = loginFingerprint(credentials)
      const outcome = await runChildUntilCleaned(root, days, before, startedAt)
      if (loginFingerprint(await readOrUndefined(root)) !== fingerprintBefore) {
        disabled = true
        return { kind: "login-changed", durationMs: now() - startedAt }
      }
      return outcome
    } finally {
      slot.release()
    }
  }

  function report(root: SweepRoot, outcome: SweepOutcome): void {
    const who = root.profileIds.join(",")
    const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`
    switch (outcome.kind) {
      case "swept":
        options.log(`[PROXY] transcript sweep: ${who} cleaned in ${seconds(outcome.durationMs)} (${outcome.refusedConnections} outbound connections refused)`)
        break
      case "timed-out":
        options.log(`[PROXY] transcript sweep: ${who} stopped after ${seconds(outcome.durationMs)} without a cleanup; the next pass retries`)
        break
      case "failed":
        options.log(`[PROXY] transcript sweep: ${who} failed after ${seconds(outcome.durationMs)}: ${outcome.error}`)
        break
      case "login-changed":
        options.log(
          `[PROXY] transcript sweep STOPPED: the stored login for ${who} changed while an idle Claude Code process ran there. ` +
          `No idle sweep runs again until restart; requests still clean up as before. Please report this.`,
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
      initialTimer = setTimeout(() => {
        initialTimer = undefined
        scheduledPass()
      }, initialDelayMs)
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
      if (pass) await settleWithin(pass.catch(() => []), SETTLE_MS + 5_000)
    },
    runPass,
    get disabled() { return disabled },
  }
}
