/**
 * Mock `Query` for unit / integration tests of persistent-mode session handling.
 *
 * Faithfully reproduces the empirical event sequence observed in the live
 * spike (see `openspec/changes/persistent-sdk-sessions/spike-notes.md`):
 *
 * - one `system { subtype: "init" }` before each turn's first assistant content
 * - zero or more `rate_limit_event` mid-turn (non-terminal)
 * - optional synthetic `user` events during tool execution (non-terminal)
 * - `assistant` events for model content
 * - exactly one `result` event per logical turn, carrying usage + session_id
 *
 * Control methods (`close`, `setModel`, `applyFlagSettings`, `interrupt`,
 * `getContextUsage`) are stubbed; every call is recorded so tests can assert
 * ordering (e.g. `setModel` MUST be called before pushing the next user
 * message when an in-place model switch is requested).
 */

import type {
  SDKMessage,
  SDKUserMessage,
  Query,
  SDKSystemMessage,
  SDKResultSuccess,
  SDKControlGetContextUsageResponse,
} from "@anthropic-ai/claude-agent-sdk"

// --- Configuration ---------------------------------------------------------

/**
 * Per-turn scripted events. The helper prepends a `system(init)` event
 * (unless `suppressSystemInit: true`) and appends a synthesized `result`
 * event (unless the last entry is already a `result`). Between those,
 * the script may include any number of assistant / user / stream_event /
 * rate_limit_event messages.
 */
export interface MockTurn {
  events: SDKMessage[]
  /** Overrides for the synthesized `result` terminator. */
  result?: {
    stopReason?: string
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
    inputTokens?: number
    outputTokens?: number
    numTurns?: number
    subtype?: "success" | "error_max_turns" | "error_during_execution"
  }
  /** If true, suppress the leading `system(init)` for this turn. */
  suppressSystemInit?: boolean
}

export interface MockQueryConfig {
  turns: MockTurn[]
  /** Stable session id the mock emits on every event that carries one. */
  sessionId?: string
  /** Throw from `iterator.next()` on or after this turn index (0-based); tests
   *  use this to simulate a crash mid-session. */
  crashOnTurn?: number
  /** Error thrown when the crash fires. Defaults to `new Error("mock crash")`. */
  crashError?: unknown
}

// --- Call-record types -----------------------------------------------------

export interface MockQueryControlCalls {
  setModel: Array<string | undefined>
  applyFlagSettings: Array<Record<string, unknown>>
  setPermissionMode: string[]
  setMaxThinkingTokens: Array<number | null>
  interrupt: number
  close: number
  streamInput: number
  stopTask: string[]
  getContextUsage: number
  initializationResult: number
  supportedCommands: number
  supportedModels: number
  supportedAgents: number
  mcpServerStatus: number
  reloadPlugins: number
  accountInfo: number
  rewindFiles: Array<{ userMessageId: string; dryRun?: boolean }>
  seedReadState: Array<{ path: string; mtime: number }>
  reconnectMcpServer: string[]
  toggleMcpServer: Array<{ serverName: string; enabled: boolean }>
  setMcpServers: Array<Record<string, unknown>>
}

function makeEmptyCalls(): MockQueryControlCalls {
  return {
    setModel: [], applyFlagSettings: [], setPermissionMode: [], setMaxThinkingTokens: [],
    interrupt: 0, close: 0, streamInput: 0, stopTask: [],
    getContextUsage: 0, initializationResult: 0, supportedCommands: 0,
    supportedModels: 0, supportedAgents: 0, mcpServerStatus: 0, reloadPlugins: 0,
    accountInfo: 0, rewindFiles: [], seedReadState: [],
    reconnectMcpServer: [], toggleMcpServer: [], setMcpServers: [],
  }
}

// --- Helpers to synthesize empirical events --------------------------------

function makeSystemInit(sessionId: string): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    uuid: `mock-sysinit-${sessionId}`,
    cwd: "/mock",
    tools: [],
    mcp_servers: [],
    model: "mock-model",
    permissionMode: "bypassPermissions",
    apiKeySource: "none" as any,
    slash_commands: [],
    output_style: "default",
    agents: [],
  } as unknown as SDKSystemMessage
}

function makeResult(sessionId: string, turn: MockTurn): SDKResultSuccess {
  const r = turn.result ?? {}
  return {
    type: "result",
    subtype: r.subtype ?? "success",
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: r.numTurns ?? 1,
    result: "",
    stop_reason: r.stopReason ?? "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: r.inputTokens ?? 0,
      output_tokens: r.outputTokens ?? 0,
      cache_creation_input_tokens: r.cacheCreationInputTokens ?? 0,
      cache_read_input_tokens: r.cacheReadInputTokens ?? 0,
    } as any,
    modelUsage: {},
    permission_denials: [],
    uuid: `mock-result-${sessionId}-${Math.random().toString(36).slice(2)}`,
    session_id: sessionId,
  } as unknown as SDKResultSuccess
}

// --- Entry point -----------------------------------------------------------

export interface MockQueryResult {
  query: Query
  calls: MockQueryControlCalls
  /** Messages pushed into the mock's input stream, in order. */
  pushed: SDKUserMessage[]
  /** Session id the mock stamps on every event. Stable across turns. */
  sessionId: string
}

