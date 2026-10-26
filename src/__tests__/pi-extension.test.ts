/**
 * Tests for the Meridian Pi extension (plugin/pi): request identity, the
 * human-turn attestation, how the Pi adapter reads both, provider registration
 * and catalog refresh, and the headers that actually reach the wire through
 * Pi's built-in Anthropic implementation.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { Model, ModelsPublication, ModelsStoreEntry, RefreshModelsContext, SimpleStreamOptions, SystemMessage } from "@earendil-works/pi-ai"
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript"
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent"
import meridian from "../../plugin/pi/index"
import { catalogStoreEntry, type MeridianModelConfig } from "../../plugin/pi/catalog"
import {
  childSourceFromEnvironment,
  requestOptions,
  type HumanTurnSession,
  type RequestState,
} from "../../plugin/pi/headers"
import { computePriorityTurnDigest } from "../../plugin/priority-attestation"
import { PRIORITY_ATTESTATION_HEADER, verifyPriorityAttestation } from "../proxy/priorityAttestation"
import { piAdapter } from "../proxy/adapters/pi"
import { buildModelList } from "../proxy/openai"

const KEY = Buffer.alloc(32, 0x5a)
const SESSION = "019a0000-0000-7000-8000-000000000001"
const NOW_SECONDS = Math.floor(Date.now() / 1000)

function rootSession(overrides: Partial<HumanTurnSession> = {}): HumanTurnSession {
  return {
    getSessionId: () => SESSION,
    getHeader: () => ({}),
    getBranch: () => [
      { type: "message", id: "a1b2c3d4", message: { role: "user", timestamp: (NOW_SECONDS - 30) * 1000 } },
      { type: "message", id: "b2c3d4e5", message: { role: "assistant", timestamp: (NOW_SECONDS - 20) * 1000 } },
      { type: "message", id: "c3d4e5f6", message: { role: "user", timestamp: NOW_SECONDS * 1000 } },
      { type: "message", id: "d4e5f6a7", message: { role: "assistant", timestamp: NOW_SECONDS * 1000 } },
      { type: "message", id: "e5f6a7b8", message: { role: "toolResult", timestamp: NOW_SECONDS * 1000 } },
    ],
    ...overrides,
  }
}

const EMPTY_CONTEXT = normalizeContext({ messages: [] })

function shape(
  options: SimpleStreamOptions | undefined,
  state: RequestState = { session: rootSession() },
  context = EMPTY_CONTEXT,
): Record<string, string | null> {
  return requestOptions(context, options, state, KEY).headers ?? {}
}

function sent(headers: Record<string, string | null>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) if (value !== null) result[name] = value
  return result
}

async function readWithAdapter<T>(headers: Record<string, string>, read: (c: any) => T): Promise<T> {
  let value: T | undefined
  const app = new Hono()
  app.get("/", (c) => {
    value = read(c)
    return c.body(null)
  })
  await app.request("http://localhost/", { headers: new Headers(headers) })
  return value as T
}

describe("Pi extension request identity", () => {
  test("keys a primary request by Pi's session ID and selects the Pi adapter", async () => {
    const headers = sent(shape({ sessionId: SESSION }))
    expect(headers["x-meridian-agent"]).toBe("pi")
    expect(headers["x-session-affinity"]).toBe(SESSION)
    expect(headers["x-meridian-source"]).toBeUndefined()
    expect(headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/)
    expect(await readWithAdapter(headers, c => piAdapter.getSessionId(c))).toBe(SESSION)
  })

  test("keeps a caller's request ID", () => {
    expect(sent(shape({ sessionId: SESSION, headers: { "X-Request-Id": "req-1" } }))["X-Request-Id"]).toBe("req-1")
  })

  test("suppresses stale identity headers from configuration or other plugins, whatever their case", () => {
    const headers = shape({
      sessionId: SESSION,
      headers: {
        "X-Session-Affinity": "someone-else",
        "x-opencode-session": "ses_other",
        "X-Session-Id": "other",
        "x-parent-session-id": "parent",
        "x-opencode-agent-mode": "primary",
        "x-opencode-agent-name": "build",
        [PRIORITY_ATTESTATION_HEADER]: "v1.forged.token",
      },
    })
    for (const name of ["x-opencode-session", "x-session-id", "x-parent-session-id", "x-opencode-agent-mode", "x-opencode-agent-name"]) {
      expect(headers[name]).toBeNull()
    }
    expect(headers["x-session-affinity"]).toBe(SESSION)
    expect(Object.keys(headers).filter(name => name.toLowerCase() === "x-session-affinity")).toEqual(["x-session-affinity"])
    expect(headers[PRIORITY_ATTESTATION_HEADER]).not.toBe("v1.forged.token")
  })

  test("falls back to a caller's affinity header, then a fresh ID, when Pi passes no session ID", () => {
    expect(sent(shape({ headers: { "x-session-affinity": "orchestrator-key" } }, {}))["x-session-affinity"]).toBe("orchestrator-key")
    const first = sent(shape(undefined, {}))["x-session-affinity"]
    const second = sent(shape(undefined, {}))["x-session-affinity"]
    expect(first).not.toBe(second)
  })

  test("marks a side call with its own session ID independent under that ID", async () => {
    const headers = sent(shape({ sessionId: "compaction-session" }))
    expect(headers["x-session-affinity"]).toBe("compaction-session")
    expect(headers["x-meridian-source"]).toBe("fork-side-call")
    expect(headers[PRIORITY_ATTESTATION_HEADER]).toBeUndefined()
    expect(await readWithAdapter(headers, c => piAdapter.getSessionId(c))).toBe("compaction-session")
  })

  test("treats nothing as a side call before Pi reports a session", () => {
    expect(sent(shape({ sessionId: "any" }, {}))["x-meridian-source"]).toBeUndefined()
  })

  test("honors a source another extension declared from before_provider_headers", () => {
    const headers = sent(shape({ sessionId: SESSION, headers: { "X-Meridian-Source": "subagent-reviewer" } }))
    expect(headers["x-meridian-source"]).toBe("subagent-reviewer")
    expect(headers[PRIORITY_ATTESTATION_HEADER]).toBeUndefined()
  })

  test("tiers a delegated child process by its environment", () => {
    expect(childSourceFromEnvironment({ MERIDIAN_SOURCE: "subagent-scout" })).toBe("subagent-scout")
    expect(childSourceFromEnvironment({ MERIDIAN_SOURCE: ` subagent-\u200bscout${"x".repeat(80)}` })).toHaveLength(64)
    expect(childSourceFromEnvironment({ PI_SUBAGENT_CHILD: "1" })).toBe("subagent-child")
    expect(childSourceFromEnvironment({ MERIDIAN_SOURCE: "subagent-a", PI_SUBAGENT_CHILD: "1" })).toBe("subagent-a")
    expect(childSourceFromEnvironment({ MERIDIAN_SOURCE: "\u200b", PI_SUBAGENT_CHILD: "0" })).toBeUndefined()

    const headers = sent(shape({ sessionId: SESSION }, { session: rootSession(), childSource: "subagent-scout" }))
    expect(headers["x-meridian-source"]).toBe("subagent-scout")
    expect(headers[PRIORITY_ATTESTATION_HEADER]).toBeUndefined()
  })

  test("tiers a pi-subagents agent by its active-agent prompt marker", () => {
    const marked = (content: string | { type: "text"; text: string }[]) =>
      sent(shape({ sessionId: SESSION }, { session: rootSession() }, normalizeContext({
        messages: [{ role: "system", content, timestamp: 0 } satisfies SystemMessage],
      })))["x-meridian-source"]
    expect(marked('<active_agent name="worker"/>\nDo the work')).toBe("subagent-worker")
    expect(marked([{ type: "text", text: '<active_agent name="re\u200bviewer"/>' }])).toBe("subagent-reviewer")
    expect(marked('Mentions <active_agent name="worker"/> later')).toBeUndefined()
  })

  test("tiers a pi-subagents agent whose prompt is appended to Pi's", () => {
    // Pi's layout (core/system-prompt.js): an untagged preamble, then each
    // section as <name>\n…\n</name>, the addendum before project_context,
    // skills and cwd. A forced prompt is the same text flattened with blank lines.
    const sections = (addendum: string, projectContext = "AGENTS.md text") => ({
      preamble: "You are an expert coding assistant operating inside pi.",
      docs: "<docs>\nPi documentation\n</docs>",
      addendum: `<addendum>\n${addendum}\n</addendum>`,
      project_context: `<project_context>\n${projectContext}\n</project_context>`,
      cwd: "<cwd>\n/tmp/project\n</cwd>",
    })
    const flat = (addendum: string, projectContext?: string) => Object.values(sections(addendum, projectContext)).join("\n\n")
    const source = (message: Omit<SystemMessage, "role" | "timestamp">) =>
      sent(shape({ sessionId: SESSION }, { session: rootSession() }, normalizeContext({
        messages: [{ role: "system", timestamp: 0, ...message } satisfies SystemMessage],
      })))["x-meridian-source"]
    const delegate = '<active_agent name="delegate"/>\n\nYou are a delegated agent.'

    expect(source({ content: flat(delegate) })).toBe("subagent-delegate")
    expect(source({ content: "", sections: sections(delegate) })).toBe("subagent-delegate")
    expect(source({ content: "", sections: { ...sections("Append."), preamble: delegate } })).toBe("subagent-delegate")
    expect(source({ content: flat(`Global append text.\n\n${delegate}`) })).toBe("subagent-delegate")
    expect(source({ content: flat(`Global append text ending in a newline.\n\n\n${delegate}`) })).toBe("subagent-delegate")

    expect(source({ content: flat('See <active_agent name="delegate"/> in the docs.') })).toBeUndefined()
    expect(source({ content: "", sections: sections('See <active_agent name="delegate"/> in the docs.') })).toBeUndefined()
    const quoted = `Example layout:\n\n<addendum>\n${delegate}\n</addendum>`
    const rootQuotingLayout = Object.entries(sections("", quoted))
      .filter(([name]) => name !== "addendum")
      .map(([, text]) => text)
      .join("\n\n")
    expect(source({ content: rootQuotingLayout })).toBeUndefined()
    expect(source({ content: "", sections: sections("Append.", quoted) })).toBeUndefined()
  })
})

describe("Pi extension human-turn attestation", () => {
  test("signs the latest user message of a root conversation", async () => {
    const headers = sent(shape({ sessionId: SESSION }))
    const verified = verifyPriorityAttestation(headers[PRIORITY_ATTESTATION_HEADER], KEY)
    expect(verified).toEqual({
      generation: "pi1",
      sessionId: SESSION,
      agentId: "pi",
      turnId: computePriorityTurnDigest({ generation: "pi1", sessionId: SESSION, humanMessageId: "c3d4e5f6" })!,
      issuedAt: NOW_SECONDS,
    })
  })

  test("signs nothing for a fork, a profile pin, or a branch without a usable user message", () => {
    const unsigned = (options: SimpleStreamOptions, session: HumanTurnSession) =>
      sent(shape(options, { session }))[PRIORITY_ATTESTATION_HEADER]
    expect(unsigned({ sessionId: SESSION }, rootSession({ getHeader: () => ({ parentSession: "/tmp/original.jsonl" }) }))).toBeUndefined()
    expect(unsigned({ sessionId: SESSION, headers: { "x-meridian-profile": "" } }, rootSession())).toBeUndefined()
    expect(unsigned({ sessionId: SESSION }, rootSession({ getBranch: () => [] }))).toBeUndefined()
    expect(unsigned({ sessionId: SESSION }, rootSession({
      getBranch: () => [{ type: "message", id: "a1b2c3d4", message: { role: "user", timestamp: "yesterday" } }],
    }))).toBeUndefined()
    expect(unsigned({ sessionId: SESSION }, rootSession({
      getBranch: () => [{ type: "message", id: "has space", message: { role: "user", timestamp: Date.now() } }],
    }))).toBeUndefined()
  })

  test("signs nothing without a key", () => {
    const headers = requestOptions(EMPTY_CONTEXT, { sessionId: SESSION }, { session: rootSession() }, Buffer.alloc(0)).headers!
    expect(headers[PRIORITY_ATTESTATION_HEADER]).toBeNull()
  })

  describe("as read by the Pi adapter", () => {
    let savedKey: string | undefined
    beforeEach(() => {
      savedKey = process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
      process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = KEY.toString("base64url")
    })
    afterEach(() => {
      if (savedKey === undefined) delete process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
      else process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = savedKey
    })

    const identity = (headers: Record<string, string>) => readWithAdapter(headers, c => piAdapter.getRoutingTurnIdentity!(c))

    test("is a trusted human turn for its own session", async () => {
      expect(await identity(sent(shape({ sessionId: SESSION })))).toEqual({
        kind: "human",
        turnId: computePriorityTurnDigest({ generation: "pi1", sessionId: SESSION, humanMessageId: "c3d4e5f6" })!,
        issuedAt: NOW_SECONDS,
        generation: "pi-1",
      })
    })

    test("is ignored with a source, a profile pin, another session key or no session key", async () => {
      const signed = sent(shape({ sessionId: SESSION }))
      expect(await identity({ ...signed, "x-meridian-source": "subagent-generate" })).toBeUndefined()
      expect(await identity({ ...signed, "x-meridian-profile": "work" })).toBeUndefined()
      expect(await identity({ ...signed, "x-session-affinity": "another-session" })).toBeUndefined()
      const { "x-session-affinity": _affinity, ...keyless } = signed
      expect(await identity(keyless)).toBeUndefined()
    })

    test("is ignored when tampered with or missing", async () => {
      const signed = sent(shape({ sessionId: SESSION }))
      const token = signed[PRIORITY_ATTESTATION_HEADER]!
      const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`
      expect(await identity({ ...signed, [PRIORITY_ATTESTATION_HEADER]: tampered })).toBeUndefined()
      const { [PRIORITY_ATTESTATION_HEADER]: _token, ...unsigned } = signed
      expect(await identity(unsigned)).toBeUndefined()
    })
  })
})

type Registered = { id: string; config: ProviderConfig }

function loadExtension(env: Record<string, string | undefined> = {}) {
  const saved = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(env)) {
    saved.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  let registered: Registered | undefined
  try {
    meridian({
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
      registerProvider: (id: string, config: ProviderConfig) => { registered = { id, config } },
    } as unknown as ExtensionAPI)
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  if (!registered) throw new Error("the extension registered no provider")
  return { handlers, provider: registered }
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}) {
  const published: ModelsPublication[] = []
  const context = {
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async (publication: ModelsPublication) => {
      published.push(publication)
      return true
    },
    ...overrides,
  } as RefreshModelsContext
  return { context, published }
}

describe("Pi extension provider registration", () => {
  test("registers a separate meridian provider on Pi's Anthropic API", () => {
    const { provider, handlers } = loadExtension()
    expect(provider.id).toBe("meridian")
    expect(provider.config).toMatchObject({
      name: "Meridian (Claude)",
      api: "anthropic-messages",
      apiKey: "meridian",
      headers: { "x-meridian-agent": "pi" },
      models: [],
    })
    // No provider-level URL, so Pi reports a models.json override to refreshModels.
    expect(provider.config.baseUrl).toBeUndefined()
    expect([...handlers.keys()]).toEqual(["session_start"])
  })

  test("references MERIDIAN_API_KEY when it is set, without copying the secret", () => {
    expect(loadExtension({ MERIDIAN_API_KEY: "secret" }).provider.config.apiKey).toBe("$MERIDIAN_API_KEY")
  })
})

describe("Pi extension catalog refresh", () => {
  const savedFetch = globalThis.fetch
  let requests: Array<{ url: string; apiKey: string | null }>
  let respond: () => Response | Promise<Response>

  beforeEach(() => {
    requests = []
    respond = () => Response.json({ object: "list", data: buildModelList(true, 0) })
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), apiKey: new Headers(init?.headers).get("x-api-key") })
      return respond()
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = savedFetch
    delete process.env.MERIDIAN_BASE_URL
    delete process.env.MERIDIAN_API_KEY
    delete process.env.PI_OFFLINE
  })

  const refresh = (context: RefreshModelsContext) => loadExtension().provider.config.refreshModels!(context)

  function stored(baseUrl: string, checkedAt = Date.now()): ModelsStoreEntry {
    const model: MeridianModelConfig = {
      id: "claude-stored",
      name: "Stored (Meridian)",
      api: "anthropic-messages",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 1000,
      compat: { supportsMidConvoToolChanges: false },
    }
    return catalogStoreEntry("meridian", [model], checkedAt)
  }

  test("discovers from Meridian and persists the catalog in Pi's model store", async () => {
    const { context, published } = refreshContext()
    const models = await refresh(context)
    expect(requests).toEqual([{ url: "http://127.0.0.1:3456/v1/models", apiKey: null }])
    expect(models.map(model => model.id)).toEqual(buildModelList(true, 0).map(model => model.id))
    expect(published).toHaveLength(1)
    expect(published[0]!.persist!.models.map(model => model.id)).toEqual(models.map(model => model.id))
  })

  test("restores the stored catalog offline without contacting Meridian", async () => {
    const { context, published } = refreshContext({ allowNetwork: false, stored: stored("http://127.0.0.1:3456") })
    expect((await refresh(context)).map(model => model.id)).toEqual(["claude-stored"])
    expect(requests).toEqual([])
    expect(published).toEqual([])
  })

  test("discovers once on a cold start with nothing stored, unless Pi is offline", async () => {
    expect((await refresh(refreshContext({ allowNetwork: false }).context)).length).toBeGreaterThan(0)
    expect(requests).toHaveLength(1)
    process.env.PI_OFFLINE = "1"
    expect(await refresh(refreshContext({ allowNetwork: false }).context)).toEqual([])
    expect(requests).toHaveLength(1)
  })

  test("keeps the stored catalog when Meridian is down, and reports the outage only with nothing to show", async () => {
    respond = () => { throw new TypeError("fetch failed") }
    const withStored = refreshContext({ stored: stored("http://127.0.0.1:3456") }).context
    expect((await refresh(withStored)).map(model => model.id)).toEqual(["claude-stored"])
    await expect(refresh(refreshContext().context)).rejects.toThrow("fetch failed")
    expect(await refresh(refreshContext({ allowNetwork: false }).context)).toEqual([])
  })

  test("ignores a catalog stored for another Meridian", async () => {
    const { context } = refreshContext({ allowNetwork: false, stored: stored("http://127.0.0.1:3458") })
    expect((await refresh(context)).some(model => model.id === "claude-stored")).toBe(false)
    expect(requests).toHaveLength(1)
  })

  test("uses Pi's models.json base URL over MERIDIAN_BASE_URL, normalized", async () => {
    process.env.MERIDIAN_BASE_URL = "http://127.0.0.1:3457/"
    await refresh(refreshContext().context)
    const models = await refresh(refreshContext({ baseUrl: "http://127.0.0.1:3458/v1" }).context)
    expect(requests.map(request => request.url)).toEqual([
      "http://127.0.0.1:3457/v1/models",
      "http://127.0.0.1:3458/v1/models",
    ])
    expect(models.every(model => model.baseUrl === "http://127.0.0.1:3458")).toBe(true)
  })

  test("authenticates discovery with Pi's resolved credential, or MERIDIAN_API_KEY on a cold start", async () => {
    await refresh(refreshContext({ credential: { type: "api_key", key: "from-pi" } }).context)
    process.env.MERIDIAN_API_KEY = "from-env"
    await refresh(refreshContext({ allowNetwork: false }).context)
    expect(requests.map(request => request.apiKey)).toEqual(["from-pi", "from-env"])
  })
})

describe("Pi extension requests on the wire", () => {
  let server: ReturnType<typeof Bun.serve>
  let received: Headers[]
  let savedKey: string | undefined

  beforeEach(() => {
    received = []
    savedKey = process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
    process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = KEY.toString("base64url")
    server = Bun.serve({
      port: 0,
      fetch(request) {
        received.push(request.headers)
        const events = [
          ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
          ["message_stop", { type: "message_stop" }],
        ]
        return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
  })
  afterEach(() => {
    server.stop(true)
    if (savedKey === undefined) delete process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
    else process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = savedKey
  })

  test("Pi's Anthropic implementation sends the shaped identity and the signed turn", async () => {
    const { provider, handlers } = loadExtension()
    handlers.get("session_start")!({ type: "session_start", reason: "startup" }, { sessionManager: rootSession() })
    const model = {
      id: "claude-haiku-5-5",
      name: "Haiku (Meridian)",
      api: "anthropic-messages",
      provider: "meridian",
      baseUrl: `http://127.0.0.1:${server.port}`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 1024,
    } as Model<"anthropic-messages">
    const context = normalizeContext({ messages: [{ role: "user", content: "ping", timestamp: Date.now() }] })
    const options = {
      apiKey: "meridian",
      sessionId: SESSION,
      headers: { "x-meridian-agent": "pi", "x-opencode-agent-mode": "primary" },
    }

    const main = await provider.config.streamSimple!(model, context, options).result()
    const side = await provider.config.streamSimple!(model, context, { ...options, sessionId: "side-session" }).result()

    expect(main.stopReason).toBe("stop")
    expect(side.stopReason).toBe("stop")
    const [primary, sideCall] = received
    expect(primary!.get("x-meridian-agent")).toBe("pi")
    expect(primary!.get("x-session-affinity")).toBe(SESSION)
    expect(primary!.get("x-api-key")).toBe("meridian")
    expect(primary!.has("x-opencode-agent-mode")).toBe(false)
    expect(primary!.has("x-meridian-source")).toBe(false)
    expect(verifyPriorityAttestation(primary!.get(PRIORITY_ATTESTATION_HEADER) ?? undefined, KEY)?.generation).toBe("pi1")
    expect(sideCall!.get("x-session-affinity")).toBe("side-session")
    expect(sideCall!.get("x-meridian-source")).toBe("fork-side-call")
    expect(sideCall!.has(PRIORITY_ATTESTATION_HEADER)).toBe(false)
  })
})
