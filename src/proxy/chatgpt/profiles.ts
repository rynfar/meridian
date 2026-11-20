/**
 * ChatGPT seats as Meridian profiles.
 *
 * The account switcher and the warmer that drive Claude profiles (Vibeterm,
 * through `/profiles/*` and `/v1/usage/quota/all`) must see a ChatGPT seat as
 * one more profile, in the same vocabulary, rather than learn a second API.
 * This module is that translation and nothing else: seat -> stable profile id,
 * plan -> allowance, and the seat's usage reading -> Claude-shaped windows.
 *
 * Two readings of the provider's windows exist - `/wham/usage` (cached) and
 * the `x-codex-*` headers of the seat's latest real response - and both are
 * turned into `CodexUsageWindow` here first, so every consumer applies one set
 * of rules to either.
 *
 * WHICH WINDOWS A SEAT HAS IS READ, NEVER ASSUMED. Pro and most Business
 * Premium seats report a weekly window only, but one Business Premium seat on
 * the measured host reports a five-hour window as well, so the plan says
 * nothing about window shape. A reading's windows are listed in
 * `windowsReported`; a consumer tells "this seat has no 5h window" from "no
 * reading yet" by that list being present.
 *
 * Pure: no I/O, no clock of its own, no credential field in or out.
 */
import { createHash } from "node:crypto"
import { describeCodexPlan, normalizeCodexPlanSlug } from "../codex/plan"
import type { CodexResetCredits, CodexUsageEntry, CodexUsageWindow } from "../codex/types"
import { codexWindowLabel } from "../codex/windows"
import type { ChatGptCredentialMode, ChatGptSeatView, SeatUnavailableReason } from "./source"
import type { ChatGptRateLimit, ChatGptUsageWindow } from "./windows"

export const CHATGPT_PROFILE_TYPE = "chatgpt"

/**
 * What a person runs at oc-codex-multi-auth for the things Meridian must not
 * do to a seat it follows: sign it in, renew its token, delete it. Meridian
 * only reads that store, so each card quotes these instead of offering a
 * button that would have to refuse. The menu labels are the plugin's own
 * (`AUTH_LABELS.OAUTH`, lib/ui/auth-menu.ts).
 */
export const CHATGPT_OWNER_TOOL = "oc-codex-multi-auth"
export const CHATGPT_LOGIN_COMMAND = "opencode auth login"
export const CHATGPT_LOGIN_METHOD = "OpenAI \u2192 Codex OAuth (ChatGPT Plus/Pro)"
/** Renews every enabled account from its refresh token; no browser needed. */
export const CHATGPT_REFRESH_COMMAND = "npx -y oc-codex-multi-auth doctor --fix"
export const CHATGPT_REFRESH_TOOL = "codex-refresh"

/** Claude's window names, which the switcher and warmer read. */
export const FIVE_HOUR_WINDOW = "five_hour"
export const SEVEN_DAY_WINDOW = "seven_day"

const FIVE_HOUR_SECONDS = 5 * 3600
const SEVEN_DAY_SECONDS = 7 * 86400

/**
 * How close to its full width a 0% window's countdown may be and still count
 * as not started. A cold window reports "now + width", so its countdown is the
 * whole width at the moment of the read; request latency and clock skew eat a
 * little of that. A window used for less than this reads cold for that long,
 * which costs nothing: it was started a moment ago either way.
 */
const NOT_STARTED_SLACK_MS = 60_000

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface ChatGptPlanFields {
  /** The vendor slug verbatim, e.g. `pro`, `self_serve_business_prolite`. */
  subscriptionType: string | null
  planLabel: string | null
  planName: string | null
  accountType: string | null
  /** Displayed multiplier, e.g. `"20x"`; null where the slug does not determine it. */
  allowance: string | null
  allowanceWeight: number | null
  /**
   * `free` for a seat on ChatGPT's free plan, which most Codex models refuse;
   * `paid` for any other known plan; null until the plan has been read.
   * Routing serves unpinned work from a free seat only after every paid one.
   */
  planTier: ChatGptPlanTier | null
}

export type ChatGptPlanTier = "free" | "paid"

