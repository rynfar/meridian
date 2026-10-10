import { describe, expect, it } from 'bun:test'
import { publicHandbackEncodingFacts, publicHandbackReceiptFacts } from '../../scripts/lib/e2eMixedAuto.mjs'

describe('handback encoding diagnostics preserve strict acceptance', () => {
  const expectedMessage = 'alpha-1\nalpha-2'
  it('distinguishes literal escapes, JSON quoting, CRLF and a trailing line feed', () => {
    const cases = [
      { text: expectedMessage, field: undefined },
      { text: JSON.stringify(expectedMessage), field: 'inputMessageMatchesJsonEncodingOfExpected' },
      { text: expectedMessage.replaceAll('\n', '\\n'), field: 'inputMessageMatchesEscapedNewlineOfExpected' },
      { text: expectedMessage.replaceAll('\n', '\r\n'), field: 'inputMessageMatchesCrlfOfExpected' },
      { text: expectedMessage + '\n', field: 'inputMessageMatchesExpectedWithTrailingNewline' },
    ]
    for (const item of cases) {
      const receipt = { input: { message: item.text }, parentPrompt: 'SubagentHandback', expectedMessage, parentResultContent: item.text }
      const result = publicHandbackEncodingFacts(receipt)
      expect(result.parentTextContainsActualInput).toBe(true)
      if (item.field) expect(result[item.field as keyof typeof result]).toBe(true)
      expect(publicHandbackReceiptFacts(receipt).inputMessageMatched).toBe(item.text === expectedMessage)
    }
  })
  it('separates actual-input delivery from fixed expected wording without qualifying it', () => {
    const input = { message: 'private other report' }
    const payload = JSON.stringify({ agentId: 'private child', handbackReport: { text: input.message } })
    const receipt = { input, expectedMessage, parentResultContent: payload }
    expect(publicHandbackEncodingFacts(receipt)).toMatchObject({ parentTextJsonValid: true, parentTextJsonString: false, parentTextContainsActualInput: true, parentTextContainsJsonEncodingOfActualInput: true, parentStructuredReportMatchesActualInput: true })
    expect(publicHandbackReceiptFacts({ ...receipt, parentPrompt: 'SubagentHandback' })).toMatchObject({ inputMessageMatched: false, structuredReportTextMatched: false, parentResultTextContainsExactReport: false })
    expect(JSON.stringify(publicHandbackEncodingFacts(receipt))).not.toContain('private')
  })
  it('requires whole direct JSON and never searches nested report objects', () => {
    const input = { message: expectedMessage }
    expect(publicHandbackEncodingFacts({ input, expectedMessage, parentResultContent: JSON.stringify(expectedMessage) })).toMatchObject({ parentTextJsonString: true, parentJsonStringMatchesActualInput: true })
    for (const value of [JSON.stringify({ nested: { handbackReport: { text: expectedMessage } } }), JSON.stringify([{ handbackReport: { text: expectedMessage } }]), 'prose ' + JSON.stringify({ handbackReport: { text: expectedMessage } })]) expect(publicHandbackEncodingFacts({ input, expectedMessage, parentResultContent: value }).parentStructuredReportMatchesActualInput).toBe(false)
  })
  it('keeps missing, empty, oversized and invalid values explicit and payload-free', () => {
    for (const input of [undefined, [], { message: 7 }, { message: 'x'.repeat(1048577) }]) expect(publicHandbackEncodingFacts({ input, expectedMessage })).toMatchObject({ inputMessagePresent: false, inputMessageCharacters: null, inputMessageLineFeeds: null, parentTextContainsActualInput: false })
    expect(publicHandbackEncodingFacts({ input: { message: '' }, expectedMessage, parentResultContent: '{}' })).toMatchObject({ inputMessagePresent: true, inputMessageCharacters: 0, parentTextContainsActualInput: false, parentTextContainsJsonEncodingOfActualInput: false })
    expect(publicHandbackEncodingFacts({ input: { message: expectedMessage }, expectedMessage, parentResultContent: 'x'.repeat(2097153) }).parentTextPresent).toBe(false)
  })
})
