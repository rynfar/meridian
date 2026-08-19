/**
 * Browser-completable creation of a new claude-max profile.
 *
 * Backs `POST /profiles/add/start` and `POST /profiles/add/complete`. Adding an
 * account no longer requires a shell on the box Meridian runs on, which is the
 * same gap `profileLogin.ts` closed for re-authenticating one.
 *
 * Deliberately a SEPARATE route from the login flow rather than a loosened
 * guard on it. `/profiles/login/start` refuses unknown ids, and that refusal is
 * what stops "re-authenticate enrique-corp" from silently creating
 * "enrique-crop" on a typo. Creating an account slot is a different act from
 * re-authenticating one that exists, so it gets its own button, its own route
 * and its own refusals.
 *
 * The slot is written only after Anthropic has returned credentials — see
 * `completeProfileAdd`. Everything that can refuse does so at `/start`, before
 * a sign-in tab opens, because a user who signs in and is only then refused has
 * burned a one-time authorization code for nothing.
 *
 * This is a leaf module — no imports from server.ts or session/.
 */

import { randomBytes } from "node:crypto"
import { envBool } from "../env"
import {
  createManualOAuthSession,
  createProfileSlot,
  exchangeAuthorizationCodeForCredentials,
  isValidProfileId,
  parseAuthorizationCodeInput,
  profileConfigDirFor,
  loadProfileIds,
} from "./profileCli"
import { LOGIN_TTL_MS } from "./profileLogin"
import { getEffectiveProfiles, type ProfileConfig } from "./profiles"

interface PendingAdd {
  profileId: string
  claudeConfigDir: string
  codeVerifier: string
  state: string
  expiresAt: number
}

/**
 * Started-but-unfinished creations, keyed by the opaque id handed to the
 * browser. Server-side for the same reason as pending logins: the PKCE
 * verifier is half of the proof and must not travel to the browser holding
 * the other half.
 *
 * At most one entry per profile id: starting a second sign-in for the same name
 * SUPERSEDES the first (see `startProfileAdd`). Nothing is on disk between
 * `/start` and `/complete`, so this map is the only thing stopping two sign-ins
 * for one new name from both completing, with the loser having spent a code to
 * be told the name is taken.
 */
const pendingAdds = new Map<string, PendingAdd>()

export type AddErrorCode =
  | "credentials_readonly"
  | "invalid_request"
  | "invalid_profile_id"
  | "profile_exists"
  | "expired_add"
  | "no_code"
  | "state_mismatch"
  | "exchange_failed"
  | "write_failed"
  | "create_failed"

export interface AddFailure {
  ok: false
  code: AddErrorCode
  status: number
  message: string
  /**
   * The pending creation is still open — paste again, no second sign-in.
   * Set exactly when the paste was rejected locally, before any code reached
   * Anthropic. Same contract as `LoginFailure.retryable`, read by the same
   * page code.
   */
  retryable?: boolean
}

export interface StartAddSuccess {
  ok: true
  profileId: string
  addId: string
  authorizeUrl: string
  expiresAt: number
}

export interface CompleteAddSuccess {
  ok: true
  profileId: string
  claudeConfigDir: string
}

export interface StartAddParams {
  profiles: ProfileConfig[] | undefined
  profileId: string
  now?: number
}

export interface CompleteAddParams {
  addId: string
  input: string
  now?: number
  fetchFn?: typeof fetch
}

function prune(now: number): void {
  for (const [id, add] of pendingAdds) {
    if (add.expiresAt <= now) pendingAdds.delete(id)
  }
}

/**
 * Refuse when this instance must not write credential files.
 *
 * Creating a profile writes both credentials and profiles.json, so a readonly
 * instance can do even less of it than a re-login. Refused at `/start` for the
 * reason the login flow refuses there: the button is present on an instance
 * that shares another's credential files, so it is there to be clicked.
 */
function readonlyRefusal(profileId: string): AddFailure | null {
  if (!envBool("CREDENTIALS_READONLY")) return null
  return {
    ok: false,
    code: "credentials_readonly",
    status: 409,
    message:
      "This Meridian instance runs with MERIDIAN_CREDENTIALS_READONLY=1 and must not write credential files, "
      + "so it cannot create a profile. Use the instance that owns these credentials, "
      + `or a terminal on the box that holds them: meridian profile add ${profileId}`,
  }
}

/**
 * Every id this instance would consider taken: the profiles it serves plus the
 * ones already written to profiles.json.
 *
 * Both, because they can differ. An instance configured from MERIDIAN_PROFILES
 * does not read profiles.json at all, so the effective list alone would let a
 * write land on top of an existing entry; and with disk discovery on, a profile
 * added seconds ago may not have reached the effective list's cache yet.
 */
function takenIds(profiles: ProfileConfig[] | undefined): Set<string> {
  const taken = new Set<string>()
  for (const p of getEffectiveProfiles(profiles)) taken.add(p.id)
  for (const id of loadProfileIds()) taken.add(id)
  return taken
}

/**
 * Create a pending profile: validate the name, refuse everything refusable,
 * reserve the id, and mint PKCE. Nothing is written to disk here.
 */
