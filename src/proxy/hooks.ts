/**
 * Event hooks: Meridian telling other programs about a moment they can act on,
 * as it happens.
 *
 * The first such moment is an OAuth sign-in waiting for its redirect. The
 * provider sends the person's browser to a loopback address
 * (http://127.0.0.1:1455/auth/callback for ChatGPT), and loopback means the
 * machine the BROWSER runs on. When that is not the machine Meridian runs on,
 * nothing there is listening and the sign-in can only be finished by pasting
 * the address back. A hook that hears `oauth.callback.listening` can open that
 * port on the browser's machine and forward what arrives to this instance's
 * public `/callback/<id>/...` route (oauthCallbacks.ts), which finishes the
 * sign-in exactly as the local listener would.
 *
 * TWO KINDS OF TARGET, BOTH CONFIGURED BY THE OPERATOR:
 *
 *   webhook   POST <url> with the event as a JSON body.
 *   command   run through the system shell with the event as JSON on stdin.
 *             The event never goes on the command line: argv is readable by
 *             every process on the machine, a pipe is not.
 *
 * Targets come from settings.json (`hooks`, edited on /settings) plus
 * MERIDIAN_HOOK_URL and MERIDIAN_HOOK_COMMAND, which add one target each and
 * are shown read-only. They are re-read for every event, so an edit applies to
 * the next one without a restart.
 *
 * DELIVERY IS BOUNDED AND NEVER RETRIED. A webhook gets 5 seconds and a
 * command 10, then it is abandoned (a command's whole process group is
 * killed). A failure is logged and recorded, not repeated: every event here is
 * about a moment that passes, so a retry that lands late is worse than none,
 * and a target that is down must not turn one event into a queue. At most 16
 * deliveries run at once; past that an event is dropped for that target and
 * the drop is recorded.
 *
 * NO EVENT CARRIES A SECRET: no code, state, verifier, token or API key. Logs
 * name a webhook by its host and a command by its program name, never the full
 * URL (webhook URLs often carry a token in the path) or the command line
 * (which may set credentials in its environment). A command's first line of
 * output IS logged and shown on /settings, so a hook must not print secrets.
 *
 * Leaf module: node builtins and the settings type only.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { MeridianHookSettings } from "../settings"

export const HOOK_EVENTS = ["oauth.callback.listening", "oauth.callback.closed", "hooks.test"] as const
export type HookEventName = (typeof HOOK_EVENTS)[number]

/** How many targets of each kind settings.json may hold, and how long a value may be. */
export const HOOK_LIMITS = { webhooks: 10, commands: 10, urlLength: 2048, commandLength: 4096 } as const

const WEBHOOK_TIMEOUT_MS = 5_000
const COMMAND_TIMEOUT_MS = 10_000
/** A command that ignores SIGTERM this long after its timeout is killed outright. */
const KILL_GRACE_MS = 2_000
const MAX_IN_FLIGHT = 16
const RECENT_LIMIT = 25
const DETAIL_LIMIT = 240
const OUTPUT_LIMIT = 16 * 1024
const RESPONSE_LIMIT = 4 * 1024

export interface HookTarget {
  kind: "webhook" | "command"
  /** The URL, or the command line. */
  value: string
  /** Events this target receives; every event when absent or empty. */
  events?: HookEventName[]
  source: "settings" | "env"
}

export interface HookDelivery {
  at: number
  event: HookEventName
  target: string
  source: HookTarget["source"]
  /** null while the delivery is still running. */
  ok: boolean | null
  /** One sanitized line: the command's first line of output, the webhook's status, or why it failed. */
  detail: string
  ms: number | null
}

export interface HookInstance {
  host: string
  pid: number
  port: number | null
  version: string | null
}

export interface HookDispatcher {
  /**
   * Deliver one event to every target that takes it. Resolves with each
   * delivery's outcome once all have finished, or after `waitMs` with the
   * unfinished ones still `ok: null` - they keep running either way.
   */
  emit(event: HookEventName, payload: Record<string, unknown>, options?: { waitMs?: number }): Promise<HookDelivery[]>
  /** The latest deliveries, newest first. */
  recent(): HookDelivery[]
}