export interface ChatGptProfile extends ChatGptPlanFields {
  id: string
  /** `accountUserId`: the credential store's key for this seat. */
  seat: string
  label: string
  email: string | null
  eligible: boolean
  unavailable: SeatUnavailableReason | null
  /** The credential owner's own next pick. */
  ownerActive: boolean
  /** Former ids from renames; each still resolves to this seat. */
  aliases: string[]
  /** 0-based position in the credential owner's store, when it has one. */
  storeIndex: number | null
  /** When Meridian renews the seat next because chatgpt.com refused its access token, epoch ms. */
  renewalRetryAt: number | null
}

/** One window in Claude's `/v1/usage/quota` vocabulary. */
export interface ProfileWindow {
  type: string
  /** Consumed fraction 0..1. */
  utilization: number | null
  /** Epoch ms of the reset; null when the window exists but has not started. */
  resetsAt: number | null
}

export interface SeatWindowsReading {
  windows: ProfileWindow[]
  /** Window types this reading declared, started or not; null = no reading. */
  windowsReported: string[] | null
  source: "usage" | "headers" | null
  fetchedAt: number | null
  stale: boolean
}

/** The latest `x-codex-*` reading of a seat, as the backend records it. */
export interface ObservedRateLimit {
  rateLimit: ChatGptRateLimit
  at: number
}

/**
 * How a seat is named to people: `email · id:xxxxxx`, matching oc-codex's own
 * `email, id:xxxxxx` surfaces. The email alone is not enough - one person holds
 * seats in several workspaces, so it repeats. A seat id is
 * `user-<user>__<workspace accountId>`, so its last six characters are the
 * workspace suffix, which is what separates one person's seats.
 */
export function chatGptSeatLabel(seatId: string, email: string | null): string {
  return `${email ?? "seat"} · id:${seatId.slice(-6)}`
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._]+/g, "-").replace(/^-+|-+$/g, "")
}

function derivedId(seat: Pick<ChatGptSeatView, "id" | "email">): string {
  const local = seat.email ? slug(seat.email.split("@")[0] ?? "") : ""
  return `${local || "seat"}-${slug(seat.id.slice(-6)) || "x"}`
}

function seatHash(seatId: string): string {
  return createHash("sha256").update(seatId).digest("hex").slice(0, 4)
}

/**
 * A stable, readable profile id per seat.
 *
 * Derived from the seat, not from store order, so it survives restarts and
 * re-orderings. The email's local part leads because an owner prefix is how a
 * fleet groups one person's accounts; the operator can rename any seat with
 * `names` (seat id -> id) where the derived one groups wrongly.
 */
export function chatGptProfileIds(
  seats: readonly Pick<ChatGptSeatView, "id" | "email">[],
  options: { reserved?: ReadonlySet<string>; names?: Readonly<Record<string, unknown>> } = {},
): Map<string, string> {
  const reserved = options.reserved ?? new Set<string>()
  const named = new Map<string, string>()
  const namedTaken = new Set<string>()
  for (const seat of seats) {
    const wanted = options.names?.[seat.id]
    if (typeof wanted !== "string" || !PROFILE_ID.test(wanted) || reserved.has(wanted) || namedTaken.has(wanted)) continue
    named.set(seat.id, wanted)
    namedTaken.add(wanted)
  }

  const derived = new Map<string, string>()
  const counts = new Map<string, number>()
  for (const seat of seats) {
    if (named.has(seat.id)) continue
    const id = derivedId(seat)
    derived.set(seat.id, id)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  const ids = new Map<string, string>()
  for (const seat of seats) {
    const name = named.get(seat.id)
    if (name) { ids.set(seat.id, name); continue }
    let id = derived.get(seat.id)!
    if ((counts.get(id) ?? 0) > 1 || namedTaken.has(id)) id = `${id}-${seatHash(seat.id)}`
    if (reserved.has(id)) id = `chatgpt-${id}`
    ids.set(seat.id, id)
  }
  return ids
}

export function chatGptPlanFields(planType: string | null | undefined): ChatGptPlanFields {
  const described = describeCodexPlan(planType)
  if (described.slug === null) {
    return { subscriptionType: null, planLabel: null, planName: null, accountType: null, allowance: null, allowanceWeight: null, planTier: null }
  }
  const weight = described.multiplier ? Number.parseFloat(described.multiplier) : Number.NaN
  const label = described.label === "—" ? null : described.label
  const normalized = described.slug.toLowerCase()
  const accountType = label === null ? null
    : /business/.test(normalized) ? "Business"
    : /team/.test(normalized) ? "Team"
    : "Personal"
  const planName = label?.replace(/^ChatGPT\s+/, "") ?? null
  return {
    subscriptionType: described.slug,
    // Worded the way a Claude profile's is - `Personal Max`, `Team Premium` -
    // so one column can name both pools' plans: `Personal Pro`, `Business
    // Premium`, `Team`. The card already says which provider a seat is on.
    planLabel: planName === null || accountType === null || planName.startsWith(accountType)
      ? planName
      : `${accountType} ${planName}`,
    planName,
    accountType,
    allowance: described.multiplier,
    allowanceWeight: Number.isFinite(weight) ? weight : null,
    planTier: normalizeCodexPlanSlug(described.slug) === "free" ? "free" : "paid",
  }
}

function storedAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((alias): alias is string => typeof alias === "string" && PROFILE_ID.test(alias)))]
}