export function startProfileAdd(params: StartAddParams): StartAddSuccess | AddFailure {
  const now = params.now ?? Date.now()
  const profileId = params.profileId.trim()
  if (!profileId) {
    return { ok: false, code: "invalid_request", status: 400, message: "Missing 'profile' in request body" }
  }

  const readonly = readonlyRefusal(profileId)
  if (readonly) return readonly

  // Before anything else touches it: this name becomes a directory.
  if (!isValidProfileId(profileId)) {
    return {
      ok: false,
      code: "invalid_profile_id",
      status: 400,
      message: "Profile names may use only letters, numbers, hyphens and underscores.",
    }
  }

  if (takenIds(params.profiles).has(profileId)) {
    return {
      ok: false,
      code: "profile_exists",
      status: 409,
      message: `Profile "${profileId}" already exists. To sign it in again, use "Log in from browser" on its card.`,
    }
  }

  prune(now)
  // A second sign-in for the same name REPLACES the first rather than being
  // refused. Cancelling the panel, reloading the page or closing the tab all
  // abandon a sign-in without telling the server, so refusing here would lock
  // the name out for the full TTL with no way for the user to release it. One
  // entry per name still holds, which is what stops two sign-ins from both
  // completing; superseding just decides which one survives.
  for (const [id, pending] of pendingAdds) {
    if (pending.profileId === profileId) pendingAdds.delete(id)
  }

  const session = createManualOAuthSession()
  const addId = randomBytes(16).toString("base64url")
  const expiresAt = now + LOGIN_TTL_MS
  pendingAdds.set(addId, {
    profileId,
    claudeConfigDir: profileConfigDirFor(profileId),
    codeVerifier: session.codeVerifier,
    state: session.state,
    expiresAt,
  })

  return { ok: true, profileId, addId, authorizeUrl: session.authorizeUrl, expiresAt }
}

/**
 * Finish a creation from what the user pasted — a bare code, or the whole
 * callback URL from the browser's address bar.
 *
 * Order matters: the credentials are exchanged FIRST and the profiles.json
 * entry is written only once they are in hand. An OAuth failure therefore
 * leaves no profile behind at all, rather than a half-made one that shows as
 * permanently logged out and has to be noticed and cleaned up. The residue of
 * a failure is at most an empty directory, which the next attempt reuses.
 */
export async function completeProfileAdd(params: CompleteAddParams): Promise<CompleteAddSuccess | AddFailure> {
  const now = params.now ?? Date.now()
  prune(now)

  const pending = pendingAdds.get(params.addId)
  if (!pending) {
    return {
      ok: false,
      code: "expired_add",
      status: 410,
      message: "This sign-in is no longer open — it expired, or it was already completed. Start it again.",
    }
  }

  // Parsed before the pending entry is consumed: a mistyped paste should not
  // force the user back through Anthropic's sign-in.
  const parsed = parseAuthorizationCodeInput(params.input)
  if (!parsed) {
    return {
      ok: false,
      code: "no_code",
      status: 400,
      message: "No authorization code found in that paste. Paste the code Claude showed you, or the whole callback URL.",
      retryable: true,
    }
  }

  // Consumed BEFORE the exchange: deleting first is what makes single-use hold
  // against two completions racing the same id.
  pendingAdds.delete(params.addId)

  const exchange = await exchangeAuthorizationCodeForCredentials({
    code: parsed.code,
    returnedState: parsed.state,
    sessionState: pending.state,
    codeVerifier: pending.codeVerifier,
    claudeConfigDir: pending.claudeConfigDir,
    fetchFn: params.fetchFn,
  })

  if (!exchange.ok) {
    if (exchange.reason === "state_mismatch") {
      // Rejected locally — nothing was spent, so put the reservation back and
      // let the user paste from the right tab.
      pendingAdds.set(params.addId, pending)
      return {
        ok: false,
        code: "state_mismatch",
        status: 400,
        message: "OAuth state did not match this sign-in. Paste the code from the tab this sign-in opened.",
        retryable: true,
      }
    }
    if (exchange.reason === "write_failed") {
      return {
        ok: false,
        code: "write_failed",
        status: 500,
        message: `Signed in, but the credentials for "${pending.profileId}" could not be written, so the profile was not created.`,
      }
    }
    // The token endpoint's own error body is deliberately not forwarded — it is
    // one-time-credential-adjacent and belongs nowhere near a rendered page.
    return {
      ok: false,
      code: "exchange_failed",
      status: 502,
      message: exchange.status
        ? `Anthropic rejected the authorization code (HTTP ${exchange.status}). Codes expire quickly — start again.`
        : "Could not reach Anthropic to exchange the authorization code. Start again.",
    }
  }

  const created = createProfileSlot(pending.profileId)
  if (!created.ok) {
    if (created.reason === "already_exists") {
      // Something created this name during the sign-in — the CLI, or another
      // instance. Said plainly rather than reported as success: the credentials
      // just authorized went into that profile's directory.
      return {
        ok: false,
        code: "profile_exists",
        status: 409,
        message: `Profile "${pending.profileId}" was created elsewhere while you were signing in. `
          + "The account you just authorized was written to its config directory; check it before using it.",
      }
    }
    return {
      ok: false,
      code: "create_failed",
      status: 500,
      message: `Signed in, but "${pending.profileId}" could not be written to profiles.json (${created.message}). `
        + `The credentials are on disk — \`meridian profile add ${pending.profileId}\` will pick them up.`,
    }
  }

  return { ok: true, profileId: created.profile.id, claudeConfigDir: created.profile.claudeConfigDir ?? pending.claudeConfigDir }
}

export function pendingAddCount(): number {
  return pendingAdds.size
}

/** Drop all pending creations — for testing only. */
export function resetPendingAdds(): void {
  pendingAdds.clear()
}
