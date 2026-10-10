import { describe, expect, it } from 'bun:test'
import { createOwnedCheckpointWitness, ownedCheckpointNativeResult } from '../../scripts/lib/e2eOwnedCheckpoint.mjs'
import { PASSTHROUGH_DENY_REASON } from '../proxy/passthroughDenial'

function fixture(cap = 4, input?: unknown) {
  const abort = new AbortController()
  const witness = createOwnedCheckpointWitness({ maxTurns: cap, signal: abort.signal, forwardedReason: PASSTHROUGH_DENY_REASON })
  const session = 'private-session', generation = 'private-generation', uuid = 'private-uuid'
  const content = [1, 2].map(number => ({ type: 'tool_use', id: `private-tool-${number}`, name: 'mcp__oc__Bash', input: input ?? { nested: { b: 2, a: 1 }, ordinal: number } }))
  const stream = (event: Record<string, unknown>) => witness.observe({ type: 'stream_event', session_id: session, event })
  const metadata = () => witness.observe({ type: 'assistant', session_id: session, uuid, message: { id: generation, content } })
  const hook = (index: number, change: Record<string, unknown> = {}) => witness.hookStarted({ hook_event_name: 'PreToolUse', session_id: session, tool_use_id: content[index]!.id, tool_name: content[index]!.name, tool_input: input ?? { ordinal: index + 1, nested: { a: 1, b: 2 } }, ...change }, content[index]!.id)
  const settle = (index: number, output = { decision: 'block', reason: PASSTHROUGH_DENY_REASON }) => witness.hookSettled(content[index]!.id, output)
  const result = (index: number, change: Record<string, unknown> = {}) => witness.observe({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: content[index]!.id, is_error: true, ...change }] } })
  const terminal = (change: Record<string, unknown> = {}) => witness.observe({ type: 'result', session_id: session, subtype: cap === 1 ? 'error_max_turns' : 'error_during_execution', num_turns: cap === 1 ? 2 : 4, is_error: true, terminal_reason: 'aborted_tools', errors: ['private native failure'], ...change })
  const complete = () => {
    witness.observe({ type: 'system', subtype: 'init', session_id: session })
    stream({ type: 'message_start', message: { id: generation } })
    content.forEach((block, index) => { stream({ type: 'content_block_start', index, content_block: block }); stream({ type: 'content_block_stop', index }) })
    metadata(); stream({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }); stream({ type: 'message_stop' })
  }
  const intent = () => { hook(0); settle(0); result(0); hook(1); witness.interruptRequested() }
  const finish = () => {
    witness.interruptSettled(true); settle(1); result(1); terminal()
    witness.iteratorError(new Error('Claude Code returned an error result: private native failure'))
    witness.iteratorSettled(); witness.close()
  }
  return { witness, abort, stream, metadata, hook, settle, result, terminal, complete, intent, finish }
}