/**
 * Every seat the credential source knows, as profiles.
 *
 * `planTypes` carries a fresher plan slug per seat where the usage service
 * read one; the credential store's copy is the fallback. `aliases` are the
 * former ids renames left behind (seat id -> ids). A former id stops being an
 * alias the moment a profile - ChatGPT or Claude - is called that, exactly as
 * a Claude profile's redirect is dropped when its old name is taken again.
 */
export function chatGptProfiles(
  seats: readonly ChatGptSeatView[],
  options: {
    reserved?: ReadonlySet<string>
    names?: Readonly<Record<string, unknown>>
    planTypes?: ReadonlyMap<string, string | null>
    aliases?: Readonly<Record<string, unknown>>
  } = {},
): ChatGptProfile[] {
  const ids = chatGptProfileIds(seats, options)
  const taken = new Set([...ids.values(), ...(options.reserved ?? [])])
  const claimed = new Set<string>()
  return seats.map(seat => {
    const aliases = storedAliases(options.aliases?.[seat.id]).filter(alias => !taken.has(alias) && !claimed.has(alias))
    for (const alias of aliases) claimed.add(alias)
    return {
      id: ids.get(seat.id)!,
      seat: seat.id,
      label: chatGptSeatLabel(seat.id, seat.email),
      email: seat.email,
      eligible: seat.eligible,
      unavailable: seat.reason ?? null,
      ownerActive: seat.active === true,
      aliases,
      storeIndex: seat.storeIndex ?? null,
      renewalRetryAt: seat.renewalRetryAt ?? null,
      ...chatGptPlanFields(options.planTypes?.get(seat.id) ?? seat.planType),
    }
  })
}

/** A profile by its id, its raw seat id, or a former id - in that order, so a current id always wins. */
export function findChatGptProfile(profiles: readonly ChatGptProfile[], idOrSeat: string | null | undefined): ChatGptProfile | undefined {
  if (!idOrSeat) return undefined
  return profiles.find(profile => profile.id === idOrSeat)
    ?? profiles.find(profile => profile.seat === idOrSeat)
    ?? profiles.find(profile => profile.aliases.includes(idOrSeat))
}

/**
 * Why a name typed for a seat about to be signed in cannot be its profile id,
 * or null when it can. Checked before the sign-in starts, so a person learns
 * of a bad name before spending a login on it. A name an existing seat already
 * carries is allowed: signing that seat in again keeps it.
 */
export function chatGptNameProblem(name: string, reserved: ReadonlySet<string>): string | null {
  if (!PROFILE_ID.test(name)) {
    return `Invalid profile name "${name}". A ChatGPT seat's name uses lowercase letters, numbers, dots, hyphens and underscores, starts with a letter or number, and is at most 64 characters.`
  }
  if (reserved.has(name)) return `Profile "${name}" already exists.`
  return null
}

export type ChatGptRenamePlan =
  | {
    ok: true
    seat: string
    from: string
    to: string
    /** The seat's former ids after the rename, chains collapsed. */
    aliases: string[]
    /** The complete `chatGptProfileNames` and `chatGptProfileAliases` settings to write. */
    names: Record<string, string>
    aliasesBySeat: Record<string, string[]>
  }
  | { ok: false; error: string }

/**
 * Plan renaming a seat's profile id, the way a Claude rename works: the new
 * id is the seat's name from now on, and the old one keeps answering as an
 * alias, so a request, an exclusion or a link that names it still reaches the
 * seat. Renaming onto another seat's former id takes that id over. Pure:
 * the caller persists both settings.
 */
