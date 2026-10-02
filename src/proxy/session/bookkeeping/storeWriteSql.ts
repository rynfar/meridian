import { randomUUID } from "node:crypto"
import { checkParameters } from "./connection"
import { getMaxStoredSessionsLimit } from "../../sessionStore"
import { mappingDigest } from "./mappingMetadata"
import { readMapping, readMappingGeneration, writeMappingRow } from "./mappings"
import { withStoreWrite } from "./storeScope"
import { advanceStoreSlot, canonicalMapping, prepareStoreLocator, pruneMappings,
  refreshMappingRoutes, rollbackProtected } from "./storeMutationSupport"
import type { StoreSessionArguments } from "./storeTypes"
import type { CanonicalStoredSession } from "./types"

export function storeSharedSession(directory: string, ...args: StoreSessionArguments): string | false {
  const [key, claudeSessionId, messageCount, lineageHash, messageHashes, sdkMessageUuids, contextUsage,
    messageBlockHashes, passthroughToolCallAssistantUuid, passthroughToolCallIds, current, source,
    expectedGeneration] = args
  checkParameters([key, claudeSessionId, lineageHash ?? null,
    passthroughToolCallAssistantUuid ?? null, expectedGeneration ?? null])
  const currentTranscript = prepareStoreLocator(directory, current, claudeSessionId)
  const sourceTranscript = prepareStoreLocator(directory, source, undefined, "sourceTranscript")
  return withStoreWrite(directory, (tx) => {
    if (rollbackProtected(tx, key)) return false
    const actual = readMappingGeneration(tx, key)
    const expected = expectedGeneration === null ? `a:${mappingDigest(key)}:0` : expectedGeneration
    if (expected !== undefined && actual !== expected) return false
    const raw = readMapping(tx, key)
    const existing = raw ? canonicalMapping(tx, key, raw) : undefined
    const changed = existing !== undefined && existing.claudeSessionId !== claudeSessionId
    if (sourceTranscript && (!changed || sourceTranscript.sessionId !== existing?.claudeSessionId))
      throw new Error("sourceTranscript.sessionId must match the replaced claudeSessionId")
    const resolvedCurrent = changed ? currentTranscript : existing?.currentTranscript ?? currentTranscript
    const previous = changed ? existing?.currentTranscript ?? sourceTranscript : existing?.previousTranscript
    const previousId = changed ? existing.claudeSessionId : existing?.previousClaudeSessionId
    const stored: CanonicalStoredSession = {
      claudeSessionId, revision: (existing?.revision ?? 0) + 1, generationId: randomUUID(),
      createdAt: existing?.createdAt || Date.now(), lastUsedAt: Date.now(),
      messageCount: messageCount ?? existing?.messageCount ?? 0,
      lineageHash: lineageHash ?? existing?.lineageHash,
      messageHashes: messageHashes ?? existing?.messageHashes,
      messageBlockHashes: messageBlockHashes ?? existing?.messageBlockHashes,
      sdkMessageUuids: sdkMessageUuids ?? existing?.sdkMessageUuids,
      contextUsage: contextUsage ?? existing?.contextUsage,
      passthroughToolCallAssistantUuid: passthroughToolCallAssistantUuid === undefined
        ? existing?.passthroughToolCallAssistantUuid : passthroughToolCallAssistantUuid ?? undefined,
      passthroughToolCallIds: passthroughToolCallIds === undefined
        ? existing?.passthroughToolCallIds : passthroughToolCallIds ?? undefined,
      ...(resolvedCurrent ? { currentTranscript: { ...resolvedCurrent } } : {}),
      ...(previous ? { previousTranscript: { ...previous } } : {}),
      ...(previousId ? { previousClaudeSessionId: previousId } : {}),
    }
    writeMappingRow(tx, key, stored, true)
    if (!pruneMappings(tx, getMaxStoredSessionsLimit(), key)) return false
    advanceStoreSlot(tx, key)
    const generation = readMappingGeneration(tx, key)
    refreshMappingRoutes(tx, key, generation)
    return generation
  })
}
