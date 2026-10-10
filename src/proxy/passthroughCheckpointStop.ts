import { isClientForwardedToolUse } from "./passthroughEarlyStop"
import { PASSTHROUGH_DENY_REASON } from "./passthroughDenial"

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
}

/** JSON-only identity; no customer inputs or SDK error text leave this module. */
function inputIdentity(value: unknown): string | undefined {
  let remaining = 16_384
  const encode = (item: unknown, depth: number): string | undefined => {
    if (--remaining < 0 || depth > 64) return undefined
    if (item === null) return "null"
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item)
    if (typeof item === "number") return Number.isFinite(item) ? JSON.stringify(item) : undefined
    const values = Array.isArray(item) ? item : object(item)
    if (!values) return undefined
    if (!Array.isArray(values) && ![Object.prototype, null].includes(Object.getPrototypeOf(values))) return undefined
    const parts: string[] = []
    for (const key of Array.isArray(values) ? Object.keys(values) : Object.keys(values).sort()) {
      const child = encode(Array.isArray(values) ? values[Number(key)] : values[key], depth + 1)
      if (child === undefined) return undefined
      parts.push(Array.isArray(values) ? child : `${JSON.stringify(key)}:${child}`)
    }
    return Array.isArray(values) ? `[${parts.join(",")}]` : `{${parts.join(",")}}`
  }
  const result = encode(value, 0)
  return result !== undefined && result.length <= 1_048_576 ? result : undefined
}

export class PassthroughCheckpointStopError extends Error {
  constructor(cause?: unknown) {
    super("Passthrough checkpoint control did not qualify a durable terminal", { cause })
    this.name = "PassthroughCheckpointStopError"
  }
}

interface ToolWitness { name: string; input: string }

/** One instance belongs to one admitted Query, including its hook callbacks.
 * No cache, session-store, process or server dependencies. Caller owns joins. */
export class PassthroughCheckpointStop {
  private interrupt: (() => Promise<void>) | undefined
  private retired = false
  private sessionId: string | undefined
  private generationId: string | undefined
  private readonly generations = new Set<string>()
  private boundary = false
  private stopReason: unknown
  private unsafeGeneration = false
  private readonly openBlocks = new Set<number>()
  private readonly toolBlocks = new Map<number, string>()
  private readonly streamed = new Map<string, string>()
  private readonly closedTools = new Set<string>()
  private readonly metadata = new Map<string, ToolWitness>()
  private readonly hooks = new Map<string, ToolWitness>()
  private readonly results = new Set<string>()
  private readonly holds = new Map<string, () => void>()
  private uuid: string | undefined
  private intent: { sessionId: string; generationId: string; uuid: string; ids: string[] } | undefined
  private acknowledged = false
  private qualified = false
  private resultErrors: string[] | undefined
  private terminalMatches = false
  private terminalSeen = false
  private fault: unknown
  private faulted = false
  private controlWork: Promise<void> | undefined
  private interruptSettled = true
  private readonly abort = () => { this.releaseHolds() }

  constructor(private readonly options: {
    signal: AbortSignal
    clientToolPrefix: string
    maxTurns: number
    acknowledgementMs?: number
  }) {
    options.signal.addEventListener("abort", this.abort, { once: true })
  }

  attach(interrupt: (() => Promise<void>) | undefined): void {
    if (!this.retired) this.interrupt = interrupt
  }

  private fail(cause: unknown): void {
    if (!this.faulted) { this.faulted = true; this.fault = cause }
    this.releaseHolds()
  }

  private name(name: string): string {
    return name.startsWith(this.options.clientToolPrefix)
      ? name.slice(this.options.clientToolPrefix.length) : name
  }

  private releaseHolds(): void {
    for (const release of this.holds.values()) release()
    this.holds.clear()
  }

