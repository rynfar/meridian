/**
 * Dynamic MCP tool registration for passthrough mode.
 *
 * In passthrough mode, OpenCode's tools need to be real callable tools
 * (not just text descriptions in the prompt). We create an MCP server
 * that registers each tool from OpenCode's request with the exact
 * name and schema, so Claude generates proper tool_use blocks.
 *
 * Tool handlers are no-ops — the PreToolUse hook blocks execution.
 * We just need the definitions so Claude can call them.
 */

import { createSdkMcpServer, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

export const PASSTHROUGH_MCP_NAME = "oc"
export const PASSTHROUGH_MCP_PREFIX = `mcp__${PASSTHROUGH_MCP_NAME}__`

/**
 * The JSON Schema subset a client's tool definitions actually use. Anything
 * richer (`anyOf`, `$ref`, tuple `items`, …) falls through to `z.any()` below,
 * exactly as before.
 */
interface JsonSchemaNode {
  type?: string
  description?: string
  enum?: string[]
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
}

/**
 * Repair the one tool-input slip the model makes often enough to matter: it
 * emits every argument as a string, so a declared `number` arrives as `"60"`
 * and a declared object as `'{"cdp_url":"..."}'`.
 *
 * That has to be repaired HERE, before validation, because a rejected call
 * never reaches the PreToolUse hook — so the proxy captures nothing, has
 * nothing to forward to the client, and the passthrough turn cap (maxTurns=1,
 * see query.ts) leaves the model no turn to correct itself. The SDK then ends
 * the query with `error_max_turns`, which server.ts can only report as a 500:
 * a hard, user-visible stream error for a call the client would have executed
 * fine. Measured live: every failing call carried `timeout: "60"` where the
 * client's schema says `number`.
 *
 * Only slips whose declared type makes the intent unambiguous are repaired,
 * and only from a string. A declared `string` is never JSON-parsed: that would
 * corrupt legitimate input which merely looks like JSON.
 */
function repairTypeSlip(schema: JsonSchemaNode, value: unknown): unknown {
  if (typeof value !== "string") return value

  if (schema.type === "number" || schema.type === "integer") {
    if (value.trim() === "") return value
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }

  if (schema.type === "boolean") {
    if (value === "true") return true
    if (value === "false") return false
    return value
  }

  if (schema.type === "object" || schema.type === "array") {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      return value
    }
    if (schema.type === "array") return Array.isArray(parsed) ? parsed : value
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : value
  }

  return value
}

/**
 * The MCP schema converter reads `description` from the OUTERMOST node only —
 * an inner `.describe()` under `.optional()` or a `preprocess` pipe is dropped
 * from the advertised schema. Apply it last so the model keeps seeing what the
 * client wrote, optional parameters included.
 */
function withDescription(node: z.ZodTypeAny, schema: JsonSchemaNode): z.ZodTypeAny {
  return typeof schema.description === "string" && schema.description
    ? node.describe(schema.description)
    : node
}

/** Wrap a validating node so a repairable slip is fixed instead of rejected. */
function repairing(schema: JsonSchemaNode, node: z.ZodTypeAny): z.ZodTypeAny {
  return z.preprocess(value => repairTypeSlip(schema, value), node)
}

/**
 * Convert a JSON Schema node to a Zod schema (simplified).
 * Handles the common types OpenCode sends. Falls back to z.any() for complex types.
 */
function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any()
  const node = schema as JsonSchemaNode
  return withDescription(buildZodNode(node), node)
}

function buildZodNode(schema: JsonSchemaNode): z.ZodTypeAny {

  if (schema.type === "string") {
    if (schema.enum) return z.enum(schema.enum as [string, ...string[]])
    return z.string()
  }
  if (schema.type === "number" || schema.type === "integer") {
    return repairing(schema, z.number())
  }
  if (schema.type === "boolean") return repairing(schema, z.boolean())
  if (schema.type === "array") {
    const items = schema.items ? jsonSchemaToZod(schema.items) : z.any()
    return repairing(schema, z.array(items))
  }
  if (schema.type === "object" && schema.properties) {
    return repairing(schema, z.object(objectShapeFromJsonSchema(schema)))
  }

  return z.any()
}