describe('independent owned interrupt observer', () => {
  for (const [label, input, changed] of [
    ['wide array', { values: Array.from({ length: 32768 }, (_, index) => index) }, { values: Array.from({ length: 32768 }, (_, index) => index === 32767 ? -1 : index) }],
    ['large string', { text: 'x'.repeat(1048577) }, { text: 'x'.repeat(1048576) + 'y' }],
    ['deep object', Array.from({ length: 256 }).reduce<unknown>(child => ({ child }), { leaf: true }), Array.from({ length: 256 }).reduce<unknown>(child => ({ child }), { leaf: false })],
  ] as const) {
    it(`independently qualifies valid JSON with a ${label}`, () => {
      const f = fixture(4, JSON.parse(JSON.stringify(input))); f.complete(); f.intent(); f.finish()
      expect(f.witness.summary().qualified).toBe(true)
    })
    it(`independently refuses changed input with a ${label}`, () => {
      const f = fixture(4, input); f.complete(); f.hook(0); f.settle(0); f.result(0)
      f.hook(1, { tool_input: changed }); f.witness.interruptRequested(); f.finish()
      expect(f.witness.summary().qualified).toBe(false)
    })
  }
  it('rejects ambiguous structure and surrogate substitution independently', () => {
    for (const [input, changed] of [[{ text: '\ud800' }, { text: '\ufffd' }], [{ 'a\":1,\"b': 2 }, { a: 1, b: 2 }], [{ a: [[1, 2], [3]] }, { a: [[1], [2, 3]] }]]) {
      const f = fixture(4, input); f.complete(); f.hook(0); f.settle(0); f.result(0)
      f.hook(1, { tool_input: changed }); f.witness.interruptRequested(); f.finish()
      expect(f.witness.summary().qualified).toBe(false)
    }
  })
  it('refuses cyclic/non-JSON/accessor inputs without reading accessors', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    const extra = [1]; Object.assign(extra, { extra: 1 })
    let reads = 0
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { reads++; return 1 } })
    for (const input of [cycle, extra, [1, , 3], new Array(1), accessor, { value: undefined }, { value: NaN }, { value: Infinity }, { value: 1n }, new Date(), Object.create({ inherited: 1 })]) {
      const f = fixture(4, input); f.complete(); f.intent(); f.finish()
      expect(f.witness.summary().qualified).toBe(false)
    }
    expect(reads).toBe(0)
  })
  const diagnostic = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'
  function streamFinish(f: ReturnType<typeof fixture>, changes: Record<string, unknown> = {}) {
    f.witness.interruptSettled(true); f.settle(1); f.result(1)
    f.terminal({ subtype: 'error_during_execution', terminal_reason: 'aborted_streaming', num_turns: 3, errors: [diagnostic], ...changes })
    f.witness.iteratorError(new Error('Claude Code returned an error result: ' + diagnostic)); f.witness.iteratorSettled(); f.witness.close()
  }
  it('independently binds the captured complete-stream abort without a product receipt', () => {
    for (const cap of [1, 4]) {
      const f = fixture(cap); f.complete(); f.intent(); streamFinish(f)
      expect(f.witness.summary()).toMatchObject({ qualified: true, terminalReason: 'aborted_streaming', iteratorErrorMatched: true, completeGeneration: true, hookResultsMatch: true })
    }
  })
  it('rejects altered or unrelated native stream-abort diagnostics', () => {
    for (const changes of [{ errors: ['ordinary streaming error'] }, { errors: [diagnostic, 'another failure'] }, { errors: [diagnostic + ' '] }, { subtype: 'error_max_turns', num_turns: 2 }]) {
      const f = fixture(); f.complete(); f.intent(); streamFinish(f, changes)
      expect(f.witness.summary().qualified).toBe(false)
    }
  })
  it('requires complete blocks, a retained hook and exact denial custody for the new terminal', () => {
    const incomplete = fixture(); incomplete.complete(); incomplete.stream({ type: 'content_block_start', index: 8, content_block: { type: 'text' } }); incomplete.intent(); streamFinish(incomplete)
    expect(incomplete.witness.summary().qualified).toBe(false)
    const missing = fixture(); missing.complete(); missing.intent(); missing.witness.interruptSettled(true); missing.settle(1)
    missing.terminal({ terminal_reason: 'aborted_streaming', errors: [diagnostic] }); missing.witness.iteratorError(new Error('Claude Code returned an error result: ' + diagnostic)); missing.witness.iteratorSettled(); missing.witness.close()
    expect(missing.witness.summary().qualified).toBe(false)
  })
  it('binds cap-one and cap-four stops including a prefix result before intent', () => {
    for (const cap of [1, 4]) {
      const f = fixture(cap); f.complete(); f.intent(); f.finish()
      expect(f.witness.summary()).toMatchObject({ requested: true, acknowledged: true, controlSettled: true, iteratorErrorMatched: true, completeGeneration: true, hookResultsMatch: true, denialResults: 2, generations: 1, tools: 2, fault: null, qualified: true })
      expect(JSON.stringify(f.witness.summary())).not.toContain('private')
    }
  })
  it('does not qualify a result that merely claims aborted tools', () => {
    const f = fixture(); f.complete(); f.terminal(); f.witness.iteratorError(new Error('Claude Code returned an error result: private native failure')); f.witness.iteratorSettled(); f.witness.close()
    expect(f.witness.summary().qualified).toBe(false)
  })
  it('correlates buffered prefix results independently of callback promise scheduling', () => {
    const f = fixture(); f.complete(); f.hook(0); f.result(0); f.settle(0); f.hook(1); f.witness.interruptRequested(); f.finish()
    expect(f.witness.summary()).toMatchObject({ denialResultsBeforeHookSettlement: 1, qualified: true })
  })
  it('still refuses a buffered result when its hook eventually refuses forwarding', () => {
    const f = fixture(); f.complete(); f.hook(0); f.result(0); f.settle(0, { decision: 'block', reason: 'unrelated refusal' }); f.hook(1); f.witness.interruptRequested(); f.finish()
    expect(f.witness.summary().qualified).toBe(false)
  })
  it('requires acknowledgement for the final retained hook while allowing an earlier prefix wrapper to settle', () => {
    const f = fixture(); f.complete(); f.hook(0); f.result(0); f.hook(1); f.witness.interruptRequested(); f.settle(0); f.finish()
    expect(f.witness.summary().qualified).toBe(true)
  })
  it('requires every block closed before the control call', () => {
    const f = fixture(); f.complete(); f.stream({ type: 'content_block_start', index: 8, content_block: { type: 'thinking' } }); f.intent(); f.finish()
    expect(f.witness.summary().qualified).toBe(false)
  })
  for (const [label, change] of Object.entries({ session: { session_id: 'foreign' }, nested: { agent_id: 'private-child' }, input: { tool_input: { ordinal: 99 } }, namespace: { tool_name: 'mcp__foreign__Bash' }, kind: { hook_event_name: 'PostToolUse' } })) {
    it(`rejects ${label} hook ownership`, () => { const f = fixture(); f.complete(); f.hook(0); f.settle(0); f.result(0); f.hook(1, change); f.witness.interruptRequested(); f.finish(); expect(f.witness.summary().qualified).toBe(false) })
  }
  it('requires a still-retained hook at the call', () => {
    const f = fixture(); f.complete(); for (const n of [0, 1]) { f.hook(n); f.settle(n); f.result(n) } f.witness.interruptRequested(); f.finish()
    expect(f.witness.summary().qualified).toBe(false)
  })
  it('rejects hook release before acknowledgement', () => {
    const f = fixture(); f.complete(); f.intent(); f.settle(1); f.finish()
    expect(f.witness.summary().qualified).toBe(false)
  })
  it('does not treat a rejected control or unsettled control as joined', () => {
    for (const reject of [false, true]) {
      const f = fixture(); f.complete(); f.intent(); if (reject) f.witness.interruptSettled(false)
      f.settle(1); f.result(1); f.terminal(); f.witness.iteratorError(new Error('Claude Code returned an error result: private native failure')); f.witness.iteratorSettled(); f.witness.close()
      expect(f.witness.summary().qualified).toBe(false)
      expect(f.witness.summary().controlSettled).toBe(reject)
    }
  })
  for (const [label, change] of Object.entries({ session: { session_id: 'foreign' }, subtype: { subtype: 'success' }, flag: { is_error: false }, reason: { terminal_reason: 'aborted_streaming' }, counter: { num_turns: 0 }, missingErrors: { errors: [] } })) {
    it(`rejects ${label} terminal mismatch`, () => {
      const f = fixture(); f.complete(); f.intent(); f.witness.interruptSettled(true); f.settle(1); f.result(1); f.terminal(change); f.witness.iteratorError(new Error('Claude Code returned an error result: private native failure')); f.witness.iteratorSettled(); f.witness.close()
      expect(f.witness.summary().qualified).toBe(false)
    })
  }
  for (const cause of ['foreign error', 'Claude Code returned an error result: another failure']) {
    it(`retains an unrelated iterator failure (${cause.startsWith('foreign') ? 'generic' : 'result-shaped'})`, () => {
      const f = fixture(); f.complete(); f.intent(); f.witness.interruptSettled(true); f.settle(1); f.result(1); f.terminal(); f.witness.iteratorError(new Error(cause)); f.witness.iteratorSettled(); f.witness.close()
      expect(f.witness.summary().qualified).toBe(false)
    })
  }
  for (const mode of ['abort', 'close', 'extra-generation', 'nested', 'repeated-control', 'duplicate-result', 'metadata', 'uuid', 'close-failure']) {
    it(`refuses ${mode} after intent`, () => {
      const f = fixture(); f.complete(); f.intent()
      if (mode === 'abort') f.abort.abort()
      if (mode === 'close') f.witness.close()
      if (mode === 'extra-generation') f.stream({ type: 'message_start', message: { id: 'later' } })
      if (mode === 'nested') f.witness.observe({ type: 'assistant', parent_tool_use_id: 'nested' })
      if (mode === 'repeated-control') f.witness.interruptRequested()
      if (mode === 'duplicate-result') f.result(0)
      if (mode === 'metadata') f.witness.observe({ type: 'assistant', session_id: 'private-session', uuid: 'private-uuid', message: { id: 'private-generation', content: [{ type: 'tool_use', id: 'private-tool-1', name: 'mcp__oc__Bash', input: { changed: true } }] } })
      if (mode === 'uuid') f.witness.observe({ type: 'assistant', session_id: 'private-session', message: { id: 'private-generation', content: [{ type: 'tool_use', id: 'private-tool-3', name: 'mcp__oc__Bash', input: {} }] } })
      f.finish(); if (mode === 'close-failure') f.witness.close(true)
      expect(f.witness.summary().qualified).toBe(false)
    })
  }
  it('requires close observation and all exact denial results', () => {
    const f = fixture(); f.complete(); f.intent(); f.witness.interruptSettled(true); f.settle(1); f.terminal(); f.witness.iteratorError(new Error('Claude Code returned an error result: private native failure')); f.witness.iteratorSettled()
    expect(f.witness.summary().qualified).toBe(false); f.witness.close(); expect(f.witness.summary().qualified).toBe(false)
  })
})

