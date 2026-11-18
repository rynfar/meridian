import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import Database from 'libsql'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, readFile, symlink, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { AgFinalText, AgTextCursor, agEventShape } from '../proxy/backends/antigravityFinalText'
import { AgNativeRecords, VERIFIED_AGY_NATIVE_RECORD_VERSION, agNativeRecordUri, isVerifiedAgNativeRecordVersion, type AgNativeAnchor } from '../proxy/backends/antigravityNativeRecord'
import { AntigravityRuntime } from '../proxy/backends/antigravityRuntime'
import { createAntigravityServer } from '../proxy/backends/antigravity'
import { DEFAULT_PROXY_CONFIG } from '../proxy/types'
import type { AgMessage } from '../proxy/backends/antigravityProtocol'

interface Turn { home: string; cid: string; trajectory: string; execution: string; inputIdx: number }
const native = createRequire(import.meta.url)('./fixtures/agy-native-record.cjs') as {
  schema: string
  input(home: string, cid: string, prompt: string): Turn
  answer(turn: Turn, text: string, options?: { tool?: boolean; execution?: string; status?: number; error?: string; modified?: string; thinking?: string; at?: number }): number
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'agy-final-text-'))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}
function dbPath(home: string, cid: string) { return join(home, '.gemini', 'antigravity-cli', 'conversations', cid + '.db') }
function anchor(prompt: string, after = -1): AgNativeAnchor { return { prompt, inputAfter: after, responseAfter: after, startedAt: Date.now(), firstInput: after < 0 } }
const verifiedRecords = (home: string) => new AgNativeRecords(home, () => VERIFIED_AGY_NATIVE_RECORD_VERSION)

describe('Antigravity text step cursor', () => {
  const frame = (index: number, type = 'agent_response') => ({ event: 'step_update', step_update: { step_index: index, step_type: type } })
  it('commits recovered steps once and ignores older frames on either side of the next input marker', () => {
    const cursor = new AgTextCursor()
    cursor.begin(17)
    cursor.observe(frame(18, 'user_input'))
    cursor.commit(19)
    cursor.begin(17) // Native DB observation can lag the committed cursor.
    expect(cursor.after).toBe(19)
    expect(cursor.observe(frame(19)).textAllowed).toBe(false)
    expect(cursor.observe(frame(21)).textAllowed).toBe(false) // Cannot assign text before this input's marker.
    expect(cursor.observe({ event: 'step_update', step_update: { step: { step_index: 20, type: 14 } } }).stale).toBe(false)
    expect(cursor.observe(frame(19)).textAllowed).toBe(false)
    expect(cursor.observe(frame(21)).textAllowed).toBe(true)
    cursor.commit()
    expect(cursor.committedThrough).toBe(21)
    cursor.begin(21)
    expect(cursor.observe(frame(21)).textAllowed).toBe(false)
  })
  it('never assigns unindexed or foreign-conversation text to an indexed/recovered phase', () => {
    const cursor = new AgTextCursor()
    const unindexed = { step_update: { step_type: 'agent_response', text_delta: 'text' } }
    cursor.begin()
    expect(cursor.observe(unindexed).textAllowed).toBe(true)
    cursor.commit(19)
    cursor.begin(19)
    expect(cursor.observe(unindexed).textAllowed).toBe(false)
    expect(cursor.observe({ ...frame(21), conversation_id: 'other' }, 'current')).toMatchObject({ textAllowed: false, stale: true, cidMismatch: true })
    expect(cursor.observe({ event: 'step_update', step_update: { step: { step_index: 21, step_type: 'agent_response', conversation_id: 'other' } } }, 'current')).toMatchObject({ textAllowed: false, stale: true, cidMismatch: true })
    expect(cursor.observe({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'other', response: 'foreign' } }, 'current')).toMatchObject({ stale: true, cidMismatch: true })
    expect(cursor.observe({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'current' } }, 'current').stale).toBe(false)
    expect(cursor.observe({ step_update: { step_index: '21' } }).stale).toBe(true)
  })
  it('advances the tool-result phase past already observed pre-tool narration', () => {
    const cursor = new AgTextCursor()
    cursor.begin(9)
    cursor.observe(frame(10, 'user_input'))
    cursor.observe(frame(11))
    cursor.nextPhase(10)
    expect(cursor.observe(frame(11)).textAllowed).toBe(false)
    expect(cursor.observe(frame(12)).textAllowed).toBe(true)
  })
})