export function planChatGptRename(input: {
  profiles: readonly ChatGptProfile[]
  reserved: ReadonlySet<string>
  names: Readonly<Record<string, unknown>> | undefined
  aliases: Readonly<Record<string, unknown>> | undefined
  from: string
  to: string
}): ChatGptRenamePlan {
  const { profiles, reserved, from, to } = input
  const profile = findChatGptProfile(profiles, from)
  if (!profile) return { ok: false, error: `Profile "${from}" not found.` }
  if (!PROFILE_ID.test(to)) {
    return {
      ok: false,
      error: `Invalid profile name "${to}". A ChatGPT seat's name uses lowercase letters, numbers, dots, hyphens and underscores, starts with a letter or number, and is at most 64 characters.`,
    }
  }
  if (to === profile.id) return { ok: false, error: `Profile "${to}" is already called that.` }
  if (reserved.has(to) || profiles.some(other => other.id === to)) {
    return { ok: false, error: `Profile "${to}" already exists.` }
  }

  const names: Record<string, string> = {}
  for (const [seat, name] of Object.entries(input.names ?? {})) {
    if (typeof name === "string") names[seat] = name
  }
  names[profile.seat] = to

  const aliasesBySeat: Record<string, string[]> = {}
  for (const [seat, value] of Object.entries(input.aliases ?? {})) {
    const kept = storedAliases(value).filter(alias => alias !== to)
    if (kept.length > 0) aliasesBySeat[seat] = kept
  }
  const aliases = [...new Set([...profile.aliases, profile.id])].filter(alias => alias !== to)
  if (aliases.length > 0) aliasesBySeat[profile.seat] = aliases
  else delete aliasesBySeat[profile.seat]

  return { ok: true, seat: profile.seat, from: profile.id, to, aliases, names, aliasesBySeat }
}

/**
 * A seat's banked rate-limit resets as its card states them.
 *
 * `expiresAt` holds one entry per banked reset, soonest first; null for one
 * whose expiry is not known. The whole list is null when the per-credit lookup
 * failed and only the count is known; the view itself is null when not even
 * the count is (no valid token to ask with, or both reads failed).
 */
export interface ChatGptResetsView {
  available: number
  expiresAt: Array<number | null> | null
}

const soonestFirst = (a: number | null, b: number | null): number =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b

export function chatGptResetsView(resets: CodexResetCredits | null | undefined): ChatGptResetsView | null {
  const available = resets ? resets.listedCount ?? resets.availableCount : null
  if (!resets || available === null || !Number.isInteger(available) || available < 0) return null
  if (resets.credits === null) return { available, expiresAt: null }
  // One expiry per banked reset: the list may state more credits than its
  // count or fewer, and the count is what the seat holds.
  const expiresAt = resets.credits.map(credit => credit.expiresAt).sort(soonestFirst).slice(0, available)
  while (expiresAt.length < available) expiresAt.push(null)
  return { available, expiresAt }
}

/** Who holds a seat's login, and what a person runs there for what Meridian will not do itself. */
export interface ChatGptOwner {
  name: typeof CHATGPT_OWNER_TOOL | "meridian"
  mode: ChatGptCredentialMode
  /** 1-based number in the owner's store: what `codex-list` prints and `codex-remove index=` takes. */
  account: number | null
  /** Signs a seat in, or in again; null where Meridian owns the login. */
  login: string | null
  loginMethod: string | null
  /** Renews an expired access token; null where Meridian refreshes it itself. */
  refresh: string | null
  refreshTool: string | null
  /** Deletes the seat at its owner; null where no such command exists. */
  remove: string | null
  /** Brings a seat signed in elsewhere into Meridian's own store; null in follow-external mode. */
  importCommand: string | null
  /** Whether /profiles can sign a seat in directly (POST /profiles/chatgpt/connect/start). Owned mode only. */
  webSignIn: boolean
}

export const CHATGPT_IMPORT_COMMAND = "meridian chatgpt-migrate --step import"

