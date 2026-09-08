#!/usr/bin/env bun
// Live: does a Codex thread keep its own SDK session when a sibling flow shares
// its prompt_cache_key?
//
// Since #655, `prompt_cache_key` was the whole identity `/v1/responses` had.
// Codex Desktop hands a spawned subagent the PARENT's cache key, and runs
// compaction against the same thread id — so two live conversations collided on
// one session key. The subagent's first turn rebound the key to its own SDK
// session and the parent's next turn then read as a rewrite of it: either a 400
// "This session advanced while the request was waiting", or, when it won the
// race instead, a full replay at 0% cache (#965).
//
// The metadata this keys on was verified against a real capture from codex-cli
// 0.153.4, not taken from docs. A user-driven turn sends, inside
// `client_metadata`:
//
//   "x-codex-turn-metadata": "{... \"thread_id\":\"<id>\", \"request_kind\":\"turn\",
//                              \"thread_source\":\"user\", \"agent_name\":\"/root\" ...}"
//
// and for that user thread `thread_id` EQUALS `prompt_cache_key`. That equality
// is the safety property: keying on the thread cannot re-anchor any session a
// real client already established. Check 1 below is that property, and it is
// the one worth failing loudly.
//
// Costs a few cents of real tokens and needs Claude Max. Run before releases
// touching Responses session identity, the turn coordinator, or request-source
// admission.
//
//   bun scripts/e2e-codex-thread-identity.mjs
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { setSessionStoreDir } from '../src/proxy/sessionStore.ts'

const WORKDIR = realpathSync(mkdtempSync('/tmp/mcodexid-'))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, 'store'))

const { startProxyServer } = await import('../src/proxy/server.ts')
const { telemetryStore } = await import('../src/telemetry/index.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3548)
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

const THREAD = '01a082ad-84cb-7630-a124-dd37fd82c39e'
const SUBAGENT_THREAD = '01a07806-1111-7000-9999-aaaaaaaaaaaa'

// Faithful to the captured shape, including the fields this route ignores.
const meta = (o) => JSON.stringify({
  installation_id: 'f45565ce-4477-49b1-be2d-ad5bc38c9996',
  session_id: THREAD, thread_id: o.thread ?? THREAD,
  agent_name: o.agent ?? '/root', turn_id: `${THREAD}-turn`,
  request_kind: o.kind ?? 'turn', thread_source: o.source ?? 'user',
  sandbox: 'seatbelt', sandbox_mode: 'read-only',
})

/** Assistant text from a Responses body, as an input item for the next turn. */
function replyItems(body) {
  try {
    const parsed = JSON.parse(body)
    return (parsed.output ?? []).filter(o => o?.type === 'message').map(o => ({
      type: 'message', role: 'assistant',
      content: (o.content ?? []).map(c => ({ type: 'output_text', text: c.text ?? '' })),
    }))
  } catch { return [] }
}

// `/v1/responses` is stateless: a real Codex client resends the whole thread as
// `input` every turn. A harness that sends one message per request makes every
// turn a fresh 1-message conversation and nothing ever resumes — which looks
// exactly like broken session identity.
async function post(label, { thread, source, kind, agent, text, cacheKey, history }) {
  const before = proxyLog.length
  const input = [...(history ?? []), { role: 'user', content: [{ type: 'input_text', text }] }]
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-meridian-agent': 'codex' },
    body: JSON.stringify({
      model: MODEL, stream: false,
      // Codex always sends the PARENT's cache key, even for a spawned thread.
      prompt_cache_key: cacheKey ?? THREAD,
      client_metadata: { 'x-codex-turn-metadata': meta({ thread, source, kind, agent }) },
      input,
    }),
  })
  const body = await res.text()
  const sent = input
  const line = proxyLog.slice(before).find(l => l.includes('[PROXY]') && l.includes('adapter=codex')) ?? ''
  const lineage = /lineage=(\S+)/.exec(line)?.[1] ?? '?'
  const requestId = /\[PROXY\]\s+(\S+)/.exec(line)?.[1]
  // The log prints session=new for any first turn, so comparing that string
  // would pass even if two flows collided. Read the resolved SDK session id.
  const rows = telemetryStore.getRecent({ limit: 200 })
  const sdkSessionId = rows.find(r => r.requestId === requestId)?.sdkSessionId ?? undefined
  say(`  ${label.padEnd(28)} lineage=${lineage.padEnd(13)} sdk=${String(sdkSessionId ?? '?').slice(0, 8).padEnd(9)} http=${res.status}`)
  return { status: res.status, lineage, sdkSessionId, body, next: [...sent, ...replyItems(body)] }
}

