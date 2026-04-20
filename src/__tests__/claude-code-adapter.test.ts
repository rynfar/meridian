/**
 * Tests for the Claude Code CLI adapter.
 *
 * Claude Code's request shape differs from the other adapters in two ways
 * that this adapter handles:
 *  - It usually runs on a different host than the proxy, so its local CWD
 *    must not be used as the SDK subprocess cwd.
 *  - It embeds working-directory info as `Primary working directory: …`
 *    inside a `# Environment` section rather than the `<env>…</env>` block
 *    OpenCode uses.
 */
import { describe, it, expect } from "bun:test"
import { claudeCodeAdapter } from "../proxy/adapters/claudecode"

describe("claudeCodeAdapter — identity", () => {
  it("has name 'claude-code'", () => {
    expect(claudeCodeAdapter.name).toBe("claude-code")
  })
})

describe("claudeCodeAdapter.getSessionId", () => {
  it("always returns undefined — Claude Code sends no session header", () => {
    const ctx = {
      req: { header: () => "any-value" },
    }
    expect(claudeCodeAdapter.getSessionId(ctx as any)).toBeUndefined()
  })

  it("returns undefined even when x-opencode-session is present", () => {
    const ctx = {
      req: {
        header: (name: string) =>
          name === "x-opencode-session" ? "sess-abc" : undefined,
      },
    }
    expect(claudeCodeAdapter.getSessionId(ctx as any)).toBeUndefined()
  })
})

describe("claudeCodeAdapter.extractWorkingDirectory", () => {
  it("always returns undefined so the SDK falls back to a valid host path", () => {
    expect(
      claudeCodeAdapter.extractWorkingDirectory({
        system:
          "# Environment\n - Primary working directory: /Users/alice/projects/app",
      })
    ).toBeUndefined()
  })

  it("returns undefined for array system prompts too", () => {
    expect(
      claudeCodeAdapter.extractWorkingDirectory({
        system: [
          { type: "text", text: "# Environment" },
          { type: "text", text: " - Primary working directory: /tmp/demo" },
        ],
      })
    ).toBeUndefined()
  })

  it("returns undefined when no system prompt is present", () => {
    expect(claudeCodeAdapter.extractWorkingDirectory({})).toBeUndefined()
  })
})

describe("claudeCodeAdapter.extractClientWorkingDirectory", () => {
  it("extracts CWD from a string system prompt", () => {
    const body = {
      system:
        "# Environment\nYou have been invoked in the following environment:\n - Primary working directory: /Users/alice/projects/app\n - Is directory a git repo: Yes",
    }
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!(body)
    ).toBe("/Users/alice/projects/app")
  })

  it("extracts CWD from an array system prompt", () => {
    const body = {
      system: [
        { type: "text", text: "# Environment" },
        { type: "text", text: " - Primary working directory: /tmp/my-repo" },
        { type: "text", text: " - Platform: linux" },
      ],
    }
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!(body)
    ).toBe("/tmp/my-repo")
  })

  it("is case-insensitive on the 'Primary working directory:' label", () => {
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!({
        system: "primary working directory: /home/user/project",
      })
    ).toBe("/home/user/project")
  })

  it("trims trailing whitespace from the captured path", () => {
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!({
        system: "Primary working directory:    /path/with/padding   \n",
      })
    ).toBe("/path/with/padding")
  })

  it("returns undefined when the system prompt is missing", () => {
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!({})
    ).toBeUndefined()
  })

  it("returns undefined when the label is absent", () => {
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!({
        system: "You are a helpful assistant. No working directory line.",
      })
    ).toBeUndefined()
  })

  it("returns undefined for empty string system prompt", () => {
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!({ system: "" })
    ).toBeUndefined()
  })

  it("returns undefined for empty array system prompt", () => {
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!({ system: [] })
    ).toBeUndefined()
  })

  it("handles a system array with non-text blocks", () => {
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!({
        system: [
          { type: "image", source: {} },
          { type: "text", text: " - Primary working directory: /opt/app" },
        ],
      })
    ).toBe("/opt/app")
  })

  it("returns the first match when multiple Primary working directory lines exist", () => {
    const body = {
      system:
        "Primary working directory: /first\nsome other text\nPrimary working directory: /second",
    }
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!(body)
    ).toBe("/first")
  })
})

describe("claudeCodeAdapter — basic configuration surface", () => {
  it("exposes MCP config like the other passthrough-capable adapters", () => {
    expect(typeof claudeCodeAdapter.getMcpServerName()).toBe("string")
    expect(Array.isArray(claudeCodeAdapter.getAllowedMcpTools())).toBe(true)
    expect(Array.isArray(claudeCodeAdapter.getBlockedBuiltinTools())).toBe(true)
    expect(Array.isArray(claudeCodeAdapter.getAgentIncompatibleTools())).toBe(true)
  })

  it("lists Claude Code's PascalCase core tools so they're not deferred", () => {
    const core = claudeCodeAdapter.getCoreToolNames!()
    expect(core).toContain("Read")
    expect(core).toContain("Write")
    expect(core).toContain("Edit")
    expect(core).toContain("Bash")
  })

  it("defaults to passthrough mode and honors the disable flags", () => {
    const original = process.env.MERIDIAN_PASSTHROUGH
    try {
      delete process.env.MERIDIAN_PASSTHROUGH
      expect(claudeCodeAdapter.usesPassthrough!()).toBe(true)

      process.env.MERIDIAN_PASSTHROUGH = "0"
      expect(claudeCodeAdapter.usesPassthrough!()).toBe(false)

      process.env.MERIDIAN_PASSTHROUGH = "false"
      expect(claudeCodeAdapter.usesPassthrough!()).toBe(false)
    } finally {
      if (original === undefined) {
        delete process.env.MERIDIAN_PASSTHROUGH
      } else {
        process.env.MERIDIAN_PASSTHROUGH = original
      }
    }
  })

  it("skips meridian's synthetic file-change tracker (Claude Code shows its own edits)", () => {
    expect(claudeCodeAdapter.shouldTrackFileChanges!()).toBe(false)
  })
})

describe("claudeCodeAdapter.extractFileChangesFromToolUse", () => {
  it("flags Write tool uses as 'wrote'", () => {
    const result = claudeCodeAdapter.extractFileChangesFromToolUse!("Write", {
      file_path: "/tmp/a.txt",
      content: "hi",
    })
    expect(result).toEqual([{ operation: "wrote", path: "/tmp/a.txt" }])
  })

  it("flags Edit and MultiEdit tool uses as 'edited'", () => {
    expect(
      claudeCodeAdapter.extractFileChangesFromToolUse!("Edit", {
        file_path: "/tmp/b.ts",
      })
    ).toEqual([{ operation: "edited", path: "/tmp/b.ts" }])

    expect(
      claudeCodeAdapter.extractFileChangesFromToolUse!("MultiEdit", {
        file_path: "/tmp/c.ts",
      })
    ).toEqual([{ operation: "edited", path: "/tmp/c.ts" }])
  })

  it("parses redirect writes from Bash commands", () => {
    const changes = claudeCodeAdapter.extractFileChangesFromToolUse!("Bash", {
      command: "echo hello > /tmp/out.txt",
    })
    expect(changes.length).toBeGreaterThan(0)
    expect(changes[0]!.path).toBe("/tmp/out.txt")
  })

  it("returns an empty array for tools it doesn't track", () => {
    expect(
      claudeCodeAdapter.extractFileChangesFromToolUse!("Grep", {
        pattern: "foo",
      })
    ).toEqual([])
  })
})
