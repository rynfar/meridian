import { expect, test } from 'bun:test'
import { validateProfileHistoryAdmission } from '../../scripts/lib/profileHistoryAdmission.mjs'
const now = Date.parse('2026-10-20T18:30:00Z')
const common = { at: new Date(now).toISOString(), refreshes: 0, credentialWrites: 0, organizationPlanActive: true, profileExtraUsageEnabled: false }
const known = { ...common, canInfer: true, extraUsageEnabled: false, windows: [{ type: 'five_hour', utilization: 0.1 }, { type: 'seven_day', utilization: 0.3 }] }
const bounded = { ...common, canInfer: false, extraUsageEnabled: null, includedAttemptPermitted: true, includedCapacityKnown: false, maximumGenerationsPerCase: 7 }
test('current usage windows establish known included capacity', () => { expect(validateProfileHistoryAdmission(known, now)).toMatchObject({ includedCapacityKnown: true, maximumGenerations: 12, extraUsageEnabled: false }) })
test('bounded admission preserves unknown capacity and its lower generation limit', () => { expect(validateProfileHistoryAdmission(bounded, now)).toMatchObject({ includedCapacityKnown: false, maximumGenerations: 7, extraUsageEnabled: false }) })
for (const [name, record] of [
 ['missing weekly window', { ...known, windows: known.windows.slice(0, 1) }],
 ['spent window', { ...known, windows: [{ type: 'five_hour', utilization: 1 }, known.windows[1]] }],
 ['negative utilization', { ...known, windows: [{ type: 'five_hour', utilization: -1 }, known.windows[1]] }],
 ['paid profile usage', { ...bounded, profileExtraUsageEnabled: true }],
 ['conflicting paid observation', { ...bounded, extraUsageEnabled: true }],
 ['credential refresh', { ...bounded, refreshes: 1 }],
 ['credential write', { ...bounded, credentialWrites: 1 }],
 ['inactive organization', { ...bounded, organizationPlanActive: false }],
 ['old observation', { ...bounded, at: new Date(now - 300000).toISOString() }],
 ['future observation', { ...bounded, at: new Date(now + 1).toISOString() }],
 ['missing attempt permission', { ...bounded, includedAttemptPermitted: false }],
 ['unknown quota relabelled known', { ...bounded, includedCapacityKnown: true }],
 ['unbounded generation count', { ...bounded, maximumGenerationsPerCase: 13 }],
 ['zero generation count', { ...bounded, maximumGenerationsPerCase: 0 }],
 ['fractional generation count', { ...bounded, maximumGenerationsPerCase: 1.5 }],
 ['known flag without windows despite bounded permit', { ...bounded, canInfer: true, extraUsageEnabled: false }],
]) test('rejects ' + name, () => { expect(() => validateProfileHistoryAdmission(record, now)).toThrow() })
