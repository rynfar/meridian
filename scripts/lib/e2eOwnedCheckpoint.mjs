// Independent E72 observer. It never calls the production stop controller or
// accepts its log receipt. Public Query events, hooks and interrupt settlement
// are correlated privately; summaries expose no IDs, inputs or native prose.
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256
function identity(value) {
  // Independent structural token encoding, with an explicit work list rather
  // than recursion. Never import the production identity or trust its receipt.
  const work = [{ value }], active = new Set(), tokens = []
  try {
    while (work.length) {
      const task = work.pop()
      if ('leave' in task) { active.delete(task.leave); tokens.push('end'); continue }
      if ('key' in task) { tokens.push(['key', task.key]); continue }
      const item = task.value
      if (item === null || ['string', 'boolean'].includes(typeof item) || typeof item === 'number' && Number.isFinite(item)) {
        tokens.push(['scalar', item]); continue
      }
      if (!item || typeof item !== 'object' || active.has(item)) return undefined
      const array = Array.isArray(item), keys = Object.keys(item)
      if (array) {
        if (keys.length !== item.length || keys.some((key, index) => key !== String(index))) return undefined
      } else {
        if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) return undefined
        keys.sort()
      }
      tokens.push(array ? 'array' : 'object'); active.add(item); work.push({ leave: item })
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index], descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor || !('value' in descriptor)) return undefined
        work.push({ value: descriptor.value })
        if (!array) work.push({ key })
      }
    }
    return JSON.stringify(tokens)
  } catch { return undefined }
}

