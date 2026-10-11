import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicNativeHandbackFrameFacts } from '../../scripts/lib/e2eMixedAuto.mjs'

describe('pinned native handback framing', () => {
  const payload = readFileSync(join(import.meta.dir, 'fixtures/e72-native-handback-frame.txt'), 'utf8')
  const receipt = { parentResultContent: payload, expectedMessage: 'alpha-1\nalpha-2', expectedActorId: 'fixture-child', clientVersion: '2.1.287' }
  it('decodes the independently captured native control without altering report bytes', () => {
    expect(payload.includes(receipt.expectedMessage)).toBe(false)
    expect(publicNativeHandbackFrameFacts(receipt)).toMatchObject({ frameMatched: true, actorMatched: true, footerTargetMatched: true, reportMatched: true, reportLines: 2 })
    expect(publicNativeHandbackFrameFacts({ ...receipt, parentResultContent: [{ type: 'text', text: payload }] }).reportMatched).toBe(true)
    const facts = JSON.stringify(publicNativeHandbackFrameFacts(receipt))
    expect(facts).not.toContain(receipt.expectedActorId)
    expect(facts).not.toContain('alpha-1')
  })
  it('requires the pinned client, exact child, footer target and complete report', () => {
    for (const change of [{ clientVersion: '2.1.296' }, { expectedActorId: 'another-child' }, { expectedActorId: undefined }, { expectedMessage: 'alpha-1 alpha-2' }, { expectedMessage: 'alpha-1\nalpha-2\n' }]) expect(publicNativeHandbackFrameFacts({ ...receipt, ...change }).reportMatched).toBe(false)
    expect(publicNativeHandbackFrameFacts({ ...receipt, parentResultContent: payload.replace("with to: 'fixture-child'", "with to: 'another-child'") }).reportMatched).toBe(false)
  })
  it('rejects prose, structured JSON, multiple blocks, borrowed framing and damaged footers', () => {
    const values = [undefined, { text: payload }, [{ type: 'text', text: payload }, { type: 'text', text: '' }], JSON.stringify({ handbackReport: { text: receipt.expectedMessage } }), receipt.expectedMessage,
      'prose ' + payload, payload + '\nextra', payload.replace('\n  alpha-2', '\nalpha-2'), payload.replace('subagent_tokens: 60', 'subagent_tokens: invalid'), payload.replace('duration_ms:', 'other_field:'), payload.replace('  alpha-2', '  alpha-2\n  fabricated report')]
    for (const value of values) expect(publicNativeHandbackFrameFacts({ ...receipt, parentResultContent: value }).reportMatched).toBe(false)
  })
  it('preserves intentional blank lines and leading spaces inside the report', () => {
    const value = payload.replace('  alpha-1\n  alpha-2', '    alpha-1\n  \n  alpha-2')
    expect(publicNativeHandbackFrameFacts({ ...receipt, parentResultContent: value, expectedMessage: '  alpha-1\n\nalpha-2' }).reportMatched).toBe(true)
    expect(publicNativeHandbackFrameFacts({ ...receipt, parentResultContent: value }).reportMatched).toBe(false)
  })
  it('rejects oversized payloads without returning report or actor text', () => {
    const facts = publicNativeHandbackFrameFacts({ ...receipt, parentResultContent: payload + 'x'.repeat(2097152) })
    expect(facts.frameMatched).toBe(false)
    expect(facts.reportLines).toBeNull()
    expect(JSON.stringify(facts)).not.toContain('alpha-1')
  })
})
