import { describe, expect, it } from 'bun:test'
import { backgroundLaunchOutput, backgroundReadReport, backgroundReadCompletion, backgroundReadNativeResult } from '../../scripts/lib/e2eBackgroundRead.mjs'

const numbered = (text: string) => text.split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n')
const report = 'alpha-1\nalpha-2'
const executionIds = ['private-command-1', 'private-command-2']
const records = () => [
  { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Run alpha-1 and alpha-2' }] } },
  ...executionIds.map(tool_use_id => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id, is_error: false, content: 'executed' }] } })),
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: report }] } },
]
const serialized = (values: unknown[]) => numbered(values.map(value => JSON.stringify(value)).join('\n'))
const completion = () => ({
  receipt: { actor: 0, paired: true, resultMatched: true, startEvent: 10,
    tool: { name: 'Read', request: 5, privateInput: { file_path: '/private/alpha.output' } }, result: { text: numbered(report) } },
  launch: { path: '/private/alpha.output', launch: { result: { request: 3 } } },
  childRequests: [{ terminalEvent: 4 }, { terminalEvent: 7 }, { terminalEvent: 9 }], finalReport: report, executionIds,
})
const native = () => ({ resultFlagValid: true, resultSubtype: 'error_max_turns', resultIsError: true, maxTurns: 1, nativeTurns: 2, terminalReason: 'max_turns', canonicalHttpToolTerminal: true, sdkToolHookCustody: true,
  generations: { completeGenerationIds: true, overflow: false, missingGenerationIds: 0, missingToolIds: 0, conflictingToolOwners: 0, uncorrelatedHooks: 0, distinctGenerations: 1 } })

describe('versioned E72 background Read proof', () => {
  it('extracts one explicit owned handle/path while rejecting missing, duplicated or guessed output fields', () => {
    expect(backgroundLaunchOutput('agentId: private-alpha (internal ID)\noutput_file: /private/alpha.output (final result)')).toEqual({ id: 'private-alpha', path: '/private/alpha.output' })
    for (const text of ['agentId: alpha', 'agentId: alpha\noutput_file: relative', 'agentId: alpha\nagentId: beta\noutput_file: /private/a', 'agentId: alpha\noutput_file: /private/a\noutput_file: /private/b', 'agentId: alpha\noutput_file: /private/a\u0000', 'prompt says output_file: /private/a']) expect(backgroundLaunchOutput(text)).toBeUndefined()
  })
  it('binds a complete numbered final report to the owned HTTP text, rather than matching prompt labels', () => {
    expect(backgroundReadReport(numbered(report), report).matched).toBe(true)
    expect(backgroundReadReport(numbered(report).replaceAll('\t', ':'), report).matched).toBe(true)
    expect(backgroundReadReport(numbered(report) + '\n\n<system-reminder>\nWhenever you read a file, consider its contents.\n</system-reminder>', report).matched).toBe(true)
    for (const text of [numbered('Run alpha-1 and alpha-2'), numbered(JSON.stringify(report)), numbered('quoted ' + report), numbered('alpha-1'), numbered('beta-1\nbeta-2'), report, '2\t' + report, numbered(report) + '\nunknown trailer', '1\talpha-1\n1\talpha-2']) expect(backgroundReadReport(text, report).matched).toBe(false)
  })
  it('requires the final assistant record after both exact successful execution records', () => {
    expect(backgroundReadReport(serialized(records()), report, executionIds)).toEqual({ matched: true, format: 'numbered-records' })
    const values = records()
    for (const bad of [values.slice(0, -1), [...values.slice(0, -1), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: report }] } }], [values.at(-1), ...values.slice(0, -1)], [...values, values.at(-1)], [values[0], values[1], values.at(-1)], [...values.slice(0, -1), { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'quoted ' + report }] } }]]) expect(backgroundReadReport(serialized(bad), report, executionIds).matched).toBe(false)
    const failed = records(); failed[1] = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: executionIds[0]!, is_error: true, content: 'failed' }] } }
    expect(backgroundReadReport(serialized(failed), report, executionIds).matched).toBe(false)
    expect(backgroundReadReport(serialized(records()), report, ['foreign', executionIds[1]!]).matched).toBe(false)
  })
  it('requires the exact launch path, parent actor, paired result and complete child before Read starts', () => {
    const good = completion()
    expect(backgroundReadCompletion(good).accepted).toBe(true)
    for (const bad of [
      { ...good, receipt: { ...good.receipt, actor: 1 } },
      { ...good, receipt: { ...good.receipt, paired: false } },
      { ...good, receipt: { ...good.receipt, resultMatched: false } },
      { ...good, receipt: { ...good.receipt, tool: { ...good.receipt.tool, privateInput: { file_path: '/private/alpha.output.extra' } } } },
      { ...good, receipt: { ...good.receipt, tool: { ...good.receipt.tool, request: 2 } } },
      { ...good, receipt: { ...good.receipt, startEvent: 9 } },
      { ...good, childRequests: [{ terminalEvent: 11 }] },
      { ...good, childRequests: [{ terminalEvent: NaN }] },
      { ...good, childRequests: [] },
      { ...good, receipt: { ...good.receipt, result: { text: numbered('Run alpha-1 and alpha-2') } } },
    ]) expect(backgroundReadCompletion(bad).accepted).toBe(false)
    expect(JSON.stringify(backgroundReadCompletion(good))).not.toContain('private')
  })
  it('qualifies the observed counter-two handoff only for the pinned tuples and one complete generation', () => {
    for (const nativeVersion of ['2.1.284', '2.1.295']) expect(backgroundReadNativeResult(native(), { sdkVersion: '0.2.141', nativeVersion })).toBe(true)
    const value = native(), tuple = { sdkVersion: '0.2.141', nativeVersion: '2.1.284' }
    for (const bad of [
      { ...value, nativeTurns: 1 }, { ...value, maxTurns: 2 }, { ...value, terminalReason: 'absent' },
      { ...value, resultIsError: false }, { ...value, resultFlagValid: false }, { ...value, resultSubtype: 'other' },
      { ...value, canonicalHttpToolTerminal: false }, { ...value, sdkToolHookCustody: false },
      ...[{ distinctGenerations: 2 }, { distinctGenerations: 0 }, { distinctGenerations: NaN }, { distinctGenerations: 1.5 }, { overflow: true }, { completeGenerationIds: false }, { missingGenerationIds: 1 }, { missingToolIds: 1 }, { conflictingToolOwners: 1 }, { uncorrelatedHooks: 1 }].map(change => ({ ...value, generations: { ...value.generations, ...change } })),
    ]) expect(backgroundReadNativeResult(bad, tuple)).toBe(false)
    expect(backgroundReadNativeResult(value, { ...tuple, nativeVersion: '2.1.296' })).toBe(false)
    expect(backgroundReadNativeResult(value, { ...tuple, sdkVersion: '0.2.142' })).toBe(false)
  })
  it('keeps normal success bounded by complete public generations and rejects a success error flag', () => {
    const value = { ...native(), resultSubtype: 'success', resultIsError: false, maxTurns: 4, nativeTurns: 4, generations: { ...native().generations, distinctGenerations: 3 } }, tuple = { sdkVersion: '0.2.141', nativeVersion: '2.1.284' }
    expect(backgroundReadNativeResult(value, tuple)).toBe(true)
    expect(backgroundReadNativeResult({ ...value, resultIsError: true }, tuple)).toBe(false)
    expect(backgroundReadNativeResult({ ...value, generations: { ...value.generations, distinctGenerations: 5 } }, tuple)).toBe(false)
  })
})