  /** Wrap only the accepted forwarding denial, after the original hook returns.
   * Duplicate/dropped calls and SDK-owned tools retain their original behavior. */
  async holdDeniedHook(input: unknown, output: unknown): Promise<void> {
    if (!this.interrupt || this.retired || this.faulted || this.options.signal.aborted) return
    // Unsupported native work keeps its existing hook/drain behavior. It
    // cannot own this generation's stop, but is not itself an SDK failure.
    if (this.unsafeGeneration && !this.intent) return
    const hook = object(input), response = object(output)
    if (hook?.hook_event_name !== "PreToolUse" || response?.decision !== "block" ||
        response.reason !== PASSTHROUGH_DENY_REASON) return
    if (!isClientForwardedToolUse({ type: "tool_use", id: hook.tool_use_id, name: hook.tool_name }, this.options.clientToolPrefix)) return
    if (hook.agent_id !== undefined) {
      if (!this.intent) { this.unsafeGeneration = true; this.releaseHolds(); return }
      this.fail(new Error("Nested SDK hook cannot own the retained checkpoint")); return
    }
    if (!this.sessionId || hook.session_id !== this.sessionId) {
      this.fail(new Error("Forwarded hook belongs to another admitted session")); return
    }
    if (!id(hook.tool_use_id) || !id(hook.tool_name)) return
    const identity = inputIdentity(hook.tool_input)
    if (identity === undefined || this.hooks.has(hook.tool_use_id)) {
      this.fail(new Error("Forwarded hook identity is incomplete or repeated"))
      return
    }
    this.hooks.set(hook.tool_use_id, { name: this.name(hook.tool_name), input: identity })
    if (this.intent) {
      this.fail(new Error("Forwarded hook does not belong to the retained generation"))
      return
    }
    const held = new Promise<void>(resolve => { this.holds.set(hook.tool_use_id as string, resolve) })
    this.advance()
    await held
  }

