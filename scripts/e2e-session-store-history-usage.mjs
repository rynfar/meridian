#!/usr/bin/env bun
// Inspect only an owned fixture's known sessions through the supported SDK API.
// No Claude private paths/files or generated text are exposed.
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
assert(process.env.CLAUDE_CONFIG_DIR, 'Provide the fixture\'s recorded native config directory')
const directory = realpathSync(process.env.E2E_HISTORY_DIR)
const sessions = (process.env.E2E_HISTORY_SESSIONS ?? '').split(',').filter(Boolean)
assert(sessions.length > 0 && sessions.every(id => /^[0-9a-f-]{36}$/i.test(id)), 'Provide known fixture session UUIDs')
for (const session of sessions) {
  const history = await getSessionMessages(session, { dir: directory })
  assert(history.length > 0, `No supported history for fixture session ${session}`)
  const assistants = history.filter(row => row.type === 'assistant').map(row => ({
    messageId: row.message?.id, contentTypes: row.message?.content?.map(block => block.type),
    input: row.message?.usage?.input_tokens, cacheRead: row.message?.usage?.cache_read_input_tokens,
    cacheCreation: row.message?.usage?.cache_creation_input_tokens, output: row.message?.usage?.output_tokens,
  }))
  console.info(JSON.stringify({ session, rows: history.length, assistants }))
}