export function createOwnedCheckpointWitness({ maxTurns, signal, forwardedReason, clientToolPrefix = 'mcp__oc__' }) {
  let session, current, intent, terminal, errorMatched = false, finished = false, closeCalls = 0, closeFailed = false
  let calls = 0, controlSettled = true, acknowledged = false, fault, sequence = 0
  let denialResultsBeforeHookSettlement = 0
  const seen = new Set(), hooks = new Map(), results = new Set()
  const fail = reason => { fault ??= reason }
  const abort = () => { if (!finished) fail('aborted') }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const name = value => id(value) && value.startsWith(clientToolPrefix) && value.length > clientToolPrefix.length ? value.slice(clientToolPrefix.length) : undefined
  const complete = () => Boolean(current && !current.unsafe && current.stopped && current.reason === 'tool_use' && current.open.size === 0 && id(current.uuid) && current.tools.size > 0 && current.tools.size === current.metadata.size && [...current.tools].every(([tool, toolName]) => current.closed.has(tool) && current.metadata.get(tool)?.name === toolName))
  const hooksMatch = () => Boolean(current && hooks.size === current.tools.size && [...current.metadata].every(([tool, metadata]) => { const hook = hooks.get(tool); return hook?.name === metadata.name && hook.input === metadata.input && hook.session === session && hook.root && !hook.failed && (!hook.returned || hook.forwarded) }))
  return {
    hookStarted(event, toolId) {
      sequence++
      if (finished || intent || !id(toolId) || event?.tool_use_id !== toolId || hooks.has(toolId) || hooks.size >= 1024) { fail('hook-identity'); return }
      hooks.set(toolId, { name: name(event.tool_name), input: identity(event.tool_input), session: event.session_id, root: event.hook_event_name === 'PreToolUse' && event.agent_id === undefined, returned: false, forwarded: false, failed: false })
    },
    hookSettled(toolId, output, failed = false) {
      sequence++
      const hook = hooks.get(toolId)
      if (!hook || hook.returned || finished) { fail('hook-settlement'); return }
      hook.returned = true; hook.failed = failed
      hook.forwarded = output?.decision === 'block' && output.reason === forwardedReason
      if (intent && ((toolId === intent.retainedHook && !acknowledged) || failed || !hook.forwarded)) fail('hook-before-ack-or-refusal')
    },
    observe(event) {
      sequence++
      if (finished) { fail('event-after-retirement'); return }
      if (event?.type === 'system' && event.subtype === 'init') {
        if (!id(event.session_id) || (session && session !== event.session_id)) fail('session')
        else session = event.session_id
      }
      if (session && event?.session_id !== undefined && event.session_id !== session) fail('session')
      const nested = event?.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null
      if (nested || (event?.type === 'assistant' && event.error) || event?.type === 'tombstone') {
        if (intent) fail('nested-or-error-after-intent')
        else if (current) current.unsafe = true
      }
      if (event?.type === 'stream_event') {
        const stream = event.event
        if (stream?.type === 'message_start') {
          if (intent || !id(stream.message?.id) || seen.has(stream.message.id) || seen.size >= 128 || (current && (!current.stopped || current.open.size > 0 || [...hooks.values()].some(hook => !hook.returned)))) fail('generation')
          else {
            seen.add(stream.message.id); hooks.clear(); results.clear()
            current = { id: stream.message.id, open: new Set(), blocks: new Map(), tools: new Map(), closed: new Set(), metadata: new Map(), stopped: false, unsafe: nested, reason: undefined, uuid: undefined }
            if (!Number.isSafeInteger(maxTurns) || seen.size > maxTurns) fail('generation-cap')
          }
        } else if (current && stream?.type === 'content_block_start') {
          if (!Number.isInteger(stream.index) || stream.index < 0 || current.open.has(stream.index) || current.stopped || current.open.size >= 1024) { fail('block'); return }
          current.open.add(stream.index)
          const block = stream.content_block
          if (block?.type === 'tool_use') {
            const toolName = name(block.name)
            if (!toolName) current.unsafe = true
            else if (!id(block.id) || current.tools.has(block.id) || current.tools.size >= 1024) fail('tool-identity')
            else { current.tools.set(block.id, toolName); current.blocks.set(stream.index, block.id) }
          }
        } else if (current && stream?.type === 'content_block_stop') {
          if (!current.open.delete(stream.index)) fail('block')
          if (current.blocks.has(stream.index)) current.closed.add(current.blocks.get(stream.index))
        } else if (current && stream?.type === 'message_delta') current.reason = stream.delta?.stop_reason
        else if (current && stream?.type === 'message_stop') { if (current.stopped) fail('block'); current.stopped = true }
      } else if (event?.type === 'assistant' && current) {
        for (const block of event.message?.content ?? []) {
          if (block?.type !== 'tool_use') continue
          const toolName = name(block.name), input = identity(block.input), previous = current.metadata.get(block.id)
          if (!toolName) { current.unsafe = true; continue }
          if (event.message.id !== current.id || !id(block.id) || input === undefined || current.metadata.size >= 1024) { fail('metadata'); continue }
          if (previous) { if (previous.name !== toolName || previous.input !== input) fail('metadata'); continue }
          current.metadata.set(block.id, { name: toolName, input }); current.uuid = event.uuid
        }
      } else if (event?.type === 'user' && current) {
        for (const block of event.message?.content ?? []) if (block?.type === 'tool_result') {
          const hook = hooks.get(block.tool_use_id)
          if (!current.tools.has(block.tool_use_id)) { if (intent) fail('denial-result'); continue }
          if (results.has(block.tool_use_id) || block.is_error !== true) fail('denial-result')
          else {
            // SDK delivery and callback promise settlement are separate public
            // channels. A buffered prefix result may be yielded before our
            // awaiting wrapper resumes. Final qualification still requires the
            // matching hook's exact forwarding denial and settled control.
            if (!hook?.returned) denialResultsBeforeHookSettlement++
            results.add(block.tool_use_id)
          }
        }
      } else if (event?.type === 'result') {
        if (terminal) fail('terminal')
        const subtype = event.subtype === 'error_during_execution' && Number.isSafeInteger(event.num_turns) && event.num_turns > 0 || maxTurns === 1 && seen.size === 1 && event.subtype === 'error_max_turns' && event.num_turns === 2
        const errors = Array.isArray(event.errors) && event.errors.length > 0 && event.errors.length <= 64 && event.errors.every(value => typeof value === 'string' && value.length <= 1048576) ? event.errors : undefined
        // Independently recorded public native tuple, not a production receipt.
        // Unknown streaming errors remain unqualified even after an interrupt.
        const completeToolStreamAbort = event.terminal_reason === 'aborted_streaming' && event.subtype === 'error_during_execution' && errors?.length === 1 && errors[0] === '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'
        const reason = event.terminal_reason === 'aborted_tools' ? 'aborted_tools' : completeToolStreamAbort ? 'aborted_streaming' : undefined
        terminal = { matches: Boolean(intent && acknowledged && event.session_id === session && subtype && event.is_error === true && reason && errors), reason, errors: errors?.slice() }
      }
    },
    interruptRequested() {
      sequence++; calls++; controlSettled = false
      const retainedHook = [...hooks.keys()].at(-1)
      if (finished || calls !== 1 || terminal || fault || !session || !complete() || !hooksMatch() || !retainedHook || hooks.get(retainedHook).returned) { fail('interrupt-intent'); return }
      intent = { session, generation: current.id, uuid: current.uuid, ids: [...current.tools.keys()], retainedHook, sequence }
    },
    interruptSettled(ok) {
      sequence++
      if (controlSettled || !calls) fail('interrupt-settlement')
      controlSettled = true
      if (!ok || finished || terminal || !intent || fault || !complete() || !hooksMatch()) fail('interrupt-ack')
      else acknowledged = true
    },
    iteratorError(error) {
      sequence++
      errorMatched = Boolean(terminal?.matches && terminal.errors && error instanceof Error && error.message === `Claude Code returned an error result: ${terminal.errors.join('; ')}`)
      if (calls && !errorMatched) fail('iterator-error')
    },
    iteratorSettled() {
      sequence++
      if (finished || (calls && (!controlSettled || !errorMatched))) fail('iterator-settlement')
      finished = true; signal?.removeEventListener('abort', abort)
    },
    close(failed = false) {
      sequence++; closeCalls++; closeFailed ||= failed
      if (!finished && calls) fail('close-before-retirement')
    },
    summary() {
      const hookResultsMatch = hooksMatch() && [...hooks.values()].every(hook => hook.returned && hook.forwarded && !hook.failed)
      const qualified = Boolean(calls === 1 && !fault && intent && acknowledged && controlSettled && terminal?.matches && errorMatched && finished && closeCalls > 0 && !closeFailed && complete() && hookResultsMatch && results.size === intent.ids.length && intent.ids.every(tool => results.has(tool)) && intent.session === session && intent.generation === current.id && intent.uuid === current.uuid)
      return { protocol: 'owned-interrupt-v1', requested: calls > 0, calls, acknowledged, controlSettled, iteratorErrorMatched: errorMatched, iteratorSettled: finished, closeObserved: closeCalls > 0, closeFailed, completeGeneration: complete(), hookResultsMatch, denialResults: results.size, denialResultsBeforeHookSettlement, generations: seen.size, tools: intent?.ids.length ?? 0, terminalReason: terminal?.matches ? terminal.reason : null, fault: fault ?? null, qualified }
    },
  }
}

