import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop, withMockSdkSessionId } from "./helpers"
import * as models from "../proxy/models"

type Message = { role: string; content: string | Array<Record<string, unknown>> }
type Input = { prompt: string | AsyncIterable<{ message: { content: unknown } }>; options?: { sessionId?: string; resume?: string; resumeSessionAt?: string; model?: string; mcpServers?: Record<string, unknown> } }
let calls: Array<{ payload: unknown[]; options: Input["options"] }> = []
let overrides: Array<{ mockRestore(): void }> = []
let failures: string[] = []
const lineagePaths = new WeakMap<object, string>()
const storePaths = new WeakMap<object, string>()

installSdkMock(() => ({
  query: (input: Input) => (async function* () {
    const payload: unknown[] = []
    calls.push({ payload, options: input.options })
    if (typeof input.prompt === "string") payload.push(input.prompt)
    else for await (const row of input.prompt) payload.push(row.message.content)
    const failure = failures.shift()
    if (failure) throw new Error(failure)
    for (const event of [messageStart(), textBlockStart(0), textDelta(0, "fixture answer"), blockStop(0), messageDelta(), messageStop(), assistantMessage([{ type: "text", text: "fixture answer" }])]) {
      yield withMockSdkSessionId(event, input.options)
    }
    yield withMockSdkSessionId({ type: "result", subtype: "success", is_error: false, result: "fixture answer", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] }, input.options)
  })(),
  createSdkMcpServer: (config: { name: string; tools: Array<{ name: string }> }) => ({ type: "sdk", name: config.name, instance: { declaredToolNames: config.tools.map(tool => tool.name) } }),
  tool: () => ({}),
}), "proxy-plugin-message-consumption.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { clearSharedSessions, lookupSharedSession, setSessionStoreDir } = await import("../proxy/sessionStore")
const { computeMessageHashes } = await import("../proxy/session/lineage")
const { storeSession } = await import("../proxy/session/cache")
const ownedDirectories: string[] = []

beforeEach(() => {
  calls = []
  failures = []
  clearSessionCache()
  clearSharedSessions()
  overrides = [
    spyOn(models, "getClaudeAuthStatusAsync").mockResolvedValue({ loggedIn: true, subscriptionType: "max" }),
    spyOn(models, "resolveClaudeExecutableAsync").mockResolvedValue("fixture-claude-not-executed"),
    spyOn(models, "mapModelToClaudeModel").mockReturnValue("sonnet"),
  ]
})
afterEach(() => { setSessionStoreDir(null); for (const override of overrides) override.mockRestore(); models.resetExtendedContextUnavailable() })
afterAll(() => { for (const directory of ownedDirectories) rmSync(directory, { recursive: true, force: true }) })

async function appWithPlugin() {
  const directory = mkdtempSync(join(tmpdir(), "plugin-message-consumption-"))
  ownedDirectories.push(directory)
  const storeDirectory = join(directory, "session-store")
  mkdirSync(storeDirectory)
  setSessionStoreDir(storeDirectory)
  const path = join(directory, "fixture-plugin.js")
  const witness = join(directory, "lineage.jsonl")
  writeFileSync(path, `import { appendFileSync } from "node:fs";
  export default {
    name: "fixture-message-transform",
    onRequest(ctx) {
      if (ctx.systemContext === "mutate") { ctx.messages[0].content = "MUTATED_EXECUTION_ONLY"; return ctx; }
      if (ctx.systemContext === "sparse") return { ...ctx, messages: new Array(1) };
      if (ctx.systemContext === "modify") {
        const messages = ctx.messages.filter(message =>
          typeof message.content !== "string" || !message.content.startsWith("REMOVE_FROM_EXECUTION"));
        return { ...ctx, messages: messages.map((message, index) =>
          index === messages.length - 1 && typeof message.content === "string"
            ? { ...message, content: message.content + " EXECUTION_TRANSFORM_APPLIED" }
            : message) };
      }
      return { ...ctx, messages: JSON.parse(JSON.stringify(ctx.messages)) };
    },
    onSession(ctx) { appendFileSync(${JSON.stringify(witness)}, JSON.stringify({lineage:ctx.lineage,reason:ctx.reason,incomingCount:ctx.incomingCount}) + "\\n"); }
  };`)
  const config = join(directory, "plugins.json")
  writeFileSync(config, JSON.stringify({ plugins: [{ path, enabled: true }] }))
  const server = createProxyServer({ silent: true, host: "127.0.0.1", port: 0, pluginDir: directory, pluginConfigPath: config, profiles: [{ id: "default", type: "api", apiKey: "fixture-only-no-network" }] })
  await server.initPlugins?.()
  lineagePaths.set(server.app, witness)
  storePaths.set(server.app, join(storeDirectory, "sessions.json"))
  return server.app
}

