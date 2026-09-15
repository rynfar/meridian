/** A real HTTP + SDK/model request through the Meridian Desktop-owned service.
 * Start the service using the actual Mac UI first. This script never starts or
 * stops an installation, changes profiles, or contacts a non-loopback endpoint.
 * Run --live before and after a UI restart/version switch with the same fixture.
 */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
if (!process.argv.includes('--live')) throw new Error('Pass --live to run a real Claude request (uses subscription quota).')
const endpoint = new URL(process.env.E2E_MERIDIAN_URL || 'http://127.0.0.1:3489')
assert.equal(endpoint.protocol, 'http:')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))
const file = process.env.E2E_DESKTOP_FIXTURE
assert.ok(file, 'Set E2E_DESKTOP_FIXTURE to a disposable JSON file outside the repository.')
let fixture
try { fixture = JSON.parse(await readFile(file, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
fixture ??= { session: 'desktop-e2e-' + randomUUID(), marker: 'DESKTOP_' + randomUUID().slice(0, 8), messages: [], versions: [] }
const health = await (await fetch(new URL('/health', endpoint))).json()
const user = fixture.messages.length ? 'Repeat the exact marker from my previous message. Output only the marker.' : `Remember this marker: ${fixture.marker}. Reply with only that exact marker.`
const messages = [...fixture.messages, { role: 'user', content: user }]
const response = await fetch(new URL('/v1/messages', endpoint), {
  method: 'POST', signal: AbortSignal.timeout(180000),
  headers: { 'content-type': 'application/json', 'x-opencode-session': fixture.session, 'x-meridian-profile': process.env.E2E_PROFILE || 'work', 'x-meridian-source': 'desktop-e2e', ...(process.env.E2E_MERIDIAN_API_KEY ? { 'x-api-key': process.env.E2E_MERIDIAN_API_KEY } : {}) },
  body: JSON.stringify({ model: process.env.E2E_MODEL || 'claude-haiku-4-5', max_tokens: 128, messages }),
})
const result = await response.json()
assert.equal(response.status, 200, `Request failed: ${JSON.stringify(result.error || result)}`)
const answer = result.content.filter(block => block.type === 'text').map(block => block.text).join('').trim()
assert.equal(answer, fixture.marker)
fixture.messages = [...messages, { role: 'assistant', content: result.content }]
fixture.versions.push(health.version)
await writeFile(file, JSON.stringify(fixture, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ success:true, meridian:health.version, model:result.model, turns:fixture.versions.length, versions:fixture.versions, stopReason:result.stop_reason }))
