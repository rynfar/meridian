#!/usr/bin/env bun
// Live: when a client's tool loop does not resume, does the log say so — and
// is the remedy it names actually the remedy?
//
// #820: on the pi adapter, 99.8% of requests carrying 1000+ messages
// classified as `lineage=new`, and NONE of them logged a reason. The bypass is
// assigned before `classifyLineage` runs, so the four `classifyLineage`
// diagnostics all sat at zero while 6,514 requests skipped resume. The
// reporter identified it only by reading `server.ts`; two others drained a
// Max subscription window first, because every one of those requests returns
// 200 and nothing in the proxy's own success metrics moves.
//
// Two claims, and the second is what makes the first worth printing:
//
//   1. A real headerless pi tool loop names its bypass on every round
//      (`diverged=independent-request:headerless-tool-result`), and says once
//      that the conversation is not resuming.
//   2. The header that line tells the operator to send ACTUALLY FIXES IT.
//      The same loop with `x-session-affinity` resumes, and stops paying to
//      re-write the prompt prefix every round.
//
// Claim 2 is the discriminator. A diagnostic that names a cause nobody can act
// on is not a fix, and the advice is only correct if the keyed run measurably
// costs less. Asserted as a ratio of cache-write tokens rather than absolute
// numbers: the field reports measured ~280k per turn against ~214 with a key,
// but that was a 454-message conversation, and a four-round probe cannot
// reproduce that magnitude — only its direction and rough shape.
//
// Needs Claude Max and costs a few cents of real tokens. Run before releases
// touching lineage classification, the independence guards, or the request log
// line.
//
//   bun scripts/e2e-lineage-divergence-reason.mjs
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSessionStoreDir } from '../src/proxy/sessionStore.ts'

const WORKDIR = realpathSync(mkdtempSync(join(tmpdir(), 'mdivreason-')))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, 'store'))
process.env.MERIDIAN_PASSTHROUGH = '1'

const FILES = { 'alpha.txt': 'ALPHA-CONTENT', 'bravo.txt': 'BRAVO-CONTENT', 'charlie.txt': 'CHARLIE-CONTENT' }
for (const [name, body] of Object.entries(FILES)) writeFileSync(join(WORKDIR, name), body + '\n')

const { startProxyServer } = await import('../src/proxy/server.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3556)
const MODEL = process.env.PROBE_MODEL ?? 'claude-haiku-4-5-20251001'

const say = console.log.bind(console)
const proxyLog = []
for (const k of ['log', 'error', 'debug', 'warn'] ) console[k] = (...a) => { proxyLog.push(a.map(String).join(' ')) }
const inst = await startProxyServer({ port: PORT, host: '127.0.0.1' })

const failures = []
const check = (ok, label, detail) => {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const READ_TOOL = {
  name: 'read',
  description: 'Read a file from disk. Read exactly one file per call.',
  input_schema: {
    type: 'object',
    properties: { file_path: { type: 'string', description: 'Absolute path' } },
    required: ['file_path'],
  },
}

// Filler tools, exactly as e2e-responses-developer-cache.mjs uses them: the
// prompt prefix has to clear Anthropic's minimum cacheable length before any
// cache accounting appears at all. Measured without them, every round of both
// loops reported cache_read=0 cache_write=0 and the cost claim was untestable.
const FILLER = Array.from({ length: 22 }, (_, i) => ({
  name: `bridge_tool_${i}`,
  description: `Bridge tool ${i}. ` + 'Filler to give the prompt prefix real mass so a re-written prefix is visible in the numbers rather than lost in noise. '.repeat(6),
  input_schema: { type: 'object', properties: { arg: { type: 'string', description: 'An argument.' } } },
}))
const TOOLS = [READ_TOOL, ...FILLER]

const PROMPT = 'Read these three files ONE AT A TIME, waiting for each result before the next call: '
  + Object.keys(FILES).map(f => join(WORKDIR, f)).join(', ')
  + '. After the third, reply with the three contents separated by commas.'

/**
 * Drive a client-side tool loop exactly as pi does: send the growing history,
 * execute whatever tool_use comes back, append the tool_result, repeat.
 */
async function runLoop(label, affinityKey, maxRounds = 4) {
  const messages = [{ role: 'user', content: PROMPT }]
  const rounds = []
  for (let round = 1; round <= maxRounds; round++) {
    const headers = { 'content-type': 'application/json', 'x-meridian-agent': 'pi' }
    if (affinityKey) headers['x-session-affinity'] = affinityKey
    const before = proxyLog.length
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: false, tools: TOOLS, messages }),
    })
    const body = await res.json().catch(() => null)
    const line = proxyLog.slice(before).find(l => l.includes('[PROXY]') && l.includes('adapter=') && l.includes('msgCount=')) ?? ''
    const usage = body?.usage ?? {}
    const info = {
      round,
      status: res.status,
      line,
      lineage: /lineage=(\S+)/.exec(line)?.[1] ?? '?',
      diverged: /diverged=(\S+)/.exec(line)?.[1],
      msgCount: Number(/msgCount=(\d+)/.exec(line)?.[1] ?? 0),
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      lastIsToolResult: Array.isArray(messages.at(-1)?.content)
        && messages.at(-1).content.some(b => b?.type === 'tool_result'),
    }
    rounds.push(info)
    say(`  ${label.padEnd(12)} round ${round}  msgs=${String(info.msgCount).padStart(2)}`
      + ` lineage=${info.lineage.padEnd(12)} diverged=${String(info.diverged ?? '—').padEnd(46)}`
      + ` cache_write=${String(info.cacheWrite).padStart(6)} cache_read=${String(info.cacheRead).padStart(6)}`)

    const blocks = body?.content ?? []
    const calls = blocks.filter(b => b.type === 'tool_use')
    if (!calls.length) break
    messages.push({ role: 'assistant', content: blocks })
    messages.push({
      role: 'user',
      content: calls.map(c => ({
        type: 'tool_result',
        tool_use_id: c.id,
        content: FILES[String(c.input?.file_path ?? '').split('/').pop()] ?? 'NOT FOUND',
      })),
    })
  }
  return rounds
}

