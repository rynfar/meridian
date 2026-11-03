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

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs"
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

/**
 * What one `/api/oauth/profile` read says about the account behind a profile.
 *
 * The UUIDs are what tells two profiles signed in to ONE account apart from
 * two accounts that merely share an email (see duplicateProfiles.ts). Absent
 * (undefined) means this record predates them and is worth one more read; null
 * means Anthropic was asked and did not say.
 *
 * `credentialMark` is the access token's expiry at the time of the read, so a
 * record can tell it was read for an earlier credential: every login and every
 * renewal writes a new one, and a login into a different account must not keep
 * the previous account's identity for a day.
 */
export interface OrganizationRecord {
  name: string | null
  fetchedAt: number
  accountUuid?: string | null
  organizationUuid?: string | null
  email?: string | null
  credentialMark?: number | null
}

export interface OrganizationLookup {
  name: string | null
  accountUuid: string | null
  organizationUuid: string | null
  email: string | null
}

// --- Pure ------------------------------------------------------------------

const MAX_IDENTIFIER_LENGTH = 200

function identifier(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= MAX_IDENTIFIER_LENGTH ? trimmed : undefined
}

/**
 * Read a record map out of whatever the file actually holds. Hand-editable and
 * written by other versions, so an entry that is neither a usable name nor a
 * known account is dropped rather than served.
 */
export function readOrganizations(raw: unknown): Record<string, OrganizationRecord> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, OrganizationRecord> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!id || typeof value !== "object" || value === null) continue
    const record = value as Record<string, unknown>
    const rawName = typeof record.name === "string" ? record.name.trim() : ""
    const name = rawName && rawName.length <= MAX_ORGANIZATION_NAME_LENGTH ? rawName : null
    const accountUuid = identifier(record.accountUuid)
    const organizationUuid = identifier(record.organizationUuid)
    if (!name && !accountUuid) continue
    const fetchedAt = typeof record.fetchedAt === "number" && isFinite(record.fetchedAt) ? record.fetchedAt : 0
    const email = identifier(record.email)
    const credentialMark = typeof record.credentialMark === "number" && isFinite(record.credentialMark)
      ? record.credentialMark
      : record.credentialMark === null ? null : undefined
    out[id] = {
      name,
      fetchedAt,
      ...(accountUuid !== undefined ? { accountUuid } : {}),
      ...(organizationUuid !== undefined ? { organizationUuid } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(credentialMark !== undefined ? { credentialMark } : {}),
    }
  }
  return out
}

/**
 * Pull the account's identity out of an `/api/oauth/profile` body: the same
 * three fields Claude Code copies into `.claude.json` as `oauthAccount`
 * (`accountUuid`, `organizationUuid`, `emailAddress`). Read here rather than
 * from that file because only Claude Code writes it, so it still names the
 * previous account after Meridian signs a profile in to another.
 */
