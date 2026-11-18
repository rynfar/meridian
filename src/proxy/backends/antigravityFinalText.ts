function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function response(value: unknown): string | undefined {
  const object = record(value)
  if (!object) return
  for (const name of ['modified_response', 'modifiedResponse', 'response']) {
    const text = object[name]
    if (typeof text === 'string' && text.trim()) return text
  }
}

/** Completed planner-response snapshots supplement the ordinary incremental channel. */
export function agFinalTextFrame(value: unknown): { delta?: string; snapshot?: string; channel: string } | undefined {
  const event = record(value)
  if (!event) return
  const update = record(event.step_update)
  const step = record(update?.step) ?? update
  if (update && step && (update.step_type === 'agent_response' || step.type === 15 || step.step_type === 'agent_response')) {
    const snapshot = response(step.planner_response) ?? response(step.plannerResponse) ?? response(step.agent_response) ?? response(step)
    if (snapshot !== undefined) return { snapshot, channel: 'step_update.planner_response' }
    if (typeof update.text_delta === 'string') return { delta: update.text_delta, channel: 'step_update.text_delta' }
  }
  const result = record(event.result)
  if (event.event === 'result' && result?.status === 'SUCCESS' && !result.error) {
    const snapshot = response(result.planner_response) ?? response(result.plannerResponse) ?? response(result.agent_response) ?? response(result)
    if (snapshot !== undefined) return { snapshot, channel: 'result.planner_response' }
  }
}

/** Step indices fence deferred output from completed inputs, including native recovery. */
export class AgTextCursor {
  after = -1
  committedThrough = -1
  inputStep?: number
  private observedThrough = -1
  private requireIndex = false
  private awaitingInput = false
  begin(marker?: number): void {
    this.after = Math.max(marker ?? -1, this.committedThrough)
    this.observedThrough = this.after
    this.inputStep = undefined
    this.requireIndex ||= marker !== undefined
    this.awaitingInput = this.requireIndex
  }
  nextPhase(marker?: number): void {
    this.after = Math.max(this.after, marker ?? -1, this.observedThrough, this.committedThrough)
    this.observedThrough = this.after
    this.requireIndex ||= marker !== undefined
  }
  commit(recoveredStep?: number): void {
    this.committedThrough = Math.max(this.committedThrough, this.observedThrough, recoveredStep ?? -1)
    this.after = Math.max(this.after, this.committedThrough)
    this.requireIndex ||= recoveredStep !== undefined
  }
  observe(value: unknown, conversationId?: string): { textAllowed: boolean; stale: boolean; stepIndex?: number; cidMismatch?: boolean } {
    const event = record(value) ?? {}, update = record(event.step_update), step = record(update?.step) ?? update
    for (const cid of [event.conversation_id, update?.conversation_id, step !== update ? step?.conversation_id : undefined, record(event.result)?.conversation_id]) {
      if (typeof cid === 'string' && conversationId && cid !== conversationId) return { textAllowed: false, stale: true, cidMismatch: true }
    }
    const index = update?.step_index ?? step?.step_index
    if (index !== undefined) {
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return { textAllowed: false, stale: true }
      if (index <= this.after) return { textAllowed: false, stale: true, stepIndex: index }
      this.requireIndex = true
      if (update?.step_type === 'user_input' || step?.step_type === 'user_input' || step?.type === 14) {
        this.inputStep = index
        this.after = index
        this.awaitingInput = false
        this.observedThrough = Math.max(this.observedThrough, index)
        return { textAllowed: false, stale: false, stepIndex: index }
      }
      if (this.awaitingInput) return { textAllowed: false, stale: true, stepIndex: index }
      this.observedThrough = Math.max(this.observedThrough, index)
      return { textAllowed: true, stale: false, stepIndex: index }
    }
    // Legacy streams without indices remain supported until a native/indexed boundary exists.
    return { textAllowed: !this.requireIndex, stale: false }
  }
}

export class AgFinalText {
  text = ''
  published = 0
  channel = 'none'
  ignoredSnapshots = 0
  get visible(): boolean { return this.text.trim().length > 0 }
  accept(value: unknown): void {
    const frame = agFinalTextFrame(value)
    if (!frame) return
    if (frame.snapshot !== undefined) {
      if (frame.snapshot.startsWith(this.text)) this.text = frame.snapshot
      else if (!this.text.startsWith(frame.snapshot)) {
        // Once bytes are already published, take() slices from published; replacing text would corrupt output.
        if (this.published === 0) this.text = frame.snapshot
        else { this.ignoredSnapshots++; return }
      }
    } else if (frame.delta) this.text += frame.delta
    this.channel = frame.channel
  }
  take(): string {
    const text = this.text.slice(this.published)
    this.published = this.text.length
    return text
  }
}

/** Shape-only diagnostics: no text, arguments, reasoning, credentials or arbitrary string values. */
export function agEventShape(value: unknown): Record<string, unknown> {
  const event = record(value) ?? {}
  const update = record(event.step_update) ?? {}
  const result = record(event.result) ?? {}
  const label = (value: unknown) => typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) : undefined
  return {
    event: label(event.event), type: label(update.step_type), state: label(update.state),
    keys: Object.keys(event).slice(0, 24).map(key => key.slice(0, 64)),
    updateKeys: Object.keys(update).slice(0, 24).map(key => key.slice(0, 64)),
    resultKeys: Object.keys(result).slice(0, 24).map(key => key.slice(0, 64)),
  }
}