/**
 * The property shape of a JSON Schema object, with optionality applied.
 *
 * Kept separate from `jsonSchemaToZod` because the MCP registration needs the
 * root as a raw shape, and the root arguments object is never a slip candidate
 * — the protocol always delivers it as an object.
 */
function objectShapeFromJsonSchema(schema: JsonSchemaNode): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {}
  const required = new Set<string>(schema.required ?? [])
  for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
    const prop = jsonSchemaToZod(propSchema)
    shape[key] = required.has(key) ? prop : withDescription(prop.optional(), propSchema)
  }
  return shape
}

/** Default threshold: auto-defer when tool count exceeds this.
 *  Override with MERIDIAN_DEFER_TOOL_THRESHOLD env var. Set to 0 to disable. */
const DEFAULT_DEFER_THRESHOLD = 15

export function getAutoDeferThreshold(): number {
  const raw = process.env.MERIDIAN_DEFER_TOOL_THRESHOLD
  if (raw === undefined) return DEFAULT_DEFER_THRESHOLD
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DEFER_THRESHOLD
  return parsed
}

/**
 * Create an MCP server with tool definitions matching OpenCode's request.
 *
 * Auto-defer: when the tool count exceeds the threshold and coreToolNames
 * is provided, non-core tools are registered without alwaysLoad so the SDK
 * defers them. Core tools are marked alwaysLoad to stay in the prompt.
 * Client-provided defer_loading: true also triggers deferral for specific tools.
 */
export function createPassthroughMcpServer(
  tools: Array<{ name: string; description?: string; input_schema?: JsonSchemaNode; defer_loading?: boolean }>,
  coreToolNames?: readonly string[]
) {
  // Auto-defer: if tool count exceeds threshold and adapter provides core tools
  const threshold = getAutoDeferThreshold()
  const autoDefer = !!(threshold > 0 && coreToolNames && coreToolNames.length > 0 && tools.length > threshold)
  const coreSet = autoDefer ? new Set(coreToolNames.map(n => n.toLowerCase())) : undefined

  // hasDeferredTools is true when: client explicitly defers any tool, OR auto-defer kicks in
  const hasDeferredTools = tools.some(t => t.defer_loading === true) || autoDefer

  // Sort tools alphabetically by name to ensure deterministic MCP registration
  // order. Non-deterministic ordering changes the SDK system prompt between
  // requests, invalidating prompt cache and causing full context re-reads.
  const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name))
  const definitions = sortedTools.map((passthroughTool) => {
    const alwaysLoad = hasDeferredTools && shouldAlwaysLoad(passthroughTool, coreSet)
    const defineTool = (shape: Record<string, z.ZodType>): SdkMcpToolDefinition<Record<string, z.ZodType>> => ({
      name: passthroughTool.name,
      description: passthroughTool.description || passthroughTool.name,
      inputSchema: shape,
      handler: async () => ({ content: [{ type: "text" as const, text: "passthrough" }] }),
      ...(alwaysLoad ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
    })
    try {
      // Register through the Agent SDK helper so its Zod 4 peer owns the MCP
      // compatibility boundary. Registering through the nested MCP instance
      // instead couples this module to that package's separate Zod version.
      //
      // The root is built as a raw shape rather than a converted object: the
      // arguments object always arrives as an object over the protocol, so it
      // is never a repair candidate, and the SDK wants the shape anyway.
      const shape = passthroughTool.input_schema?.properties
        ? objectShapeFromJsonSchema(passthroughTool.input_schema)
        : {}
      return defineTool(shape)
    } catch {
      const fallbackShape: Record<string, z.ZodType> = { input: z.string().optional() }
      return defineTool(fallbackShape)
    }
  })

  const server = createSdkMcpServer({ name: PASSTHROUGH_MCP_NAME, tools: definitions })
  return {
    server,
    toolNames: sortedTools.map(tool => `${PASSTHROUGH_MCP_PREFIX}${tool.name}`),
    hasDeferredTools,
  }
}

