import { describe, expect, it } from 'bun:test'
import { agContextBudget, agHistoryLimits } from '../proxy/backends/antigravityHistory'

describe('Antigravity per-model context budget', () => {
  it('uses the model-family table and keeps unknown models at the Gemini default', () => {
    expect(agContextBudget('gemini-4-neon')).toBe(1_000_000)
    expect(agContextBudget('claude-opus-4-5')).toBe(230_000)
    expect(agContextBudget('claude-sonnet-4-5')).toBe(230_000)
    expect(agContextBudget('gpt-oss-120b-medium')).toBe(120_000)
    expect(agContextBudget('vendor-new-model')).toBe(1_000_000)
  })

  it('reuses MERIDIAN_AGY_MAX_CONTEXT_TOKENS as the explicit override', () => {
    const env = { MERIDIAN_AGY_MAX_CONTEXT_TOKENS: '300000' }
    expect(agContextBudget('claude-opus-4-5', env)).toBe(300_000)
    expect(agContextBudget('gemini-4-neon', env)).toBe(300_000)
    expect(agContextBudget('gemini-4-neon', { MERIDIAN_AGY_MAX_CONTEXT_TOKENS: '1048576' })).toBe(1_048_576)
    expect(() => agContextBudget('gemini-4-neon', { MERIDIAN_AGY_MAX_CONTEXT_TOKENS: '1048577' })).toThrow('1 to 1048576')
  })

  it('keeps history defaults and override validation aligned with the budget helper', () => {
    expect(agHistoryLimits({}).contextTokens).toBe(1_000_000)
    expect(agHistoryLimits({ MERIDIAN_AGY_MAX_CONTEXT_TOKENS: '300000' }).contextTokens).toBe(300_000)
  })
})
