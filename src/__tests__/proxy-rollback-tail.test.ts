/**
 * Opt-in partial replay over HTTP through the mocked SDK, in Oh My Pi's
 * request shape (`x-meridian-agent: pi`, key in `metadata.user_id`).
 *
 * A history that stopped continuing its stored session forks that session at
 * the last proved assistant turn (`resume` + `resumeSessionAt` +
 * `forkSession`) and is sent everything after it: the fork point's own tool
 * results natively, the rest rendered as replay context. With the setting off,
 * or when the fork is not proved, the same requests replay the whole history.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop, withMockSdkSessionId } from "./helpers"

type QueryInput = {
  prompt: unknown
  options?: { sessionId?: string; resume?: string; resumeSessionAt?: string; forkSession?: boolean }
}
let captured: QueryInput[] = []
/** Make a forked query fail the way an oversized prompt does. */
let overflowForks = false
const RESPONSE_UUID = "response-uuid"
installSdkMock(() => ({
  query: (input: QueryInput) => {
    captured.push(input)
    return (async function* () {
      if (overflowForks && input.options?.resumeSessionAt) throw new Error("Claude Code returned an error result: Prompt is too long")
      const reply = { ...assistantMessage([{ type: "text", text: "ok" }]), uuid: RESPONSE_UUID }
      for (const message of [messageStart(), textBlockStart(0), textDelta(0, "ok"), blockStop(0), messageDelta(), messageStop(), reply]) {
        yield withMockSdkSessionId(message, input.options)
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-rollback-tail.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))
// Loaded after the mocks above are installed, as the other proxy tests do.

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { storeSession } = await import("../proxy/session/cache")
const { lookupSharedSession } = await import("../proxy/sessionStore")
const { diagnosticLog, telemetryStore } = await import("../telemetry")
const { setSetting } = await import("../settings")

type Message = { role: string; content: unknown }
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (text: string): Message => ({
  role: "assistant", content: [{ type: "thinking", thinking: "considering", signature: "sig" }, { type: "text", text }],
})
const toolCall = (...ids: string[]): Message => ({
  role: "assistant", content: [
    { type: "thinking", thinking: "planning", signature: "sig" },
    ...ids.map(id => ({ type: "tool_use", id, name: "read", input: { path: `/${id}` } })),
  ],
})
const toolResults = (...ids: string[]): Message => ({
  role: "user", content: ids.map(id => ({ type: "tool_result", tool_use_id: id, content: `RESULT_${id}` })),
})
const conversation = (count: number): Message[] =>
  Array.from({ length: count }, (_, index) => index % 2 === 0 ? user(`user ${index}`) : assistant(`assistant ${index}`))
const uuidsOf = (messages: Message[]) => messages.map((message, index) => message.role === "assistant" ? `uuid-${index}` : null)

async function seed(key: string | undefined, messages: Message[], checkpoint?: { uuid: string; ids: string[] }, workingDirectory?: string): Promise<unknown> {
  const uuids: Array<string | null> = uuidsOf(messages)
  if (checkpoint) uuids.push(checkpoint.uuid)
  return storeSession(key, messages, "sdk-source", workingDirectory, uuids, undefined, checkpoint?.uuid, checkpoint?.ids)
}

type Client = { headers: Record<string, string>; body: Record<string, unknown> }
/** Oh My Pi: the conversation key rides in `metadata.user_id`. */
const piClient = (key: string): Client => ({
  headers: { "x-meridian-agent": "pi" },
  body: { metadata: { user_id: JSON.stringify({ session_id: key }) } },
})
/** OpenCode without its plugin: no session header, so the stored session is
 *  found by the conversation's fingerprint (first user message + cwd). */
const OPENCODE_CWD = "/tmp/rollback-tail-headerless-opencode"
const headerlessOpenCode: Client = {
  headers: { "user-agent": "opencode/1.0.0" },
  body: { system: `<env>\n  Working directory: ${OPENCODE_CWD}\n</env>` },
}

async function sendAs(client: Client, messages: Message[], stream = false, queries = 1): Promise<void> {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...client.headers },
    body: JSON.stringify({ model: "haiku", max_tokens: 256, stream, messages, ...client.body }),
  }))
  expect(response.status).toBe(200)
  const body = await response.text()
  if (stream) expect(body).toContain("event: message_stop")
  expect(captured).toHaveLength(queries)
}

const send = (key: string, messages: Message[], stream = false, queries = 1) => sendAs(piClient(key), messages, stream, queries)

/** The one SDK input a request produced: a string, or the structured message. */
async function promptOf(input: QueryInput): Promise<string | unknown[]> {
  if (typeof input.prompt === "string") return input.prompt
  const messages: Array<{ message: { content: unknown[] } }> = []
  for await (const message of input.prompt as AsyncIterable<{ message: { content: unknown[] } }>) messages.push(message)
  expect(messages).toHaveLength(1)
  return messages[0]!.message.content
}

const diagnostics = () => diagnosticLog.getRecent().map(entry => entry.message).join("\n")
const lastLineage = () => telemetryStore.getRecent()[0]?.lineageType

function expectFork(rollbackUuid: string): void {
  expect(captured[0]!.options?.resume).toBe("sdk-source")
  expect(captured[0]!.options?.resumeSessionAt).toBe(rollbackUuid)
  expect(captured[0]!.options?.forkSession).toBe(true)
}

function expectFreshReplay(): void {
  expect(captured[0]!.options?.resume).toBeUndefined()
  expect(captured[0]!.options?.resumeSessionAt).toBeUndefined()
}

describe("rollback-tail partial replay over HTTP", () => {
  let key = ""
  beforeEach(async () => {
    captured = []
    key = `rollback-tail-${crypto.randomUUID()}`
    await clearSessionCache()
    diagnosticLog.clear()
    telemetryStore.clear()
    process.env.MERIDIAN_PARTIAL_REPLAY = "1"
    overflowForks = false
  })
  afterEach(() => {
    delete process.env.MERIDIAN_PARTIAL_REPLAY
    delete process.env.MERIDIAN_REPLAY_BUDGET_TOKENS
    setSetting("partialReplay", undefined)
  })

  // Production shape (12:03:41, dee23f01): 444 stored, 443 incoming, user
  // message 440 rewritten, 439 an assistant[thinking,text], the stored
  // trailing turn dropped and a new prompt added.
  const history = conversation(444)
  const undoGap = [...history.slice(0, 440), user("REWRITTEN_440"), history[441]!, user("NEW_PROMPT_442")]

  for (const stream of [false, true]) {
    it(`forks an undo-gap at the assistant before the rewrite and delivers the tail (stream=${stream})`, async () => {
      await seed(key, history)
      await send(key, undoGap, stream)
      expectFork("uuid-439")
      const prompt = await promptOf(captured[0]!)
      expect(typeof prompt).toBe("string")
      const text = prompt as string
      expect(text.startsWith("<conversation_history>\nREWRITTEN_440\n\n[Assistant: assistant 441]\n</conversation_history>")).toBe(true)
      expect(text).toContain("context only")
      expect(text.endsWith("NEW_PROMPT_442")).toBe(true)
      expect(text).not.toContain("user 438")
      expect(diagnostics()).toContain("lineage=rollback-tail session=sdk-sour rollback=uuid-439 from=undo-gap prefix=440 tail=3")
      expect(diagnostics()).toContain("Rollback-tail candidate: message 439.")
      expect(lastLineage()).toBe("rollback-tail")

      // The fork keeps the native UUIDs through 439; the delivered tail has
      // none, and the reply is the next rollback point.
      const published = lookupSharedSession(key)
      expect(published?.messageCount).toBe(443)
      expect(published?.sdkMessageUuids?.slice(438)).toEqual([null, "uuid-439", null, null, null, RESPONSE_UUID])
    })
  }

  // #1510 composition (Oh My Pi, 2026-11-07): the stored history holds an
  // eval-state note the client later dropped, plus a background side request
  // under the main key. Regrouping proves the prefix through the final answer;
  // the remaining change is the undone side request, which forks there.
  it("forks a regrouped history at its moved final answer instead of replaying it", async () => {
    const reminder = (body: string) => `<system-reminder>\n${body}\n</system-reminder>`
    const userBlocks = (...texts: string[]): Message => ({ role: "user", content: texts.map(text => ({ type: "text", text })) })
    const head = [user("HEAD_MARKER start the work"), assistant("first part done"), user("continue"), assistant("second part done")]
    const evalStateNote = user(reminder("eval kernel state: x = 1"))
    const prompt = userBlocks(reminder("Today: 2026-11-07"), "polish, fix and create PR")
    const stretchNote = user("Reply in stretchtext.")
    const work = [assistant("checked the diff"), user("go on"), assistant("PR opened")]
    const sideTail: Message[] = [user(`${reminder("probe context")}\n`), { role: "system", content: [] }, user("SIDE_MARKER Is the task complete?")]
    const nextPrompt = userBlocks(reminder("Today: 2026-11-07"), "NEXT_MARKER update the changelog")

    await seed(key, [...head, evalStateNote, prompt, stretchNote, ...work, ...sideTail])
    await send(key, [...head, prompt, stretchNote, ...work, nextPrompt, stretchNote])

    // Stored index 9 ("PR opened") sits at incoming index 8 after the regroup.
    expectFork("uuid-9")
    const delivered = JSON.stringify(await promptOf(captured[0]!))
    expect(delivered).toContain("NEXT_MARKER")
    expect(delivered).not.toContain("HEAD_MARKER")
    expect(delivered).not.toContain("SIDE_MARKER")
    expect(diagnostics()).toContain("1 run, stored 10 -> incoming 9")
    expect(diagnostics()).toContain("lineage=rollback-tail session=sdk-sour rollback=uuid-9 from=undo-gap prefix=9 tail=2")
    expect(lastLineage()).toBe("rollback-tail")
  })

  it("keeps today's full replay with the setting off", async () => {
    delete process.env.MERIDIAN_PARTIAL_REPLAY
    await seed(key, history)
    await send(key, undoGap)
    expectFreshReplay()
    expect(await promptOf(captured[0]!)).toContain("user 438")
    expect(diagnostics()).toContain("diverged=undo-gap")
    expect(diagnostics()).not.toContain("rollback-tail")
    expect(lastLineage()).toBe("new")
  })

  it("turns on from settings.json, and MERIDIAN_PARTIAL_REPLAY=0 forces it off", async () => {
    delete process.env.MERIDIAN_PARTIAL_REPLAY
    setSetting("partialReplay", true)
    await seed(key, history)
    await send(key, undoGap)
    expectFork("uuid-439")

    captured = []
    process.env.MERIDIAN_PARTIAL_REPLAY = "0"
    const other = `${key}-off`
    await seed(other, history)
    await send(other, undoGap)
    expectFreshReplay()
  })

  it("forks before an empty thinking-only assistant that came back with a tool call and its result", async () => {
    // Stored: assistant 5 was thinking-only. Incoming: the same slot now holds
    // thinking+tool_use, and its result replaces the stored trailing turn.
    const stored = [...conversation(5), { role: "assistant", content: [{ type: "thinking", thinking: "…", signature: "sig" }] }, user("user 6")]
    await seed(key, stored)
    await send(key, [...stored.slice(0, 5), toolCall("filled"), toolResults("filled")])
    expectFork("uuid-3")
    const text = await promptOf(captured[0]!)
    expect(typeof text).toBe("string")
    expect(text).toContain("user 4")
    expect(text).toContain('Previously called tool: {"id":"filled"')
    expect(text).toContain('Recorded tool result: {"tool_use_id":"filled","is_error":false}')
    expect(text).toContain("RESULT_filled")
    expect(diagnostics()).toContain("from=undo-gap prefix=4 tail=3")
  })

  it("forks modified history at the assistant before the change", async () => {
    const stored = conversation(9)
    await seed(key, stored)
    await send(key, [...stored.slice(0, 6), user("REWRITTEN_6"), assistant("reply 7"), user("user 8"), assistant("reply 9"), user("LIVE_10")])
    expectFork("uuid-5")
    const text = await promptOf(captured[0]!) as string
    expect(text).toContain("REWRITTEN_6")
    expect(text).toContain("[Assistant: reply 9]")
    expect(text.endsWith("LIVE_10")).toBe(true)
    expect(text).not.toContain("user 4")
    expect(diagnostics()).toContain("from=modified-history prefix=6 tail=5")
  })

  it("settles a tool-call fork point with its native results, then the rendered rest", async () => {
    const stored = [user("go"), assistant("plan"), user("read both"), toolCall("t1", "t2"), toolResults("t1", "t2"), assistant("summary"), user("thanks")]
    await seed(key, stored)
    await send(key, [...stored.slice(0, 5), assistant("REVISED_SUMMARY"), user("LIVE")])
    expectFork("uuid-3")
    const content = await promptOf(captured[0]!) as Array<Record<string, unknown>>
    expect(Array.isArray(content)).toBe(true)
    expect(content.slice(0, 2)).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "RESULT_t1" },
      { type: "tool_result", tool_use_id: "t2", content: "RESULT_t2" },
    ])
    expect(content).toHaveLength(3)
    const rendered = content[2] as { type: string; text: string }
    expect(rendered.type).toBe("text")
    expect(rendered.text.startsWith("<conversation_history>\n[Assistant: REVISED_SUMMARY]\n</conversation_history>")).toBe(true)
    expect(rendered.text.endsWith("LIVE")).toBe(true)
    expect(rendered.text).not.toContain("RESULT_t1")
  })

  it("forks before a tool-call assistant whose results are not all present", async () => {
    const stored = [user("go"), assistant("plan"), user("read both"), toolCall("t1", "t2"), toolResults("t1"), assistant("summary"), user("thanks")]
    await seed(key, stored)
    await send(key, [...stored.slice(0, 5), assistant("REVISED_SUMMARY"), user("LIVE")])
    expectFork("uuid-1")
    const text = await promptOf(captured[0]!)
    expect(typeof text).toBe("string")
    expect(text).toContain('Previously called tool: {"id":"t1"')
    expect(text).toContain('Recorded tool result: {"tool_use_id":"t1","is_error":false}')
    expect(text).toContain("[Assistant: REVISED_SUMMARY]")
  })

  it("replays fresh when the history is over the replay budget", async () => {
    process.env.MERIDIAN_REPLAY_BUDGET_TOKENS = "20"
    const stored = conversation(9)
    await seed(key, stored)
    await send(key, [...stored.slice(0, 6), user("REWRITTEN_6"), assistant("reply 7"), user("LIVE_8")])
    expectFreshReplay()
    expect(diagnostics()).toContain("rollback-tail refused (over-budget) for undo-gap")
    expect(lastLineage()).toBe("new")
  })

  for (const stream of [false, true]) {
    it(`replays fresh when the forked tail overflows the context window (stream=${stream})`, async () => {
      overflowForks = true
      await seed(key, history)
      await send(key, undoGap, stream, 2)
      expectFork("uuid-439")
      expect(captured[1]!.options?.resume).toBeUndefined()
      expect(captured[1]!.options?.resumeSessionAt).toBeUndefined()
      const replay = await promptOf(captured[1]!)
      expect(replay).toContain("user 438")
      expect(replay).toContain("REWRITTEN_440")
    })
  }

  it("forks before an unsettled passthrough checkpoint instead of replaying it", async () => {
    // The stored turn forwarded c1 and c2; the client answered only c1.
    const stored = [user("go"), assistant("plan"), user("read it"), toolCall("t1"), toolResults("t1")]
    const incoming = [...stored, toolCall("c1", "c2"), toolResults("c1")]
    await seed(key, stored, { uuid: "uuid-checkpoint", ids: ["c1", "c2"] })
    await send(key, incoming)
    expectFork("uuid-3")
    const content = await promptOf(captured[0]!) as Array<Record<string, unknown>>
    expect(content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "RESULT_t1" })
    const rendered = content[1] as { text: string }
    expect(rendered.text).toContain('Previously called tool: {"id":"c1"')
    expect(rendered.text).toContain('Recorded tool result: {"tool_use_id":"c1","is_error":false}')
    expect(diagnostics()).toContain("lineage=rollback-tail session=sdk-sour rollback=uuid-3 from=checkpoint-mismatch prefix=4 tail=3")
    expect(lastLineage()).toBe("rollback-tail")
    expect(lookupSharedSession(key)?.sdkMessageUuids).toEqual([null, "uuid-1", null, "uuid-3", null, null, null, RESPONSE_UUID])
  })

  it("keeps the replay of a headerless OpenCode checkpoint mismatch", async () => {
    // Matched by fingerprint, the request may be a side agent sharing this
    // conversation's opening. Its partial checkpoint results are followed by
    // queued user text, so it ends in a user turn and is looked up (a request
    // ending in a tool_result skips lookup). It replays its own body instead
    // of forking the matched session.
    const stored = [user(`go ${key}`), assistant("plan"), user("read it"), toolCall("t1"), toolResults("t1")]
    await seed(undefined, stored, { uuid: "uuid-checkpoint", ids: ["c1", "c2"] }, OPENCODE_CWD)
    await sendAs(headerlessOpenCode, [...stored, toolCall("c1", "c2"), toolResults("c1"), user("QUEUED_TEXT")])
    expect(diagnostics()).not.toContain("lineage=rollback-tail")
    expect(diagnostics()).toContain("rollback-tail refused (headerless-opencode) for checkpoint-mismatch")
    expectFreshReplay()
    const replay = JSON.stringify(await promptOf(captured[0]!))
    expect(replay).toContain("plan")
    expect(replay).toContain("QUEUED_TEXT")
    expect(lastLineage()).toBe("continuation")
  })

  it("keeps the replay of a headerless OpenCode undo-gap", async () => {
    const stored = conversation(9)
    await seed(undefined, stored, undefined, OPENCODE_CWD)
    await sendAs(headerlessOpenCode, [...stored.slice(0, 6), user("REWRITTEN_6"), assistant("reply 7"), user("LIVE_8")])
    expect(diagnostics()).toContain("rollback-tail refused (headerless-opencode) for undo-gap")
    expectFreshReplay()
    expect(lastLineage()).toBe("new")
  })

  it("keeps today's replay of an unsettled checkpoint with the setting off", async () => {
    delete process.env.MERIDIAN_PARTIAL_REPLAY
    const stored = [user("go"), assistant("plan"), user("read it"), toolCall("t1"), toolResults("t1")]
    await seed(key, stored, { uuid: "uuid-checkpoint", ids: ["c1", "c2"] })
    await send(key, [...stored, toolCall("c1", "c2"), toolResults("c1")])
    expectFreshReplay()
    expect(lastLineage()).toBe("continuation")
  })
})
