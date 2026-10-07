import { createHash, randomUUID } from "node:crypto"
import { basename, dirname, join } from "node:path"
import { rmdirSync, unlinkSync } from "node:fs"
import { isUuidV4 } from "./uuid"
import { BookkeepingFormatError } from "./storagePaths"

declare const privatePathBrand: unique symbol
export type PrivatePath = string & { readonly [privatePathBrand]: true }

export function shortPrivatePrefix(publicPath: string, kind: "p" | "i" = "p"): string {
  const hash = createHash("sha256").update(basename(publicPath)).digest("hex")
  return join(dirname(publicPath), `.bk-${kind}-${hash}-`)
}

/** The optional name is only for a validated durable intent, never an arbitrary path cast. */
export function privateName(publicPath: string, migrationId: string, recorded?: string, kind: "p" | "i" = "p"): PrivatePath {
  if (!isUuidV4(migrationId)) throw new BookkeepingFormatError("invalid private name migration UUID")
  const prefix = `${publicPath}.releasing-${migrationId}-`
  const short = `${shortPrivatePrefix(publicPath, kind)}${migrationId}-`
  const generated = Buffer.byteLength(basename(prefix)) + 36 <= 255 ? prefix : short
  const path = recorded ?? `${generated}${randomUUID()}`
  if (!(path.startsWith(prefix) && isUuidV4(path.slice(prefix.length)))
    && !(path.startsWith(short) && isUuidV4(path.slice(short.length)))) {
    throw new BookkeepingFormatError("invalid recorded private name")
  }
  return path as PrivatePath
}

/** Separate namespace: a user source ending in .deletion-intent is still a capture, not an intent. */
export function privateIntentName(source: string, id: string, recorded?: string): PrivatePath {
  return privateName(source + ".deletion-intent", id, recorded, "i")
}

/** POSIX boundary: freshly generated private UUID names are not concurrently named by another actor. */
export function unlinkPrivate(path: PrivatePath): void { unlinkSync(path) }
export function rmdirPrivate(path: PrivatePath): void { rmdirSync(path) }
