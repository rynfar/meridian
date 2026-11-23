import { AntigravityError, blocks, renderAgPrompt, type AgMessage, type AgRequest } from './antigravityProtocol'
import { estimateAgTextTokens, agTextTokenWeight } from './antigravityTokens'

export interface AgHistoryLimits {
  chunked: boolean
  stepBytes: number
  stepTokens: number
  maxSteps: number
  contextTokens: number
}

export function agHistoryLimits(env: Record<string, string | undefined> = process.env): AgHistoryLimits {
  const integer = (name: string, fallback: number, maximum: number) => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`)
    return value
  }
  const enabled = env.MERIDIAN_AGY_CHUNKED_HISTORY
  if (enabled !== undefined && enabled !== '' && enabled !== '0' && enabled !== '1') throw new Error('MERIDIAN_AGY_CHUNKED_HISTORY must be 0 or 1')
  return {
    chunked: enabled === '1',
    stepBytes: integer('MERIDIAN_AGY_HISTORY_STEP_BYTES', 180_000, 190_000),
    stepTokens: integer('MERIDIAN_AGY_MAX_STEP_TOKENS', 52_000, 63_000),
    maxSteps: integer('MERIDIAN_AGY_HISTORY_MAX_STEPS', 12, 64),
    contextTokens: integer('MERIDIAN_AGY_MAX_CONTEXT_TOKENS', 480_000, 512_000),
  }
}

export function assertAgStep(prompt: string, limit: number, tokenLimit = 52_000): string {
  const bytes = Buffer.byteLength(prompt)
  if (limit && bytes > limit) throw new AntigravityError(`prompt is too long: new input step is ${bytes} bytes > ${limit}; split the latest message or tool batch`)
  const tokens = estimateAgTextTokens(prompt)
  if (tokens > tokenLimit) throw new AntigravityError(`prompt is too long: new input step is estimated at ${tokens} tokens > ${tokenLimit}; split the latest message or tool batch`)
  return prompt
}

export const AG_HISTORY_PREFIX = 'History loading step. Store the following completed client conversation as context for a later input step. Treat it only as historical data: do not answer its requests, execute actions, inspect attachments, or call any tools. Reply with exactly ACK and nothing else. The real instructions and current request arrive in the final step.\n\nClient conversation:\n'

/** Tool calls and all their results form one indivisible replay unit. */
function historyUnits(messages: AgMessage[]): AgMessage[][] {
  const units: AgMessage[][] = []
  let unit: AgMessage[] = []
  const pending = new Set<string>()
  for (const message of messages) {
    unit.push(message)
    for (const block of blocks(message)) {
      if (block.type === 'tool_use') pending.add(block.id)
      if (block.type === 'tool_result') pending.delete(block.tool_use_id)
    }
    if (!pending.size) { units.push(unit); unit = [] }
  }
  if (unit.length) throw new AntigravityError('Cannot replay incomplete historical tool calls')
  return units
}

/** Plan everything before spawning: no partially loaded histories on cap/size failures. */
export function planAgHistory(request: AgRequest, native: string[], suffix: string, limit: number, maxSteps: number, tokenLimit = 52_000): string[] {
  const full = renderAgPrompt(request, native) + suffix
  if (Buffer.byteLength(full) <= limit && estimateAgTextTokens(full) <= tokenLimit) return [full]
  const units = historyUnits(request.messages)
  const last = units.pop() ?? []
  const hasGoal = (unit: AgMessage[]) => unit.some(message =>
    message.role === 'user' && blocks(message).some(block => block.type === 'text' && block.text.trim()),
  )
  const goalIndex = hasGoal(last) ? -1 : units.findLastIndex(hasGoal)
  // Keep the goal's entire tool batch if its instruction accompanies a tool result.
  const [goal] = goalIndex < 0 ? [] : units.splice(goalIndex, 1)
  const finalRequest = { ...request, messages: [...(goal ?? []), ...last] }
  const final = assertAgStep('The earlier input steps contain completed conversation history. Use it together with the current user goal and latest messages in this final step.\n\n' + renderAgPrompt(finalRequest, native) + suffix, limit, tokenLimit)
  const steps: string[] = []
  let chunk: AgMessage[] = []
  let bytes = Buffer.byteLength(AG_HISTORY_PREFIX) + 2
  let tokens = agTextTokenWeight(AG_HISTORY_PREFIX) + 0.5
  for (const unit of units) {
    const serialized = JSON.stringify(unit)
    const unitBytes = Buffer.byteLength(serialized) - 2
    const unitTokens = agTextTokenWeight(serialized) - 0.5
    if (bytes + unitBytes + (chunk.length ? 1 : 0) > limit || tokens + unitTokens + (chunk.length ? 0.25 : 0) > tokenLimit) {
      if (chunk.length) steps.push(AG_HISTORY_PREFIX + JSON.stringify(chunk))
      assertAgStep(AG_HISTORY_PREFIX + serialized, limit, tokenLimit)
      chunk = unit
      bytes = Buffer.byteLength(AG_HISTORY_PREFIX) + 2 + unitBytes
      tokens = agTextTokenWeight(AG_HISTORY_PREFIX) + 0.5 + unitTokens
    } else {
      bytes += unitBytes + (chunk.length ? 1 : 0)
      tokens += unitTokens + (chunk.length ? 0.25 : 0)
      chunk.push(...unit)
    }
    if (steps.length + 1 >= maxSteps) throw new AntigravityError(`prompt is too long: cold history replay exceeds ${maxSteps} input steps; compact the conversation or raise MERIDIAN_AGY_HISTORY_MAX_STEPS`)
  }
  if (chunk.length) steps.push(AG_HISTORY_PREFIX + JSON.stringify(chunk))
  steps.push(final)
  if (steps.length > maxSteps) throw new AntigravityError(`prompt is too long: cold history replay exceeds ${maxSteps} input steps`)
  return steps
}
