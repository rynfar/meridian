/**
 * Plugin invocation statistics.
 *
 * Counts hook invocations, errors, and accumulated runtime per plugin so
 * users can confirm their plugin is actually running and catch regressions
 * (e.g. a plugin throwing on every request).
 *
 * Stats are tracked only for plugins the loader has registered — adapter
 * built-in transforms are internal plumbing and flow through the same
 * pipeline but aren't metered here.
 */

export interface HookStats {
  /** Number of successful invocations */
  invocations: number
  /** Number of times the hook threw */
  errors: number
  /** Accumulated execution time in milliseconds (successful calls only) */
  totalMs: number
}

export interface PluginStats {
  /** Per-hook counters, keyed by hook name (onRequest, onResponse, etc.) */
  hooks: Record<string, HookStats>
  /** Unix timestamp of the most recent invocation of any hook */
  lastInvokedAt?: number
  /** Most recent error, if any */
  lastError?: {
    hook: string
    message: string
    at: number
  }
}

const stats = new Map<string, PluginStats>()

function emptyStats(): PluginStats {
  return { hooks: {} }
}

function emptyHook(): HookStats {
  return { invocations: 0, errors: 0, totalMs: 0 }
}

/**
 * Register a plugin name for stats tracking. Called by the loader after
 * a plugin validates successfully. Resets any prior stats for that name
 * (so /plugins/reload gives you a clean slate).
 */
export function registerPluginStats(name: string): void {
  stats.set(name, emptyStats())
}

/**
 * Drop all stats. Called before a full reload so stale data doesn't linger
 * for plugins that were removed from the config.
 */
export function resetAllPluginStats(): void {
  stats.clear()
}

/**
 * Whether the given name is a tracked plugin. Adapter built-in transforms
 * aren't registered, so the runner can silently skip stats for them.
 */
export function isTrackedPlugin(name: string): boolean {
  return stats.has(name)
}

/**
 * Record a successful invocation of a hook.
 */
export function recordInvocation(name: string, hook: string, durationMs: number): void {
  const entry = stats.get(name)
  if (!entry) return
  const h = entry.hooks[hook] ?? emptyHook()
  h.invocations += 1
  h.totalMs += durationMs
  entry.hooks[hook] = h
  entry.lastInvokedAt = Date.now()
}

/**
 * Record an error from a hook.
 */
export function recordError(name: string, hook: string, err: unknown): void {
  const entry = stats.get(name)
  if (!entry) return
  const h = entry.hooks[hook] ?? emptyHook()
  h.errors += 1
  entry.hooks[hook] = h
  const at = Date.now()
  entry.lastInvokedAt = at
  entry.lastError = {
    hook,
    message: err instanceof Error ? err.message : String(err),
    at,
  }
}

/**
 * Read a snapshot of stats for one plugin. Returns a deep copy so callers
 * can't mutate the internal state.
 */
export function getPluginStats(name: string): PluginStats | undefined {
  const entry = stats.get(name)
  if (!entry) return undefined
  return {
    hooks: Object.fromEntries(
      Object.entries(entry.hooks).map(([k, v]) => [k, { ...v }])
    ),
    lastInvokedAt: entry.lastInvokedAt,
    ...(entry.lastError ? { lastError: { ...entry.lastError } } : {}),
  }
}
