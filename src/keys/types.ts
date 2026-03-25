export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  requestCount: number
}

export interface UsageEntry {
  timestamp: number
  tokens: number
  inputTokens?: number
  outputTokens?: number
  model?: string
}

export interface KeyLimits {
  /** Max tokens per 6-hour window (0 = unlimited) */
  limit6h: number
  /** Max tokens per weekly window (0 = unlimited) */
  limitWeekly: number
}

export interface ApiKey {
  /** Unique identifier */
  id: string
  /** Human-readable label */
  name: string
  /** The API key string (what clients send) */
  key: string
  /** Whether this key is active */
  enabled: boolean
  /** ISO timestamp */
  createdAt: string
  /** ISO timestamp of last successful request */
  lastUsedAt: string | null
  /** Cumulative input tokens */
  inputTokens: number
  /** Cumulative output tokens */
  outputTokens: number
  /** Total request count */
  requestCount: number
  /** Per-model usage breakdown */
  modelUsage?: Record<string, ModelUsage>
  /** Per-key rate limits */
  limits?: KeyLimits
  /** Rolling usage entries for rate limit enforcement */
  usageLog?: UsageEntry[]
}