  observe(value: unknown): void {
    if (!this.interrupt || this.retired) return
    if (this.faulted) throw new PassthroughCheckpointStopError(this.fault)
    const message = object(value)
    if (!message) return
    if (message.parent_tool_use_id !== undefined && message.parent_tool_use_id !== null) {
      if (!this.intent) { this.unsafeGeneration = true; this.releaseHolds(); return }
      this.fail(new Error("Nested SDK work cannot own a client checkpoint"))
      throw new PassthroughCheckpointStopError(this.fault)
    }
    if (message.type === "system" && message.subtype === "init") {
      if (!id(message.session_id) || (this.sessionId && this.sessionId !== message.session_id)) {
        this.fail(new Error("SDK admission identity changed"))
      } else this.sessionId = message.session_id
    } else if (this.sessionId && message.session_id !== undefined && message.session_id !== this.sessionId) {
      this.fail(new Error("SDK event belongs to another admitted session"))
    }
    if ((message.type === "assistant" && message.error) || message.type === "tombstone") {
      // Before intent, leave SDK error classification/retries completely alone.
      if (!this.intent) { this.interrupt = undefined; this.releaseHolds(); return }
      this.fail(new Error("SDK generation failed after checkpoint intent", { cause: message.error }))
    }
    if (message.type === "stream_event") {
      const event = object(message.event)
      if (event?.type === "message_start") {
        const generation = object(event.message)?.id
        if (!id(generation) || this.generations.has(generation) || this.intent || this.openBlocks.size > 0 || this.holds.size > 0) {
          this.fail(new Error("SDK generation boundary is incomplete or superseded"))
        } else {
          this.generationId = generation
          this.generations.add(generation)
          this.boundary = false; this.stopReason = undefined; this.unsafeGeneration = false
          this.toolBlocks.clear(); this.streamed.clear(); this.closedTools.clear()
          this.metadata.clear(); this.hooks.clear(); this.results.clear(); this.uuid = undefined
          if (this.generations.size > this.options.maxTurns) this.fail(new Error("SDK generation budget exceeded"))
        }
      } else if (event?.type === "content_block_start" && Number.isInteger(event.index)) {
        const index = event.index as number
        if (this.openBlocks.has(index) || this.boundary) this.fail(new Error("SDK block boundary repeated"))
        this.openBlocks.add(index)
        const block = object(event.content_block)
        if (block?.type === "tool_use") {
          if (!isClientForwardedToolUse(block, this.options.clientToolPrefix) || !id(block.name)) this.unsafeGeneration = true
          else if (this.streamed.has(block.id)) this.fail(new Error("SDK tool identity repeated"))
          else { this.streamed.set(block.id, this.name(block.name)); this.toolBlocks.set(index, block.id) }
        }
      } else if (event?.type === "content_block_stop" && Number.isInteger(event.index)) {
        const index = event.index as number
        if (!this.openBlocks.delete(index)) this.fail(new Error("SDK closed an unowned block"))
        const tool = this.toolBlocks.get(index)
        if (tool) this.closedTools.add(tool)
      } else if (event?.type === "message_delta") this.stopReason = object(event.delta)?.stop_reason
      else if (event?.type === "message_stop") this.boundary = true
    } else if (message.type === "assistant") {
      const assistant = object(message.message)
      if (Array.isArray(assistant?.content)) {
        for (const raw of assistant.content) {
          const block = object(raw)
          if (block?.type !== "tool_use") continue
          if (!isClientForwardedToolUse(block, this.options.clientToolPrefix) || !id(block.name)) {
            this.unsafeGeneration = true; continue
          }
          const identity = inputIdentity(block.input)
          const previous = this.metadata.get(block.id)
          if (assistant?.id !== this.generationId || identity === undefined ||
              (previous && (previous.input !== identity || previous.name !== this.name(block.name)))) {
            this.fail(new Error("SDK tool metadata is incomplete, conflicting or belongs to another generation"))
          } else if (previous) {
            // A full assistant snapshot may repeat an earlier fragment. Keep
            // the UUID of the final newly observed call, as the tracker does.
            continue
          } else {
            this.metadata.set(block.id, { name: this.name(block.name), input: identity })
            // The last tool-bearing fragment must have a usable assistant UUID.
            this.uuid = id(message.uuid) ? message.uuid : undefined
          }
        }
      }
    } else if (message.type === "user") {
      const user = object(message.message)
      if (Array.isArray(user?.content)) for (const raw of user.content) {
        const block = object(raw)
        if (block?.type !== "tool_result" || !id(block.tool_use_id) || !this.streamed.has(block.tool_use_id)) continue
        if (block.is_error !== true) this.fail(new Error("A forwarded SDK tool result was not denied"))
        if (this.results.has(block.tool_use_id)) this.fail(new Error("SDK checkpoint result repeated"))
        this.results.add(block.tool_use_id)
      }
    } else if (message.type === "result") {
      if (this.terminalSeen) this.fail(new Error("SDK terminal result repeated"))
      this.terminalSeen = true
      const errors = message.errors
      this.resultErrors = Array.isArray(errors) && errors.length > 0 && errors.every(error => typeof error === "string") ? errors : undefined
      // NOTE: Native counters include tool handling, not just API generations:
      // pinned cap-two/two-tool interruption reports four, cap-four/three-tool
      // interruption reports five. Keep the original Query cap and independently
      // enforce public generation bounds. Cap one has its own observed terminal
      // subtype/counter, still bound to the same acknowledged aborted-tools stop.
      const resultKindMatches = message.subtype === "error_during_execution"
        ? Number.isSafeInteger(message.num_turns) && (message.num_turns as number) > 0
        : this.options.maxTurns === 1 && this.generations.size === 1 &&
          message.subtype === "error_max_turns" && message.num_turns === 2
      // NOTE: SDK 0.2.141/native 2.1.284 and 2.1.296 can acknowledge our
      // complete tool checkpoint while the provider's SSE body is still open.
      // Interrupting that transport reports aborted_streaming with this exact
      // public diagnostic. It is not evidence of an incomplete generation:
      // acceptsIteratorError still binds every closed block, UUID, hook and
      // denial to the acknowledged intent before granting publication.
      const completedToolStreamAbort = message.terminal_reason === "aborted_streaming" &&
        message.subtype === "error_during_execution" && this.resultErrors?.length === 1 &&
        this.resultErrors[0] === "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"
      this.terminalMatches = Boolean(this.intent && this.acknowledged &&
        message.session_id === this.intent.sessionId && resultKindMatches &&
        message.is_error === true && (message.terminal_reason === "aborted_tools" || completedToolStreamAbort) &&
        this.generations.size <= this.options.maxTurns && this.resultErrors)
    }
    this.advance()
    if (this.faulted) throw new PassthroughCheckpointStopError(this.fault)
  }

