declare const uuidV4Brand: unique symbol
export type UuidV4 = string & { readonly [uuidV4Brand]: true }

/** Shared with the legacy facade: one lowercase v4/variant matcher, no permissive fallback. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isUuidV4(value: unknown): value is UuidV4 {
  return typeof value === "string" && UUID_PATTERN.test(value)
}
