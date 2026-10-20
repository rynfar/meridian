import assert from 'node:assert/strict'

// This authorizes a bounded probe attempt. It never claims unknown quota is known.
export function validateProfileHistoryAdmission(guard, now = Date.now()) {
  assert(guard && typeof guard === 'object', 'Owned admission record required')
  const observed = Date.parse(guard.at)
  assert(Number.isFinite(observed) && now - observed >= 0 && now - observed < 300000, 'Fresh observation timestamp required')
  assert.equal(guard.refreshes, 0, 'Credential refresh is not permitted')
  assert.equal(guard.credentialWrites, 0, 'Credential writes are not permitted')
  assert.equal(guard.organizationPlanActive, true, 'Active organization required')
  assert.equal(guard.profileExtraUsageEnabled, false, 'Paid Extra Usage must be freshly disabled')
  assert.notEqual(guard.extraUsageEnabled, true, 'Conflicting paid usage observation')

  const known = guard.canInfer === true
  let maximumGenerations = 12
  if (known) {
    assert.equal(guard.extraUsageEnabled, false)
    assert(Array.isArray(guard.windows) && ['five_hour', 'seven_day'].every(type => guard.windows.some(row => row.type === type && typeof row.utilization === 'number' && row.utilization >= 0 && row.utilization < 1)), 'Known capacity needs both current usage windows')
  } else {
    assert.equal(guard.includedAttemptPermitted, true, 'Explicit bounded-attempt admission required')
    assert.equal(guard.includedCapacityKnown, false, 'Unknown capacity must remain labelled unknown')
    maximumGenerations = guard.maximumGenerationsPerCase
    assert(Number.isInteger(maximumGenerations) && maximumGenerations > 0 && maximumGenerations <= 12, 'Bounded probe requires a limit from 1 to 12 generations')
  }
  return { observedAt: guard.at, includedCapacityKnown: known, extraUsageEnabled: false, maximumGenerations, basis: known ? 'current usage windows' : 'explicit bounded attempt; current capacity unknown' }
}
