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

/** A new working turn must consume the real saved checkpoint as a fork. */
export function checkpointResumeMatches(
  query: { resume?: unknown; resumeSessionAt?: unknown; forkSession?: unknown },
  checkpoint: { claudeSessionId?: unknown; passthroughToolCallAssistantUuid?: unknown },
): boolean {
  return typeof checkpoint.claudeSessionId === "string" && checkpoint.claudeSessionId.length > 0
    && typeof checkpoint.passthroughToolCallAssistantUuid === "string" && checkpoint.passthroughToolCallAssistantUuid.length > 0
    && query.resume === checkpoint.claudeSessionId
    && query.resumeSessionAt === checkpoint.passthroughToolCallAssistantUuid
    && query.forkSession === true
}

/** Count all matching results before checking the one genuine owned Read. */
export function durableReadResultMatches(
  blocks: readonly { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown }[],
  toolId: string,
  ownedValue: string,
): boolean {
  if (!toolId || !ownedValue) return false
  const results = blocks.filter(block => block.type === "tool_result" && block.tool_use_id === toolId)
  const result = results[0]
  return results.length === 1 && result !== undefined && result.is_error !== true
    && (JSON.stringify(result.content)?.includes(ownedValue) ?? false)
}
