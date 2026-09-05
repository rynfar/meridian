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
 * Use this at MCP validation and client capture. Current Claude Code repairs
 * some top-level fields before PreToolUse, but nested values can remain strings.
 * The hook precedes the MCP handler, and streamed arguments precede the hook:
 * repairing only the handler cannot correct what the client receives.
 *
 * Only slips whose declared type makes the intent unambiguous are repaired,
 * and only from a string. A declared `string` is never JSON-parsed: that would
 * corrupt legitimate input which merely looks like JSON.
 */
function repairTypeSlip(schema: JsonSchemaNode, value: unknown): unknown {
  if (typeof value !== "string") return value

  if (schema.type === "number" || schema.type === "integer") {
    const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value.trim())
    if (!match) return value
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return value
    if (schema.type === "integer") {
      if (!Number.isSafeInteger(parsed)) return value
      // Number() can round a non-integral decimal such as 1.0000000000000001
      // to an integer. Check the decimal's fractional digits before accepting.
      const fraction = match[3] ?? ""
      const digits = `${match[2]}${fraction}`.replace(/^0+/, "")
      const scale = Number(match[4] ?? 0) - fraction.length
      if (digits && scale < 0 && (-scale > digits.length || /[1-9]/.test(digits.slice(scale)))) return value
    }
    return parsed
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

/** Repair capture input too: CLI PreToolUse precedes the MCP handler parser. */
function repairCapturedValue(schema: unknown, value: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return value
  const node = schema as JsonSchemaNode
  const repaired = repairTypeSlip(node, value)
  if (node.type === "array" && Array.isArray(repaired)) {
    return repaired.map(item => repairCapturedValue(node.items, item))
  }
  if (node.type === "object" && repaired && typeof repaired === "object" && !Array.isArray(repaired) && node.properties) {
    return repairCapturedObject(repaired as Record<string, unknown>, node.properties)
  }
  return repaired
}

function repairCapturedObject(input: Record<string, unknown>, properties: Record<string, unknown>): Record<string, unknown> {
  // Preserve every key, including fields outside the simplified schema subset.
  // Parsing through a ZodObject here would strip unknown client arguments.
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key,
    repairCapturedValue(Object.hasOwn(properties, key) ? properties[key] : undefined, value),
  ]))
}

/** Only buffer streamed arguments whose declared fields can need type repair. */
export function hasRepairableToolInput(schema: { properties?: Record<string, unknown> } | undefined): boolean {
  return Object.values(schema?.properties ?? {}).some(property => {
    if (!property || typeof property !== "object" || Array.isArray(property)) return false
    const type = (property as { type?: unknown }).type
    return type === "number" || type === "integer" || type === "boolean" || type === "object" || type === "array"
  })
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
  // A preprocess pipe accepts unknown input at the type level. MCP's input
  // schema converter otherwise drops required fields, despite runtime rejection
  // of undefined. Optional properties are wrapped explicitly by the caller.
  return z.preprocess(value => repairTypeSlip(schema, value), node).nonoptional()
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
  if (schema.type === "integer") {
    return repairing(schema, z.number().int())
  }
  if (schema.type === "number") {
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
  if (!input || typeof input !== "object" || Array.isArray(input) || !clientSchema?.properties) return input

  const schemaKeys = new Set(Object.keys(clientSchema.properties))
  const required = new Set(clientSchema.required ?? [])

  // Name normalization is only needed for missing required fields. Type repair
  // also applies when every field is present, including optional/nested fields.
  const missingRequired = [...required].filter(k => input[k] === undefined)
  if (missingRequired.length === 0) return repairCapturedObject(input, clientSchema.properties)

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

  return repairCapturedObject(normalized, clientSchema.properties)
}