export function chatGptOwner(mode: ChatGptCredentialMode, storeIndex: number | null): ChatGptOwner {
  const account = storeIndex === null ? null : storeIndex + 1
  if (mode === "owned") {
    return {
      name: "meridian", mode, account, login: null, loginMethod: null, refresh: null, refreshTool: null, remove: null,
      importCommand: CHATGPT_IMPORT_COMMAND, webSignIn: true,
    }
  }
  return {
    name: CHATGPT_OWNER_TOOL,
    mode,
    account,
    login: CHATGPT_LOGIN_COMMAND,
    loginMethod: CHATGPT_LOGIN_METHOD,
    refresh: CHATGPT_REFRESH_COMMAND,
    refreshTool: CHATGPT_REFRESH_TOOL,
    remove: account === null ? null : `codex-remove index=${account} confirm=true`,
    importCommand: null,
    webSignIn: false,
  }
}

/**
 * Why Meridian answers a remove of this seat with a refusal, and what removes
 * it instead; null for a seat in Meridian's own store, which it removes
 * itself. The interactive menu leads because it names each account by its
 * email; `codex-remove` takes a store position, which moves when an account
 * is added or deleted, so it is offered with the check that comes first.
 */
export function chatGptRemovalRefusal(profile: Pick<ChatGptProfile, "id" | "label">, owner: ChatGptOwner): string | null {
  if (owner.mode === "owned") return null
  const menu = `run \`${owner.login}\`, choose ${owner.loginMethod}, pick ${profile.label} and choose "Delete this account"`
  const tool = owner.remove
    ? `, or in an opencode session check with \`codex-list\` that account ${owner.account} is ${profile.label} and run \`${owner.remove}\``
    : ""
  return `"${profile.id}" is a ChatGPT seat that ${CHATGPT_OWNER_TOOL} owns. Meridian only reads that store, so it cannot remove the seat. To remove it, ${menu}${tool}. Meridian drops the card on its next read of the store.`
}

export interface ChatGptRemovalSettings {
  chatGptProfileNames?: Record<string, string>
  chatGptProfileAliases?: Record<string, string[]>
  profileOrder?: string[]
}

/**
 * Every setting keyed on a removed seat, rewritten without it: its name and
 * former names and its place in the order. Only keys
 * that change are returned. The caller moves the active pointer and drops the
 * credits override (a ChatGPT feature). Telemetry is history and keeps the seat.
 */
export function chatGptRemovalSettings(
  profile: Pick<ChatGptProfile, "id" | "seat" | "aliases">,
  settings: Readonly<ChatGptRemovalSettings>,
): ChatGptRemovalSettings {
  const names = new Set([profile.id, profile.seat, ...profile.aliases])
  const update: ChatGptRemovalSettings = {}
  if (settings.chatGptProfileNames && profile.seat in settings.chatGptProfileNames) {
    const { [profile.seat]: _name, ...rest } = settings.chatGptProfileNames
    update.chatGptProfileNames = rest
  }
  if (settings.chatGptProfileAliases && profile.seat in settings.chatGptProfileAliases) {
    const { [profile.seat]: _aliases, ...rest } = settings.chatGptProfileAliases
    update.chatGptProfileAliases = rest
  }
  if (settings.profileOrder?.some(id => names.has(id))) {
    update.profileOrder = settings.profileOrder.filter(id => !names.has(id))
  }
  return update
}

/**
 * Whether a seat's access token can serve right now.
 *
 * The store states one reason per seat, and a quota or cooldown mark hides
 * the token's own state behind it: a seat marked quota-exhausted may hold an
 * expired token as well. The usage service reads the token's `exp` claim
 * before any request (`token_expired`), and a 401/403 from the usage endpoint
 * is chatgpt.com refusing the token, so both count here.
 */
export type ChatGptTokenState = "ok" | "expired" | "refused" | "no_token" | "requires_reauth" | "unknown"

export function chatGptTokenState(unavailable: SeatUnavailableReason | null, usageError: string | null | undefined): ChatGptTokenState {
  switch (unavailable) {
    case "no_token":
    case "requires_reauth":
    case "unknown":
    case "expired":
      return unavailable
    default:
      if (usageError === "no_token") return "no_token"
      if (usageError === "token_expired") return "expired"
      if (usageError === "unauthorized") return "refused"
      return "ok"
  }
}

/** Claude's name for a window of this width; any other width keeps its natural label. */
export function profileWindowType(limitWindowSeconds: number | null | undefined): string {
  if (limitWindowSeconds === FIVE_HOUR_SECONDS) return FIVE_HOUR_WINDOW
  if (limitWindowSeconds === SEVEN_DAY_SECONDS) return SEVEN_DAY_WINDOW
  return codexWindowLabel(limitWindowSeconds)
}

