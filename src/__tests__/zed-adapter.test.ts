/**
 * Zed adapter — identity, working directories and tool configuration.
 *
 * Zed reaches Meridian over /v1/chat/completions, keys its sessions by the
 * thread id it sends as prompt_cache_key, executes every tool itself and
 * ships its own system prompt. The SDK subprocess runs in Meridian's neutral
 * directory, never in process.cwd().
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { existsSync } from "node:fs"
import type { Context } from "hono"
import {
  extractZedRootDirectory,
  extractZedSessionId,
  extractZedSystemText,
  isZedUserAgent,
  normalizeZedSessionId,
  zedAdapter,
  ZED_SESSION_HEADER,
} from "../proxy/adapters/zed"
import { neutralWorkingDirectory } from "../proxy/cwd"
import { createRequestContext, runTransformHook } from "../proxy/transform"
import { getAdapterTransforms } from "../proxy/transforms/registry"

function makeContext(headers: Record<string, string>): Context {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  )
  return {
    req: {
      header: (name?: string) => name
        ? normalized[name.toLowerCase()]
        : { ...normalized },
    },
  } as unknown as Context
}

const AGENT_SYSTEM = "You are the Zed agent.\n\nThe current project contains the following root directories:\n\n- `C:\\workspaces\\project`"

describe("Zed adapter — identity", () => {
  it("recognises Zed's User-Agent prefix only", () => {
    expect(isZedUserAgent("Zed/1.25.3 (windows; x86_64)")).toBe(true)
    expect(isZedUserAgent("Zedd/1.0")).toBe(false)
    expect(isZedUserAgent(undefined)).toBe(false)
  })

  it("accepts only bounded wire-safe thread ids", () => {
    expect(normalizeZedSessionId("thread-8c7c0fce-9eba-43c4-b883-49534fa4bd2e")).toBe("thread-8c7c0fce-9eba-43c4-b883-49534fa4bd2e")
    expect(normalizeZedSessionId(" t:1 ")).toBe("t:1")
    expect(normalizeZedSessionId("bad id")).toBeUndefined()
    expect(normalizeZedSessionId("a".repeat(257))).toBeUndefined()
    expect(normalizeZedSessionId(42)).toBeUndefined()
    expect(normalizeZedSessionId(undefined)).toBeUndefined()
  })

  it("reads the thread id from prompt_cache_key on the OpenAI body", () => {
    expect(extractZedSessionId({ prompt_cache_key: "thread-1", messages: [] })).toBe("thread-1")
    expect(extractZedSessionId({ messages: [] })).toBeUndefined()
    expect(extractZedSessionId(null)).toBeUndefined()
  })

  it("uses the forwarded header first, then the body", () => {
    expect(zedAdapter.getSessionId(makeContext({ [ZED_SESSION_HEADER]: "thread-1" }), { prompt_cache_key: "thread-2" })).toBe("thread-1")
    expect(zedAdapter.getSessionId(makeContext({}), { prompt_cache_key: "thread-2" })).toBe("thread-2")
    expect(zedAdapter.getSessionId(makeContext({ [ZED_SESSION_HEADER]: "bad id" }), {})).toBeUndefined()
  })

  it("marks a request without the agent system prompt (title/summary one-shot) as auxiliary", () => {
    expect(zedAdapter.isAuxiliaryRequest!(makeContext({}), { messages: [] })).toBe(true)
    expect(zedAdapter.isAuxiliaryRequest!(makeContext({}), { system: "" })).toBe(true)
    expect(zedAdapter.isAuxiliaryRequest!(makeContext({}), { system: AGENT_SYSTEM })).toBe(false)
    expect(zedAdapter.isAuxiliaryRequest!(makeContext({}), { system: [{ type: "text", text: AGENT_SYSTEM }] })).toBe(false)
  })
})

describe("Zed adapter — working directories", () => {
  it("runs the SDK in Meridian's neutral directory, never in process.cwd()", () => {
    const dir = zedAdapter.extractWorkingDirectory({ system: AGENT_SYSTEM })
    expect(dir).toBe(neutralWorkingDirectory())
    expect(existsSync(dir!)).toBe(true)
    expect(dir).not.toBe(process.cwd())
  })

  it("reports the first root directory Zed lists as the client's path", () => {
    expect(extractZedRootDirectory({ system: AGENT_SYSTEM })).toBe("C:\\workspaces\\project")
    expect(extractZedRootDirectory({ system: [{ type: "text", text: "root directories:\n\n- `/first`\n- `/second`" }] })).toBe("/first")
    expect(extractZedRootDirectory({ system: "no roots here" })).toBeUndefined()
    expect(extractZedRootDirectory({})).toBeUndefined()
    expect(zedAdapter.extractClientWorkingDirectory!({ system: AGENT_SYSTEM })).toBe("C:\\workspaces\\project")
  })

  it("flattens string and block system prompts", () => {
    expect(extractZedSystemText({ system: "a" })).toBe("a")
    expect(extractZedSystemText({ system: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })).toBe("a\nb")
    expect(extractZedSystemText({})).toBe("")
  })
})

describe("Zed adapter — tool configuration", () => {
  let savedPassthrough: string | undefined
  beforeEach(() => {
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    delete process.env.MERIDIAN_PASSTHROUGH
  })
  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("is passthrough by default and loads nothing from the host", () => {
    expect(zedAdapter.name).toBe("zed")
    expect(zedAdapter.usesPassthrough!()).toBe(true)
    expect(zedAdapter.getSettingSources!()).toHaveLength(0)
    expect(zedAdapter.supportsThinking!()).toBe(true)
    // Zed's panel shows every edit as a tool card; no synthetic "Files changed:" block.
    expect(zedAdapter.shouldTrackFileChanges!()).toBe(false)
  })

  it("keeps OpenCode's tool pipeline but un-defers the catalog and leaves the file-change summary off", () => {
    const ctx = runTransformHook(getAdapterTransforms("zed"), "onRequest", createRequestContext({
      adapter: "zed",
      body: { tools: [] },
      headers: new Headers(),
      model: "opus",
      messages: [],
      stream: true,
      workingDirectory: neutralWorkingDirectory(),
    }), "zed")
    expect(ctx.passthrough).toBe(true)
    expect(ctx.coreToolNames).toBeUndefined()
    expect(ctx.settingSources).toHaveLength(0)
    expect(ctx.shouldTrackFileChanges).toBe(false)
    expect(ctx.supportsThinking).toBe(true)
    expect(ctx.extractFileChangesFromToolUse).toBeUndefined()
  })
})