  private complete(): boolean {
    return Boolean(this.sessionId && this.generationId && this.uuid && this.boundary &&
      this.stopReason === "tool_use" && this.openBlocks.size === 0 && this.streamed.size > 0 &&
      this.streamed.size === this.metadata.size && this.streamed.size === this.closedTools.size &&
      [...this.streamed].every(([tool, name]) => this.closedTools.has(tool) && this.metadata.get(tool)?.name === name))
  }

  private advance(): void {
    if (this.faulted || this.retired || this.options.signal.aborted || this.unsafeGeneration) {
      this.releaseHolds(); return
    }
    if (this.intent || !this.complete() || !this.interrupt) return
    if (this.hooks.size < this.streamed.size) {
      // Holding every denial deadlocks serial native hook dispatch. Once the
      // entire generation is complete, allow its observed prefix to settle.
      this.releaseHolds(); return
    }
    if (this.hooks.size !== this.streamed.size || ![...this.metadata].every(([tool, witness]) => {
      const hook = this.hooks.get(tool)
      return hook?.name === witness.name && hook.input === witness.input
    })) {
      this.fail(new Error("Forwarded hook set or input does not match complete SDK metadata")); return
    }
    if (this.holds.size === 0) { this.fail(new Error("Final forwarded hook is not retained")); return }
    this.intent = { sessionId: this.sessionId!, generationId: this.generationId!, uuid: this.uuid!, ids: [...this.streamed.keys()] }
    const interrupt = this.interrupt
    this.controlWork = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let returned = false
      try {
        this.interruptSettled = false
        const requested = interrupt()
        returned = true
        const pending = requested.then(
          () => { this.interruptSettled = true },
          error => { this.interruptSettled = true; throw error },
        )
        await Promise.race([pending, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Checkpoint interrupt acknowledgement timed out")), this.options.acknowledgementMs ?? 3_000)
        })])
        if (!this.retired && !this.options.signal.aborted && !this.terminalSeen) this.acknowledged = true
        else this.fail(new Error("Checkpoint acknowledgement arrived after retirement or terminal"))
      } catch (error) {
        if (!returned) this.interruptSettled = true
        this.fail(error)
      }
      finally { clearTimeout(timer); this.releaseHolds() }
    })()
  }

  acceptsIteratorError(error: unknown): boolean {
    if (!this.intent || this.faulted || this.retired || this.options.signal.aborted || !this.terminalMatches ||
        this.results.size !== this.intent.ids.length || !this.intent.ids.every(tool => this.results.has(tool)) ||
        !this.complete() || this.intent.uuid !== this.uuid || this.intent.generationId !== this.generationId ||
        !(error instanceof Error) || !this.resultErrors ||
        error.message !== `Claude Code returned an error result: ${this.resultErrors.join("; ")}`) return false
    this.qualified = true
    return true
  }

  /** Retire synchronously before any cleanup await; old callbacks cannot act. */
  async retire(): Promise<void> {
    this.retired = true
    this.interrupt = undefined
    this.releaseHolds()
    this.options.signal.removeEventListener("abort", this.abort)
    await this.controlWork
  }

  get requested(): boolean { return this.intent !== undefined }
  get controlJoined(): boolean { return this.interruptSettled }
  get failure(): unknown { return this.fault }
  get failed(): boolean { return this.faulted || (this.requested && !this.qualified && !this.options.signal.aborted) }
  get receipt(): { acknowledged: boolean; qualified: boolean; generations: number; tools: number } {
    return { acknowledged: this.acknowledged, qualified: this.qualified, generations: this.generations.size, tools: this.intent?.ids.length ?? 0 }
  }
}
