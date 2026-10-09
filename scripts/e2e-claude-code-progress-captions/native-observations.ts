/** Bounded model labels only; provider prose and credential envelopes are omitted. */
export function modelLabel(value: unknown): string | null {
  return typeof value === "string" && value.length <= 128
    && /^(?:(?:opus|sonnet|haiku|fable)(?:\[1m\])?|claude-(?:opus|sonnet|haiku|fable|mythos)-[0-9][a-z0-9.-]{0,95}(?:\[1m\])?)$/.test(value)
    ? value : null
}

interface BackendWitness {
  requested: unknown
  sdk: unknown
  pin: unknown
  native: unknown
  version: unknown
}

interface ExpectedBackend {
  requested: string
  sdk: string
  native: string
  version: string
}

/** Each label has its own exact pin; extended context is never stripped. */
export function exactBackendModel(actual: BackendWitness, expected: ExpectedBackend): boolean {
  return (actual.requested === expected.requested || actual.requested === expected.native)
    && actual.sdk === expected.sdk && actual.pin === expected.requested
    && actual.native === expected.native && actual.version === expected.version
}

interface QueryCustody {
  gate?: { handle?: object }
  handle?: object
  iteratorSettledAt?: number
  closeAt?: number
}

/** Model acceptance is independent of observed executor/query ownership. */
export function queryCustodyJoined(query: QueryCustody): boolean {
  return query.handle !== undefined && query.handle !== null
    && query.gate?.handle === query.handle
    && typeof query.iteratorSettledAt === "number" && Number.isSafeInteger(query.iteratorSettledAt) && query.iteratorSettledAt > 0
    && typeof query.closeAt === "number" && Number.isSafeInteger(query.closeAt) && query.closeAt > 0
}
