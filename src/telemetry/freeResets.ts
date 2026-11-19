/**
 * A Claude account's banked free resets, as /profiles and / show them.
 *
 * Meridian is the only reader: oauthUsage.ts parses the provider's grants per
 * profile, `/v1/usage/quota/all` serves them as each entry's `bankedResets`,
 * and `POST /v1/usage/quota/reset` redeems one. Both pages turn that reading
 * into the same view here, so a card on / and its card on /profiles never
 * disagree about how many resets of each kind an account has or whether one
 * can be redeemed.
 *
 * Both functions are serialized with `.toString()` into the pages' inline
 * scripts (the buildBadge.ts pattern), so each must stay self-contained: no
 * references to anything outside its own body. They take `unknown` because
 * the browser hands them raw JSON; a grant that cannot be read is skipped.
 */

export type FreeResetKind = "full" | "fable" | "unknown"

/** The resets of one kind: what a redeem would clear is the same for all of them. */
export interface FreeResetGroup {
  readonly kind: FreeResetKind
  /** "Full reset", "Fable reset" or "Unrecognised reset". */
  readonly name: string
  /** The row label on / and the noun in /profiles' confirmation. */
  readonly shortName: string
  /** For an unrecognised reset, what the provider calls it (unescaped); else null. */
  readonly providerLabel: string | null
  /** Resets on unexpired grants of this kind, the ones the provider holds back included. */
  readonly available: number
  /** Resets of this kind the provider would redeem right now. */
  readonly usable: number
  /** When this kind's soonest-expiring grant expires, if the provider says. */
  readonly expiresAt: number | null
  /** The grant a redeem of this kind spends, or null when Meridian offers none. */
  readonly grantId: string | null
  /** That grant as the confirmation names it: the provider's label and the id. */
  readonly grantName: string | null
  /** Fable usage a Fable reset would give back, from a current reading. */
  readonly fableUsed: string | null
  /** The provider's scope for the grant a redeem spends lists `five_hour` (with no such grant: every grant of this kind does). */
  readonly clearsFiveHour: boolean
  /** Why Meridian offers no redeem although the provider would allow one. */
  readonly reason: string | null
  /** Drawn in --muted: nothing of this kind can be redeemed from here. */
  readonly muted: boolean
  readonly value: string
  readonly note: string
  readonly title: string
}

export interface FreeResetView {
  readonly available: number
  readonly usable: number
  /** Full first, then Fable, then each unrecognised kind as the provider listed it. */
  readonly groups: readonly FreeResetGroup[]
}

