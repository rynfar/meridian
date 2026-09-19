import { describe, expect, it } from 'bun:test'
import { providerOverview, type ProviderSnapshot } from '../telemetry/providerView'
import { ClaudeProviderFacts, claudeProvider, disabledProvider, parseProviderSnapshot } from '../proxy/backends/providerStatus'
import { parseAgRequest } from '../proxy/backends/antigravityProtocol'

const sample: ProviderSnapshot = { fetchedAt: 1000, providers: [
  { ...disabledProvider('claude'), enabled: true, status: 'healthy', activity: { requests: 2, errors: 0, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 }, accounts: [{ id: '<script>alert(1)</script>', fetchedAt: 1000, windows: [{ type: '5h', utilization: .25, resetsAt: 900000 }] }] },
  { ...disabledProvider('antigravity'), enabled: true, status: 'unavailable', error: 'quota unavailable', accounts: [] },
] }
describe('provider presentation and contract', () => {
  it('keeps unavailable providers visible and labels partial totals', () => {
    const html = providerOverview(sample)
    expect(html).toContain('totals are partial')
    expect(html).toContain('quota unavailable')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })
  it('filters provider cards without changing account ownership', () => {
    const html = providerOverview(sample, 'antigravity')
    expect(html).toContain('data-provider-card="antigravity"')
    expect(html).not.toContain('data-provider-card="claude"')
    expect(html).not.toContain('Manage Claude accounts')
  })
  it('rejects malformed desktop provider data rather than rendering invented numbers', () => {
    expect(parseProviderSnapshot(sample)).toEqual(sample)
    expect(() => parseProviderSnapshot({ ...sample, providers: [{ id: 'antigravity' }] })).toThrow()
  })
  it('normalizes Claude token counts and omits absent activity', () => {
    expect(claudeProvider({status:'healthy'}, {}, {}).activity).toBeUndefined()
    expect(claudeProvider({}, {totalRequests:2,tokenUsage:{totalInputTokens:33,totalOutputTokens:4}}, {}).activity?.inputTokens).toBe(33)
  })
  it('rejects orphan, duplicated and role-invalid tool history before replay', () => {
    const call = {type:'tool_use',id:'one',name:'read',input:{}}
    const result = {type:'tool_result',tool_use_id:'one',content:'done'}
    const parse = (messages: unknown[]) => parseAgRequest({model:'fixture',messages})
    expect(() => parse([{role:'user',content:[result]}])).toThrow('Unknown')
    expect(() => parse([{role:'user',content:[call]}])).toThrow('Invalid')
    expect(() => parse([{role:'assistant',content:[call]}, {role:'user',content:'continue'}])).toThrow('matching result')
    expect(() => parse([{role:'assistant',content:[call]}, {role:'user',content:[result,result]}])).toThrow()
  })
  it('returns current activity immediately while an external quota request is stalled', async () => {
    const cache = new ClaudeProviderFacts()
    let finish!: (value: unknown) => void
    const slow = new Promise(resolve => { finish = resolve })
    const read = (path: string) => path === '/health' ? Promise.resolve({status:'healthy'}) : slow
    expect(cache.snapshot(read, {totalRequests:3}).activity?.requests).toBe(3)
    expect(cache.snapshot(read, {totalRequests:4}).activity?.requests).toBe(4)
    finish({profiles:[]}); await slow
  })

})