export function extractAccountIdentity(body: unknown): Omit<OrganizationLookup, "name"> {
  const object = (value: unknown) => (typeof value === "object" && value !== null ? value as Record<string, unknown> : {})
  const account = object(object(body).account)
  const organization = object(object(body).organization)
  return {
    accountUuid: identifier(account.uuid) ?? null,
    organizationUuid: identifier(organization.uuid) ?? null,
    email: identifier(account.email) ?? identifier(account.email_address) ?? null,
  }
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

/**
 * Whether a record is worth another read: it is missing, aged, older than the
 * account identity fields, or read for an earlier credential. Pass
 * `credentialMark` (the stored access token's expiry) to have a login or a
 * renewal re-read the account; omit it to judge by age alone.
 */
export function organizationNeedsRefresh(
  record: OrganizationRecord | undefined,
  now: number,
  refreshAfterMs: number = ORGANIZATION_REFRESH_AFTER_MS,
  credentialMark?: number | null,
): boolean {
  if (!record) return true
  if (record.accountUuid === undefined) return true
  if (credentialMark != null && record.credentialMark !== credentialMark) return true
  return now - record.fetchedAt >= refreshAfterMs
}

/**
 * Whether a record describes the credential a profile holds NOW: it was read
 * for the very access token stored now. A record read for an earlier
 * credential may name the account the profile was signed in to before, and
 * one whose current token is unknown cannot be shown to be current, so
 * neither is trusted for the shown email or for duplicate detection.
 */
export function organizationRecordCurrent(record: OrganizationRecord | undefined, credentialMark: number | null | undefined): boolean {
  if (!record || record.accountUuid === undefined) return false
  return credentialMark != null && record.credentialMark === credentialMark
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

export function rememberOrganization(profileId: string, lookup: OrganizationLookup, credentialMark: number | null = null): void {
  const file = organizationsFile()
  const record: OrganizationRecord = { ...lookup, fetchedAt: Date.now(), credentialMark }
  const merged = { ...organizationNames(), [profileId]: record }
  // Written beside the file and renamed over it, so a reader (another
  // instance, or a poll in this one) never sees half a file.
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temporary, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    renameSync(temporary, file)
  } catch (err) {
    console.warn(`[meridian] Failed to write ${file}: ${err instanceof Error ? err.message : err}`)
    try {
      rmSync(temporary, { force: true })
    } catch (cleanupErr) {
      console.warn(`[meridian] Failed to remove ${temporary}: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`)
    }
  }
}

// --- Lookup ----------------------------------------------------------------

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface FetchedOrganization {
  lookup: OrganizationLookup
  /** The access token's expiry, epoch ms, of the credential the read used. */
  credentialMark: number | null
}

/**
 * Best-effort lookup for one account. Never throws and never fails its caller:
 * a profile whose organization is unknown is strictly better than a page that
 * will not render.
 */
export async function fetchOrganization(
  store: CredentialStore,
  fetchImpl: FetchLike = globalThis.fetch,
  onCredential?: (credentialMark: number | null) => void,
): Promise<FetchedOrganization | null> {
  try {
    const credentials = await store.read()
    const token = credentials?.claudeAiOauth?.accessToken
    if (!token) return null
    const expiresAt = credentials?.claudeAiOauth?.expiresAt
    const credentialMark = typeof expiresAt === "number" && isFinite(expiresAt) ? expiresAt : null
    onCredential?.(credentialMark)
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
    const body = await response.json()
    return {
      lookup: { name: extractOrganizationName(body), ...extractAccountIdentity(body) },
      credentialMark,
    }
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

export function organizationLookupEnabled(): boolean {
  return lookupEnabled
}

const lastAttemptAt = new Map<string, number>()
const lastAttemptMark = new Map<string, number | null>()
const inflight = new Set<string>()

export interface RefreshOrganizationOpts {
  claudeConfigDir?: string
  store?: CredentialStore
  fetchImpl?: FetchLike
  retryAfterMs?: number
  /**
   * The access token expiry the caller sees now. A different one than the last
   * attempt was made for is a new login or a renewal, and is read at once
   * instead of waiting out the retry floor.
   */
  credentialMark?: number | null
}

async function lookUpAndRemember(profileId: string, opts: RefreshOrganizationOpts): Promise<OrganizationRecord | null> {
  const store = opts.store ?? createPlatformCredentialStore({ claudeConfigDir: opts.claudeConfigDir })
  // The credential actually read is the one this attempt was for, whoever
  // started it, so a poll that sees the same token does not read it again.
  const found = await fetchOrganization(store, opts.fetchImpl, mark => { lastAttemptMark.set(profileId, mark) })
  if (!found || (!found.lookup.name && !found.lookup.accountUuid)) return null
  rememberOrganization(profileId, found.lookup, found.credentialMark)
  // Lengths and presence rather than values: this log is what gets pasted into
  // an issue, and authDiscovery.ts redacts the same fields for that reason.
  claudeLog("organization.discovered", {
    profile: profileId,
    nameLength: found.lookup.name?.length ?? 0,
    accountKnown: !!found.lookup.accountUuid,
    organizationKnown: !!found.lookup.organizationUuid,
  })
  return organizationNames()[profileId] ?? null
}

/** Learn one profile's organization in the background. Returns immediately. */
export function refreshOrganizationNameSoon(profileId: string, opts: RefreshOrganizationOpts = {}): void {
  if (!lookupEnabled && !opts.store) return
  if (inflight.has(profileId)) return
  const now = Date.now()
  const last = lastAttemptAt.get(profileId)
  const newCredential = opts.credentialMark != null && lastAttemptMark.get(profileId) !== opts.credentialMark
  if (!newCredential && last !== undefined && now - last < (opts.retryAfterMs ?? ORGANIZATION_RETRY_AFTER_MS)) return
  lastAttemptAt.set(profileId, now)
  if (opts.credentialMark !== undefined) lastAttemptMark.set(profileId, opts.credentialMark)
  inflight.add(profileId)
  void (async () => {
    try {
      await lookUpAndRemember(profileId, opts)
    } finally {
      inflight.delete(profileId)
    }
  })()
}

/**
 * Read one profile's account now and wait for the answer — for a login that
 * just finished, whose page is waiting to show who it signed in as. Ignores the
 * retry floor: a new credential is exactly what the floor must not hold back.
 * Null when the lookup is disarmed or Anthropic did not answer.
 */
export async function refreshOrganizationNow(profileId: string, opts: RefreshOrganizationOpts = {}): Promise<OrganizationRecord | null> {
  if (!lookupEnabled && !opts.store) return null
  lastAttemptAt.set(profileId, Date.now())
  inflight.add(profileId)
  try {
    return await lookUpAndRemember(profileId, opts)
  } finally {
    inflight.delete(profileId)
  }
}

/** Reset module state — for testing only. */
export function resetOrganizationLookupForTesting(): void {
  lookupEnabled = false
  lastAttemptAt.clear()
  lastAttemptMark.clear()
  inflight.clear()
}
