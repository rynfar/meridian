#!/usr/bin/env bun
// Manual process benchmark, separate from correctness assertions. Use the same
// script/runtime/filesystem on unchanged main and the corrected delivery tree.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'meridian-store-cost-'))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
process.env.MERIDIAN_SESSION_DIR = root
const { storeSharedSession, lookupSharedSession, readSessionStoreSnapshot } = await import('../src/proxy/sessionStore.ts')
const entries = 856
const count = 250
const hash = '0123456789abcdef0123456789abcdef'
const document = { '\u0000meridian-session-store': { version: 1, slots: {} } }
for (let index = 0; index < entries; index++) {
  document[`fixture-${index}`] = {
    claudeSessionId: randomUUID(), revision: 1, generationId: randomUUID(),
    createdAt: Date.now(), lastUsedAt: Date.now(), messageCount: count,
    lineageHash: hash, messageHashes: Array(count).fill(hash),
    messageBlockHashes: Array.from({ length: count }, (_, i) => i % 3 ? [hash] : [hash, hash]),
    sdkMessageUuids: Array(count).fill(null),
  }
}
const path = join(root, 'sessions.json')
const bytes = JSON.stringify(document)
writeFileSync(path, bytes, { mode: 0o600 })
let freezeCalls = 0
let freezeMs = 0
const realFreeze = Object.freeze
if (process.argv.includes('--trace-freeze')) Object.freeze = function (value) {
  const started = performance.now()
  const result = realFreeze(value)
  freezeMs += performance.now() - started
  freezeCalls++
  return result
}
const coldStarted = performance.now()
const first = lookupSharedSession('fixture-0')
assert(first)
const coldReadMs = performance.now() - coldStarted
const coldFreeze = { calls: freezeCalls, ms: freezeMs }
Object.freeze = realFreeze
await storeSharedSession('fixture-0', first.claudeSessionId, count)
const samples = []
for (let i = 0; i < 30; i++) {
  await new Promise(resolve => setImmediate(resolve))
  const key = `fixture-${i % entries}`
  const session = lookupSharedSession(key)
  assert(session)
  const started = performance.now()
  const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - started), 0))
  const write = storeSharedSession(key, session.claudeSessionId, count)
  samples.push(await timer)
  await write
}
assert.equal(Object.keys(readSessionStoreSnapshot()).length, entries)
const final = JSON.parse(readFileSync(path, 'utf8'))
assert.deepEqual(final['fixture-0'].messageBlockHashes, document['fixture-0'].messageBlockHashes)
const sorted = samples.toSorted((a, b) => a - b)
console.log(JSON.stringify({ result: 'PASS', platform: `${process.platform}/${process.arch}`,
  bytes: bytes.length, entries, samples: samples.length, coldReadMs,
  ...(process.argv.includes('--trace-freeze') ? { coldFreeze } : {}),
  medianWriteLoopLagMs: sorted[Math.floor(sorted.length / 2)],
  p95WriteLoopLagMs: sorted[Math.floor(sorted.length * .95)],
  maxWriteLoopLagMs: sorted.at(-1), artifact: root }))
