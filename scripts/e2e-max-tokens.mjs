#!/usr/bin/env bun
// Live: is the client's `max_tokens` actually a cap, and does a truncated turn
// say so?
//
// `max_tokens` is REQUIRED on `/v1/messages` and the API contract makes it a
// hard cap on total output, with a cut-off response reporting
// `stop_reason: "max_tokens"`. Nothing on this path ever read it (#874,
// reported by @albe-jj with 16 -> 3900 output tokens, a 244x overshoot, and
// `end_turn` every time).
//
// Why this needs the real SDK and could not be reasoned out:
//
//   - The Agent SDK's `Options` has NO output cap. The full key list has
//     `maxBudgetUsd`, `maxThinkingTokens`, `maxTurns`, `taskBudget` and nothing
//     for output tokens, so there is no parameter to pass through.
//   - The CLI's `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is the only lever, and when it
//     trips the CLI does not return a truncated turn — it THROWS
//     "Claude's response exceeded the N output token maximum". Wiring it up
//     naively converts a satisfiable request into a hard error.
//   - But the cap is real: probed at 64 against CLI 2.1.263, the turn produced
//     genuine assistant text (154 chars, ~38 tokens) and then threw. The API
//     stopped generating; only the shape coming back was wrong.
//
// So the fix passes the cap through and translates that refusal into the stop
// reason the wire defines. Because generation really stopped, the SDK session
// holds the same truncated text the client receives — no post-hoc truncation,
// so resume stays consistent.
//
// Four claims:
//
//   1. A small cap actually bounds output. Asserted as a large multiple of the
//      cap rather than an exact number: the cap counts thinking plus text, and
//      the point is that a 244x overshoot is gone, not that a specific token
//      count lands.
//   2. A capped turn reports `stop_reason: "max_tokens"`, not `end_turn` and
//      not an HTTP error.
//   3. A generous cap is unchanged — same stop reason as today, no truncation.
//      This is the regression guard: the cap now rides on EVERY request.
//   4. Streaming behaves the same as non-streaming.
//
// Costs a few cents of real tokens and needs Claude Max. Run before releases
// touching the SDK call builder, env plumbing, or terminal stop reasons.
//
//   bun scripts/e2e-max-tokens.mjs
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { setSessionStoreDir } from '../src/proxy/sessionStore.ts'

const WORKDIR = realpathSync(mkdtempSync('/tmp/mmaxtok-'))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, 'store'))

// Opt-in. The gate must set it explicitly, and the DEFAULT path is asserted
// separately below so the off-by-default promise is tested, not assumed.
process.env.MERIDIAN_ENFORCE_MAX_TOKENS = '1'
const { startProxyServer } = await import('../src/proxy/server.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3552)
const MODEL = process.env.PROBE_MODEL ?? 'claude-haiku-4-5-20251001'
const PROMPT = 'Write a detailed essay on the history of planet Earth.'

const say = console.log.bind(console)
const proxyLog = []
for (const k of ['log', 'error', 'debug']) console[k] = (...a) => { proxyLog.push(a.map(String).join(' ')) }
const inst = await startProxyServer({ port: PORT, host: '127.0.0.1' })

const failures = []
const check = (ok, label, detail) => {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

async function ask(maxTokens, stream) {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session': `maxtok-${maxTokens}-${stream}-${process.pid}` },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, stream, messages: [{ role: 'user', content: PROMPT }] }),
  })
  const text = await res.text()
  let stop = null, out = 0, chars = 0, errors = 0
  if (stream) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      let ev
      try { ev = JSON.parse(line.slice(5)) } catch { continue }
      if (ev.type === 'error') errors++
      if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) stop = ev.delta.stop_reason
        if (ev.usage?.output_tokens) out = ev.usage.output_tokens
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') chars += (ev.delta.text ?? '').length
    }
  } else {
    let body = null
    try { body = JSON.parse(text) } catch { /* surfaced by the caller */ }
    if (body?.type === 'error') errors++
    stop = body?.stop_reason ?? null
    out = body?.usage?.output_tokens ?? 0
    chars = (body?.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('').length
  }
  say(`  max_tokens=${String(maxTokens).padEnd(6)} stream=${String(stream).padEnd(5)} http=${res.status} stop=${String(stop).padEnd(11)} output_tokens=${String(out).padStart(5)} chars=${String(chars).padStart(5)} errors=${errors}`)
  return { status: res.status, stop, out, chars, errors }
}

