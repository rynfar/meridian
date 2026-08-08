/**
 * Ask what is listening on a port, before concluding anything about it.
 *
 * A busy port is not a usage error, and it is almost never a stranger: the
 * thing holding Meridian's port is usually Meridian. So the CLI asks it,
 * and only reports a conflict when the answer is no.
 *
 * ## What is probed, and why that endpoint
 *
 * `GET /health`. It is the only identifying route that is free of every
 * complication:
 *
 *  - **It is public.** `createProxyServer` gates `/v1/*`, `/telemetry*`,
 *    `/profiles*`, `/plugins*`, `/settings*`, `/metrics` and `/auth/*`
 *    behind `requireAuth`, leaving `/` and `/health` open by design. So
 *    identification never depends on holding the instance's API key.
 *  - **It is cheap and side-effect free.** It reads cached auth status;
 *    it spends no model quota, which matters when the accounts behind the
 *    running instance are not all ours to spend.
 *  - **It echoes nothing secret.** It returns a status, a version, a mode
 *    and the logged-in account — never tokens, never `profiles.json`.
 *
 * The status code is deliberately not the signal: `/health` answers 503
 * when the account is logged out, and a 401 would still be Meridian's own
 * error envelope. Identification is by *shape* — a JSON body carrying a
 * recognised `status` and a `version` — so a running-but-unhappy instance
 * is still recognised as itself, which is precisely when someone runs the
 * command to find out what is going on.
 *
 * `/` is not used: it is HTML that fetches its data client-side, so it
 * proves nothing a `<title>` match would not, and matches less reliably.
 */

import { createServer } from "node:net"
import type {
  DashboardSnapshot,
  HealthPayload,
  ProfileListPayload,
  QuotaPayload,
  SummaryPayload,
} from "../telemetry/cliDashboard"

/** A wedged port must not hang the CLI: every request is bounded by this. */
export const PROBE_TIMEOUT_MS = 2000

export type ProbeResult =
  | { kind: "meridian"; snapshot: DashboardSnapshot }
  /** Something answered, and it was not Meridian. */
  | { kind: "foreign"; description: string }
  /** Nothing answered, or the probe timed out. Treated as not-Meridian. */
  | { kind: "unreachable"; description: string }

export interface ProbeOptions {
  timeoutMs?: number
  /**
   * Sent as `x-api-key` on the gated reads. This invocation was about to
   * start a server with `MERIDIAN_API_KEY`, and the instance already
   * running is normally configured from the same environment — so the
   * usual case authenticates without asking anyone for anything.
   */
  apiKey?: string
  /** Injectable for tests; production callers omit it. */
  fetchImpl?: typeof fetch
}

/**
 * Wildcard binds are not connectable addresses everywhere (`0.0.0.0` works
 * on Linux and not on Windows), so probe the loopback the wildcard covers.
 * IPv6 literals are bracketed for the URL.
 */
export function probeUrlBase(host: string, port: number): string {
  let target = host
  if (host === "0.0.0.0" || host === "") target = "127.0.0.1"
  else if (host === "::" || host === "[::]") target = "::1"
  const literal = target.includes(":") ? `[${target.replace(/^\[|\]$/g, "")}]` : target
  return `http://${literal}:${port}`
}

const HEALTH_STATUSES = new Set(["healthy", "degraded", "unhealthy"])

/**
 * Is this body Meridian's `/health`, or Meridian's auth rejection?
 *
 * Both are accepted: a 401 carrying `authentication_error` can only have
 * come from `requireAuth`, so it identifies the server even though it
 * withholds the data.
 */
export function isMeridianHealthBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false
  const record = body as Record<string, unknown>
  if (typeof record["status"] === "string" && HEALTH_STATUSES.has(record["status"]) && typeof record["version"] === "string") {
    return true
  }
  const error = record["error"]
  if (record["type"] === "error" && typeof error === "object" && error !== null) {
    return (error as Record<string, unknown>)["type"] === "authentication_error"
  }
  return false
}

/** Describe a foreign listener from its response — headers only, never its body. */
export function describeForeignResponse(status: number, statusText: string, headers: Headers): string {
  const parts = [`HTTP ${status}${statusText ? ` ${statusText}` : ""}`]
  const server = headers.get("server")
  if (server) parts.push(`server: ${server}`)
  const contentType = headers.get("content-type")
  if (contentType) parts.push(contentType.split(";")[0]!.trim())
  return parts.join(", ")
}

/**
 * Whether a server could bind `host:port` right now.
 *
 * The same question `serve()` asks, asked first — so the answer arrives
 * before the pre-flight auth check and the plugin loader have printed
 * anything, and the dashboard can be the whole output. Losing the race
 * between this and the real bind is harmless: `startProxyServer`'s own
 * EADDRINUSE handler is still in place behind it.
 */