async function post(app: Awaited<ReturnType<typeof appWithPlugin>>, messages: Message[], system: string, stream: boolean, session: string, allowFailure = false, tools?: Array<{ name: string; input_schema: { type: string; properties: Record<string, unknown> } }>) {
  const before = JSON.stringify(messages)
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session": session },
    body: JSON.stringify({ model: "sonnet", stream, system, messages, ...(tools ? { tools } : {}) }),
  }))
  if (!allowFailure) expect(response.status).toBe(200)
  const output = await response.text()
  if (stream && !allowFailure) expect(output).toContain("event: message_stop")
  expect(JSON.stringify(messages)).toBe(before)
  return response
}

function lineages(app: object): Array<{ lineage: string; reason?: string; incomingCount: number }> {
  const path = lineagePaths.get(app)
  return path && existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) : []
}

function capturedText(index: number): string {
  return calls[index]!.payload.flatMap(value => typeof value === "string" ? [value] : Array.isArray(value)
    ? value.filter(block => block.type === "text").map(block => block.text) : []).join("\n")
}

describe("documented plugin message transforms at SDK ingress", () => {
  for (const stream of [false, true]) {
    it(`in-place message edits cannot mutate raw ancestry (stream=${stream})`, async () => {
      const app = await appWithPlugin()
      const raw: Message[] = [{ role: "user", content: "RAW_CLIENT_ANCESTRY" }]
      await post(app, raw, "mutate", stream, "fixture-in-place")
      expect(capturedText(0)).toContain("MUTATED_EXECUTION_ONLY")
      expect(capturedText(0)).not.toContain("RAW_CLIENT_ANCESTRY")
      expect(lookupSharedSession("fixture-in-place")?.messageHashes).toEqual(computeMessageHashes(raw))
      expect(lookupSharedSession("fixture-in-place")?.lineageHash).toBe("")
    })

    it(`rejects sparse plugin output before SDK ingress (stream=${stream})`, async () => {
      const app = await appWithPlugin()
      const response = await post(app, [{ role: "user", content: "objective" }], "sparse", stream, "fixture-invalid-history", true)
      expect(response.status).toBe(400)
      expect(calls).toHaveLength(0)
      expect(lookupSharedSession("fixture-invalid-history")).toBeUndefined()
    })

    for (const structured of [false, true]) {
      it(`consumes transformed fresh history and retains completed tools (stream=${stream}, structured=${structured})`, async () => {
        const media = { type: "image", source: { type: "base64", media_type: "image/png", data: "fixture-pixels" } }
        const call = { type: "tool_use", id: "fixture-call", name: "read", input: { path: "fixture.txt" } }
        const messages: Message[] = [
          { role: "user", content: "REMOVE_FROM_EXECUTION stale poll" },
          { role: "assistant", content: "REMOVE_FROM_EXECUTION stale acknowledgment" },
          { role: "user", content: structured ? [{ type: "text", text: "original objective" }, media] : "original objective" },
          { role: "assistant", content: [call] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, is_error: true, content: "EXACT_FIXTURE_RESULT" }] },
          { role: "user", content: "live question" },
        ]
        const app = await appWithPlugin()
        await post(app, messages, "modify", stream, "fixture-modified-fresh")
        expect(calls).toHaveLength(1)
        const text = capturedText(0)
        expect(text).not.toContain("REMOVE_FROM_EXECUTION")
        expect(text).toContain("EXECUTION_TRANSFORM_APPLIED")
        expect(text).toContain(call.id)
        expect(text).toContain(JSON.stringify(call.input))
        expect(text).toContain("EXACT_FIXTURE_RESULT")
        expect(text).toContain('"is_error":true')
        if (structured) expect(calls[0]!.payload.flat()).toContainEqual(media)
        const stored = lookupSharedSession("fixture-modified-fresh")
        expect(stored?.messageCount).toBe(messages.length)
        expect(stored?.messageHashes).toEqual(computeMessageHashes(messages))
        expect(stored?.lineageHash).toBe("")
        expect(stored?.clientLineageHash).toBeString()
      })
    }

    it(`equivalent cloned history retains ordinary resume (stream=${stream})`, async () => {
      const app = await appWithPlugin()
      const prior: Message[] = [{ role: "user", content: "initial objective" }]
      await post(app, prior, "noop", stream, "fixture-clone-resume")
      const firstId = calls[0]?.options?.sessionId
      expect(firstId).toBeString()
      await post(app, [...prior, { role: "assistant", content: "fixture answer" }, { role: "user", content: "follow-up question" }], "noop", stream, "fixture-clone-resume")
      expect(calls[1]?.options?.resume).toBe(firstId)
      expect(capturedText(1)).toContain("follow-up question")
      expect(capturedText(1)).not.toContain("initial objective")
    })

    it(`changed execution history cannot slice using raw resume offsets (stream=${stream})`, async () => {
      const app = await appWithPlugin()
      const prior: Message[] = [{ role: "user", content: "REMOVE_FROM_EXECUTION cached instruction" }]
      await post(app, prior, "noop", stream, "fixture-changed-resume")
      await post(app, [...prior, { role: "assistant", content: "fixture answer" }, { role: "user", content: "new live question" }], "modify", stream, "fixture-changed-resume")
      expect(calls[1]?.options?.resume).toBeUndefined()
      expect(capturedText(1)).toContain("EXECUTION_TRANSFORM_APPLIED")
      expect(capturedText(1)).not.toContain("REMOVE_FROM_EXECUTION")
      expect(lineages(app).at(-1)?.lineage).toBe("continuation")
    })

    it(`a transformed transcript cannot prove a later raw SDK resume (stream=${stream})`, async () => {
      const app = await appWithPlugin()
      const prior: Message[] = [{ role: "user", content: "REMOVE_FROM_EXECUTION previous poll" }, { role: "user", content: "initial objective" }]
      await post(app, prior, "modify", stream, "fixture-after-transformation")
      await post(app, [...prior, { role: "assistant", content: "fixture answer" }, { role: "user", content: "new question" }], "noop", stream, "fixture-after-transformation")
      expect(calls[1]?.options?.resume).toBeUndefined()
      expect(capturedText(1)).toContain("initial objective")
      expect(capturedText(1)).toContain("new question")
      expect(lineages(app).at(-1)?.lineage).toBe("continuation")
      const second = [...prior, { role: "assistant", content: "fixture answer" }, { role: "user", content: "new question" }]
      await post(app, [...second, { role: "assistant", content: "fixture answer" }, { role: "user", content: "third question" }], "noop", stream, "fixture-after-transformation")
      expect(calls[2]?.options?.resume).toBe(calls[1]?.options?.sessionId)
      expect(capturedText(2)).toBe("third question")
      expect(lookupSharedSession("fixture-after-transformation")?.clientLineageHash).toBeUndefined()
    })

    it(`transformed growing history remains a raw continuation (stream=${stream})`, async () => {
      const app = await appWithPlugin()
      const prior: Message[] = [{ role: "user", content: "REMOVE_FROM_EXECUTION original poll" }, { role: "user", content: "first question" }]
      await post(app, prior, "modify", stream, "fixture-raw-continuation")
      await post(app, [...prior, { role: "assistant", content: "fixture answer" }, { role: "user", content: "second question" }], "modify", stream, "fixture-raw-continuation")
      expect(lineages(app).at(-1)).toEqual({ lineage: "continuation", incomingCount: 4 })
      expect(calls[1]?.options?.resume).toBeUndefined()
      expect(capturedText(1)).not.toContain("REMOVE_FROM_EXECUTION")
      expect(capturedText(1)).toContain("first question")
      expect(capturedText(1)).toContain("second question EXECUTION_TRANSFORM_APPLIED")
    })

    for (const modify of [false, true]) {
      it(`checkpoint proof and tool pairing (stream=${stream}, modified=${modify})`, async () => {
        const app = await appWithPlugin()
        const prior: Message[] = [{ role: "user", content: "REMOVE_FROM_EXECUTION original objective" }]
        storeSession("fixture-checkpoint", prior, "fixture-sdk-checkpoint", undefined, [null, "fixture-tool-uuid"], undefined, "fixture-tool-uuid", ["fixture-tool-id"])
        const call = { type: "tool_use", id: "fixture-tool-id", name: "read", input: { path: "fixture.txt" } }
        await post(app, [...prior, { role: "assistant", content: [call] }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "EXACT_CHECKPOINT_RESULT" }] }], modify ? "modify" : "noop", stream, "fixture-checkpoint")
        if (modify) {
          expect(calls[0]?.options?.resume).toBeUndefined()
          expect(calls[0]?.options?.resumeSessionAt).toBeUndefined()
          expect(capturedText(0)).toContain(call.id)
          expect(capturedText(0)).toContain("EXACT_CHECKPOINT_RESULT")
          expect(lookupSharedSession("fixture-checkpoint")?.passthroughToolCallAssistantUuid).toBeUndefined()
        } else {
          expect(calls[0]?.options?.resume).toBe("fixture-sdk-checkpoint")
          expect(calls[0]?.options?.resumeSessionAt).toBe("fixture-tool-uuid")
          expect(JSON.stringify(calls[0]?.payload)).toContain('"tool_use_id":"fixture-tool-id"')
          expect(JSON.stringify(calls[0]?.payload)).toContain('"type":"tool_result"')
        }
      })
    }

    for (const changedNamespace of [false, true]) {
      it(`tool inheritance retains transcript namespace eligibility (stream=${stream}, namespaceChanged=${changedNamespace})`, async () => {
        const app = await appWithPlugin()
        const prior: Message[] = [{ role: "user", content: "initial objective" }]
        const key = "fixture-tool-namespace"
        await post(app, prior, "noop", stream, key, false, [{ name: "fixture_namespace_tool", input_schema: { type: "object", properties: {} } }])
        expect(JSON.stringify(calls[0]?.options?.mcpServers)).toContain("fixture_namespace_tool")
        const firstId = calls[0]?.options?.sessionId
        if (!firstId) throw new Error("fixture SDK session ID missing")
        if (changedNamespace) {
          const file = storePaths.get(app)
          if (!file) throw new Error("fixture store path missing")
          const document = JSON.parse(readFileSync(file, "utf8"))
          const changedConfigDir = join(tmpdir(), "different-fixture-transcript-config")
          document[key].currentTranscript.configDir = changedConfigDir
          writeFileSync(file, JSON.stringify(document))
          expect(lookupSharedSession(key)?.currentTranscript?.configDir).toBe(changedConfigDir)
        }
        await post(app, [...prior, { role: "assistant", content: "fixture answer" }, { role: "user", content: "next question" }], "modify", stream, key)
        expect(calls[1]?.options?.resume).toBeUndefined()
        if (changedNamespace) expect(calls[1]?.options?.mcpServers).toBeUndefined()
        else expect(JSON.stringify(calls[1]?.options?.mcpServers)).toContain("fixture_namespace_tool")
      })
    }

    it(`transformed undo cannot inherit a raw rollback UUID (stream=${stream})`, async () => {
      const app = await appWithPlugin()
      const cached: Message[] = [{ role: "user", content: "REMOVE_FROM_EXECUTION first instruction" }, { role: "assistant", content: "prior answer" }, { role: "user", content: "old question" }]
      storeSession("fixture-undo", cached, "fixture-sdk-undo", undefined, [null, "fixture-old-uuid", null])
      await post(app, [...cached.slice(0, 2), { role: "user", content: "replacement question" }], "modify", stream, "fixture-undo")
      expect(lineages(app).at(-1)?.lineage).toBe("undo")
      expect(calls[0]?.options?.resume).toBeUndefined()
      expect(calls[0]?.options?.resumeSessionAt).toBeUndefined()
      expect(capturedText(0)).not.toContain("REMOVE_FROM_EXECUTION")
      expect(capturedText(0)).toContain("replacement question EXECUTION_TRANSFORM_APPLIED")
    })

    it(`overflow retries retain the transformed replay source (stream=${stream})`, async () => {
      const app = await appWithPlugin()
      failures = ["Claude Code returned an error result: Prompt is too long"]
      const history: Message[] = [{ role: "user", content: "REMOVE_FROM_EXECUTION first poll" }, { role: "user", content: "objective" }, ...Array.from({ length: 8 }, (_, index) => [{ role: "user", content: `context ${index}` }, { role: "assistant", content: "я".repeat(60_000) }]).flat(), { role: "user", content: "live question" }]
      await post(app, history, "modify", stream, "fixture-overflow")
      expect(calls).toHaveLength(2)
      for (let index = 0; index < calls.length; index++) {
        expect(capturedText(index)).not.toContain("REMOVE_FROM_EXECUTION")
        expect(capturedText(index)).toContain("live question EXECUTION_TRANSFORM_APPLIED")
      }
    })

    it(`model fallback retains the transformed replay source (stream=${stream})`, async () => {
      overrides.push(spyOn(models, "mapModelToClaudeModel").mockReturnValue("opus[1m]"))
      const app = await appWithPlugin()
      failures = ["Extra usage required for 1m context"]
      await post(app, [{ role: "user", content: "REMOVE_FROM_EXECUTION first poll" }, { role: "user", content: "live question" }], "modify", stream, "fixture-model-fallback")
      expect(calls).toHaveLength(2)
      expect(calls[0]?.options?.model).toBe("opus[1m]")
      expect(calls[1]?.options?.model).toBe("opus")
      for (let index = 0; index < calls.length; index++) {
        expect(capturedText(index)).not.toContain("REMOVE_FROM_EXECUTION")
        expect(capturedText(index)).toContain("EXECUTION_TRANSFORM_APPLIED")
      }
    })

    it(`a simulated resume refusal cannot reintroduce omitted history (stream=${stream})`, async () => {
      const app = await appWithPlugin()
      failures = ["Missing message UUID in session"]
      storeSession("fixture-resume-refusal", [{ role: "user", content: "REMOVE_FROM_EXECUTION cached input" }], "fixture-sdk-refused")
      const response = await post(app, [{ role: "user", content: "REMOVE_FROM_EXECUTION cached input" }, { role: "assistant", content: "fixture answer" }, { role: "user", content: "new question" }], "modify", stream, "fixture-resume-refusal", true)
      if (!stream) expect(response.status).not.toBe(200)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.options?.resume).toBeUndefined()
      expect(capturedText(0)).not.toContain("REMOVE_FROM_EXECUTION")
      expect(capturedText(0)).toContain("EXECUTION_TRANSFORM_APPLIED")
    })
  }
})
