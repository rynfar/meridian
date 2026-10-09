import { describe, expect, it } from 'bun:test'
import { createPublicSdkGenerationWitness, publicToolCapabilities } from '../../scripts/lib/e2ePublicSdkDiagnostics.mjs'

describe('E72 public SDK diagnostics', () => {
  it('deduplicates streamed starts and assistant fragments by model message ID, with distinct later generations', () => {
    let time = 10
    const witness = createPublicSdkGenerationWitness({ now: () => time++ })
    const id = 'private-model-message', tool = 'private-tool-id'
    witness.observeHook(tool, 'forwarded')
    witness.observe({ type: 'stream_event', uuid: 'public-envelope-1', event: { type: 'message_start', message: { id } } })
    for (const uuid of ['public-envelope-2', 'public-envelope-3']) witness.observe({ type: 'assistant', uuid, message: { id, content: [{ type: 'tool_use', id: tool, input: { private: 'not emitted' } }] } })
    witness.observeHook('private-later-tool', 'dropped')
    witness.observe({ type: 'assistant', message: { id: 'private-second-model-message', content: [{ type: 'tool_use', id: 'private-later-tool' }] } })
    const summary = witness.summary()
    expect(summary.distinctGenerations).toBe(2)
    expect(summary.assistantEvents).toBe(3)
    expect(summary.streamStarts).toBe(1)
    expect(summary.completeGenerationIds).toBe(true)
    expect(summary.generations.map(row => [row.distinctTools, row.forwardedHooks, row.droppedHooks])).toEqual([[1, 1, 0], [1, 0, 1]])
    expect(summary.generations[0]?.assistantEvents).toBe(2)
    expect(summary.generations[0]?.firstHookMs).toBeLessThan(summary.generations[0]!.firstEventMs)
    expect(JSON.stringify(summary)).not.toContain('private')
    const snapshot = JSON.stringify(summary)
    summary.generations[0]!.number = 99
    expect(JSON.stringify(witness.summary())).toBe(snapshot)
  })
  it('keeps idless events unqualified and does not mistake envelope UUIDs for generations', () => {
    const witness = createPublicSdkGenerationWitness({ now: () => 0 })
    witness.observe({ type: 'assistant', uuid: 'private-envelope', message: { content: [] } })
    witness.observe({ type: 'stream_event', event: { type: 'message_start', message: { id: '' } } })
    expect(witness.summary()).toMatchObject({ distinctGenerations: 0, missingGenerationIds: 2, completeGenerationIds: false })
  })
  it('retains conflicts, repeated hooks, orphan hooks and bounded overflow without exporting IDs', () => {
    const witness = createPublicSdkGenerationWitness({ now: () => 0, maximumGenerations: 2, maximumTools: 2 })
    witness.observeHook('private-tool', 'forwarded'); witness.observeHook('private-tool', 'dropped'); witness.observeHook('private-orphan', 'unknown')
    for (const id of ['private-a', 'private-b']) witness.observe({ type: 'assistant', message: { id, content: [{ type: 'tool_use', id: 'private-tool' }] } })
    witness.observe({ type: 'assistant', message: { id: 'private-c', content: [] } })
    witness.observeHook('private-third', 'forwarded')
    expect(witness.summary()).toMatchObject({ distinctGenerations: 2, conflictingToolOwners: 1, uncorrelatedHooks: 1, overflow: true, completeGenerationIds: false })
    expect(witness.summary().generations[0]).toMatchObject({ forwardedHooks: 1, droppedHooks: 0, repeatedHookEvents: 1 })
    expect(JSON.stringify(witness.summary())).not.toContain('private')
  })
  it('distinguishes missing, invalid, native and client MCP catalogs using only named capability booleans', () => {
    expect(publicToolCapabilities(undefined)).toMatchObject({ catalogPresent: false, catalogValid: false, taskOutput: false })
    expect(publicToolCapabilities([])).toMatchObject({ catalogPresent: true, catalogValid: true, taskOutput: false })
    expect(publicToolCapabilities(['TaskOutput', 'Read', 'mcp__oc__Read', 'private-other-tool'])).toMatchObject({ taskOutput: true, read: true, clientMcpRead: true, clientMcpTaskOutput: false })
    expect(publicToolCapabilities(['mcp__oc__TaskOutput', 'mcp__oc__*'])).toMatchObject({ taskOutput: false, clientMcpTaskOutput: true, clientMcpWildcard: true })
    expect(publicToolCapabilities(['TaskOutput', null])).toMatchObject({ catalogValid: false, taskOutput: true })
    expect(JSON.stringify(publicToolCapabilities(['private-other-tool']))).not.toContain('private')
  })
})