export function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once("error", () => resolve(false))
    probe.once("listening", () => probe.close(() => resolve(true)))
    probe.listen(port, host)
  })
}

async function readJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  apiKey?: string,
): Promise<
  | { ok: true; status: number; statusText: string; body: unknown; headers: Headers }
  | { ok: false; reason: string }
> {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: apiKey ? { "x-api-key": apiKey } : undefined,
    })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return { ok: true, status: response.status, statusText: response.statusText, body, headers: response.headers }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Fetch a gated section, returning the reason when it cannot be read. */
async function readSection<T>(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  apiKey: string | undefined,
): Promise<{ data: T | null; reason?: string }> {
  const result = await readJson(fetchImpl, url, timeoutMs, apiKey)
  if (!result.ok) return { data: null, reason: result.reason }
  if (result.status === 401) {
    return {
      data: null,
      reason: apiKey
        ? "the running instance rejected this MERIDIAN_API_KEY"
        : "the running instance requires an API key — set MERIDIAN_API_KEY",
    }
  }
  if (result.status >= 400) return { data: null, reason: `HTTP ${result.status}` }
  if (result.body == null) return { data: null, reason: "unreadable response" }
  return { data: result.body as T }
}

/**
 * Ask the thing on `host:port` whether it is Meridian, and if so collect
 * everything the landing page shows.
 *
 * The four reads are the four the page itself makes. Each is independent:
 * a gated section that cannot be read becomes a note on the rendered page
 * rather than a failure or, worse, a section of zeroes.
 */
export async function probeMeridian(host: string, port: number, options: ProbeOptions = {}): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const apiKey = options.apiKey || undefined
  const fetchImpl = options.fetchImpl ?? fetch
  const base = probeUrlBase(host, port)

  const health = await readJson(fetchImpl, `${base}/health`, timeoutMs, apiKey)
  if (!health.ok) return { kind: "unreachable", description: health.reason }
  if (!isMeridianHealthBody(health.body)) {
    return {
      kind: "foreign",
      description: describeForeignResponse(health.status, health.statusText, health.headers),
    }
  }

  const authRejected = health.status === 401
  const [profileList, quota, summary] = await Promise.all([
    readSection<ProfileListPayload>(fetchImpl, `${base}/profiles/list`, timeoutMs, apiKey),
    readSection<QuotaPayload>(fetchImpl, `${base}/v1/usage/quota/all`, timeoutMs, apiKey),
    readSection<SummaryPayload>(fetchImpl, `${base}/telemetry/summary?window=86400000`, timeoutMs, apiKey),
  ])

  const unavailable: DashboardSnapshot["unavailable"] = {}
  const accountsReason = profileList.reason ?? quota.reason
  if (accountsReason) unavailable.accounts = `accounts unavailable — ${accountsReason}`
  if (summary.reason) unavailable.traffic = `traffic unavailable — ${summary.reason}`

  return {
    kind: "meridian",
    snapshot: {
      health: authRejected ? null : (health.body as HealthPayload),
      profileList: profileList.data,
      quota: quota.data,
      summary: summary.data,
      ...(Object.keys(unavailable).length > 0 ? { unavailable } : {}),
    },
  }
}

export type ProbeFailure = Exclude<ProbeResult, { kind: "meridian" }>

/** The message for `meridian status` when there is nothing of ours to show. */
export function formatStatusMessage(result: ProbeFailure, host: string, port: number): string {
  if (result.kind === "foreign") {
    return [
      `Error: http://${host}:${port} is not Meridian (${result.description}).`,
      `  Something else owns that port. Point at the right one: MERIDIAN_PORT=<port> meridian status`,
    ].join("\n")
  }
  return [
    `Error: no Meridian instance is listening on http://${host}:${port}.`,
    `  Start one with: meridian`,
  ].join("\n")
}

/**
 * The message for a busy port that is not Meridian. A conflict, so it goes
 * to stderr and exits non-zero — but it says what it found, which is the
 * part that was missing.
 */
export function formatConflictMessage(result: ProbeFailure, host: string, port: number): string {
  const found =
    result.kind === "foreign"
      ? `Something is listening there, and it is not Meridian (${result.description}).`
      : `Something is holding the port but did not answer (${result.description}).`
  return [
    `Error: ${host}:${port} is already in use.`,
    found,
    "",
    `  Identify it with: lsof -i :${port}`,
    `  Or use a different port: MERIDIAN_PORT=4567 meridian`,
  ].join("\n")
}