/** `quota` is the profile's `/v1/usage/quota/all` entry: its `stale` flag and `seven_day_fable` window. */
export function freeResetView(raw: unknown, nowMs: number, quota?: unknown): FreeResetView | null {
  if (typeof raw !== "object" || raw === null) return null
  const banked = raw as { eligible?: unknown; nextGrantId?: unknown; grants?: unknown }
  if (banked.eligible !== true || !Array.isArray(banked.grants)) return null

  interface Live {
    id: string | null; left: number; expiresAt: number | null; usable: boolean; description: string | null; fablePct: number | null
    fiveHour: boolean
  }
  interface Bucket { kind: FreeResetKind; key: string; label: string | null; grants: Live[] }
  const text = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null)
  const pct = (v: unknown): number | null => (typeof v === "number" && isFinite(v) && v >= 0 && v <= 100 ? v : null)

  const buckets: Bucket[] = []
  const seen = new Set<string>()
  for (const item of banked.grants as unknown[]) {
    if (typeof item !== "object" || item === null) continue
    const g = item as {
      id?: unknown; resetsLeft?: unknown; expiresAt?: unknown; startsAt?: unknown; paused?: unknown; usableNow?: unknown
      kind?: unknown; providerType?: unknown; description?: unknown; percentUsed?: unknown; clears?: unknown
    }
    if (typeof g.resetsLeft !== "number" || !Number.isSafeInteger(g.resetsLeft) || g.resetsLeft <= 0) continue
    const expiresAt = typeof g.expiresAt === "number" && isFinite(g.expiresAt) ? g.expiresAt : null
    if (expiresAt !== null && expiresAt <= nowMs) continue
    const id = typeof g.id === "string" && g.id.length > 0 ? g.id : null
    if (id !== null) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    const startsAt = typeof g.startsAt === "number" && isFinite(g.startsAt) ? g.startsAt : null
    // A reading from before Meridian read grant scope has no kind; only the
    // launch grants' ids say what they clear. Never the provider's raw type.
    const kind: FreeResetKind = g.kind === "full" || g.kind === "fable" || g.kind === "unknown" ? g.kind
      : g.kind !== undefined ? "unknown"
      : id === "full-reset-2611" ? "full"
      : id !== null && /^launch-2610-fable(-6mo|-12mo)?$/.test(id) ? "fable" : "unknown"
    const providerType = text(g.providerType)
    const description = text(g.description)
    const used = typeof g.percentUsed === "object" && g.percentUsed !== null
      ? (g.percentUsed as { seven_day_overage_included?: unknown }).seven_day_overage_included : undefined
    // An unrecognised grant is named by what the provider calls it, else by its
    // raw id, so grants with nothing else to tell them apart stay apart.
    const named = providerType !== null || description !== null
    const key = kind !== "unknown" ? kind : JSON.stringify(named ? [providerType, description] : [null, null, id])
    let bucket = buckets.find(b => b.key === key)
    if (!bucket) {
      const label = description !== null ? "\u201c" + description + "\u201d" + (providerType !== null ? " (type " + providerType + ")" : "")
        : providerType !== null ? "type " + providerType : id !== null ? "id " + id : null
      bucket = { kind, key, label: kind === "unknown" ? label : null, grants: [] }
      buckets.push(bucket)
    }
    bucket.grants.push({
      id, left: g.resetsLeft, expiresAt, description, fablePct: pct(used),
      fiveHour: Array.isArray(g.clears) && g.clears.includes("five_hour"),
      usable: g.usableNow === true && g.paused !== true && (startsAt === null || startsAt <= nowMs),
    })
  }
  if (buckets.length === 0) return null

  const order = { full: 0, fable: 1, unknown: 2 }
  buckets.sort((a, b) => order[a.kind] - order[b.kind])

  function within(ms: number): string {
    const minutes = Math.max(1, Math.floor(ms / 60000))
    if (minutes < 60) return minutes + "m"
    const hours = Math.floor(minutes / 60)
    return hours < 24 ? hours + "h" : Math.floor(hours / 24) + "d"
  }

  // The 7d Fable window is the fallback evidence of Fable usage, and only a
  // current reading confirms any: a stale one is what a later check failed to replace.
  const reading = (typeof quota === "object" && quota !== null ? quota : {}) as { stale?: unknown; windows?: unknown }
  const stale = reading.stale === true
  let fableWindow: number | null = null
  if (Array.isArray(reading.windows)) {
    for (const w of reading.windows as unknown[]) {
      const window = (typeof w === "object" && w !== null ? w : {}) as { type?: unknown; utilization?: unknown }
      if (window.type === "seven_day_fable" && typeof window.utilization === "number" && isFinite(window.utilization)) {
        fableWindow = Math.max(0, Math.min(1, window.utilization)) * 100
      }
    }
  }

  const groups: FreeResetGroup[] = buckets.map(bucket => {
    let available = 0
    let usable = 0
    let expiresAt: number | null = null
    let soonest: Live | null = null
    let next: Live | null = null
    for (const g of bucket.grants) {
      available += g.left
      if (g.expiresAt !== null && (expiresAt === null || g.expiresAt < expiresAt)) expiresAt = g.expiresAt
      if (!g.usable) continue
      usable += g.left
      if (g.id !== null && g.id === banked.nextGrantId) next = g
      if (g.id !== null && (soonest === null
        || (g.expiresAt !== null && (soonest.expiresAt === null || g.expiresAt < soonest.expiresAt)))) soonest = g
    }
    const pick = next ?? soonest
    const kind = bucket.kind

    let fablePct: number | null = null
    if (kind === "fable") {
      const stated = bucket.grants.find(g => g.fablePct !== null)
      fablePct = pick?.fablePct ?? stated?.fablePct ?? fableWindow
    }
    const fableUsed = kind !== "fable" || stale || fablePct === null ? null
      : fablePct > 0 && fablePct < 1 ? "<1%" : Math.round(fablePct) + "%"

    let reason: string | null = null
    if (kind === "unknown") reason = "not recognised, none offered"
    // A known zero is worth saying even while Anthropic holds the grant back.
    else if (kind === "fable" && !stale && fablePct === 0) reason = "no Fable usage to give back right now"
    else if (kind === "fable" && usable > 0) {
      reason = stale ? "Fable usage not confirmed: the last reading is stale"
        : fablePct === null ? "Fable usage unknown" : null
    }
    const grantId = pick !== null && reason === null ? pick.id : null

    const noun = kind === "full" ? "full reset" : kind === "fable" ? "Fable reset" : "unrecognised reset"
    const plural = (n: number) => n + " " + noun + (n === 1 ? "" : "s")
    const status = usable === 0 ? "none usable now" : usable === available ? "all usable now" : usable + " usable now"
    const expiry = expiresAt === null ? "" : (available === 1 ? "expires in " : "next expires in ") + within(expiresAt - nowMs)
    const held = available - usable
    const clearsFiveHour = pick !== null ? pick.fiveHour : bucket.grants.every(g => g.fiveHour)
    const fiveHour = clearsFiveHour ? " It also clears the 5-hour window." : ""
    const effect = kind === "full" ? " Redeeming one clears this account's weekly usage." + fiveHour
      : kind === "fable" ? " Redeeming one gives back only Fable usage to the weekly allowance; the rest of the week's usage stays as it is." + fiveHour
      : " Anthropic lists " + (available === 1 ? "it" : "them") + (bucket.label !== null ? " as " + bucket.label : "")
        + ", but Meridian does not know what one clears, so it offers no redeem."
    const parts = [bucket.label, reason ?? status, reason === null && fableUsed !== null ? "Fable " + fableUsed + " used" : null, expiry]

    return {
      kind,
      name: kind === "full" ? "Full reset" : kind === "fable" ? "Fable reset" : "Unrecognised reset",
      shortName: kind === "unknown" ? "other reset" : noun,
      providerLabel: bucket.label,
      available,
      usable,
      expiresAt,
      grantId,
      grantName: grantId === null || pick === null ? null : pick.description !== null ? pick.description + " (" + grantId + ")" : grantId,
      fableUsed,
      clearsFiveHour: kind !== "unknown" && clearsFiveHour,
      reason,
      muted: usable === 0 || reason !== null,
      value: String(available),
      note: parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" \u00b7 "),
      title: plural(available) + " banked; " + usable + " can be redeemed now"
        + (held > 0 ? ", " + held + " held back by Anthropic (paused, not started yet, or blocked until a limit is hit)" : "")
        + (expiresAt === null ? "." : ". The soonest expires " + new Date(expiresAt).toLocaleString() + ".")
        + effect
        + (kind === "fable" && reason !== null ? " Not offered: " + reason + "." : ""),
    }
  })

  let available = 0
  let usable = 0
  for (const g of groups) {
    available += g.available
    usable += g.usable
  }
  return { available, usable, groups }
}