export interface HookDispatcherOptions {
  targets: () => HookTarget[]
  instance: () => HookInstance
  log?: (line: string) => void
  now?: () => number
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  spawnImpl?: typeof spawn
  webhookTimeoutMs?: number
  commandTimeoutMs?: number
  maxInFlight?: number
}

function isHookEventName(value: unknown): value is HookEventName {
  return typeof value === "string" && (HOOK_EVENTS as readonly string[]).includes(value)
}

/** Terminal escapes and control characters out, whitespace collapsed, length capped. */
function sanitize(text: string): string {
  const plain = text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return plain.length > DETAIL_LIMIT ? `${plain.slice(0, DETAIL_LIMIT - 1)}…` : plain
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map(sanitize).filter(line => line.length > 0)
}

const firstLine = (text: string) => lines(text)[0] ?? ""
const lastLine = (text: string) => lines(text).at(-1) ?? ""

const COMMAND_WRAPPERS = new Set(["exec", "env", "nohup", "command", "nice", "time"])

/**
 * The program a command line runs, for logs: `HOME=/x exec /a/b/relay --flag`
 * is `relay`. Assignments, wrappers and their flags are skipped and no
 * argument is ever shown, because a command line is where people put secrets.
 */
export function hookProgramName(command: string): string {
  for (const raw of command.trim().split(/\s+/)) {
    const token = raw.replace(/^['"]+|['"]+$/g, "")
    if (!token || token.startsWith("-") || COMMAND_WRAPPERS.has(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
    return token.split(/[\\/]/).pop() || "(command)"
  }
  return "(command)"
}

/** How a target is named in logs and on /settings: a webhook by host, a command by program. */
export function hookTargetLabel(target: Pick<HookTarget, "kind" | "value">): string {
  if (target.kind === "webhook") {
    try {
      return `webhook ${new URL(target.value).host}`
    } catch {
      return "webhook (invalid URL)"
    }
  }
  return `command ${hookProgramName(target.value)}`
}

function validWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

function parseEvents(value: unknown, where: string): { ok: true; events?: HookEventName[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true }
  if (!Array.isArray(value)) return { ok: false, error: `${where}.events must be an array of event names` }
  const unknown = value.filter(name => !isHookEventName(name))
  if (unknown.length > 0) return { ok: false, error: `${where}.events has unknown events: ${unknown.map(String).join(", ")}. Known: ${HOOK_EVENTS.join(", ")}` }
  const events = [...new Set(value as HookEventName[])]
  return { ok: true, ...(events.length > 0 ? { events } : {}) }
}

/**
 * Validate what /settings submits. Everything or nothing: one bad target
 * rejects the whole save, so a form never half-applies.
 */
export function parseHookSettings(body: unknown): { ok: true; value: MeridianHookSettings } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "hooks must be an object" }
  const input = body as Record<string, unknown>
  const value: MeridianHookSettings = {}

  if (input.webhooks !== undefined) {
    if (!Array.isArray(input.webhooks)) return { ok: false, error: "webhooks must be an array" }
    if (input.webhooks.length > HOOK_LIMITS.webhooks) return { ok: false, error: `at most ${HOOK_LIMITS.webhooks} webhooks` }
    const webhooks: NonNullable<MeridianHookSettings["webhooks"]> = []
    for (const [index, entry] of input.webhooks.entries()) {
      const where = `webhooks[${index}]`
      const url = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).url : undefined
      if (typeof url !== "string" || !url.trim()) return { ok: false, error: `${where}.url is required` }
      if (url.length > HOOK_LIMITS.urlLength || !validWebhookUrl(url.trim())) return { ok: false, error: `${where}.url must be an http(s) URL` }
      const events = parseEvents((entry as Record<string, unknown>).events, where)
      if (!events.ok) return events
      webhooks.push({ url: url.trim(), ...(events.events ? { events: events.events } : {}) })
    }
    value.webhooks = webhooks
  }

  if (input.commands !== undefined) {
    if (!Array.isArray(input.commands)) return { ok: false, error: "commands must be an array" }
    if (input.commands.length > HOOK_LIMITS.commands) return { ok: false, error: `at most ${HOOK_LIMITS.commands} commands` }
    const commands: NonNullable<MeridianHookSettings["commands"]> = []
    for (const [index, entry] of input.commands.entries()) {
      const where = `commands[${index}]`
      const command = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).command : undefined
      if (typeof command !== "string" || !command.trim()) return { ok: false, error: `${where}.command is required` }
      if (command.length > HOOK_LIMITS.commandLength || command.includes("\u0000")) return { ok: false, error: `${where}.command is too long or contains a NUL byte` }
      const events = parseEvents((entry as Record<string, unknown>).events, where)
      if (!events.ok) return events
      commands.push({ command: command.trim(), ...(events.events ? { events: events.events } : {}) })
    }
    value.commands = commands
  }

  return { ok: true, value }
}