describe('Antigravity final response channels', () => {
  it('deduplicates complete snapshots, extends streamed prefixes, and excludes thinking', () => {
    const text = new AgFinalText()
    text.accept({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'head=' } }
    )
    expect(text.take()).toBe('head=')
    text.accept({ event: 'step_update', step_update: { step_type: 'thinking', text_delta: 'SECRET_THINKING' } })
    text.accept({ event: 'step_update', step_update: { step: { type: 15, planner_response: { response: 'head=H;tail=T', thinking: 'SECRET_THINKING' } } } })
    expect(text.take()).toBe('H;tail=T')
    text.accept({ event: 'result', result: { status: 'SUCCESS', planner_response: { modified_response: 'head=H;tail=T' } } })
    expect(text.take()).toBe('')
    expect(text.text).not.toContain('SECRET_THINKING')
  })
  it('keeps published deltas when consecutive planner steps have separate snapshots', () => {
    const text = new AgFinalText()
    text.accept({ step_update: { step_type: 'agent_response', text_delta: 'First step. ' } })
    expect(text.take()).toBe('First step. ')
    text.accept({ step_update: { step_type: 'agent_response', planner_response: { response: 'First step. ' } } })
    text.accept({ step_update: { step_type: 'agent_response', text_delta: 'Final answer.' } })
    expect(text.take()).toBe('Final answer.')
    text.accept({ step_update: { step_type: 'agent_response', planner_response: { response: 'Final answer.' } } })
    expect(text.text).toBe('First step. Final answer.')
    expect(text.take()).toBe('')
    expect(text.ignoredSnapshots).toBe(1)
  })
  it('records field shapes without text, arguments or reasoning values', () => {
    const shape = agEventShape({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'SECRET_ANSWER', thinking: 'SECRET_THINKING', arguments: { token: 'SECRET_CREDENTIAL' } } })
    const serialized = JSON.stringify(shape)
    expect(serialized).toContain('text_delta')
    expect(serialized).not.toContain('SECRET_')
  })
})

