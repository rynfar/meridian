/**
 * Meridian's own ChatGPT credential store.
 *
 * Separate from `~/.opencode/oc-codex-multi-auth-accounts.json` by design.
 * That file belongs to the plugin, Meridian reads it and never writes it, and
 * this one is the writable store Meridian owns outright.
 *
 * IDENTITY IS `accountUserId`, THE SEAT. `accountId` is the workspace and is
 * NOT unique - in the operator's live pool one `accountId` covers two people
 * with two emails and two seats. Keying on it does not merge two rows in a
 * display, it hands one person's refresh token to the other's account.
 *
 * A WRITE IS ALL-OR-NOTHING AND NEEDS THE LEASE. Refresh tokens are
 * single-use, so the rotated replacement is the only credential that still
 * works: a half-written document destroys it exactly as thoroughly as never
 * writing it, and a second writer overwriting it does the same. Every write
 * therefore goes through a fsynced staging file renamed into place, and every
 * write is refused unless this process holds the writer lease at the moment it
 * happens.
 *
 * READS NEED NO LEASE. A reader spends nothing, and requiring one would mean a
 * dashboard could take refresh authority away from the process doing the work.
 */

import { randomUUID } from "node:crypto"
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"
import { syncDirectoryDurablySync } from "../session/durableFileSystem"
import type { WriterLease } from "./lease"

const STORE_VERSION = 1

export interface ChatGptAccount {
  /** The `chatgpt_account_user_id` claim: one seat, and the only safe key. */
  accountUserId: string
  /** The `chatgpt_account_id` claim, sent as the `chatgpt-account-id` scope header. Shared between seats. */
  accountId: string
  email: string | null
  refreshToken: string
  accessToken: string | null
  expiresAt: number | null
  tokenRotatedAt: number | null
  /**
   * Stamped before an exchange is dispatched and cleared only by the commit
   * that records its result. Surviving therefore means the replacement token
   * was never written down, so `refreshToken` may already be spent - which is
   * a state to report, never one to retry. See refresh.ts.
   */
  exchangeStartedAt: number | null
  /** The seat's latest renewals, oldest first; absent until one is recorded. See refresh.ts. */
  renewals?: ChatGptRenewal[]
}

/**
 * One token exchange the provider saw, and what came back. `rotated` and
 * `kept` say whether a new refresh token was issued; `refused` is the provider
 * declining the grant, `unverified` an exchange whose result is unknown. No
 * field is a credential.
 */
export interface ChatGptRenewal {
  at: number
  outcome: ChatGptRenewalOutcome
  /** Which refusal, or which failed status, in refresh.ts's own words. */
  cause?: string
  /** The new access token's issue time and expiry, as far as they are known. */
  issuedAt?: number
  expiresAt?: number
}

export type ChatGptRenewalOutcome = "rotated" | "kept" | "refused" | "unverified"

export class WriterLeaseRequiredError extends Error {
  readonly path: string

  constructor(path: string) {
    super(
      `Refusing to write the ChatGPT credential store at ${path} without the writer lease. `
      + "Exactly one process may hold refresh authority for these accounts.",
    )
    this.name = "WriterLeaseRequiredError"
    this.path = path
  }
}

export class ChatGptStoreCorruptError extends Error {
  readonly path: string

  constructor(path: string, detail: string, options?: ErrorOptions) {
    super(`The ChatGPT credential store at ${path} is not valid: ${detail}.`, options)
    this.name = "ChatGptStoreCorruptError"
    this.path = path
  }
}

/**
 * Both ids are strings, so nothing but a runtime check can tell that a record
 * is about to be filed under a seat other than its own.
 */
export class AccountIdentityMismatchError extends Error {
  readonly expectedAccountUserId: string
  readonly actualAccountUserId: string

  constructor(expected: string, actual: string) {
    super(
      `Refusing to file the record for seat "${actual}" under seat "${expected}". `
      + "accountUserId is the only account identity this store recognizes.",
    )
    this.name = "AccountIdentityMismatchError"
    this.expectedAccountUserId = expected
    this.actualAccountUserId = actual
  }
}

export interface ChatGptCredentialStore {
  readonly path: string
  readAccounts(): ChatGptAccount[]
  readAccount(accountUserId: string): ChatGptAccount | undefined
  /**
   * Read, mutate and durably replace one seat's record. Returns what was
   * committed, so a caller holding a freshly rotated token can only obtain it
   * from a write that already reached disk.
   */
  commitAccount(
    accountUserId: string,
    mutate: (current: ChatGptAccount | undefined) => ChatGptAccount,
  ): ChatGptAccount
  /**
   * Durably drop these seats, returning the records removed. Used only when a
   * seat's refresh authority is handed to another program: the record must be
   * gone before that program renews, or both would spend one token.
   */
  removeAccounts(accountUserIds: readonly string[]): ChatGptAccount[]
}

export interface ChatGptCredentialStoreOptions {
  path: string
  /** Absent means read-only. Writes are refused rather than performed unguarded. */
  lease?: WriterLease
}