/**
 * Every target, settings first. A malformed entry in a hand-edited
 * settings.json is skipped rather than allowed to stop the others.
 */
export function resolveHookTargets(saved: MeridianHookSettings | undefined, environment: { url?: string; command?: string }): HookTarget[] {
  const targets: HookTarget[] = []
  const eventsOf = (value: unknown): HookEventName[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const events = value.filter(isHookEventName)
    return events.length > 0 ? events : undefined
  }
  for (const entry of Array.isArray(saved?.webhooks) ? saved.webhooks : []) {
    if (typeof entry?.url === "string" && validWebhookUrl(entry.url)) targets.push({ kind: "webhook", value: entry.url, events: eventsOf(entry.events), source: "settings" })
  }
  for (const entry of Array.isArray(saved?.commands) ? saved.commands : []) {
    if (typeof entry?.command === "string" && entry.command.trim()) targets.push({ kind: "command", value: entry.command, events: eventsOf(entry.events), source: "settings" })
  }
  const url = environment.url?.trim()
  if (url && validWebhookUrl(url)) targets.push({ kind: "webhook", value: url, source: "env" })
  const command = environment.command?.trim()
  if (command) targets.push({ kind: "command", value: command, source: "env" })
  return targets
}

/** At most `limit` bytes of a response body; the rest is cancelled unread. */
async function readSome(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  let finished = false
  while (size < limit) {
    const { done, value } = await reader.read()
    if (done) {
      finished = true
      break
    }
    chunks.push(value)
    size += value.byteLength
  }
  if (!finished) void reader.cancel().catch(() => {})
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8")
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === "string" && code) return code
  return error instanceof Error ? error.name : "error"
}

