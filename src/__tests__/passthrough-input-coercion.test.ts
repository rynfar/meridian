import { describe, expect, it, mock, beforeEach } from "bun:test"
import { z } from "zod"

// Same minimal SDK mock the sibling passthrough tests use: capture what would
// be registered instead of reaching the real Agent SDK.
let registeredTools: Array<{ name: string; inputSchema: Record<string, z.ZodType> }> = []
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (options: {
    tools?: Array<{ name: string; inputSchema: Record<string, z.ZodType> }>
  }) => {
    for (const definition of options.tools ?? []) {
      registeredTools.push({ name: definition.name, inputSchema: definition.inputSchema })
    }
    return { type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }
  },
}))

import { createPassthroughMcpServer } from "../proxy/passthroughTools"

/** The shape of the failing live calls: omp's `browser` tool. */
const BROWSER_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["open", "close", "run"], description: "operation" },
    name: { type: "string", description: "tab id" },
    timeout: { type: "number", description: "timeout in seconds" },
    all: { type: "boolean", description: "release every managed tab" },
    app: {
      type: "object",
      description: "browser app options",
      properties: { cdp_url: { type: "string" }, relay: { type: "boolean" } },
    },
    args: { type: "array", items: { type: "string" }, description: "extra cli args" },
  },
  required: ["action"],
}

function registerBrowser() {
  createPassthroughMcpServer([
    { name: "browser", description: "Drives a real Chromium tab", input_schema: BROWSER_SCHEMA },
  ])
  const tool = registeredTools.find(entry => entry.name === "browser")
  if (!tool) throw new Error("browser tool was not registered")
  return z.object(tool.inputSchema)
}

beforeEach(() => {
  registeredTools = []
})

describe("passthrough tool input coercion", () => {
  it("accepts the stringified arguments that made the SDK refuse the call", () => {
    const schema = registerBrowser()

    // Exactly the payload measured on the failing turns: every value a string.
    const result = schema.safeParse({
      action: "open",
      timeout: "60",
      all: "true",
      app: '{"cdp_url":"http://127.0.0.1:39113"}',
      args: '["--headless"]',
    })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      action: "open",
      timeout: 60,
      all: true,
      app: { cdp_url: "http://127.0.0.1:39113" },
      args: ["--headless"],
    })
  })

  it("still advertises the client's declared types and descriptions", () => {
    const schema = registerBrowser()

    // The repair must be invisible to the model: widening the advertised type
    // would trade one failure mode for worse arguments on every call.
    const advertised = z.toJSONSchema(schema, { io: "input" }) as {
      properties: Record<string, { type?: string; description?: string }>
      required?: string[]
    }

    expect(advertised.properties.timeout).toMatchObject({
      type: "number",
      description: "timeout in seconds",
    })
    expect(advertised.properties.all).toMatchObject({ type: "boolean" })
    expect(advertised.properties.app).toMatchObject({
      type: "object",
      description: "browser app options",
    })
    expect(advertised.properties.args).toMatchObject({ type: "array" })
    expect(advertised.required).toEqual(["action"])
  })

  it("leaves declared strings alone, JSON-looking or not", () => {
    const schema = registerBrowser()

    // A `string` parameter that happens to hold JSON is legitimate input, not
    // a slip; parsing it would corrupt the call.
    const result = schema.safeParse({ action: "open", name: '{"not":"parsed"}' })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ action: "open", name: '{"not":"parsed"}' })
  })

  it("still rejects a value no repair can make valid", () => {
    const schema = registerBrowser()

    expect(schema.safeParse({ action: "open", timeout: "soon" }).success).toBe(false)
    expect(schema.safeParse({ action: "open", app: "not json" }).success).toBe(false)
    expect(schema.safeParse({ action: "open", args: '{"cdp_url":"x"}' }).success).toBe(false)
    expect(schema.safeParse({ timeout: "60" }).success).toBe(false)
  })
})