describe.skipIf(process.platform === 'win32')('Antigravity current-turn native record', () => {
  it('gates SQLite recovery to the verified agy 1.2.7 schema version', async () => {
    const home = await directory(), cid = randomUUID()
    native.answer(native.input(home, cid, 'CURRENT'), 'ANSWER')
    expect(isVerifiedAgNativeRecordVersion('1.2.7')).toBe(true)
    expect(isVerifiedAgNativeRecordVersion('1.5.5')).toBe(false)
    for (const version of ['', '1.5.5']) {
      const records = new AgNativeRecords(home, () => version)
      expect(records.supported()).toBe(false)
      expect(records.watermark(cid)).toBeUndefined()
      expect(records.recover(cid, anchor('CURRENT'))).toBeUndefined()
    }
    expect(verifiedRecords(home).supported()).toBe(true)
    expect(verifiedRecords(home).recover(cid, anchor('CURRENT'))?.text).toBe('ANSWER')
  })
  it('reads the independently supplied 1.2.7 protobuf fixture without changing the DB', async () => {
    const home = await directory()
    const fixture = JSON.parse(await readFile(fileURLToPath(new URL('./fixtures/agy-native-turn-1.2.7.json', import.meta.url)), 'utf8')) as {
      conversation_id: string; trajectory_meta: Array<[string, string, number, number]>;
      steps: Array<{ idx: number; step_type: number; status: number; step_format: number; metadata_hex: string; step_payload_hex: string }>
      expected: { user_response: string; final_text: string }
    }
    const path = dbPath(home, fixture.conversation_id)
    await mkdir(join(home, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true })
    const db = new Database(path)
    db.exec(native.schema)
    for (const row of fixture.trajectory_meta) db.prepare('INSERT INTO trajectory_meta VALUES(?,?,?,?)').run(...row)
    for (const row of fixture.steps) db.prepare('INSERT INTO steps VALUES(?,?,?,?,?,?,NULL)').run(row.idx, row.step_type, row.status, row.step_format, Buffer.from(row.metadata_hex, 'hex'), Buffer.from(row.step_payload_hex, 'hex'))
    db.close()
    const before = createHash('sha256').update(await readFile(path)).digest('hex')
    const records = verifiedRecords(home)
    const result = records.recover(fixture.conversation_id, { ...anchor(fixture.expected.user_response, 9), firstInput: false, startedAt: 1700000000000 })
    expect(result?.text).toBe(fixture.expected.final_text)
    expect(result?.inputStep).toBe(10)
    expect(result?.responseStep).toBe(11)
    expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(before)
  })
  it('enforces actual SQLite read-only mode despite libsql ignoring the readonly option', async () => {
    const home = await directory(), cid = randomUUID()
    native.answer(native.input(home, cid, 'CURRENT'), 'ANSWER')
    const db = new Database(agNativeRecordUri(dbPath(home, cid)))
    try { expect(() => db.exec('DELETE FROM steps')).toThrow() } finally { db.close() }
  })
  it('rejects an old answer even when the new prompt would be identical', async () => {
    const home = await directory(), cid = randomUUID(), records = verifiedRecords(home)
    native.answer(native.input(home, cid, 'SAME_PROMPT'), 'OLD_ANSWER')
    const mark = records.watermark(cid)!
    expect(records.recover(cid, { ...anchor('SAME_PROMPT', mark), conversationId: cid })).toBeUndefined()
  })
  it('selects only the new execution and rejects mismatched input, conversation, phase and timestamps', async () => {
    const home = await directory(), cid = randomUUID(), records = verifiedRecords(home)
    native.answer(native.input(home, cid, 'OLD'), 'OLD_ANSWER')
    const current = anchor('CURRENT', records.watermark(cid)!)
    native.answer(native.input(home, cid, 'CURRENT'), 'NEW_ANSWER')
    expect(records.recover(cid, current)?.text).toBe('NEW_ANSWER')
    expect(records.recover(cid, { ...current, prompt: 'DIFFERENT' })).toBeUndefined()
    expect(records.recover(cid, { ...current, conversationId: randomUUID() })).toBeUndefined()
    expect(records.recover(cid, { ...current, responseAfter: records.watermark(cid)! })).toBeUndefined()
    expect(records.recover(cid, { ...current, startedAt: Date.now() + 60000 })).toBeUndefined()
  })
  for (const failure of ['execution', 'status', 'error', 'tool', 'empty', 'ambiguous'] as const) {
    it(`rejects native ${failure} records`, async () => {
      const home = await directory(), cid = randomUUID(), records = verifiedRecords(home), current = anchor('CURRENT')
      const turn = native.input(home, cid, 'CURRENT')
      native.answer(turn, failure === 'empty' ? '' : 'ANSWER', {
        ...(failure === 'execution' ? { execution: randomUUID() } : {}),
        ...(failure === 'status' ? { status: 2 } : {}),
        ...(failure === 'error' ? { error: 'native failure' } : {}),
        ...(failure === 'tool' ? { tool: true } : {}),
        ...(failure === 'ambiguous' ? { modified: 'DIFFERENT' } : {}), thinking: 'PRIVATE_THINKING',
      })
      expect(records.recover(cid, current)).toBeUndefined()
    })
  }
  it('rejects oversized and malformed protobuf records without retaining a read transaction', async () => {
    const home = await directory(), cid = randomUUID(), records = verifiedRecords(home), current = anchor('CURRENT')
    native.answer(native.input(home, cid, 'CURRENT'), 'ANSWER')
    for (const value of ["X'80'", 'zeroblob(4194305)']) {
      const db = new Database(dbPath(home, cid))
      try { db.exec(`UPDATE steps SET step_payload = ${value} WHERE step_type = 15`) } finally { db.close() }
      expect(records.recover(cid, current)).toBeUndefined()
    }
  })
  it('sees committed WAL content and never follows a database symlink', async () => {
    const home = await directory(), cid = randomUUID(), records = verifiedRecords(home)
    const turn = native.input(home, cid, 'CURRENT')
    const held = new Database(dbPath(home, cid)); held.pragma('journal_mode = WAL')
    try {
      const current = { ...anchor('CURRENT'), startedAt: Date.now() - 1000 }
      native.answer(turn, 'WAL_ANSWER')
      expect(records.recover(cid, current)?.text).toBe('WAL_ANSWER')
    } finally { held.close() }
    const alias = randomUUID()
    await symlink(dbPath(home, cid), dbPath(home, alias))
    expect(records.watermark(alias)).toBeUndefined()
    expect(records.recover('../bad', anchor('CURRENT'))).toBeUndefined()
  })
})

