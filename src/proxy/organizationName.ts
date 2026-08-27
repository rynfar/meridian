/**
 * The organization an account belongs to, as Anthropic names it.
 *
 * `GET /api/oauth/profile` answers `organization.name` — the human label for
 * the account behind a profile. A fleet whose profiles are called `work2` and
 * `corp3` is told apart by that label and by nothing else on the card.
 *
 * WHERE IT IS KEPT. `.credentials.json` already holds `subscriptionType` and
 * `rateLimitTier`, so it looks like the natural home — but those are Claude
 * Code's OWN keys. Meridian writes that file to be indistinguishable from one
 * `claude login` wrote, and a Meridian-invented key breaks that deliberately;
 * worse, Claude Code rewrites the file on its next refresh and would drop the
 * key, so it would not even survive. This is Meridian's own file, beside
 * settings.json, and neither objection applies to it.
 *
 * WHY IT IS CACHED. The render path must not make an authenticated round trip
 * per profile: two pages poll `/profiles/list` every 10s and a fleet is a dozen
 * accounts, which is a dozen requests to Anthropic every ten seconds for a
 * string that changes approximately never. So reads are synchronous and
 * cache-only, and a stale entry is refreshed in the background — the response
 * never waits on the network.
 *
 * Leaf module — no imports from server.ts or session/.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { claudeLog } from "../logger"
import { createPlatformCredentialStore, type CredentialStore } from "./tokenRefresh"

const OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"

/** How old an entry may get before a background refresh is worth making. */
export const ORGANIZATION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

/** Floor between two lookups for one profile, successful or not, so an
 *  unreachable Anthropic cannot be retried once per 10s poll forever. */
export const ORGANIZATION_RETRY_AFTER_MS = 5 * 60 * 1000

/** Longest plausible organization name — a defence against a garbage body. */
const MAX_ORGANIZATION_NAME_LENGTH = 200

/** Same resolution as settings.ts, per call rather than at import, so tests
 *  can redirect it (see `src/__tests__/preload.ts`). */
function organizationsFile(): string {
  const override = process.env.MERIDIAN_CONFIG_DIR
  return override
    ? join(override, "organizations.json")
    : join(homedir(), ".config", "meridian", "organizations.json")
}

export interface OrganizationRecord {
  name: string
  fetchedAt: number
}

// --- Pure ------------------------------------------------------------------

/**
 * Read a record map out of whatever the file actually holds. Hand-editable and
 * written by other versions, so an entry that is not a usable name is dropped
 * rather than served.
 */
export function readOrganizations(raw: unknown): Record<string, OrganizationRecord> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, OrganizationRecord> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!id || typeof value !== "object" || value === null) continue
    const record = value as { name?: unknown; fetchedAt?: unknown }
    if (typeof record.name !== "string") continue
    const name = record.name.trim()
    if (!name || name.length > MAX_ORGANIZATION_NAME_LENGTH) continue
    const fetchedAt = typeof record.fetchedAt === "number" && isFinite(record.fetchedAt) ? record.fetchedAt : 0
    out[id] = { name, fetchedAt }
  }
  return out
}

/**
 * Pull the name out of an `/api/oauth/profile` body.
 *
 * Nullable in principle even though every account measured has one, so an
 * absent name yields null and the caller renders nothing rather than "unknown".
 */
export function extractOrganizationName(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null
  const organization = (body as { organization?: unknown }).organization
  if (typeof organization !== "object" || organization === null) return null
  const name = (organization as { name?: unknown }).name
  if (typeof name !== "string") return null
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > MAX_ORGANIZATION_NAME_LENGTH) return null
  return trimmed
}

export function organizationNeedsRefresh(
  record: OrganizationRecord | undefined,
  now: number,
  refreshAfterMs: number = ORGANIZATION_REFRESH_AFTER_MS,
): boolean {
  if (!record) return true
  return now - record.fetchedAt >= refreshAfterMs
}

// --- Persistence -----------------------------------------------------------

/** Every organization on record, keyed by profile id. */
export function organizationNames(): Record<string, OrganizationRecord> {
  const file = organizationsFile()
  try {
    if (!existsSync(file)) return {}
    return readOrganizations(JSON.parse(readFileSync(file, "utf-8")))
  } catch {
    return {}
  }
}

export function rememberOrganizationName(profileId: string, name: string): void {
  const file = organizationsFile()
  const merged = { ...organizationNames(), [profileId]: { name, fetchedAt: Date.now() } }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 })
  } catch (err) {
    console.warn(`[meridian] Failed to write ${file}: ${err instanceof Error ? err.message : err}`)
  }
}

// --- Lookup ----------------------------------------------------------------

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Best-effort lookup for one account. Never throws and never fails its caller:
 * a profile whose organization is unknown is strictly better than a page that
 * will not render.
 */
export async function fetchOrganizationName(
  store: CredentialStore,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<string | null> {
  try {
    const credentials = await store.read()
    const token = credentials?.claudeAiOauth?.accessToken
    if (!token) return null
    const response = await fetchImpl(OAUTH_PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      claudeLog("organization.bad_response", { status: response.status })
      return null
    }
    return extractOrganizationName(await response.json())
  } catch (err) {
    claudeLog("organization.lookup_failed", { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * Off by default, armed by the CLI at startup — the same guard
 * `enableDiskProfileDiscovery` uses, and for a sharper reason: a background
 * lookup for a profile with no config directory of its own would read the
 * developer's real `~/.claude` credentials and call Anthropic from the test
 * suite.
 */
let lookupEnabled = false

export function enableOrganizationLookup(): void {
  lookupEnabled = true
}

const lastAttemptAt = new Map<string, number>()
const inflight = new Set<string>()

export interface RefreshOrganizationOpts {
  claudeConfigDir?: string
  store?: CredentialStore
  fetchImpl?: FetchLike
  retryAfterMs?: number
}

/** Learn one profile's organization in the background. Returns immediately. */
export function refreshOrganizationNameSoon(profileId: string, opts: RefreshOrganizationOpts = {}): void {
  if (!lookupEnabled && !opts.store) return
  if (inflight.has(profileId)) return
  const now = Date.now()
  const last = lastAttemptAt.get(profileId)
  if (last !== undefined && now - last < (opts.retryAfterMs ?? ORGANIZATION_RETRY_AFTER_MS)) return
  lastAttemptAt.set(profileId, now)
  inflight.add(profileId)
  void (async () => {
    try {
      const store = opts.store ?? createPlatformCredentialStore({ claudeConfigDir: opts.claudeConfigDir })
      const name = await fetchOrganizationName(store, opts.fetchImpl)
      if (name) {
        rememberOrganizationName(profileId, name)
        // Length rather than the value: this log is what gets pasted into an
        // issue, and authDiscovery.ts redacts the same field for that reason.
        claudeLog("organization.discovered", { profile: profileId, nameLength: name.length })
      }
    } finally {
      inflight.delete(profileId)
    }
  })()
}

/** Reset module state — for testing only. */
export function resetOrganizationLookupForTesting(): void {
  lookupEnabled = false
  lastAttemptAt.clear()
  inflight.clear()
}