describe('versioned E72 qualification remains separate from legacy', () => {
  const tuple = { sdkVersion: '0.2.141', nativeVersion: '2.1.296' }
  function row() {
    const f = fixture(); f.complete(); f.intent(); f.finish()
    return { ownedCheckpoint: f.witness.summary(), generations: { completeGenerationIds: true, distinctGenerations: 1 }, maxTurns: 4, resultFlagValid: true, sdkToolHookCustody: true, resultSubtype: 'error_during_execution', resultIsError: true, terminalReason: 'aborted_tools', nativeTurns: 4, canonicalHttpToolTerminal: true, explicitlyDroppedSdkToolCount: 0, toolCount: 2 }
  }
  it('binds the new public terminal reason to its actual witness and only qualified native pins', () => {
    const diagnostic = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'
    const f = fixture(); f.complete(); f.intent(); f.witness.interruptSettled(true); f.settle(1); f.result(1)
    f.terminal({ terminal_reason: 'aborted_streaming', errors: [diagnostic], num_turns: 3 })
    f.witness.iteratorError(new Error('Claude Code returned an error result: ' + diagnostic)); f.witness.iteratorSettled(); f.witness.close()
    const value = { ...row(), ownedCheckpoint: f.witness.summary(), terminalReason: 'aborted_streaming', nativeTurns: 3 }
    for (const nativeVersion of ['2.1.284', '2.1.296']) expect(ownedCheckpointNativeResult(value, { ...tuple, nativeVersion })).toBe(true)
    expect(ownedCheckpointNativeResult(value, { ...tuple, nativeVersion: '2.1.295' })).toBe(false)
    expect(ownedCheckpointNativeResult({ ...row(), terminalReason: 'aborted_streaming' }, tuple)).toBe(false)
    expect(ownedCheckpointNativeResult({ ...value, terminalReason: 'aborted_tools' }, tuple)).toBe(false)
  })
  it('qualifies the recorded source/installed tuples through both independent and HTTP custody', () => { for (const nativeVersion of ['2.1.284', '2.1.295', '2.1.296']) expect(ownedCheckpointNativeResult(row(), { ...tuple, nativeVersion })).toBe(true) })
  it('refuses receipt-only, missing HTTP/hook custody and unqualified versions', () => {
    const value = row()
    for (const change of [{ ownedCheckpoint: undefined }, { ownedCheckpoint: { ...value.ownedCheckpoint, qualified: false } }, { canonicalHttpToolTerminal: false }, { sdkToolHookCustody: false }, { explicitlyDroppedSdkToolCount: 1 }, { toolCount: 3 }, { generations: { ...value.generations, distinctGenerations: 5 } }, { resultSubtype: 'success' }, { terminalReason: 'other' }]) expect(ownedCheckpointNativeResult({ ...value, ...change }, tuple)).toBe(false)
    expect(ownedCheckpointNativeResult(value, { ...tuple, nativeVersion: '2.1.297' })).toBe(false)
    expect(ownedCheckpointNativeResult(value, { ...tuple, sdkVersion: '0.2.142' })).toBe(false)
  })
  it('preserves ordinary successful queries and refuses unowned errors', () => {
    const value = { ...row(), ownedCheckpoint: { protocol: 'owned-interrupt-v1', requested: false }, resultSubtype: 'success', resultIsError: false }
    expect(ownedCheckpointNativeResult(value, tuple)).toBe(true)
    expect(ownedCheckpointNativeResult({ ...value, resultIsError: true }, tuple)).toBe(false)
    expect(ownedCheckpointNativeResult({ ...value, resultSubtype: 'error_max_turns', resultIsError: true }, tuple)).toBe(false)
  })
})