export function createHookDispatcher(options: HookDispatcherOptions): HookDispatcher {
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => console.error(line))
  const fetchImpl = options.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init))
  const spawnImpl = options.spawnImpl ?? spawn
  const webhookTimeoutMs = options.webhookTimeoutMs ?? WEBHOOK_TIMEOUT_MS
  const commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS
  const maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT
  const recent: HookDelivery[] = []
  let inFlight = 0

  const remember = (delivery: HookDelivery) => {
    recent.unshift(delivery)
    recent.length = Math.min(recent.length, RECENT_LIMIT)
  }

  const deliverWebhook = async (url: string, event: HookEventName, id: string, body: string): Promise<{ ok: boolean; detail: string }> => {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "meridian-hooks/1",
          "x-meridian-event": event,
          "x-meridian-delivery": id,
        },
        body,
        // A redirect would re-send the event somewhere the operator did not name.
        redirect: "manual",
        signal: AbortSignal.timeout(webhookTimeoutMs),
      })
    } catch (error) {
      const code = errorCode(error)
      return { ok: false, detail: code === "TimeoutError" || code === "AbortError" ? `no answer in ${webhookTimeoutMs / 1000}s` : `unreachable (${code})` }
    }
    const answer = firstLine(await readSome(response, RESPONSE_LIMIT).catch(() => ""))
    if (response.status >= 200 && response.status < 300) return { ok: true, detail: answer || `HTTP ${response.status}` }
    const redirected = response.status >= 300 && response.status < 400 ? " (redirects are not followed)" : ""
    return { ok: false, detail: `HTTP ${response.status}${redirected}${answer ? `: ${answer}` : ""}` }
  }

  const stop = (child: ChildProcess, signal: NodeJS.Signals) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
    try {
      // The shell's whole group, so a program it started does not outlive it.
      if (process.platform !== "win32") process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch (error) {
      if (errorCode(error) !== "ESRCH") child.kill(signal)
    }
  }

  const deliverCommand = (command: string, event: HookEventName, id: string, body: string): Promise<{ ok: boolean; detail: string }> =>
    new Promise(resolve => {
      let child: ChildProcess
      try {
        child = spawnImpl(command, {
          shell: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, MERIDIAN_HOOK_EVENT: event, MERIDIAN_HOOK_DELIVERY: id },
          detached: process.platform !== "win32",
          windowsHide: true,
        })
      } catch (error) {
        resolve({ ok: false, detail: `could not start (${errorCode(error)})` })
        return
      }
      let stdout = ""
      let stderr = ""
      let timedOut = false
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: { ok: boolean; detail: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        timedOut = true
        stop(child, "SIGTERM")
        killTimer = setTimeout(() => stop(child, "SIGKILL"), KILL_GRACE_MS)
        killTimer.unref?.()
      }, commandTimeoutMs)
      timer.unref?.()
      child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8") })
      child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString("utf8") })
      // A command that never reads its stdin closes the pipe on exit; the
      // EPIPE that follows says nothing about whether the hook worked.
      child.stdin?.on("error", (error: Error) => { stderr ||= `stdin: ${errorCode(error)}` })
      child.stdin?.end(body)
      child.once("error", (error: Error) => finish({ ok: false, detail: `could not start (${errorCode(error)})` }))
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (timedOut) {
          finish({ ok: false, detail: `no answer in ${commandTimeoutMs / 1000}s, stopped` })
          return
        }
        if (code === 0) {
          finish({ ok: true, detail: firstLine(stdout) || "exit 0" })
          return
        }
        const said = lastLine(stderr) || firstLine(stdout)
        finish({ ok: false, detail: `exit ${code ?? signal ?? "?"}${said ? `: ${said}` : ""}` })
      })
    })

  const deliver = (target: HookTarget, event: HookEventName, id: string, body: string): { record: HookDelivery; done: Promise<void> } => {
    const label = hookTargetLabel(target)
    const record: HookDelivery = { at: now(), event, target: label, source: target.source, ok: null, detail: "running", ms: null }
    remember(record)
    if (inFlight >= maxInFlight) {
      record.ok = false
      record.detail = `dropped: ${maxInFlight} deliveries already running`
      record.ms = 0
      log(`[hooks] ${event} -> ${label}: ${record.detail}`)
      return { record, done: Promise.resolve() }
    }
    inFlight++
    const started = now()
    const attempt = target.kind === "webhook" ? deliverWebhook(target.value, event, id, body) : deliverCommand(target.value, event, id, body)
    const settle = (result: { ok: boolean; detail: string }) => {
      record.ok = result.ok
      record.detail = sanitize(result.detail)
      record.ms = now() - started
      log(`[hooks] ${event} -> ${label}: ${result.ok ? "ok" : "failed"} in ${record.ms}ms${record.detail ? `: ${record.detail}` : ""}`)
    }
    const done = attempt
      .then(settle, (error: unknown) => settle({ ok: false, detail: `failed (${errorCode(error)})` }))
      .finally(() => { inFlight-- })
    return { record, done }
  }

  return {
    emit(event, payload, emitOptions) {
      let targets: HookTarget[]
      let instance: HookInstance
      try {
        targets = options.targets().filter(target => !target.events?.length || target.events.includes(event))
        instance = options.instance()
      } catch (error) {
        log(`[hooks] ${event}: could not read hook targets (${errorCode(error)})`)
        return Promise.resolve([])
      }
      if (targets.length === 0) return Promise.resolve([])
      const id = randomUUID()
      const body = JSON.stringify({ version: 1, event, id, at: new Date(now()).toISOString(), instance, ...payload })
      const deliveries = targets.map(target => deliver(target, event, id, body))
      const snapshot = () => deliveries.map(({ record }) => ({ ...record }))
      const all = Promise.all(deliveries.map(({ done }) => done)).then(snapshot)
      const waitMs = emitOptions?.waitMs
      if (waitMs === undefined) return all
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<HookDelivery[]>(resolve => {
        timer = setTimeout(() => resolve(snapshot()), Math.max(0, waitMs))
        timer.unref?.()
      })
      return Promise.race([all, deadline]).finally(() => clearTimeout(timer))
    },

    recent() {
      return recent.map(delivery => ({ ...delivery }))
    },
  }
}