/**
 * Create a mock Query. Consume it the same way you'd consume a real Query:
 * feed it a stream via the `prompt` you pass into the real `query()` API,
 * OR push messages directly via `streamInputMock` on the returned object.
 *
 * This helper takes the opposite approach from the real SDK: YOU construct
 * the mock's input by pushing into its internal queue, since tests don't
 * typically hold onto the AsyncIterable that `query()` reads.
 */
export function createMockQuery(config: MockQueryConfig): MockQueryResult {
  const sessionId = config.sessionId ?? `mock-session-${Math.random().toString(36).slice(2)}`
  const calls = makeEmptyCalls()
  const pushed: SDKUserMessage[] = []

  // Queue of pushed user messages — the mock consumes one per scripted turn.
  const pendingUsers: SDKUserMessage[] = []
  const userWaiters: Array<() => void> = []
  let closed = false

  const pushUser = (msg: SDKUserMessage) => {
    if (closed) return
    pushed.push(msg)
    pendingUsers.push(msg)
    const w = userWaiters.shift()
    if (w) w()
  }

  const awaitUser = () => new Promise<void>((resolve) => {
    if (pendingUsers.length > 0 || closed) resolve()
    else userWaiters.push(resolve)
  })

  async function* generate(): AsyncGenerator<SDKMessage, void> {
    for (let turnIdx = 0; turnIdx < config.turns.length; turnIdx++) {
      if (closed) return
      // Wait for a user message to be pushed before producing this turn's events.
      await awaitUser()
      if (closed) return
      pendingUsers.shift()

      if (config.crashOnTurn != null && turnIdx >= config.crashOnTurn) {
        throw config.crashError ?? new Error("mock crash")
      }

      const turn = config.turns[turnIdx]!
      if (!turn.suppressSystemInit) yield makeSystemInit(sessionId)
      for (const ev of turn.events) {
        // If the test supplied their own result as part of events, honor it
        // and move on without appending a synthetic one.
        yield ev
      }
      // Append a synthesized result unless the last emitted event was already a result.
      const last = turn.events[turn.events.length - 1] as { type?: unknown } | undefined
      if (last?.type !== "result") yield makeResult(sessionId, turn)
    }
    // After all scripted turns are consumed, the generator ends.
  }

  const gen = generate()

  const query: Query = {
    // AsyncGenerator<SDKMessage, void> surface
    next: gen.next.bind(gen),
    return: gen.return.bind(gen),
    throw: gen.throw.bind(gen),
    [Symbol.asyncIterator]() { return this },

    // Control methods — all record the call, most are no-ops.
    interrupt: async () => { calls.interrupt += 1 },
    setPermissionMode: async (mode: string) => { calls.setPermissionMode.push(mode) },
    setModel: async (model?: string) => { calls.setModel.push(model) },
    setMaxThinkingTokens: async (n: number | null) => { calls.setMaxThinkingTokens.push(n) },
    applyFlagSettings: async (settings: Record<string, unknown>) => { calls.applyFlagSettings.push(settings) },
    initializationResult: async () => { calls.initializationResult += 1; return {} as any },
    supportedCommands: async () => { calls.supportedCommands += 1; return [] },
    supportedModels: async () => { calls.supportedModels += 1; return [] },
    supportedAgents: async () => { calls.supportedAgents += 1; return [] },
    mcpServerStatus: async () => { calls.mcpServerStatus += 1; return [] },
    getContextUsage: async () => {
      calls.getContextUsage += 1
      return {} as SDKControlGetContextUsageResponse
    },
    reloadPlugins: async () => { calls.reloadPlugins += 1; return {} as any },
    accountInfo: async () => { calls.accountInfo += 1; return {} as any },
    rewindFiles: async (userMessageId: string, options?: { dryRun?: boolean }) => {
      calls.rewindFiles.push({ userMessageId, dryRun: options?.dryRun })
      return { canRewind: true } as any
    },
    seedReadState: async (path: string, mtime: number) => { calls.seedReadState.push({ path, mtime }) },
    reconnectMcpServer: async (serverName: string) => { calls.reconnectMcpServer.push(serverName) },
    toggleMcpServer: async (serverName: string, enabled: boolean) => { calls.toggleMcpServer.push({ serverName, enabled }) },
    setMcpServers: async (servers: Record<string, unknown>) => {
      calls.setMcpServers.push(servers)
      return { added: [], removed: [], errors: [] } as any
    },
    streamInput: async (stream: AsyncIterable<SDKUserMessage>) => {
      calls.streamInput += 1
      for await (const m of stream) pushUser(m)
    },
    stopTask: async (taskId: string) => { calls.stopTask.push(taskId) },
    close: () => {
      calls.close += 1
      closed = true
      // Wake any awaiting user-queue waiters so the generator can exit
      while (userWaiters.length) userWaiters.shift()!()
    },
  } as unknown as Query

  // Convenience: allow tests to push user messages directly (not via streamInput)
  ;(query as any).__pushUserForTest = pushUser

  return { query, calls, pushed, sessionId }
}

/** Push a user message into a mock query created by `createMockQuery`. */
export function pushUserMessage(query: Query, msg: SDKUserMessage): void {
  const push = (query as any).__pushUserForTest as ((m: SDKUserMessage) => void) | undefined
  if (!push) throw new Error("pushUserMessage: query was not created by createMockQuery")
  push(msg)
}
