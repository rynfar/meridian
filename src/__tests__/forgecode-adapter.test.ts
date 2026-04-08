/**
 * Tests for the ForgeCode agent adapter.
 */
import { describe, it, expect } from "bun:test"
import { forgeCodeAdapter } from "../proxy/adapters/forgecode"

describe("forgeCodeAdapter — identity", () => {
  it("has name 'forgecode'", () => {
    expect(forgeCodeAdapter.name).toBe("forgecode")
  })
})

describe("forgeCodeAdapter.getSessionId", () => {
  it("always returns undefined — ForgeCode sends no session header", () => {
    const ctx = {
      req: { header: () => "any-value" },
    }
    expect(forgeCodeAdapter.getSessionId(ctx as any)).toBeUndefined()
  })

  it("returns undefined even when x-opencode-session is present", () => {
    const ctx = {
      req: {
        header: (name: string) =>
          name === "x-opencode-session" ? "sess-abc" : undefined,
      },
    }
    expect(forgeCodeAdapter.getSessionId(ctx as any)).toBeUndefined()
  })
})

describe("forgeCodeAdapter.extractWorkingDirectory", () => {
  it("extracts CWD from string system prompt with XML tag", () => {
    const body = {
      system: "<system_information>\n<current_working_directory>/Users/test/project</current_working_directory>\n</system_information>",
    }
    expect(forgeCodeAdapter.extractWorkingDirectory(body)).toBe("/Users/test/project")
  })

  it("extracts CWD from array system prompt", () => {
    const body = {
      system: [
        { type: "text", text: "<operating_system>Darwin</operating_system>" },
        { type: "text", text: "<current_working_directory>/tmp/my-repo</current_working_directory>" },
      ],
    }
    expect(forgeCodeAdapter.extractWorkingDirectory(body)).toBe("/tmp/my-repo")
  })

  it("extracts CWD case-insensitively", () => {
    const body = {
      system: "<Current_Working_Directory>/home/user/project</Current_Working_Directory>",
    }
    expect(forgeCodeAdapter.extractWorkingDirectory(body)).toBe("/home/user/project")
  })

  it("returns undefined when system prompt is missing", () => {
    expect(forgeCodeAdapter.extractWorkingDirectory({})).toBeUndefined()
  })

  it("returns undefined when system prompt has no CWD tag", () => {
    const body = {
      system: "You are a helpful assistant. No directory info here.",
    }
    expect(forgeCodeAdapter.extractWorkingDirectory(body)).toBeUndefined()
  })

  it("returns undefined for empty string system", () => {
    expect(forgeCodeAdapter.extractWorkingDirectory({ system: "" })).toBeUndefined()
  })

  it("returns undefined for empty array system", () => {
    expect(forgeCodeAdapter.extractWorkingDirectory({ system: [] })).toBeUndefined()
  })

  it("handles system array with non-text blocks", () => {
    const body = {
      system: [
        { type: "image", source: {} },
        { type: "text", text: "<current_working_directory>/opt/app</current_working_directory>" },
      ],
    }
    expect(forgeCodeAdapter.extractWorkingDirectory(body)).toBe("/opt/app")
  })

  it("trims whitespace from CWD", () => {
    const body = {
      system: "<current_working_directory>  /Users/test/project  </current_working_directory>",
    }
    expect(forgeCodeAdapter.extractWorkingDirectory(body)).toBe("/Users/test/project")
  })

  it("does not match OpenCode <env> format", () => {
    const body = {
      system: "<env>\n  Working directory: /Users/test/project\n</env>",
    }
    expect(forgeCodeAdapter.extractWorkingDirectory(body)).toBeUndefined()
  })

  it("does not match Pi plain-text format", () => {
    const body = {
      system: "Current working directory: /Users/test/project",
    }
    expect(forgeCodeAdapter.extractWorkingDirectory(body)).toBeUndefined()
  })

  it("extracts CWD from full ForgeCode system prompt", () => {
    const body = {
      system: [
        {
          type: "text",
          text: "<system_information>\n<operating_system>Darwin</operating_system>\n<current_working_directory>/Users/dev/my-project</current_working_directory>\n<default_shell>/bin/zsh</default_shell>\n<home_directory>/Users/dev</home_directory>\n</system_information>",
        },
      ],
    }
    expect(forgeCodeAdapter.extractWorkingDirectory(body)).toBe("/Users/dev/my-project")
  })
})

describe("forgeCodeAdapter.normalizeContent", () => {
  it("normalizes string content", () => {
    expect(forgeCodeAdapter.normalizeContent("hello world")).toBe("hello world")
  })

  it("normalizes array of text blocks", () => {
    const content = [
      { type: "text", text: "First block" },
      { type: "text", text: "Second block" },
    ]
    const result = forgeCodeAdapter.normalizeContent(content)
    expect(result).toContain("First block")
    expect(result).toContain("Second block")
  })

  it("normalizes tool_use blocks", () => {
    const content = [
      { type: "tool_use", id: "tu_1", name: "shell", input: { command: "ls" } },
    ]
    const result = forgeCodeAdapter.normalizeContent(content)
    expect(result).toContain("tool_use")
    expect(result).toContain("shell")
  })

  it("handles null content", () => {
    expect(forgeCodeAdapter.normalizeContent(null as any)).toBe("null")
  })
})

