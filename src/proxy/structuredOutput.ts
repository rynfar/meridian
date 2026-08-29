import type { OutputFormat } from "@anthropic-ai/claude-agent-sdk"

export type OutputFormatParseResult =
  | { ok: true; value: OutputFormat | undefined }
  | { ok: false; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Parse Anthropic's `output_config.format` into the Claude Agent SDK's native
 * structured-output option. Absence is a no-op; malformed or unsupported
 * values are rejected at the HTTP boundary instead of failing in the SDK.
 *
 * Combining `tools` with `output_config.format` is rejected: structured-output
 * mode buffers the SDK's wire events and replaces the response content with the
 * validated result, so a tool_use turn would be swallowed and the client-driven
 * tool loop would never see it.
 *
 * `dialect` selects which spelling errors name. The OpenAI endpoint translates
 * `response_format` into this shape before validating, so it asks for its own
 * field paths and errors point at what the client actually sent.
 */
export type OutputFormatDialect = "anthropic" | "openai"

const ERROR_PATHS = {
  anthropic: {
    format: "output_config.format",
    type: "output_config.format.type",
    schema: "output_config.format.schema",
  },
  openai: {
    format: "response_format",
    type: "response_format.type",
    schema: "response_format.json_schema.schema",
  },
} as const

export function parseOutputFormat(
  outputConfig: unknown,
  tools?: unknown,
  dialect: OutputFormatDialect = "anthropic",
): OutputFormatParseResult {
  const paths = ERROR_PATHS[dialect]
  if (outputConfig === undefined) return { ok: true, value: undefined }
  if (!isRecord(outputConfig)) {
    return { ok: false, message: "output_config: Expected an object" }
  }

  const format = outputConfig.format
  if (format === undefined) return { ok: true, value: undefined }
  if (!isRecord(format)) {
    return { ok: false, message: `${paths.format}: Expected an object` }
  }
  if (format.type !== "json_schema") {
    return { ok: false, message: `${paths.type}: Only 'json_schema' is supported` }
  }
  if (!isRecord(format.schema)) {
    return { ok: false, message: `${paths.schema}: Expected a JSON Schema object` }
  }
  if (Array.isArray(tools) && tools.length > 0) {
    return { ok: false, message: `${paths.format}: Cannot be combined with tools` }
  }

  return {
    ok: true,
    value: { type: "json_schema", schema: stripRootSchemaKeyword(format.schema) },
  }
}

/**
 * Drop a root-level `$schema` before handing the schema to the SDK.
 *
 * Anything but the draft-07 URI makes the model fail to submit its structured
 * result: the request burns its turn budget and ends with no structured_output,
 * surfacing as a 500. That includes the 2020-12 URI, which zod v4's
 * `z.toJSONSchema()` emits by default - so every schema from the zod/Vercel AI
 * SDK toolchain hits it.
 *
 * The keyword only declares which dialect the schema is written in and
 * constrains nothing, so dropping it changes no validation semantics. Nested
 * occurrences are left alone: they are already tolerated, and rewriting a
 * caller's schema deeper than necessary risks touching a `properties` key
 * legitimately named `$schema`.
 */
function stripRootSchemaKeyword(schema: Record<string, unknown>): Record<string, unknown> {
  if (!("$schema" in schema)) return schema
  const { $schema: _dialect, ...rest } = schema
  return rest
}

export function structuredOutputText(value: unknown): string {
  return JSON.stringify(value)
}
