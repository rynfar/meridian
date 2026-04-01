/**
 * Tests for tool configuration constants.
 * Guards against accidental changes to tool blocking lists.
 */
import { describe, it, expect } from "bun:test"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../proxy/tools"
import { openCodeAdapter } from "../proxy/adapters/opencode"

describe("tool configuration", () => {
  it("BLOCKED_BUILTIN_TOOLS contains expected core tools", () => {
    expect(BLOCKED_BUILTIN_TOOLS).toContain("Read")
    expect(BLOCKED_BUILTIN_TOOLS).toContain("Write")
    expect(BLOCKED_BUILTIN_TOOLS).toContain("Edit")
    expect(BLOCKED_BUILTIN_TOOLS).toContain("Bash")
    expect(BLOCKED_BUILTIN_TOOLS).toContain("Glob")
    expect(BLOCKED_BUILTIN_TOOLS).toContain("Grep")
  })

  it("CLAUDE_CODE_ONLY_TOOLS contains schema-incompatible tools", () => {
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("TodoWrite")
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("AskUserQuestion")
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("Agent")
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("WebSearch")
  })

  it("CLAUDE_CODE_ONLY_TOOLS contains SDK-only tools", () => {
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("ToolSearch")
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("EnterPlanMode")
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("EnterWorktree")
  })

  it("OpenCode adapter MCP server name is opencode", () => {
    expect(openCodeAdapter.getMcpServerName()).toBe("opencode")
  })

  it("OpenCode adapter MCP tools use correct prefix", () => {
    const mcpTools = openCodeAdapter.getAllowedMcpTools()
    for (const tool of mcpTools) {
      expect(tool).toStartWith(`mcp__${openCodeAdapter.getMcpServerName()}__`)
    }
  })

  it("OpenCode adapter MCP tools contains all 6 MCP tools", () => {
    const mcpTools = openCodeAdapter.getAllowedMcpTools()
    expect(mcpTools).toHaveLength(6)
    expect(mcpTools).toContain("mcp__opencode__read")
    expect(mcpTools).toContain("mcp__opencode__write")
    expect(mcpTools).toContain("mcp__opencode__edit")
    expect(mcpTools).toContain("mcp__opencode__bash")
    expect(mcpTools).toContain("mcp__opencode__glob")
    expect(mcpTools).toContain("mcp__opencode__grep")
  })
})
