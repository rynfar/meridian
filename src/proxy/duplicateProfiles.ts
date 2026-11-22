/**
 * Profiles that are signed in to the same account.
 *
 * A re-login into the wrong browser session leaves two profiles holding one
 * account: two names, two credential stores, ONE quota. Nothing breaks - both
 * serve - so nothing tells the operator, and every count of the fleet's
 * capacity is quietly wrong by one account. This names such profiles so a page
 * can say which one to sign in again or remove. It never removes, renames or
 * excludes anything itself.
 *
 * WHAT COUNTS AS ONE ACCOUNT. Email alone does not: one person legitimately
 * holds a personal plan and seats in several Team organizations, each its own
 * subscription and its own quota. So identity is per provider:
 *
 *   claude   the Anthropic account UUID AND the organization UUID, from
 *            `/api/oauth/profile`. The same person in two organizations is two
 *            subscriptions. When either profile's UUIDs are not known yet, the
 *            email AND the organization name stand in for them - weaker, and
 *            reported as such through `basis`.
 *   chatgpt  the seat id (`accountUserId`, which is `user-<user>__<workspace>`)
 *            is one seat. A different seat with the same email in the same
 *            workspace is the same subscription seen under a new user id (see
 *            chatgpt/migrate/duplicates.ts, which applies the same rule to an
 *            import).
 *
 * Profiles of different providers are never duplicates of each other.
 *
 * Leaf module - pure, no I/O.
 */

/** Which evidence made two profiles one account. */
export type DuplicateBasis =
  | "account-organization"
  | "email-organization"
  | "seat"
  | "workspace-email"

export interface ClaudeIdentity {
  provider: "claude"
  accountUuid?: string | null
  organizationUuid?: string | null
  email?: string | null
  organizationName?: string | null
}

export interface ChatGptIdentity {
  provider: "chatgpt"
  /** `accountUserId`. */
  seat: string
  email?: string | null
}

export type AccountIdentity = ClaudeIdentity | ChatGptIdentity

export interface IdentifiedProfile {
  id: string
  identity: AccountIdentity | null
}

export interface DuplicateView {
  /** The other profiles holding this account, in input order. */
  duplicateOf: string[]
  /** The weakest evidence any of those matches rests on. */
  duplicateBasis: DuplicateBasis | null
}

function norm(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase()
  return trimmed ? trimmed : null
}

function exact(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** The workspace half of a ChatGPT seat id, or null when it has none. */
export function chatGptWorkspaceOf(seat: string): string | null {
  const at = seat.lastIndexOf("__")
  return at >= 0 && at + 2 < seat.length ? seat.slice(at + 2) : null
}

/**
 * Whether two identities are one account, and on what evidence. Null means
 * they are not, OR that there is not enough evidence to say they are - an
 * unknown is never a duplicate.
 */
export function sameAccount(a: AccountIdentity, b: AccountIdentity): DuplicateBasis | null {
  if (a.provider === "claude" && b.provider === "claude") {
    const aAccount = exact(a.accountUuid), aOrg = exact(a.organizationUuid)
    const bAccount = exact(b.accountUuid), bOrg = exact(b.organizationUuid)
    // Both UUID pairs known: they alone decide, whatever the names say.
    if (aAccount && aOrg && bAccount && bOrg) {
      return aAccount === bAccount && aOrg === bOrg ? "account-organization" : null
    }
    const aEmail = norm(a.email), bEmail = norm(b.email)
    const aName = exact(a.organizationName), bName = exact(b.organizationName)
    return aEmail && aName && aEmail === bEmail && aName === bName ? "email-organization" : null
  }
  if (a.provider === "chatgpt" && b.provider === "chatgpt") {
    if (a.seat === b.seat) return "seat"
    const workspace = chatGptWorkspaceOf(a.seat)
    const aEmail = norm(a.email)
    return workspace && aEmail && workspace === chatGptWorkspaceOf(b.seat) && aEmail === norm(b.email)
      ? "workspace-email"
      : null
  }
  return null
}

const BASIS_STRENGTH: Record<DuplicateBasis, number> = {
  "account-organization": 2,
  seat: 2,
  "email-organization": 1,
  "workspace-email": 1,
}

/**
 * Every profile's duplicates. Pairwise on purpose: a fleet is a few dozen
 * profiles, and grouping by a key cannot express "UUIDs decide when both are
 * known, names otherwise".
 */
export function findDuplicateProfiles(profiles: readonly IdentifiedProfile[]): Map<string, DuplicateView> {
  const out = new Map<string, DuplicateView>()
  for (const p of profiles) out.set(p.id, { duplicateOf: [], duplicateBasis: null })
  for (let i = 0; i < profiles.length; i++) {
    const a = profiles[i]!
    if (!a.identity) continue
    for (let j = i + 1; j < profiles.length; j++) {
      const b = profiles[j]!
      if (!b.identity || a.id === b.id) continue
      const basis = sameAccount(a.identity, b.identity)
      if (!basis) continue
      for (const [self, other] of [[a.id, b.id], [b.id, a.id]] as const) {
        const view = out.get(self)!
        view.duplicateOf.push(other)
        if (!view.duplicateBasis || BASIS_STRENGTH[basis] < BASIS_STRENGTH[view.duplicateBasis]) {
          view.duplicateBasis = basis
        }
      }
    }
  }
  return out
}
