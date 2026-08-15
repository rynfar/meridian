import { listAdapterNames } from "../adapters/detect"

/**
 * Adapters a plugin may scope itself to.
 *
 * Derived from the adapter registry rather than hand-listed, because the
 * hand-kept copy drifted every time an adapter was added and nothing failed
 * loudly enough to notice: it was already missing `claude-code`, `cherry` and
 * `codex` before `prime` missed it again (#791). The symptom is a plugin
 * scoped to a perfectly real adapter being reported as referencing an unknown
 * one — which reads as the plugin being wrong rather than this list being
 * stale.
 *
 * Adapter INSTANCES (#476) are deliberately absent. Plugins scope to a base
 * adapter and apply to its instances automatically, so an instance name is not
 * something a plugin should be declaring.
 */
const KNOWN_HOOKS = ["onRequest", "onResponse", "onTelemetry", "onSession", "onToolUse", "onToolResult", "onError"]

export interface ValidationResult {
  valid: boolean
  hooks: string[]
  error?: string
  warnings?: string[]
}

export function validateTransform(exported: unknown): ValidationResult {
  if (exported == null || typeof exported !== "object") {
    return { valid: false, hooks: [], error: "Plugin must export an object" }
  }

  const obj = exported as Record<string, unknown>

  if (typeof obj.name !== "string" || obj.name.length === 0) {
    return { valid: false, hooks: [], error: "Plugin must have a name: string property" }
  }

  const hooks: string[] = []
  for (const hook of KNOWN_HOOKS) {
    if (obj[hook] !== undefined) {
      if (typeof obj[hook] !== "function") {
        return { valid: false, hooks: [], error: `${hook} must be a function, got ${typeof obj[hook]}` }
      }
      hooks.push(hook)
    }
  }

  const warnings: string[] = []
  if (Array.isArray(obj.adapters)) {
    const known = listAdapterNames()
    for (const adapter of obj.adapters) {
      if (typeof adapter === "string" && !known.includes(adapter)) {
        warnings.push(adapter)
      }
    }
  }

  return {
    valid: true,
    hooks,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