say(`\n=== max_tokens enforcement (model=${MODEL}) ===`)

// The reported case: a 16-token cap that produced 3900 tokens and `end_turn`.
const tiny = await ask(16, false)
check(tiny.status === 200 && tiny.errors === 0, 'a tiny cap does not fail the request',
  `http=${tiny.status} errors=${tiny.errors}`)
check(tiny.stop === 'max_tokens', 'a capped turn reports stop_reason=max_tokens',
  `stop=${tiny.stop}`)
// Asserted as a bound, not an exact count: the cap covers thinking + text, and
// the defect was a 244x overshoot, not an off-by-a-few.
check(tiny.out > 0 && tiny.out < 16 * 20, 'output is actually bounded by the cap',
  `output_tokens=${tiny.out} against cap 16 (reported 3900 = 244x)`)

const tinyStream = await ask(16, true)
check(tinyStream.status === 200 && tinyStream.errors === 0,
  'streaming: a tiny cap delivers no error frame', `http=${tinyStream.status} errors=${tinyStream.errors}`)
check(tinyStream.stop === 'max_tokens', 'streaming: capped turn closes as max_tokens',
  `stop=${tinyStream.stop}`)

// REGRESSION GUARD. The cap now rides on every request, so a generous value
// must behave exactly as before: a full answer ending normally.
const roomy = await ask(4096, false)
check(roomy.status === 200 && roomy.errors === 0, 'a generous cap is unaffected',
  `http=${roomy.status} errors=${roomy.errors}`)
check(roomy.stop === 'end_turn', 'a generous cap still ends normally', `stop=${roomy.stop}`)
check(roomy.chars > tiny.chars, 'a generous cap returns more content than a tiny one',
  `${roomy.chars} chars vs ${tiny.chars}`)

const roomyStream = await ask(4096, true)
check(roomyStream.status === 200 && roomyStream.stop === 'end_turn',
  'streaming: a generous cap still ends normally', `http=${roomyStream.status} stop=${roomyStream.stop}`)

// The off-by-default promise, asserted rather than assumed: a fresh proxy with
// the flag cleared must ignore a tiny cap exactly as before the change.
delete process.env.MERIDIAN_ENFORCE_MAX_TOKENS
const off = await startProxyServer({ port: PORT + 1, host: '127.0.0.1' })
try {
  const res = await fetch(`http://127.0.0.1:${PORT + 1}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session': `maxtok-off-${process.pid}` },
    body: JSON.stringify({ model: MODEL, max_tokens: 16, stream: false, messages: [{ role: 'user', content: PROMPT }] }),
  })
  const body = await res.json()
  const out = body?.usage?.output_tokens ?? 0
  say(`  default (flag unset)  http=${res.status} stop=${body?.stop_reason} output_tokens=${out}`)
  // Compared against the capped run rather than an absolute number: what
  // matters is that the cap had no effect, and "many times the capped output"
  // says that at any model size. A fixed threshold just encodes one model's
  // verbosity and fails on a quieter one.
  check(res.status === 200 && body?.stop_reason === 'end_turn' && out > tiny.out * 2,
    'with the flag unset a tiny cap is ignored, exactly as before',
    `stop=${body?.stop_reason} output_tokens=${out} vs capped ${tiny.out}`)
} finally {
  await off.close()
}

say(`\n=== verdict ===`)
if (failures.length) {
  say(`  FAIL: ${failures.length} check(s)`)
  for (const f of failures) say(`    - ${f}`)
  say('\n  recent proxy diagnostics:')
  for (const l of proxyLog.filter(l => l.includes('[PROXY]')).slice(-12)) say(`    ${l}`)
} else {
  say('  PASS: max_tokens bounds output and truncation is reported honestly')
}
await inst.close()
process.exit(failures.length ? 1 : 0)