const executable = fileURLToPath(new URL('./fixtures/agy-cli.cjs', import.meta.url))
async function server(nativeRecords = true, options: { turnTimeoutMs?: number; reuseConversations?: boolean } = {}) {
  const home = await directory()
  const runtime = new AntigravityRuntime({ executable, allowToolBridge: true, turnTimeoutMs: options.turnTimeoutMs ?? 10000, idleConversationMs: 5000, reuseConversations: options.reuseConversations })
  runtime.childEnv.HOME = home
  if (nativeRecords) runtime.childEnv.AGY_FIXTURE_NATIVE_RECORDS = '1'
  const app = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity' }, runtime)
  cleanup.unshift(app.closeBackend)
  const send = (messages: AgMessage[], extra = {}, signal?: AbortSignal) => app.app.fetch(new Request('http://local/v1/messages', { method: 'POST', signal, body: JSON.stringify({ model: 'fixture-model', max_tokens: 128, messages, tools: [], ...extra }) }))
  return { runtime, send, app, home }
}

describe.skipIf(process.platform === 'win32')('Antigravity final-text recovery integration', () => {
  for (const channel of ['FINAL_RESPONSE_SNAPSHOT', 'FINAL_RESULT_SNAPSHOT', 'FINAL_LATE_RESPONSE']) {
    it(`collects ${channel} without requiring native records`, async () => {
      const { send } = await server(false)
      const response = await send([{ role: 'user', content: `SKIP_TOOLS ${channel}` }])
      expect(response.status).toBe(200)
      const answer = await response.json() as { content: unknown }
      expect(answer.content).toEqual([{ type: 'text', text: 'READY' }])
    })
  }
  it('preserves a two-planner-step delta response without treating per-step snapshots as cumulative', async () => {
    const { send } = await server(false)
    const log = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const response = await send([{ role: 'user', content: 'SKIP_TOOLS FINAL_MULTISTEP_SNAPSHOT' }])
      expect(response.status).toBe(200)
      expect((await response.json() as { content: unknown }).content).toEqual([{ type: 'text', text: 'First planner step. READY' }])
      const lines = log.mock.calls.map(args => String(args[0]))
      expect(lines.some(line => line.includes('antigravity.final_text_snapshot_ignored'))).toBe(true)
      expect(lines.join('\n')).not.toContain('First planner step.')
      expect(lines.join('\n')).not.toContain('READY')
    } finally { log.mockRestore() }
  })
  describe('recovered-turn cursor isolation', () => {
    it('excludes the prior 44-byte response from the 90-byte concatenation shape', async () => {
      const { send, runtime } = await server()
      const oldText = 'FIRST_ONLY_' + 'X'.repeat(33), currentText = 'SECOND_ONLY_' + 'Y'.repeat(32)
      expect(Buffer.byteLength(oldText)).toBe(44)
      expect(Buffer.byteLength(currentText)).toBe(44)
      expect(Buffer.byteLength(oldText + '\n' + currentText + '\n')).toBe(90)
      const messages: AgMessage[] = [{ role: 'user', content: `SKIP_TOOLS TURN_ANSWER_${oldText} NATIVE_RECORD_ONLY NATIVE_DEFERRED_CURSOR NATIVE_DEFERRED_TAGGED_ONLY` }]
      const first = await send(messages)
      const prior = await first.json() as { content: AgMessage['content'] }
      expect(prior.content).toEqual([{ type: 'text', text: oldText }])
      messages.push({ role: 'assistant', content: prior.content }, { role: 'user', content: `SKIP_TOOLS TURN_ANSWER_${currentText} CURRENT_NEWLINE` })
      const second = await send(messages)
      expect(second.status).toBe(200)
      expect((await second.json() as { content: unknown }).content).toEqual([{ type: 'text', text: currentText + '\n' }])
      expect(runtime.reused).toBe(1)
    })
    for (const twice of [false, true]) {
      it(`returns exact current text after ${twice ? 'two consecutive recoveries' : 'one recovery'}`, async () => {
        const { send, runtime } = await server()
        const messages: AgMessage[] = []
        for (const [at, expected] of ['FIRST_ONLY', 'SECOND_ONLY', 'THIRD_ONLY'].entries()) {
          const hidden = at === 0 || (twice && at === 1)
          messages.push({ role: 'user', content: `SKIP_TOOLS TURN_ANSWER_${expected} ${hidden ? 'NATIVE_RECORD_ONLY NATIVE_DEFERRED_CURSOR' : ''}` })
          const response = await send(messages)
          expect(response.status).toBe(200)
          const answer = await response.json() as { content: AgMessage['content'] }
          expect(answer.content).toEqual([{ type: 'text', text: expected }])
          messages.push({ role: 'assistant', content: answer.content })
        }
        expect(runtime.reused).toBe(2)
      })
    }
    for (const mode of ['stream', 'UNSCOPED_CURRENT_TEXT', 'STALE_RESULT_SNAPSHOT']) {
      it(`keeps exact next-turn text with ${mode}`, async () => {
        const { send } = await server()
        const messages: AgMessage[] = [{ role: 'user', content: 'SKIP_TOOLS TURN_ANSWER_FIRST_ONLY NATIVE_RECORD_ONLY NATIVE_DEFERRED_CURSOR' }]
        const first = await send(messages)
        const prior = await first.json() as { content: AgMessage['content'] }
        expect(prior.content).toEqual([{ type: 'text', text: 'FIRST_ONLY' }])
        messages.push({ role: 'assistant', content: prior.content }, { role: 'user', content: `SKIP_TOOLS TURN_ANSWER_SECOND_ONLY ${mode === 'stream' ? '' : mode}` })
        const response = await send(messages, { stream: mode === 'stream' })
        expect(response.status).toBe(200)
        if (mode === 'stream') {
          const text = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as { type: string; delta?: { type: string; text?: string } }).filter(event => event.type === 'content_block_delta' && event.delta?.type === 'text_delta').map(event => event.delta!.text).join('')
          expect(text).toBe('SECOND_ONLY')
        } else expect((await response.json() as { content: unknown }).content).toEqual([{ type: 'text', text: 'SECOND_ONLY' }])
      })
    }
    it('does not prepend a recovered answer to a later tool-use response or tool-result answer', async () => {
      const { send, runtime, home } = await server()
      const gate = join(home, 'deferred-tool-gate')
      runtime.childEnv.AGY_FIXTURE_TOOL_GATE = gate
      const tools = [{ name: 'lookup', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }]
      const messages: AgMessage[] = [{ role: 'user', content: 'SKIP_TOOLS TURN_ANSWER_FIRST_ONLY NATIVE_RECORD_ONLY NATIVE_DEFERRED_CURSOR' }]
      const first = await send(messages, { tools })
      expect(first.status).toBe(200)
      const answer = await first.json() as { content: AgMessage['content'] }
      expect(answer.content).toEqual([{ type: 'text', text: 'FIRST_ONLY' }])
      messages.push({ role: 'assistant', content: answer.content }, { role: 'user', content: 'DEFER_TOOL_TEXT lookup current value' })
      const pendingSecond = send(messages, { tools })
      const deadline = Date.now() + 3000
      while (!runtime.toolOwners.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1))
      expect(runtime.toolOwners.size).toBe(1)
      await writeFile(gate, '')
      const second = await pendingSecond
      const emitted = () => access(gate + '.emitted').then(() => true, () => false)
      while (!(await emitted()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1))
      await access(gate + '.emitted')
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(second.status).toBe(200)
      const call = await second.json() as { stop_reason: string; content: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> }
      expect(call.stop_reason).toBe('tool_use')
      expect(call.content).toEqual([{ type: 'tool_use', id: call.content[0]!.id, name: 'lookup', input: { key: 'probe0' } }])
      messages.push({ role: 'assistant', content: call.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.content[0]!.id, content: 'TOOL_FINAL_ONLY' }] })
      const third = await send(messages, { tools })
      expect(third.status).toBe(200)
      expect((await third.json() as { content: unknown }).content).toEqual([{ type: 'text', text: 'TOOL_FINAL_ONLY' }])
    })
    it('keeps a genuinely empty next turn an error despite delayed prior text', async () => {
      const { send } = await server()
      const messages: AgMessage[] = [{ role: 'user', content: 'SKIP_TOOLS TURN_ANSWER_FIRST_ONLY NATIVE_RECORD_ONLY NATIVE_DEFERRED_CURSOR' }]
      const first = await send(messages)
      const answer = await first.json() as { content: AgMessage['content'] }
      expect(answer.content).toEqual([{ type: 'text', text: 'FIRST_ONLY' }])
      messages.push({ role: 'assistant', content: answer.content }, { role: 'user', content: 'SKIP_TOOLS NATIVE_RECORD_EMPTY' })
      expect((await send(messages)).status).toBe(502)
    })
    it('logs a shape-only conversation mismatch when a frame carries a foreign conversation_id', async () => {
      const { send } = await server(true, { turnTimeoutMs: 150 })
      const log = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const response = await send([{ role: 'user', content: 'SKIP_TOOLS FOREIGN_CID_RESULT' }])
        expect(response.status).toBe(504)
        const lines = log.mock.calls.map(args => String(args[0]))
        expect(lines.some(line => line.includes('antigravity.conversation_mismatch'))).toBe(true)
        expect(lines.join('\n')).not.toContain('FOREIGN_CID_RESULT')
      } finally { log.mockRestore() }
    })
  })
  it('recovers across alternating warm turns from the current native record without text in logs', async () => {
    const { send, runtime } = await server()
    const messages: AgMessage[] = []
    const log = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const turn of [1, 2, 3, 4, 5]) {
        const expected = `TURN_${turn}_SECRET_TEXT`
        messages.push({ role: 'user', content: `SKIP_TOOLS TURN_ANSWER_${expected} ${turn % 2 === 1 ? 'NATIVE_RECORD_ONLY' : ''}` })
        const response = await send(messages)
        expect(response.status).toBe(200)
        const answer = await response.json() as { content: AgMessage['content'] }
        expect(answer.content).toEqual([{ type: 'text', text: expected }])
        messages.push({ role: 'assistant', content: answer.content })
      }
      expect(runtime.reused).toBe(4)
      const lines = log.mock.calls.map(args => String(args[0]))
      expect(lines.filter(line => line.includes('antigravity.final_text_recovered') && line.includes('native-record'))).toHaveLength(3)
      expect(lines.join('\n')).not.toContain('SECRET_TEXT')
      expect(lines.join('\n')).not.toContain('PRIVATE_REASONING_NEVER_RETURN')
    } finally { log.mockRestore() }
  })
  it('recovers an unrecognized stream channel from the native record and rejects empty, wrong-exec, or unverified-version records', async () => {
    const { send, runtime } = await server()
    expect((await send([{ role: 'user', content: 'SKIP_TOOLS FINAL_UNRECOGNIZED' }])).status).toBe(200)
    expect((await send([{ role: 'user', content: 'SKIP_TOOLS NATIVE_RECORD_EMPTY' }])).status).toBe(502)
    expect((await send([{ role: 'user', content: 'SKIP_TOOLS NATIVE_RECORD_WRONG_EXEC' }])).status).toBe(502)
    const verify = spyOn(runtime, 'verifyAccount').mockImplementation(async () => { runtime.cliVersion = '1.5.5' })
    try { expect((await send([{ role: 'user', content: 'SKIP_TOOLS NATIVE_RECORD_ONLY' }])).status).toBe(502) }
    finally { verify.mockRestore() }
  })
  it('supports non-reusable cold recovery when stream text is absent', async () => {
    const { send } = await server(true, { reuseConversations: false })
    const response = await send([{ role: 'user', content: 'SKIP_TOOLS TURN_ANSWER_COLD_NATIVE NATIVE_RECORD_ONLY' }])
    expect(response.status).toBe(200)
    expect((await response.json() as { content: unknown }).content).toEqual([{ type: 'text', text: 'COLD_NATIVE' }])
  })
  it('never reuses pre-tool narration as the final answer', async () => {
    const { send } = await server()
    const tools = [{ name: 'lookup', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }]
    const messages: AgMessage[] = [{ role: 'user', content: 'NATIVE_EMPTY_AFTER_TOOL lookup' }]
    const first = await send(messages, { tools })
    const calls = await first.json() as { content: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> }
    messages.push({ role: 'assistant', content: calls.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: calls.content[0]!.id, content: 'new result' }] })
    expect((await send(messages, { tools })).status).toBe(502)
  })
  it('recovers only the post-tool answer from the same native execution', async () => {
    const { send } = await server()
    const tools = [{ name: 'lookup', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }]
    const messages: AgMessage[] = [{ role: 'user', content: 'NATIVE_RECORD_ONLY lookup' }]
    const first = await send(messages, { tools })
    const calls = await first.json() as { content: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> }
    messages.push({ role: 'assistant', content: calls.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: calls.content[0]!.id, content: 'post-tool answer' }] })
    const response = await send(messages, { tools })
    expect(response.status).toBe(200)
    expect((await response.json() as { content: unknown }).content).toEqual([{ type: 'text', text: 'post-tool answer' }])
  })
  for (const interruption of ['cancel', 'shutdown']) {
    it(`joins native recovery on ${interruption}`, async () => {
      const { send, runtime, app } = await server()
      const controller = new AbortController()
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const read = spyOn(AgNativeRecords.prototype, 'recover').mockImplementation(() => { entered(); return undefined })
      try {
        const pending = send([{ role: 'user', content: 'SKIP_TOOLS NATIVE_RECORD_EMPTY' }], {}, controller.signal)
        await started
        if (interruption === 'cancel') controller.abort()
        else await app.closeBackend()
        expect((await pending).status).toBe(interruption === 'cancel' ? 499 : 503)
        await app.closeBackend()
        expect(runtime.settling.size).toBe(0)
        expect(runtime.runs.size).toBe(0)
      } finally { read.mockRestore() }
    })
  }
  for (const invalid of ['BAD_NATIVE_JSON', 'WRONG_NATIVE_SCHEMA']) {
    it(`rejects recovered structured ${invalid}`, async () => {
      const { send } = await server()
      const format = { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } }
      const response = await send([{ role: 'user', content: `SKIP_TOOLS NATIVE_RECORD_ONLY MISSING_STRUCTURED ${invalid}` }], { output_config: { format } })
      expect(response.status).toBe(502)
      expect(await response.text()).not.toContain('PRIVATE_INVALID_JSON')
    })
  }
  it('validates recovered structured JSON rather than returning unvalidated native text', async () => {
    const { send } = await server()
    const format = { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } }
    const response = await send([{ role: 'user', content: 'SKIP_TOOLS NATIVE_RECORD_ONLY MISSING_STRUCTURED' }], { output_config: { format } })
    expect(response.status).toBe(200)
    expect((await response.json() as { content: unknown }).content).toEqual([{ type: 'text', text: '{"answer":"READY"}' }])
  })
})