/**
 * Determine if a tool should be marked alwaysLoad (kept in prompt, not deferred).
 * A tool is always-loaded when:
 * - Client explicitly did NOT set defer_loading on it AND no auto-defer, OR
 * - Auto-defer is active and the tool name is in the core set, OR
 * - Client explicitly set defer_loading: false (opt out of deferral)
 */
function shouldAlwaysLoad(
  tool: { name: string; defer_loading?: boolean },
  coreSet: Set<string> | undefined
): boolean {
  // Client explicitly deferred this tool — never alwaysLoad
  if (tool.defer_loading === true) return false
  // Auto-defer active: only core tools get alwaysLoad
  if (coreSet) return coreSet.has(tool.name.toLowerCase())
  // No auto-defer: client-triggered deferral — non-deferred tools get alwaysLoad
  return true
}

/**
 * Stable cache key for a tool set — name + input schema, sorted.
 * Schema is included so silently-updated tool definitions force a rebuild
 * of the cached MCP server.
 */
export function computeToolSetKey(
  tools: Array<{ name: string; input_schema?: unknown; defer_loading?: boolean }>
): string {
  const entries = tools
    .map(t => ({
      name: t.name,
      defer: t.defer_loading === true,
      schema: stableStringify(t.input_schema ?? null),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return JSON.stringify(entries)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts = keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
  return `{${parts.join(",")}}`
}

/**
 * Stable semantic signature for a forwarded tool_use: tool name + a
 * key-order-independent serialization of its input. Two tool calls with the
 * same name and the same arguments share a signature even if the SDK assigns
 * them different tool_use ids.
 *
 * Used by the passthrough capture path to tell apart genuine parallel calls
 * (distinct signatures — e.g. get_weather vs get_time) from an SDK internal
 * continuation turn re-emitting a blocked call (identical signature, new id).
 * The former are all forwarded; the latter is a duplicate and dropped.
 */
export function toolUseSignature(name: string, input: unknown): string {
  return `${name}::${stableStringify(input ?? null)}`
}

/**
 * Strip the MCP prefix from a tool name to get the OpenCode tool name.
 * e.g., "mcp__oc__todowrite" → "todowrite"
 */
export function stripMcpPrefix(toolName: string): string {
  if (toolName.startsWith(PASSTHROUGH_MCP_PREFIX)) {
    return toolName.slice(PASSTHROUGH_MCP_PREFIX.length)
  }
  return toolName
}

function toCamelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function toSnakeCase(s: string): string {
  return s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
}

/**
 * Normalize tool input parameter names to match the client's schema.
 *
 * The Claude Code SDK's system prompt references built-in tools with
 * snake_case parameter names (e.g., file_path), but clients like OpenCode
 * may use camelCase (e.g., filePath). When the model generates a tool call
 * using the SDK's naming convention instead of the MCP schema's convention,
 * required parameters appear undefined on the client side.
 *
 * This function detects unrecognized keys, tries snake_case ↔ camelCase
 * conversion, and remaps them when a match exists in the client's schema.
 * It only activates when at least one required parameter is missing, so
 * well-formed tool calls pass through untouched.
 */
export function normalizeToolInput(
  input: Record<string, unknown> | undefined,
  clientSchema: { properties?: Record<string, unknown>; required?: string[] } | undefined,
): Record<string, unknown> | undefined {
  if (!input || !clientSchema?.properties) return input

  const schemaKeys = new Set(Object.keys(clientSchema.properties))
  const required = new Set(clientSchema.required ?? [])

  // Fast path: all required fields are present, no normalization needed
  const missingRequired = [...required].filter(k => input[k] === undefined)
  if (missingRequired.length === 0) return input

  const normalized = { ...input }

  for (const key of Object.keys(normalized)) {
    if (schemaKeys.has(key)) continue // Already matches

    // Try camelCase: file_path → filePath
    const camel = toCamelCase(key)
    if (camel !== key && schemaKeys.has(camel) && normalized[camel] === undefined) {
      normalized[camel] = normalized[key]
      delete normalized[key]
      continue
    }

    // Try snake_case: filePath → file_path
    const snake = toSnakeCase(key)
    if (snake !== key && schemaKeys.has(snake) && normalized[snake] === undefined) {
      normalized[snake] = normalized[key]
      delete normalized[key]
    }
  }

  return normalized
}