describe("forgeCodeAdapter tool configuration", () => {
  it("getBlockedBuiltinTools includes SDK PascalCase tool names", () => {
    const blocked = forgeCodeAdapter.getBlockedBuiltinTools()
    expect(blocked).toContain("Read")
    expect(blocked).toContain("Write")
    expect(blocked).toContain("Edit")
    expect(blocked).toContain("Bash")
    expect(blocked).toContain("Glob")
    expect(blocked).toContain("Grep")
  })

  it("getBlockedBuiltinTools does NOT include ForgeCode's tool names", () => {
    const blocked = forgeCodeAdapter.getBlockedBuiltinTools()
    expect(blocked).not.toContain("shell")
    expect(blocked).not.toContain("patch")
    expect(blocked).not.toContain("write")
    expect(blocked).not.toContain("read")
    expect(blocked).not.toContain("fs_search")
  })

  it("getAgentIncompatibleTools includes Claude-Code-only tools", () => {
    const incompatible = forgeCodeAdapter.getAgentIncompatibleTools()
    expect(incompatible).toContain("EnterPlanMode")
    expect(incompatible).toContain("ExitPlanMode")
    expect(incompatible).not.toContain("ToolSearch")
    expect(incompatible).toContain("CronCreate")
    expect(incompatible).toContain("EnterWorktree")
  })

  it("getMcpServerName returns 'forgecode'", () => {
    expect(forgeCodeAdapter.getMcpServerName()).toBe("forgecode")
  })

  it("getAllowedMcpTools returns exactly 6 tools", () => {
    expect(forgeCodeAdapter.getAllowedMcpTools()).toHaveLength(6)
  })

  it("getAllowedMcpTools all have mcp__forgecode__ prefix", () => {
    for (const tool of forgeCodeAdapter.getAllowedMcpTools()) {
      expect(tool).toStartWith("mcp__forgecode__")
    }
  })

  it("getAllowedMcpTools covers the standard set", () => {
    const tools = forgeCodeAdapter.getAllowedMcpTools()
    expect(tools).toContain("mcp__forgecode__read")
    expect(tools).toContain("mcp__forgecode__write")
    expect(tools).toContain("mcp__forgecode__edit")
    expect(tools).toContain("mcp__forgecode__bash")
    expect(tools).toContain("mcp__forgecode__glob")
    expect(tools).toContain("mcp__forgecode__grep")
  })
})

describe("forgeCodeAdapter.buildSdkAgents", () => {
  it("always returns empty object", () => {
    expect(forgeCodeAdapter.buildSdkAgents!({}, [])).toEqual({})
  })
})

describe("forgeCodeAdapter.buildSdkHooks", () => {
  it("always returns undefined", () => {
    expect(forgeCodeAdapter.buildSdkHooks!({}, {})).toBeUndefined()
  })
})

describe("forgeCodeAdapter.buildSystemContextAddendum", () => {
  it("always returns empty string", () => {
    expect(forgeCodeAdapter.buildSystemContextAddendum!({}, {})).toBe("")
  })
})

describe("forgeCodeAdapter.usesPassthrough", () => {
  it("is not defined — defers to CLAUDE_PROXY_PASSTHROUGH env var", () => {
    expect(forgeCodeAdapter.usesPassthrough).toBeUndefined()
  })
})

describe("forgeCodeAdapter.extractFileChangesFromToolUse", () => {
  it("detects write with file_path", () => {
    const changes = forgeCodeAdapter.extractFileChangesFromToolUse!("write", { file_path: "/tmp/test.ts", content: "hello" })
    expect(changes).toEqual([{ operation: "wrote", path: "/tmp/test.ts" }])
  })

  it("detects write with filePath fallback", () => {
    const changes = forgeCodeAdapter.extractFileChangesFromToolUse!("write", { filePath: "/tmp/test.ts" })
    expect(changes).toEqual([{ operation: "wrote", path: "/tmp/test.ts" }])
  })

  it("detects write with path fallback", () => {
    const changes = forgeCodeAdapter.extractFileChangesFromToolUse!("write", { path: "/tmp/test.ts" })
    expect(changes).toEqual([{ operation: "wrote", path: "/tmp/test.ts" }])
  })

  it("detects patch with file_path", () => {
    const changes = forgeCodeAdapter.extractFileChangesFromToolUse!("patch", { file_path: "/tmp/test.ts", old_string: "foo", new_string: "bar" })
    expect(changes).toEqual([{ operation: "edited", path: "/tmp/test.ts" }])
  })

  it("detects multi_patch with file_path", () => {
    const changes = forgeCodeAdapter.extractFileChangesFromToolUse!("multi_patch", { file_path: "/tmp/test.ts" })
    expect(changes).toEqual([{ operation: "edited", path: "/tmp/test.ts" }])
  })

  it("detects shell commands with output redirects", () => {
    const changes = forgeCodeAdapter.extractFileChangesFromToolUse!("shell", { command: "echo hello > /tmp/out.txt" })
    expect(changes.length).toBeGreaterThan(0)
    expect(changes[0]!.path).toBe("/tmp/out.txt")
  })

  it("returns empty for read tool", () => {
    expect(forgeCodeAdapter.extractFileChangesFromToolUse!("read", { file_path: "/tmp/test.ts" })).toEqual([])
  })

  it("returns empty for fs_search tool", () => {
    expect(forgeCodeAdapter.extractFileChangesFromToolUse!("fs_search", { pattern: "TODO" })).toEqual([])
  })

  it("returns empty for write with no path", () => {
    expect(forgeCodeAdapter.extractFileChangesFromToolUse!("write", { content: "hello" })).toEqual([])
  })

  it("returns empty for shell with no command", () => {
    expect(forgeCodeAdapter.extractFileChangesFromToolUse!("shell", {})).toEqual([])
  })

  it("returns empty for null input", () => {
    expect(forgeCodeAdapter.extractFileChangesFromToolUse!("write", null)).toEqual([])
  })

  it("returns empty for unknown tool", () => {
    expect(forgeCodeAdapter.extractFileChangesFromToolUse!("fetch", { url: "https://example.com" })).toEqual([])
  })
})