export function ownedCheckpointNativeResult(row, { sdkVersion, nativeVersion }) {
  if (sdkVersion !== '0.2.141' || !['2.1.284', '2.1.295', '2.1.296'].includes(nativeVersion)) return false
  const g = row.generations, stop = row.ownedCheckpoint
  if (!g?.completeGenerationIds || g.overflow || g.missingGenerationIds || g.missingToolIds || g.conflictingToolOwners || g.uncorrelatedHooks || g.overlappingStreamStarts || g.uncorrelatedStopEvents || !Number.isSafeInteger(row.maxTurns) || row.maxTurns < 1 || !Number.isSafeInteger(g.distinctGenerations) || g.distinctGenerations < 1 || g.distinctGenerations > row.maxTurns || !row.resultFlagValid || !row.sdkToolHookCustody) return false
  if (!stop || stop.protocol !== 'owned-interrupt-v1') return false
  if (!stop.requested) return row.resultSubtype === 'success' && row.resultIsError === false
  if (row.terminalReason === 'aborted_streaming' && !['2.1.284', '2.1.296'].includes(nativeVersion)) return false
  return stop.qualified === true && stop.generations === g.distinctGenerations && stop.tools === row.toolCount && row.explicitlyDroppedSdkToolCount === 0 && row.canonicalHttpToolTerminal === true && row.resultIsError === true && row.terminalReason === stop.terminalReason && ['aborted_tools', 'aborted_streaming'].includes(row.terminalReason) && (row.resultSubtype === 'error_during_execution' || row.terminalReason === 'aborted_tools' && row.maxTurns === 1 && row.resultSubtype === 'error_max_turns' && row.nativeTurns === 2)
}