/** What /profiles says after `POST /v1/usage/quota/reset` answers `status` with `body`; `label` names a window. */
export function freeResetOutcomeText(status: number, body: unknown, label?: (window: string) => string): { ok: boolean; text: string } {
  const answer = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>
  if (status >= 200 && status < 300 && answer.result === "reset") {
    const cleared = Array.isArray(answer.cleared) ? answer.cleared.filter((c): c is string => typeof c === "string") : []
    const left = answer.resetsLeft
    return {
      ok: true,
      text: "Reset redeemed" + (cleared.length > 0 ? ": cleared " + cleared.map(c => (label ? label(c) : c)).join(", ") : "") + "."
        + (typeof left === "number" ? " " + left + " left on that grant." : ""),
    }
  }
  if (status >= 200 && status < 300) {
    const why: Record<string, string> = {
      not_limited: "Anthropic says this account is not rate limited, so there is nothing to reset yet",
      already_used: "this grant has already been used",
      cooldown: "Anthropic asks to wait before redeeming another reset on this account",
      ineligible: "Anthropic says this account cannot redeem resets",
      unavailable: "Anthropic has no reset to redeem on this account right now",
    }
    const result = typeof answer.result === "string" ? answer.result : ""
    return { ok: false, text: "Not redeemed: " + (why[result] ?? "Anthropic answered " + (result || "nothing")) + "." }
  }
  if (status === 0) return { ok: false, text: "Not redeemed: Meridian did not answer." }
  const error = typeof answer.error === "string" && answer.error.length > 0 ? answer.error : "Meridian answered " + status
  return {
    ok: false,
    text: "Not redeemed: " + error + "." + (answer.indeterminate === true ? " It may have gone through - check the figures before trying again." : ""),
  }
}
