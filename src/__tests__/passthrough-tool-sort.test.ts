import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test"

import { installSdkMock } from "./sdkMock"
// Provide a minimal SDK mock so createPassthroughMcpServer can register tools
// without hitting the real SDK (which may not be available in CI or may have
// been mocked differently by a sibling test file).
let registeredTools: Array<{ name: string; config: any }> = []
installSdkMock(() => ({
  createSdkMcpServer: (options: {
    tools?: Array<{
      name: string
      description: string
      inputSchema: unknown
      _meta?: Record<string, unknown>
    }>
  }) => {
    for (const definition of options.tools ?? []) {
      registeredTools.push({
        name: definition.name,
        config: {
          description: definition.description,
          inputSchema: definition.inputSchema,
          _meta: definition._meta,
        },
      })
    }
    return {
      type: "sdk",
      name: "test",
      instance: { tool: () => {}, registerTool: () => ({}) },
    }
  },
}), "passthrough-tool-sort.test.ts")

import { createPassthroughMcpServer, getAutoDeferThreshold } from "../proxy/passthroughTools"

// Generate N tools for threshold testing
function makeTools(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${String(i).padStart(2, "0")}`,
    description: `Tool ${i}`,
  }))
}

const CORE_TOOLS = ["read", "write", "edit", "bash", "glob", "grep"]

let savedThreshold: string | undefined

beforeEach(() => {
  registeredTools = []
  savedThreshold = process.env.MERIDIAN_DEFER_TOOL_THRESHOLD
  delete process.env.MERIDIAN_DEFER_TOOL_THRESHOLD
})

afterEach(() => {
  if (savedThreshold !== undefined) process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = savedThreshold
  else delete process.env.MERIDIAN_DEFER_TOOL_THRESHOLD
})

describe("createPassthroughMcpServer tool ordering", () => {
  it("produces the same toolNames regardless of input order", () => {
    const toolsA = [
      { name: "write", description: "Write a file" },
      { name: "bash", description: "Run a command" },
      { name: "read", description: "Read a file" },
    ]
    const toolsB = [
      { name: "read", description: "Read a file" },
      { name: "write", description: "Write a file" },
      { name: "bash", description: "Run a command" },
    ]

    const resultA = createPassthroughMcpServer(toolsA)
    const resultB = createPassthroughMcpServer(toolsB)

    expect(resultA.toolNames).toEqual(resultB.toolNames)
    expect(resultA.toolNames).toEqual([
      "mcp__oc__bash",
      "mcp__oc__read",
      "mcp__oc__write",
    ])
  })

  it("returns hasDeferredTools=true when any tool has defer_loading", () => {
    const tools = [
      { name: "read", description: "Read a file" },
      { name: "custom", description: "Custom tool", defer_loading: true },
    ]
    const result = createPassthroughMcpServer(tools)
    expect(result.hasDeferredTools).toBe(true)
  })

  it("returns hasDeferredTools=false when no tools have defer_loading", () => {
    const tools = [
      { name: "read", description: "Read a file" },
      { name: "write", description: "Write a file" },
    ]
    const result = createPassthroughMcpServer(tools)
    expect(result.hasDeferredTools).toBe(false)
  })
})

describe("auto-defer: threshold-based tool deferral", () => {
  it("does not auto-defer when tool count is at or below threshold", () => {
    const tools = makeTools(15) // exactly at default threshold
    const result = createPassthroughMcpServer(tools, CORE_TOOLS)
    expect(result.hasDeferredTools).toBe(false)
    // No tool should have alwaysLoad
    for (const t of registeredTools) {
      expect(t.config._meta).toBeUndefined()
    }
  })

  it("auto-defers non-core tools when count exceeds threshold", () => {
    // 16 generic tools + 6 core tools = 22 total, above threshold of 15
    const tools = [
      ...CORE_TOOLS.map(name => ({ name, description: `${name} tool` })),
      ...makeTools(16),
    ]
    const result = createPassthroughMcpServer(tools, CORE_TOOLS)
    expect(result.hasDeferredTools).toBe(true)

    // Core tools should have alwaysLoad
    for (const name of CORE_TOOLS) {
      const reg = registeredTools.find(t => t.name === name)
      expect(reg).toBeDefined()
      expect(reg!.config._meta?.["anthropic/alwaysLoad"]).toBe(true)
    }

    // Non-core tools should NOT have alwaysLoad
    for (const reg of registeredTools) {
      if (CORE_TOOLS.includes(reg.name)) continue
      expect(reg.config._meta?.["anthropic/alwaysLoad"]).toBeUndefined()
    }
  })

  it("does not auto-defer when coreToolNames is not provided", () => {
    const tools = makeTools(20) // above threshold
    const result = createPassthroughMcpServer(tools) // no coreToolNames
    expect(result.hasDeferredTools).toBe(false)
  })

  it("respects MERIDIAN_DEFER_TOOL_THRESHOLD env var", () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "5"
    const tools = [
      ...CORE_TOOLS.slice(0, 3).map(name => ({ name, description: `${name} tool` })),
      ...makeTools(4),
    ]
    // 7 tools > threshold of 5
    const result = createPassthroughMcpServer(tools, CORE_TOOLS)
    expect(result.hasDeferredTools).toBe(true)
  })

  it("disables auto-defer when threshold is 0", () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "0"
    const tools = makeTools(100) // huge number
    const result = createPassthroughMcpServer(tools, CORE_TOOLS)
    expect(result.hasDeferredTools).toBe(false)
  })

  it("core tool matching is case-insensitive", () => {
    const tools = [
      { name: "Read", description: "Read a file" },
      { name: "WRITE", description: "Write a file" },
      ...makeTools(20),
    ]
    createPassthroughMcpServer(tools, CORE_TOOLS)

    const readReg = registeredTools.find(t => t.name === "Read")
    const writeReg = registeredTools.find(t => t.name === "WRITE")
    expect(readReg!.config._meta?.["anthropic/alwaysLoad"]).toBe(true)
    expect(writeReg!.config._meta?.["anthropic/alwaysLoad"]).toBe(true)
  })

  it("client defer_loading=true overrides auto-defer alwaysLoad", () => {
    const tools = [
      { name: "read", description: "Read", defer_loading: true }, // explicitly deferred even though core
      ...makeTools(20),
    ]
    const result = createPassthroughMcpServer(tools, CORE_TOOLS)
    expect(result.hasDeferredTools).toBe(true)

    const readReg = registeredTools.find(t => t.name === "read")
    // defer_loading=true should override core status — NOT alwaysLoad
    expect(readReg!.config._meta?.["anthropic/alwaysLoad"]).toBeUndefined()
  })
})

describe("getAutoDeferThreshold", () => {
  it("returns default 15 when env var not set", () => {
    expect(getAutoDeferThreshold()).toBe(15)
  })

  it("returns env var value when set", () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "25"
    expect(getAutoDeferThreshold()).toBe(25)
  })

  it("returns 0 when set to 0 (disable)", () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "0"
    expect(getAutoDeferThreshold()).toBe(0)
  })

  it("returns default for invalid values", () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "abc"
    expect(getAutoDeferThreshold()).toBe(15)
  })
})