const adviceCount = () => proxyLog.filter(l =>
  l.includes('Client-driven tool loop with no session identity')).length

say(`\n=== lineage divergence reason (model=${MODEL}, adapter=pi, passthrough) ===`)

// A: the reported configuration. pi sends no session header of its own.
const A = await runLoop('A headerless', undefined)
const adviceAfterA = adviceCount()

// B: the same loop, with the key the new log line tells the operator to send.
const B = await runLoop('B keyed', `pi-affinity-${process.pid}`)

say('')
// --- Claim 1: no divergence is silent, anywhere in either loop. ---
check(A.every(r => r.status === 200) && B.every(r => r.status === 200),
  'both loops completed', `A=${A.map(r => r.status).join(',')} B=${B.map(r => r.status).join(',')}`)

// THE INVARIANT. Before this change every one of these printed `lineage=new`
// and nothing else; the reporter had 6,514 of them and no way to tell a key
// that never resolved from a request that never looked.
const silent = [...A, ...B].filter(r => r.lineage !== 'continuation' && r.lineage !== 'compaction' && !r.diverged)
check(silent.length === 0, 'every diverged round names a reason',
  silent.length ? `silent: ${silent.map(r => `round ${r.round} lineage=${r.lineage}`).join(', ')}`
    : `${[...A, ...B].filter(r => r.diverged).length} of ${A.length + B.length} rounds diverged, all named`)

const toolRounds = A.filter(r => r.lastIsToolResult)
check(toolRounds.length >= 2, 'the headerless loop ran real tool rounds',
  `${toolRounds.length} of ${A.length} rounds carried a tool_result`)

// The reported bypass, named. Not asserted on EVERY tool round: a headerless
// passthrough loop recovers through the durable checkpoint exactly once — the
// checkpoint upgrade rewrites the lineage result but leaves the request
// independent, so the store is still skipped and the checkpoint never
// advances. Every later round then finds a checkpoint two tool calls stale and
// takes the bypass. That is the shape the field report shows: 6,019 `new`
// against 10 `continuation` at 1000+ messages.
const bypassed = toolRounds.filter(r => r.diverged === 'independent-request:headerless-tool-result')
check(bypassed.length >= 1, 'a headerless tool round names the bypass',
  `${bypassed.length} of ${toolRounds.length} tool rounds; others: `
  + `${[...new Set(toolRounds.filter(r => !bypassed.includes(r)).map(r => r.lineage))].join(', ') || 'none'}`)

// Once per process, not once per round: the reporter's log had 6,019 of these
// in a single conversation, and a per-round line would bury itself.
check(adviceAfterA === 1, 'the advice is printed exactly once, not once per round',
  `${adviceAfterA} occurrence(s) across ${A.length} rounds`)
