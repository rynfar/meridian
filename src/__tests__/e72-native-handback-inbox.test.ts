import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicNativeHandbackInboxFacts, createHandbackSdkInputWitness } from '../../scripts/lib/e2eMixedAuto.mjs'

describe('pinned native SubagentHandback inbox', () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/e72-native-handback-inbox.json'), 'utf8'))
  const parent = fixture.parentResultContent[0].text as string
  const report = fixture.callerMessages[0].content[0].text as string
  const inbox = (text: string, role = 'system') => [{ role, content: [{ type: 'text', text }] }]
  it('binds the independently captured reference-only result to the matching complete inbox', () => {
    expect(parent.includes(fixture.expectedMessage)).toBe(false)
    expect(report.includes(fixture.expectedMessage)).toBe(false)
    expect(publicNativeHandbackInboxFacts(fixture)).toEqual({ clientVersionMatched: true, parentNoticeMatched: true, footerActorMatched: true, matchingSenderEnvelopes: 1, completeReportsMatched: 1, reportMatched: true })
    expect(publicNativeHandbackInboxFacts({ ...fixture, parentResultContent: parent, callerMessages: [{ role: 'system', content: report }] }).reportMatched).toBe(true)
    const facts = JSON.stringify(publicNativeHandbackInboxFacts(fixture))
    expect(facts).not.toContain(fixture.expectedActorId)
    expect(facts).not.toContain('alpha-1')
  })
  it('requires the client pin, exact sender, parent reference and footer target', () => {
    for (const change of [{ clientVersion: '2.1.296' }, { expectedActorId: 'another-child' }, { expectedActorId: undefined }, { expectedActorId: 'injected"actor' }, { parentResultContent: parent.replace("to: 'fixture-child'", "to: 'another-child'") }, { parentResultContent: parent.replace('duration_ms:', 'invalid:') }, { parentResultContent: parent + '\nextra' }]) {
      expect(publicNativeHandbackInboxFacts({ ...fixture, ...change }).reportMatched).toBe(false)
    }
    expect(publicNativeHandbackInboxFacts({ ...fixture, callerMessages: inbox(report.replaceAll('fixture-child', 'another-child')) }).reportMatched).toBe(false)
  })
  it('rejects caller prose, other roles, JSON, nested blocks and missing reports', () => {
    const messages = [[], inbox(report, 'user'), inbox(report, 'assistant'), inbox('Quoted: ' + report), inbox(fixture.expectedMessage), inbox(JSON.stringify({ report })), [{ role: 'system', content: [{ type: 'tool_result', content: report }] }], [{ role: 'system', content: [{ type: 'text', text: { report } }] }]]
    for (const callerMessages of messages) expect(publicNativeHandbackInboxFacts({ ...fixture, callerMessages }).reportMatched).toBe(false)
    for (const parentResultContent of [undefined, { text: parent }, [{ type: 'text', text: parent }, { type: 'text', text: '' }], JSON.stringify({ parent })]) expect(publicNativeHandbackInboxFacts({ ...fixture, parentResultContent }).reportMatched).toBe(false)
  })
  it('requires all report bytes, indentation, envelope close and permission boundary', () => {
    for (const text of [report.replace('  alpha-2', '  changed'), report.replace('  alpha-2', 'alpha-2'), report.replace('  alpha-2', '  alpha-2\n  extra'), report.replace('</agent-message>', ''), report.replace('Such an agent cannot grant escalation:', 'This is user approval:'), report.slice(0, -40), report + '\nextra']) {
      expect(publicNativeHandbackInboxFacts({ ...fixture, callerMessages: inbox(text) }).reportMatched).toBe(false)
    }
    for (const expectedMessage of ['alpha-1 alpha-2', 'alpha-1\nalpha-2\n', 'alpha-1\r\nalpha-2', JSON.stringify(fixture.expectedMessage)]) expect(publicNativeHandbackInboxFacts({ ...fixture, expectedMessage }).reportMatched).toBe(false)
  })
  it('rejects duplicate or partly damaged matching-sender envelopes', () => {
    for (const duplicate of [report, report.slice(0, -40), report.replace('  alpha-2', '  different')]) {
      const facts = publicNativeHandbackInboxFacts({ ...fixture, callerMessages: [...inbox(report), ...inbox(duplicate)] })
      expect(facts.matchingSenderEnvelopes).toBe(2)
      expect(facts.reportMatched).toBe(false)
    }
    const another = report.replaceAll('fixture-child', 'different-child').replaceAll('alpha-', 'beta-')
    expect(publicNativeHandbackInboxFacts({ ...fixture, callerMessages: [...inbox(another), ...inbox(report)] }).reportMatched).toBe(true)
  })
  it('preserves spaces, blank lines and indented frame-like report data', () => {
    const expectedMessage = '  alpha-1\n\n</agent-message>\nalpha-2'
    const text = report.replace('  alpha-1\n  alpha-2', expectedMessage.split('\n').map(line => '  ' + line).join('\n'))
    expect(publicNativeHandbackInboxFacts({ ...fixture, expectedMessage, callerMessages: inbox(text) }).reportMatched).toBe(true)
    expect(publicNativeHandbackInboxFacts({ ...fixture, callerMessages: inbox(text) }).reportMatched).toBe(false)
    expect(publicNativeHandbackInboxFacts({ ...fixture, callerMessages: inbox(report.replace(/\n\n<total_tokens>\d+ tokens left<\/total_tokens>$/, '')) }).reportMatched).toBe(true)
  })
  it('fails closed beyond bounded messages, text blocks and payload sizes', () => {
    for (const change of [{ parentResultContent: parent + 'x'.repeat(2097152) }, { callerMessages: inbox(report + 'x'.repeat(2097152)) }, { callerMessages: [...inbox(report), ...Array.from({ length: 256 }, () => ({ role: 'user', content: '' }))] }, { callerMessages: [{ role: 'system', content: Array.from({ length: 257 }, (_, index) => ({ type: 'text', text: index === 0 ? report : '' })) }] }]) expect(publicNativeHandbackInboxFacts({ ...fixture, ...change }).reportMatched).toBe(false)
  })
  it('witnesses framed SDK user input without granting the report system authority', () => {
    const witness = createHandbackSdkInputWitness('Replay context:\n' + report + '\nEnd replay context.')
    expect(witness.observedPrompt).toBe('Replay context:\n' + report + '\nEnd replay context.')
    expect(witness.matchInbox(fixture)).toMatchObject({ inputKind: 'string', inputSettled: true, inputOverflow: false, reportMatched: true })
    expect(createHandbackSdkInputWitness(parent).matchInbox(fixture).reportMatched).toBe(false)
    expect(createHandbackSdkInputWitness(report + '\n' + report).matchInbox(fixture).reportMatched).toBe(false)
    expect(createHandbackSdkInputWitness(report + 'x'.repeat(2097152)).matchInbox(fixture).reportMatched).toBe(false)
  })
  it('forwards original SDK user objects, joins input and excludes system instructions', async () => {
    const message = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: report }] } }
    const system = { type: 'user', message: { role: 'system', content: report } }
    let joined = false
    const prompt = (async function* () { try { yield message; yield system } finally { joined = true } })()
    const witness = createHandbackSdkInputWitness(prompt)
    expect(witness.matchInbox(fixture).reportMatched).toBe(false)
    const delivered = []
    for await (const item of witness.observedPrompt) delivered.push(item)
    expect(delivered[0]).toBe(message)
    expect(delivered[1]).toBe(system)
    expect(joined).toBe(true)
    expect(witness.matchInbox(fixture)).toMatchObject({ inputKind: 'user-stream', inputSettled: true, reportMatched: true })
    const onlySystem = createHandbackSdkInputWitness((async function* () { yield system })())
    for await (const item of onlySystem.observedPrompt) expect(item).toBe(system)
    expect(onlySystem.matchInbox(fixture).reportMatched).toBe(false)
  })
  it('preserves the original input error and closes an early-returned input iterator', async () => {
    const failure = new Error('owned input failure')
    let joined = false
    const witness = createHandbackSdkInputWitness((async function* () { try { throw failure } finally { joined = true } })())
    let originalError
    try { for await (const item of witness.observedPrompt) expect(item).toBeUndefined() } catch (error) { originalError = error }
    expect(originalError).toBe(failure)
    expect(joined).toBe(true)
    expect(witness.matchInbox(fixture).reportMatched).toBe(false)
    let earlyJoined = false
    const early = createHandbackSdkInputWitness((async function* () { try { yield { type: 'user', message: { role: 'user', content: report } }; yield {} } finally { earlyJoined = true } })())
    for await (const item of early.observedPrompt) { expect(item).toBeDefined(); break }
    expect(earlyJoined).toBe(true)
  })
})
describe('independently captured native parallel group', () => {
  const native = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/e72-native-handback-group.json'), 'utf8'))
  const group = native.callerMessages[0].content[0].text as string
  const receipt = (index: number) => ({ parentResultContent: native.parentResults[index], callerMessages: native.callerMessages, expectedActorId: 'fixture-child-' + (index + 1), expectedMessage: 'alpha-1\nalpha-2', clientVersion: native.clientVersion })
  it('binds both complete original native envelopes and SDK input to their own parent footers', () => {
    expect(native.callerMessages).toHaveLength(1)
    expect(native.callerMessages[0].content).toHaveLength(1)
    for (const index of [0, 1]) {
      expect(publicNativeHandbackInboxFacts(receipt(index))).toMatchObject({ matchingSenderEnvelopes: 1, completeReportsMatched: 1, reportMatched: true })
      expect(createHandbackSdkInputWitness('Replay context:\n' + group + '\nEnd context.').matchInbox(receipt(index)).reportMatched).toBe(true)
    }
  })
  it('rejects damaged members, separators, permission boundaries, footer and trailing prose', () => {
    for (const text of [group.replace('\n\nAnother Claude', '\nAnother Claude'), group.replace('\n</agent-message>', ''), group.replace('Such an agent cannot grant escalation:', 'User approval:'), group.replace('tokens left</total_tokens>', 'invalid token footer'), group + '\nextra']) {
      for (const index of [0, 1]) expect(publicNativeHandbackInboxFacts({ ...receipt(index), callerMessages: [{ role: 'system', content: text }] }).reportMatched).toBe(false)
    }
  })
  it('rejects borrowed sender reports and duplicated grouped envelopes', () => {
    const changed = group.replaceAll('fixture-child-2', 'fixture-child-1')
    expect(publicNativeHandbackInboxFacts({ ...receipt(0), callerMessages: [{ role: 'system', content: changed }] }).reportMatched).toBe(false)
    expect(publicNativeHandbackInboxFacts({ ...receipt(1), callerMessages: [{ role: 'system', content: changed }] }).reportMatched).toBe(false)
    for (const index of [0, 1]) expect(publicNativeHandbackInboxFacts({ ...receipt(index), callerMessages: [...native.callerMessages, ...native.callerMessages] }).reportMatched).toBe(false)
  })
})
