#!/usr/bin/env bun
// Live: does a developer note appearing mid-conversation destroy the prompt
// cache for the whole history?
//
// Anthropic caches the prompt as one prefix, ordered tools -> system ->
// messages. `/v1/responses` folded every `developer`/`system` input item into
// the Anthropic `system` block regardless of where it sat, so a note that first
// shows up on turn N rewrote the system block and invalidated every cached
// token behind the tools — the entire conversation (#966).
//
// Codex emits exactly these as ordinary conversation events:
// `<image_resize_notice>` after every `view_image`, `<model_switch>` and
// `<collaboration_mode>` on a model change, `<app-context>` on app refresh. The
// report measured 14 of 14 cache collapses on a long Desktop thread following
// one of those within 1-3 seconds, with 240k-584k tokens re-written each time.
//
// Confirmed from a real codex-cli 0.153.4 capture that the harness preamble
// arrives as a LEADING `developer` item (`input roles: ["developer","user",...]`).
// That case must keep folding into `system` — it is genuinely the preamble, and
// changing it would move every existing client's cache prefix. Only a note that
// arrives AFTER the conversation starts is inlined.
//
// This is an A/B, because the claim is about cost rather than correctness. Two
// identical conversations, sent twice each so the second turn can hit a warm
// prefix; one carries a developer note in its replayed history.
//
//   A (control)   turn 2 reads its prefix from cache
//   B (developer) turn 2 must re-write no more of it than A did
//
// Both sides use the same tools block and the same message text, so the only
// variable is the note. What is asserted is the ratio of re-written tokens, not
// the hit percentage — see the discriminator note below for why.
//
// Costs a few cents of real tokens and needs Claude Max. Run before releases
// touching Responses prompt assembly or system-block construction.
//
//   bun scripts/e2e-responses-developer-cache.mjs
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { setSessionStoreDir } from '../src/proxy/sessionStore.ts'

const WORKDIR = realpathSync(mkdtempSync('/tmp/mdevcache-'))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, 'store'))

const { startProxyServer } = await import('../src/proxy/server.ts')
const { telemetryStore } = await import('../src/telemetry/index.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3550)
const MODEL = process.env.PROBE_MODEL ?? 'claude-haiku-4-5-20251001'

const say = console.log.bind(console)
const proxyLog = []
for (const k of ['log', 'error', 'debug']) console[k] = (...a) => { proxyLog.push(a.map(String).join(' ')) }
const inst = await startProxyServer({ port: PORT, host: '127.0.0.1' })

const failures = []
const check = (ok, label, detail) => {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// A tools block big enough that losing the cache behind it is unmistakable.
const tools = Array.from({ length: 24 }, (_, i) => ({
  type: 'function', name: `bridge_tool_${i}`,
  description: `Bridge tool ${i}. ` + 'Filler to give the prompt prefix real mass so a cache collapse is visible in the numbers rather than lost in noise. '.repeat(6),
  parameters: { type: 'object', properties: { arg: { type: 'string', description: 'An argument.' } } },
}))

// The shape Codex actually emits mid-conversation.
const NOTE = '<image_resize_notice>The image was resized to fit the context window.</image_resize_notice>'

async function post(thread, input) {
  const before = proxyLog.length
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-meridian-agent': 'codex' },
    body: JSON.stringify({ model: MODEL, stream: false, tools, prompt_cache_key: thread, input }),
  })
  const body = await res.text()
  const line = proxyLog.slice(before).find(l => l.includes('[PROXY]') && l.includes('adapter=codex')) ?? ''
  const requestId = /\[PROXY\]\s+(\S+)/.exec(line)?.[1]
  const row = telemetryStore.getRecent({ limit: 200 }).find(r => r.requestId === requestId)
  return {
    status: res.status, body,
    read: row?.cacheReadInputTokens ?? 0,
    write: row?.cacheCreationInputTokens ?? 0,
    lineage: /lineage=(\S+)/.exec(line)?.[1] ?? '?',
  }
}

const preamble = { role: 'developer', content: [{ type: 'input_text', text: 'You are a helpful assistant. Follow the harness rules.' }] }
const u1 = { role: 'user', content: [{ type: 'input_text', text: 'Reply with the single word ALPHA.' }] }
const a1 = (t) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] })
const u2 = { role: 'user', content: [{ type: 'input_text', text: 'Now reply with the single word BRAVO.' }] }

async function run(label, thread, withNote) {
  // Turn 1 establishes the prefix. Identical on both sides.
  const t1 = await post(thread, [preamble, u1])
  let reply = 'ALPHA'
  try {
    const parsed = JSON.parse(t1.body)
    reply = (parsed.output ?? []).filter(o => o?.type === 'message')
      .flatMap(o => (o.content ?? []).map(c => c.text ?? '')).join('') || reply
  } catch { /* keep the default */ }
  // Turn 2 replays the history; B inserts the note where Codex would.
  const history = withNote
    ? [preamble, u1, a1(reply), { role: 'developer', content: [{ type: 'input_text', text: NOTE }] }, u2]
    : [preamble, u1, a1(reply), u2]
  const t2 = await post(thread, history)
  const total = t2.read + t2.write
  const pct = total ? Math.round((100 * t2.read) / total) : 0
  say(`  ${label.padEnd(14)} turn2 lineage=${t2.lineage.padEnd(13)} cache_read=${String(t2.read).padStart(7)} cache_write=${String(t2.write).padStart(7)}  ${pct}% cached`)
  return { ...t2, pct }
}

say(`\n=== responses developer-note cache A/B (model=${MODEL}) ===`)
const A = await run('A control', `devcache-a-${process.pid}`, false)
const B = await run('B developer', `devcache-b-${process.pid}`, true)

check(A.status === 200 && B.status === 200, 'both conversations completed', `http=${A.status},${B.status}`)
check(A.pct >= 80, 'the control turn 2 read its prefix from cache', `${A.pct}% cached`)

// THE DISCRIMINATOR is re-written tokens, not hit percentage.
//
// Percentage does not scale down to a probe. The reported collapse was on a
// ~700k-token thread where the system block sits behind a ~125k tools block, so
// losing everything behind system cost 240k-584k. Here the whole conversation
// is ~6.5k, so the same bug only moves the rate from 98% to ~86% — which any
// reasonable percentage threshold would wave through. Measured on pre-fix code:
//
//   A control    cache_read=6581  cache_write=114   98% cached
//   B developer  cache_read=5765  cache_write=931   86% cached
//
// The ratio of re-written tokens is the invariant: ~8x pre-fix, ~1.1x after.
const writeRatio = A.write > 0 ? B.write / A.write : (B.write > 0 ? Infinity : 1)
check(writeRatio <= 3,
  'the note re-wrote no more of the prefix than the control',
  `B/A cache_write = ${writeRatio.toFixed(1)}x (${B.write} vs ${A.write}); pre-fix measured ~8x`)
say(`  note  hit rate control=${A.pct}% note=${B.pct}% — reported as context; at probe scale the`
  + ` percentage barely moves even when the prefix is re-written, so it is not asserted`)

say(`\n=== verdict ===`)
if (failures.length) {
  say(`  FAIL: ${failures.length} check(s)`)
  for (const f of failures) say(`    - ${f}`)
  say('\n  recent proxy diagnostics:')
  for (const l of proxyLog.filter(l => l.includes('[PROXY]')).slice(-10)) say(`    ${l}`)
} else {
  say('  PASS: a mid-conversation developer note keeps the cached prefix')
}
await inst.close()
process.exit(failures.length ? 1 : 0)
