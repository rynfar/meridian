import { describe, expect, it, beforeEach } from "bun:test"
import { z } from "zod"
import { installSdkMock } from "./sdkMock"

// Same minimal SDK mock the sibling passthrough tests use: capture what would
// be registered instead of reaching the real Agent SDK.
let registeredTools: Array<{ name: string; inputSchema: Record<string, z.ZodType> }> = []
installSdkMock(() => ({
  createSdkMcpServer: (options: {
    tools?: Array<{ name: string; inputSchema: Record<string, z.ZodType> }>
  }) => {
    for (const definition of options.tools ?? []) {
      registeredTools.push({ name: definition.name, inputSchema: definition.inputSchema })
    }
    return { type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }
  },
}), "passthrough-input-coercion.test.ts")

import { createPassthroughMcpServer } from "../proxy/passthroughTools"

/** The shape of the failing live calls: omp's `browser` tool. */
const BROWSER_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["open", "close", "run"], description: "operation" },
    name: { type: "string", description: "tab id" },
    timeout: { type: "number", description: "timeout in seconds" },
    retryCount: { type: "integer", description: "number of retries" },
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
  it("preserves requiredness and validation over the real SDK MCP protocol", () => {
    // A child isolates the real SDK from the suite's process-global mocks.
    const moduleUrl = new URL("../proxy/passthroughTools.ts", import.meta.url).href
    const script = `
      import assert from "node:assert/strict";
      import { Client } from "@modelcontextprotocol/sdk/client/index.js";
      import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
      import { createPassthroughMcpServer } from ${JSON.stringify(moduleUrl)};
      const properties = {
        count: { type: "integer" }, timeout: { type: "number", description: "Seconds" },
        enabled: { type: "boolean" }, names: { type: "array", items: { type: "string" } },
        app: { type: "object", properties: { relay: { type: "boolean" } }, required: ["relay"] },
        label: { type: "string", description: "Optional label" },
      };
      const required = ["count", "timeout", "enabled", "names", "app"];
      const { server } = createPassthroughMcpServer([{ name: "test", input_schema: { type: "object", properties, required } }]);
      const client = new Client({ name: "test", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(b); await client.connect(a);
      try {
        const schema = (await client.listTools()).tools[0].inputSchema;
        assert.deepEqual(schema.required, required);
        assert.deepEqual(schema.properties.app.required, ["relay"]);
        assert.equal(schema.properties.timeout.type, "number");
        assert.equal(schema.properties.timeout.description, "Seconds");
        assert.equal(schema.properties.label.description, "Optional label");
        const args = { count: "2", timeout: "60", enabled: "true", names: '["first"]', app: '{"relay":"false"}' };
        assert(!(await client.callTool({ name: "test", arguments: args })).isError);
        assert((await client.callTool({ name: "test", arguments: { ...args, timeout: "soon" } })).isError);
        delete args.timeout;
        assert((await client.callTool({ name: "test", arguments: args })).isError);
      } finally { await client.close(); await server.instance.close(); }
    `
    const child = Bun.spawnSync({ cmd: [process.execPath, "-e", script], stdout: "pipe", stderr: "pipe" })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
  })

  it("advertises required repaired fields and nested required fields", () => {
    createPassthroughMcpServer([{ name: "required", input_schema: {
      type: "object", properties: {
        ...BROWSER_SCHEMA.properties,
        app: { ...BROWSER_SCHEMA.properties.app, required: ["relay"] },
      },
      required: Object.keys(BROWSER_SCHEMA.properties),
    } }])
    const tool = registeredTools.find(entry => entry.name === "required")
    if (!tool) throw new Error("required tool missing")
    const advertised = z.toJSONSchema(z.object(tool.inputSchema), { io: "input" })
    expect(advertised.required).toEqual(Object.keys(BROWSER_SCHEMA.properties))
    expect(advertised.properties?.app).toMatchObject({ required: ["relay"] })
  })
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

  it("repairs integer strings only when they are integral", () => {
    const schema = registerBrowser()

    const accepted = schema.safeParse({ action: "open", retryCount: "2" })
    expect(accepted.success).toBe(true)
    if (accepted.success) expect(accepted.data.retryCount).toBe(2)

    expect(schema.safeParse({ action: "open", retryCount: "1.5" }).success).toBe(false)
    expect(schema.safeParse({ action: "open", retryCount: "9007199254740993" }).success).toBe(false)
    expect(schema.safeParse({ action: "open", retryCount: "1.0000000000000001" }).success).toBe(false)
    expect(schema.safeParse({ action: "open", retryCount: "2.0" }).success).toBe(true)
    expect(schema.safeParse({ action: "open", retryCount: "2e1" }).success).toBe(true)
  })
  it("only repairs JSON numeric syntax", () => {
    const schema = registerBrowser()
    for (const value of ["0x10", "0b10", "+2", "01", "", " ", "Infinity", "NaN"]) {
      expect(schema.safeParse({ action: "open", timeout: value }).success).toBe(false)
    }
    expect(schema.safeParse({ action: "open", timeout: " 1.25e2 " }).data?.timeout).toBe(125)
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
    expect(advertised.properties.retryCount).toMatchObject({
      type: "integer",
      description: "number of retries",
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