say(`\n=== codex thread identity (model=${MODEL}) ===`)

// 1. SAFETY: a user thread, whose thread_id equals its cache key, must behave
//    exactly as before — establish, then resume.
const t1 = await post('user turn 1', { text: 'Remember the word ZEBRA. Reply OK.' })
const t2 = await post('user turn 2 (same thread)', { text: 'What word did I ask you to remember?', history: t1.next })
check(t1.status === 200 && t2.status === 200, 'a user thread still completes both turns',
  `http=${t1.status},${t2.status}`)
check(t2.lineage.includes('continuation'), 'a user thread still RESUMES its own session',
  `turn 2 lineage=${t2.lineage}`)

// 2. A spawned thread carries the PARENT's cache key but its own thread_id.
//    It must get its own session rather than rebinding the parent's.
//    GUARD, not a discriminator: pre-fix each sibling's FIRST turn also opened
//    its own SDK session, so this passes either way. The damage is not that the
//    sibling lacks a session — it is that it rebinds the key the parent is
//    using, which only shows up in check 4.
const sub = await post('subagent turn', {
  thread: SUBAGENT_THREAD, source: 'subagent', agent: '/root/sub',
  // Its own conversation, not the parent's — only the cache key is shared.
  text: 'You are a subagent. Reply SUBOK.',
})
check(sub.status === 200, 'a spawned thread is admitted, not refused', `http=${sub.status}`)
check(Boolean(sub.sdkSessionId) && Boolean(t2.sdkSessionId) && sub.sdkSessionId !== t2.sdkSessionId,
  'the spawned thread got its OWN SDK session',
  `subagent=${String(sub.sdkSessionId).slice(0, 8)} parent=${String(t2.sdkSessionId).slice(0, 8)}`)

// 3. Compaction runs against the same thread id with its own request_kind.
//    It must not rebind the conversation's session.
const compact = await post('compaction (same thread)', {
  // Compaction really does carry the conversation's history; the point is that
  // it must not be keyed ON the conversation.
  kind: 'compact', history: t2.next, text: 'Summarize the conversation so far in one line.',
})
check(compact.status === 200, 'a compaction request is admitted', `http=${compact.status}`)
check(Boolean(compact.sdkSessionId) && compact.sdkSessionId !== t2.sdkSessionId,
  'compaction did NOT land on the conversation session',
  `compact=${String(compact.sdkSessionId).slice(0, 8)} conversation=${String(t2.sdkSessionId).slice(0, 8)}`)

// 4. THE DISCRIMINATOR. After both sibling flows the parent must still resume.
//    Measured pre-fix: `lineage=undo` — the compaction landed on the
//    conversation's session and the next real turn read as a rewrite of it,
//    which is #965's reported symptom exactly. With the fix: `continuation`.
//
//    Note what the ZEBRA check does and does not prove. It passes BOTH ways,
//    because an `undo` still replays the history — correctness survives, cost
//    does not (a fresh session at 0% cache). It is here to catch the worse
//    failure where the parent silently answers from the sibling's session, not
//    as evidence the fix works.
const t3 = await post('user turn 3 (after both)', { text: 'Repeat only the word I asked you to remember.', history: t2.next })
check(t3.status === 200, 'the parent turn after both siblings succeeded', `http=${t3.status}`)
check(t3.lineage.includes('continuation'), 'the parent thread STILL resumes its own session',
  `lineage=${t3.lineage}`)
let answered = false
try {
  const parsed = JSON.parse(t3.body)
  const text = (parsed.output ?? []).filter(o => o?.type === 'message')
    .flatMap(o => (o.content ?? []).map(c => c.text ?? '')).join('')
  answered = /zebra/i.test(text)
} catch { /* reported below */ }
check(answered, 'the parent conversation kept its history across both siblings',
  answered ? 'recalled ZEBRA' : 'did NOT recall ZEBRA — history was lost')

say(`\n=== verdict ===`)
if (failures.length) {
  say(`  FAIL: ${failures.length} check(s)`)
  for (const f of failures) say(`    - ${f}`)
  say('\n  recent proxy diagnostics:')
  for (const l of proxyLog.filter(l => l.includes('[PROXY]')).slice(-14)) say(`    ${l}`)
} else {
  say('  PASS: user thread unchanged, siblings isolated, parent history intact')
}
await inst.close()
process.exit(failures.length ? 1 : 0)