/**
 * The `x-codex-*` reading of a response, in the shape `/wham/usage` yields.
 *
 * A window the headers gave only as `reset_after_seconds` is anchored at the
 * moment the response was observed.
 */
export function observedUsageWindows(observed: ObservedRateLimit | undefined): CodexUsageWindow[] {
  if (!observed) return []
  return [observed.rateLimit.primary_window, observed.rateLimit.secondary_window]
    .filter((window): window is ChatGptUsageWindow => !!window)
    .map(window => {
      const width = typeof window.limit_window_seconds === "number" && Number.isFinite(window.limit_window_seconds)
        ? window.limit_window_seconds
        : null
      const resetsAt = typeof window.reset_at === "number" && window.reset_at > 0
        ? window.reset_at * 1000
        : typeof window.reset_after_seconds === "number" && window.reset_after_seconds > 0
          ? observed.at + window.reset_after_seconds * 1000
          : null
      return {
        type: codexWindowLabel(width),
        utilization: typeof window.used_percent === "number" && Number.isFinite(window.used_percent)
          ? Math.min(1, Math.max(0, window.used_percent / 100))
          : null,
        resetsAt,
        limitWindowSeconds: width,
      }
    })
}

/**
 * Whether a window has not been drawn from since it last reset.
 *
 * A rolling ChatGPT window starts at its first request, so an untouched one
 * reports a reset of "now plus the window" that moves forward on every read.
 * Reporting that as a reset would tell the warmer the window is running when
 * it is cold - so it is reported the way Claude reports a cold window, with no
 * reset at all. A window used even fractionally has a shorter countdown.
 */
export function isWindowNotStarted(window: CodexUsageWindow, readAt: number): boolean {
  if (window.utilization !== 0 || window.resetsAt === null) return false
  const width = window.limitWindowSeconds
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return false
  return window.resetsAt - readAt >= width * 1000 - NOT_STARTED_SLACK_MS
}

function toProfileWindows(windows: readonly CodexUsageWindow[], readAt: number): ProfileWindow[] {
  return windows.map(window => ({
    type: profileWindowType(window.limitWindowSeconds),
    utilization: window.utilization === null ? null : Math.min(1, Math.max(0, window.utilization)),
    resetsAt: isWindowNotStarted(window, readAt) ? null : window.resetsAt,
  }))
}

/**
 * A seat's windows from whichever reading is newer: the usage service's or
 * the headers of the seat's latest response. Either one is a complete
 * statement of which windows the seat has.
 */
export function seatWindows(input: { usage?: CodexUsageEntry; observed?: ObservedRateLimit }): SeatWindowsReading {
  const usageAt = input.usage && input.usage.fetchedAt !== null && input.usage.windows.length > 0 ? input.usage.fetchedAt : null
  const observedWindows = observedUsageWindows(input.observed)
  const observedAt = observedWindows.length > 0 && input.observed ? input.observed.at : null

  const useHeaders = observedAt !== null && (usageAt === null || observedAt > usageAt)
  if (useHeaders) {
    const windows = toProfileWindows(observedWindows, observedAt)
    return { windows, windowsReported: windows.map(window => window.type), source: "headers", fetchedAt: observedAt, stale: false }
  }
  if (usageAt !== null) {
    const windows = toProfileWindows(input.usage!.windows, usageAt)
    return { windows, windowsReported: windows.map(window => window.type), source: "usage", fetchedAt: usageAt, stale: input.usage!.stale }
  }
  return { windows: [], windowsReported: null, source: null, fetchedAt: null, stale: false }
}

/**
 * The quota entry's `error`, in the words the switcher already understands:
 * `no_token` means a human is needed, exactly as for a Claude profile.
 */
export function chatGptQuotaError(
  unavailable: SeatUnavailableReason | null,
  usageError: string | null | undefined,
  hasWindows: boolean,
): string | null {
  switch (unavailable) {
    case "no_token":
    case "requires_reauth":
    case "unknown":
      return "no_token"
    case "expired":
      return "token_expired"
    case "disabled":
      return "disabled"
    default:
      return hasWindows ? null : usageError ?? null
  }
}

/** Whether the seat's credential can serve right now. */
export function chatGptLoggedIn(unavailable: SeatUnavailableReason | null): boolean {
  return unavailable !== "no_token" && unavailable !== "requires_reauth" && unavailable !== "expired" && unavailable !== "unknown"
}
