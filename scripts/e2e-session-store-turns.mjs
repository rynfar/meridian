#!/usr/bin/env bun
// Run E41 with the real SDK/model while every session-store fsync waits.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import * as files from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spyOn } from 'bun:test'
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { observeSdkModels } from './lib/observe-sdk-models.mjs'

const credentials = realpathSync(process.env.E2E_PROFILE_CLAUDE_DIR)
const config = mkdtempSync(join(tmpdir(), 'meridian-store-turns-config-'))
for (const key of Object.keys(process.env)) {
  if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_|OPENAI_)/.test(key)) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: config, MERIDIAN_CREDENTIALS_READONLY: '1',
  CLAUDE_CONFIG_DIR: credentials,
  MERIDIAN_NO_UPDATE_CHECK: '1', PROBE_MODEL: process.env.PROBE_MODEL ?? 'claude-opus-5-5' })
writeFileSync(join(config, 'profiles.json'), JSON.stringify([{ id: 'default', claudeConfigDir: credentials }]), { mode: 0o600 })
const handles = new WeakSet(), realOpen = files.open, servedModels = new Set()
let writes = 0, credentialMatches = 0, queries = 0, ticksDuringWrites = 0, waiting = 0
const openObserver = spyOn(files, 'open').mockImplementation(async (...args) => {
  const handle = await realOpen(...args)
  if (String(args[0]).includes('/sessions.json.tmp-')) handles.add(handle)
  return handle
})
const probe = await realOpen(join(config, 'probe'), 'w')
const prototype = Object.getPrototypeOf(probe), realSync = prototype.sync
await probe.close()
prototype.sync = async function () {
  if (handles.has(this)) {
    writes++; waiting++
    try { await new Promise(resolve => setTimeout(resolve, 200)) } finally { waiting-- }
  }
  return realSync.call(this)
}
const realQuery = sdk.query
const usageTrace = [], completedSessions = []
const queryObserver = spyOn(sdk, 'query').mockImplementation(input => {
  queries++
  const query = queries
  if (process.env.E2E_USAGE_TRACE === '1') usageTrace.push({ query, type: 'options', thinking: input.options?.thinking, effort: input.options?.effort })
  if (input.options?.env?.CLAUDE_CONFIG_DIR === credentials) credentialMatches++
  return observeSdkModels(realQuery(input), servedModels, message => {
    if (message.type === 'system' && message.subtype === 'api_retry') usageTrace.push({ query, type: 'api_retry', attempt: message.attempt, delayMs: message.retry_delay_ms, status: message.error_status })
    const usage = message.type === 'assistant' ? message.message?.usage
      : message.type === 'result' ? message.usage
      : message.type === 'stream_event' && message.event?.type === 'message_start' ? message.event.message?.usage : undefined
    if (message.type === 'result' && message.session_id) completedSessions.push({ query, id: message.session_id, directory: input.options?.cwd })
    if (usage) usageTrace.push({ query, type: message.type,
      contentTypes: message.type === 'assistant' ? message.message?.content?.map(block => block.type) : undefined,
      input: usage.input_tokens, cacheRead: usage.cache_read_input_tokens, cacheCreation: usage.cache_creation_input_tokens, output: usage.output_tokens,
      subtype: message.type === 'result' ? message.subtype : undefined,
      messageId: message.type === 'assistant' ? message.message?.id : undefined,
      iterations: usage.iterations })
  })
})
const timer = setInterval(() => { if (waiting) ticksDuringWrites++ }, 10)
try {
  const { pass } = await import('./e2e-passthrough-turns.mjs')
  assert(pass, 'E41 tool batching, active history or prompt-cache continuity failed')
  assert(writes > 0 && ticksDuringWrites > 0, 'No asynchronous session-store contention observed')
  assert(queries > 0 && credentialMatches === queries, 'Unexpected native credential directory')
  assert(servedModels.size > 0 && [...servedModels].every(model => model === process.env.PROBE_MODEL || model.startsWith(process.env.PROBE_MODEL + '-')))
  console.info(JSON.stringify({ result: 'PASS', writes, ticksDuringWrites, queries,
    allQueriesUseOwnedAccount: true, servedModels: [...servedModels], platform: `${process.platform}/${process.arch}`, bun: Bun.version,
    stream: process.argv.includes('--stream'), parallel: process.env.PROBE_PARALLEL === '1' }))
} finally {
  clearInterval(timer)
  prototype.sync = realSync
  openObserver.mockRestore()
  queryObserver.mockRestore()
  if (process.env.E2E_USAGE_TRACE === '1') {
    console.info(JSON.stringify({ phase: 'sdk-usage', usageTrace }))
    // Supported SDK history only; emit metadata/counters, never model text.
    for (const session of completedSessions) {
      const history = await sdk.getSessionMessages(session.id, { dir: session.directory })
      const assistants = history.filter(row => row.type === 'assistant').map(row => ({
        messageId: row.message?.id, contentTypes: row.message?.content?.map(block => block.type),
        input: row.message?.usage?.input_tokens, cacheRead: row.message?.usage?.cache_read_input_tokens,
        cacheCreation: row.message?.usage?.cache_creation_input_tokens, output: row.message?.usage?.output_tokens }))
      console.info(JSON.stringify({ phase: 'supported-history-usage', query: session.query, assistants }))
    }
  }
}