check(adviceCount() === 1, 'the second loop does not repeat it', `${adviceCount()} total`)

// The first turn of the keyed loop resolved no key — a different outcome that
// used to render as the same `lineage=new`.
check(B[0].diverged === 'not-found', 'a key that never resolved says so instead',
  `round 1 diverged=${B[0].diverged}`)

// --- Claim 2: THE DISCRIMINATOR. Is the advice the log gives correct? ---
const keyedToolRounds = B.filter(r => r.lastIsToolResult)
check(keyedToolRounds.length > 0 && keyedToolRounds.every(r => r.lineage === 'continuation'),
  'the keyed loop resumes on every tool round',
  `saw ${[...new Set(keyedToolRounds.map(r => r.lineage))].join(', ')}`)
check(keyedToolRounds.every(r => r.diverged === undefined),
  'a resumed round prints no divergence at all',
  `saw ${[...new Set(keyedToolRounds.map(r => String(r.diverged)))].join(', ')}`)

// Cost, which is the only reason any of this matters. A resumed round reads
// its prefix; a bypassed round pays to write one. Asserted as a ratio and only
// over the rounds that actually diverged, because absolute numbers here encode
// one model's verbosity at one probe size. The field measured ~280k written
// per turn against ~214 with a key, on a 454-message conversation; a
// four-round probe reproduces the direction, not that magnitude.
const sum = (rs, k) => rs.reduce((n, r) => n + r[k], 0)
const writeA = sum(bypassed, 'cacheWrite'), writeB = sum(keyedToolRounds, 'cacheWrite')
const readA = sum(bypassed, 'cacheRead'), readB = sum(keyedToolRounds, 'cacheRead')
say(`\n  bypassed rounds: cache_write=${writeA} cache_read=${readA}`)
say(`  resumed  rounds: cache_write=${writeB} cache_read=${readB}`)
check(readB > 0, 'a resumed round reads its prompt prefix from cache',
  `keyed cache_read=${readB} across ${keyedToolRounds.length} tool rounds`)
check(readB > readA, 'the keyed loop reads more from cache than the bypassed one',
  `${readB} vs ${readA}`)

// THE FIELD SIGNATURE, reproduced. #820 and the passthrough report both
// measured a cache_read that does not move while the conversation grows, and a
// cache_write that does — 30k read on every one of 12,781 to 13,030 messages.
// That is the static-prefix floor: a fresh SDK session re-reads the tools and
// system block and nothing else, then pays to write the history again.
const readsOf = rs => rs.map(r => r.cacheRead)
const bypassReads = readsOf(bypassed)
check(bypassed.length >= 2 && new Set(bypassReads).size === 1,
  'a bypassed round reads the same static prefix no matter how far the conversation got',
  `cache_read ${bypassReads.join(' -> ')} while msgCount went ${bypassed.map(r => r.msgCount).join(' -> ')}`)
const keyedReads = readsOf(keyedToolRounds)
check(keyedReads.at(-1) > keyedReads[0],
  'a resumed round reads MORE as the conversation grows',
  `cache_read ${keyedReads.join(' -> ')} across msgCount ${keyedToolRounds.map(r => r.msgCount).join(' -> ')}`)

// Per-round rather than total: the two loops ran a different number of
// bypassed rounds, and the operator pays per turn.
const perRound = rs => (rs.length ? sum(rs, 'cacheWrite') / rs.length : 0)
const ratio = perRound(keyedToolRounds) > 0 ? perRound(bypassed) / perRound(keyedToolRounds) : Infinity
check(ratio >= 3, 'a bypassed round pays several times over to re-write the prefix',
  `${Math.round(perRound(bypassed))} vs ${Math.round(perRound(keyedToolRounds))} cache-write tokens per round = ${ratio.toFixed(1)}x`
  + ' (field measured ~280k vs ~214 on a 454-message conversation)')

say(`\n=== verdict ===`)
if (failures.length) {
  say(`  FAIL: ${failures.length} check(s)`)
  for (const f of failures) say(`    - ${f}`)
  say('\n  recent proxy diagnostics:')
  for (const l of proxyLog.filter(l => l.includes('[PROXY]')).slice(-10)) say(`    ${l}`)
} else {
  say('  PASS: every divergence names itself, and the named remedy works')
}
await inst.close()
process.exit(failures.length ? 1 : 0)
