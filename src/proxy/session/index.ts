/**
 * Session management — barrel export.
 */
export { computeLineageHash, hashMessage, computeMessageHashes, verifyLineage, measurePrefixOverlap, measureSuffixOverlap, MIN_SUFFIX_FOR_COMPACTION } from "./lineage"
export type { SessionState, LineageResult, LineageDivergenceReason } from "./lineage"
export { extractClientCwd, getConversationFingerprint } from "./fingerprint"
export { lookupSession, storeSession, clearSessionCache, getMaxSessionsLimit, evictSession } from "./cache"
