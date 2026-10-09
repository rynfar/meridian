// Public SDK events only. Identifiers stay in bounded private maps; summaries
// contain ordinals, counts, booleans and monotonic times, never event payloads.
export function publicToolCapabilities(names) {
  const present = Array.isArray(names)
  const valid = present && names.every(name => typeof name === 'string' && name.length > 0 && name.length <= 256)
  const has = name => present && names.includes(name)
  return { catalogPresent: present, catalogValid: valid, taskOutput: has('TaskOutput'), read: has('Read'), clientMcpTaskOutput: has('mcp__oc__TaskOutput'), clientMcpRead: has('mcp__oc__Read'), clientMcpWildcard: has('mcp__oc__*') }
}

export function createPublicSdkGenerationWitness({ now, maximumGenerations = 128, maximumTools = 1024 }) {
  const generations = new Map(), tools = new Map(), hooks = new Map()
  let assistantEvents = 0, streamStarts = 0, missingGenerationIds = 0, missingToolIds = 0, conflictingToolOwners = 0, overflow = false
  const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 256
  return {
    observe(event) {
      const assistant = event.type === 'assistant'
      const start = event.type === 'stream_event' && event.event?.type === 'message_start'
      if (!assistant && !start) return
      if (assistant) assistantEvents++; else streamStarts++
      const message = assistant ? event.message : event.event.message
      if (!validId(message?.id)) { missingGenerationIds++; return }
      let generation = generations.get(message.id)
      if (!generation) {
        if (generations.size >= maximumGenerations) { overflow = true; return }
        generation = { number: generations.size + 1, firstEventMs: now(), lastEventMs: null, assistantEvents: 0, streamStarts: 0 }
        generations.set(message.id, generation)
      }
      generation.lastEventMs = now()
      if (assistant) generation.assistantEvents++; else generation.streamStarts++
      if (!assistant || !Array.isArray(message.content)) return
      for (const block of message.content) {
        if (block?.type !== 'tool_use') continue
        if (!validId(block.id)) { missingToolIds++; continue }
        if (tools.has(block.id)) {
          if (tools.get(block.id) !== generation.number) conflictingToolOwners++
        } else if (tools.size < maximumTools) tools.set(block.id, generation.number)
        else overflow = true
      }
    },
    observeHook(id, fate) {
      if (!validId(id)) { missingToolIds++; return }
      if (!hooks.has(id) && hooks.size >= maximumTools) { overflow = true; return }
      const previous = hooks.get(id)
      // Retain the first hook observation; a repeated hook is diagnostic data,
      // not authority to overwrite a previously forwarded or refused call.
      if (previous) { previous.observations++; return }
      hooks.set(id, { observedMs: now(), fate: ['forwarded', 'dropped'].includes(fate) ? fate : 'unknown', observations: 1 })
    },
    summary() {
      const rows = [...generations.values()].map(generation => {
        const ids = [...tools].filter(([, owner]) => owner === generation.number).map(([id]) => id)
        const receipts = ids.map(id => hooks.get(id)).filter(Boolean)
        return { ...generation, distinctTools: ids.length, toolHooks: receipts.length,
          forwardedHooks: receipts.filter(receipt => receipt.fate === 'forwarded').length,
          droppedHooks: receipts.filter(receipt => receipt.fate === 'dropped').length,
          unknownHooks: receipts.filter(receipt => receipt.fate === 'unknown').length,
          repeatedHookEvents: receipts.reduce((sum, receipt) => sum + receipt.observations - 1, 0),
          firstHookMs: receipts.length ? Math.min(...receipts.map(receipt => receipt.observedMs)) : null }
      })
      return { assistantEvents, streamStarts, distinctGenerations: generations.size, missingGenerationIds, missingToolIds, conflictingToolOwners, overflow,
        completeGenerationIds: assistantEvents + streamStarts > 0 && missingGenerationIds === 0 && !overflow,
        uncorrelatedHooks: [...hooks.keys()].filter(id => !tools.has(id)).length, generations: rows }
    },
  }
}