interface StoredDocument {
  version: number
  accounts: ChatGptAccount[]
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

const RENEWAL_OUTCOMES: ReadonlySet<string> = new Set(["rotated", "kept", "refused", "unverified"])

// The history is a record of what happened, never something a credential
// depends on, so a malformed entry is dropped rather than failing the store.
function parseRenewals(value: unknown): ChatGptRenewal[] | undefined {
  if (!Array.isArray(value)) return undefined
  const renewals: ChatGptRenewal[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue
    const raw = entry as Record<string, unknown>
    const at = nullableNumber(raw.at)
    if (at === null || typeof raw.outcome !== "string" || !RENEWAL_OUTCOMES.has(raw.outcome)) continue
    const renewal: ChatGptRenewal = { at, outcome: raw.outcome as ChatGptRenewalOutcome }
    if (typeof raw.cause === "string" && raw.cause.length > 0 && raw.cause.length <= 64) renewal.cause = raw.cause
    const issuedAt = nullableNumber(raw.issuedAt)
    if (issuedAt !== null) renewal.issuedAt = issuedAt
    const expiresAt = nullableNumber(raw.expiresAt)
    if (expiresAt !== null) renewal.expiresAt = expiresAt
    renewals.push(renewal)
  }
  return renewals.length > 0 ? renewals : undefined
}

function parseAccount(value: unknown, path: string, index: number): ChatGptAccount {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ChatGptStoreCorruptError(path, `entry ${index} is not an object`)
  }
  const record = value as Record<string, unknown>
  const { accountUserId, accountId, refreshToken } = record
  if (
    typeof accountUserId !== "string" || accountUserId.length === 0
    || typeof accountId !== "string" || accountId.length === 0
    || typeof refreshToken !== "string" || refreshToken.length === 0
  ) {
    throw new ChatGptStoreCorruptError(path, `entry ${index} is missing its identity or its credential`)
  }
  const renewals = parseRenewals(record.renewals)
  return {
    accountUserId,
    accountId,
    email: nullableString(record.email),
    refreshToken,
    accessToken: nullableString(record.accessToken),
    expiresAt: nullableNumber(record.expiresAt),
    tokenRotatedAt: nullableNumber(record.tokenRotatedAt),
    exchangeStartedAt: nullableNumber(record.exchangeStartedAt),
    ...(renewals ? { renewals } : {}),
  }
}

function parseDocument(path: string, raw: string): StoredDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ChatGptStoreCorruptError(path, "it is not JSON", { cause: error })
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ChatGptStoreCorruptError(path, "its top level is not an object")
  }
  const document = parsed as Record<string, unknown>
  if (document.version !== STORE_VERSION) {
    // Rewriting a document this build does not understand would drop whatever
    // fields it added, and one of them could be the live refresh token.
    throw new ChatGptStoreCorruptError(
      path,
      `it declares version ${JSON.stringify(document.version)} and this build writes version ${STORE_VERSION}`,
    )
  }
  if (!Array.isArray(document.accounts)) {
    throw new ChatGptStoreCorruptError(path, "its accounts field is not an array")
  }
  return {
    version: STORE_VERSION,
    accounts: document.accounts.map((entry, index) => parseAccount(entry, path, index)),
  }
}

function readDocument(path: string): StoredDocument {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    // Never written yet is a legitimate state and reports as empty. Anything
    // else is reported as the failure it is - see ChatGptStoreCorruptError.
    if (errnoCode(error) === "ENOENT") return { version: STORE_VERSION, accounts: [] }
    throw error
  }
  return parseDocument(path, raw)
}

function publishDocument(path: string, document: StoredDocument): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const staging = `${path}.staging-${process.pid}-${randomUUID()}`
  let fd: number | undefined
  try {
    fd = openSync(staging, "wx", 0o600)
    fchmodSync(fd, 0o600)
    writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(staging, path)
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch (error) {
        console.error("[chatgpt] credential staging close failed:", (error as Error).message)
      }
    }
    try { unlinkSync(staging) } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        console.error("[chatgpt] credential staging cleanup failed:", (error as Error).message)
      }
    }
  }
  syncDirectoryDurablySync(dirname(path))
}

export function createChatGptCredentialStore(
  options: ChatGptCredentialStoreOptions,
): ChatGptCredentialStore {
  const { path, lease } = options

  return {
    path,

    readAccounts() {
      return readDocument(path).accounts
    },

    readAccount(accountUserId) {
      return readDocument(path).accounts.find(account => account.accountUserId === accountUserId)
    },

    commitAccount(accountUserId, mutate) {
      if (!lease) throw new WriterLeaseRequiredError(path)
      lease.assertValid()

      const document = readDocument(path)
      const index = document.accounts.findIndex(account => account.accountUserId === accountUserId)
      const current = index >= 0 ? document.accounts[index] : undefined
      const next = mutate(current ? { ...current } : undefined)
      if (next.accountUserId !== accountUserId) {
        throw new AccountIdentityMismatchError(accountUserId, next.accountUserId)
      }

      const accounts = [...document.accounts]
      if (index >= 0) accounts[index] = next
      else accounts.push(next)

      // Checked again with nothing left to do but write. A writer displaced
      // during the read-modify step and only noticing afterwards has already
      // overwritten what the new owner committed, and an overwritten
      // single-use token is not recoverable by retrying.
      lease.assertValid()
      publishDocument(path, { version: STORE_VERSION, accounts })
      return next
    },

    removeAccounts(accountUserIds) {
      if (!lease) throw new WriterLeaseRequiredError(path)
      lease.assertValid()
      const drop = new Set(accountUserIds)
      const document = readDocument(path)
      const removed = document.accounts.filter(account => drop.has(account.accountUserId))
      if (removed.length === 0) return []
      lease.assertValid()
      publishDocument(path, { version: STORE_VERSION, accounts: document.accounts.filter(account => !drop.has(account.accountUserId)) })
      return removed
    },
  }
}
