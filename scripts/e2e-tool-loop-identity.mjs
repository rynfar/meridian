#!/usr/bin/env bun
// Live: does a headerless OpenAI client's OWN tool loop keep one SDK session
// and read its prompt prefix from cache — instead of re-writing it every round?
//
// A generic OpenAI client running its own tool loop resends the whole growing
// conversation each round, ending in the `tool` message it just produced, and
// sends no session header of any kind. With no identity, every round used to
// take the headerless-tool-result bypass: no session lookup, no cache write, a
// fresh SDK session per round (#820 put that at 35k-56k cache-write tokens per
// turn on a LiteLLM-fronted loop against 46-53 on a direct connection).
//
// The fingerprint is not a substitute — it is (first user message, cwd), so two
// runs of one workflow started from the same prompt in the same directory hash
// to one key and one would resume the other's session. The loop's own first
// tool-call id is the missing discriminator: issued per generation, retained in
// the replayed history, so every later round derives the same key and no two
// concurrent runs collide. Meridian derives `tool-loop:<hash>` from it and
// resumes, rather than packing and rebuilding.
//
// Second claim, and the reason the first survives contact: a derived key is
// Meridian's own inference, not a contract the client agreed to. A generic
// OpenAI client echoes its own tool-call ids, not the ids Meridian forwarded,
// so the passthrough tool checkpoint cannot always be settled. When it cannot,
// the continuation the session store DOES confirm must win — resume, not
// rebuild. A client that supplies its own key keeps today's replay-on-mismatch
// behaviour, so this is scoped to the synthesized key.
//
// Two arms, no session header on either:
//
//   loop    the client's own tool loop (a stable first tool-call id in the
//           replayed history). From turn 2 on, each turn must read the previous
//           turn's prompt back from cache and write only the new delta.
//   control the same shape with no tool call at all. It stays on the packed
//           path, reads nothing back, and rewrites the whole prompt every turn.
//
// The control declares no tools. A declared tools block is itself a stable
// cacheable prefix that reads back even on the packed path (measured: 5,529
// tokens read on every control turn when the loop arm's tools were sent), so a
// control that carried tools could never satisfy its own criterion. The control
// is here to show what the packed path costs, not to reproduce the loop's body
// byte for byte.
//
// Needs Claude Max and costs a few cents of real tokens. Run before releases
// touching OpenAI session identity, the derived tool-loop key, the passthrough
// early-stop checkpoint, or the headerless-tool-result bypass.
//
//   bun scripts/e2e-tool-loop-identity.mjs
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setSessionStoreDir } from '../src/proxy/sessionStore.ts'

const say = console.log.bind(console)

// Isolate everything Meridian writes, the same switch set E57 documents, so this
// can run beside the live instance. The Claude credential file has no switch of
// its own, so mark the run read-only to stop a token refresh from rewriting the
// live login. MERIDIAN_WORKDIR also seeds the fingerprint cwd and the SDK's
// transcript directory.
const WORKDIR = realpathSync(mkdtempSync(join(tmpdir(), 'mtoolloop-')))
process.env.MERIDIAN_WORKDIR = WORKDIR
process.env.MERIDIAN_CONFIG_DIR = join(WORKDIR, 'config')
process.env.MERIDIAN_SESSION_DIR = join(WORKDIR, 'sessions')
process.env.MERIDIAN_TELEMETRY_DB = join(WORKDIR, 'telemetry.db')
process.env.MERIDIAN_UPDATE_CHECK_PATH = join(WORKDIR, 'update-check.json')
process.env.MERIDIAN_DESIGN_TOKEN_PATH = join(WORKDIR, 'design-token.json')
process.env.MERIDIAN_CREDENTIALS_READONLY = '1'
process.env.MERIDIAN_PASSTHROUGH = '1'
// The checkpoint decision is recorded only in the debug log
// (`passthrough.checkpoint_resume_preferred` / `passthrough.checkpoint_replay`).
process.env.OPENCODE_CLAUDE_PROVIDER_DEBUG = '1'
// Disable auto-defer. With it on, the 23-tool set defers every non-core tool,
// which flips `ENABLE_TOOL_SEARCH` and adds the billed digest turn — a second
// SDK query inside one request. Its usage is what the OpenAI response reports,
// so the first turn read a cache it had just written and every prompt looked
// roughly doubled. Deferral is E45/E53's subject; this gate is about identity,
// so pin the documented switch that removes it.
process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = '0'
setSessionStoreDir(join(WORKDIR, 'store'))

// The SDK writes its session transcripts under the real config root, whether or
// not Meridian's own state moved: `~/.claude/projects/<cwd-slug>/`. The slug is
// the SDK subprocess cwd with `/` replaced by `-`, so it is unique to this
// scratch WORKDIR and removing it deletes only what this run created.
const HOME = process.env.HOME ?? tmpdir()
const TRANSCRIPT_DIR = join(HOME, '.claude', 'projects', WORKDIR.replaceAll('/', '-'))

const { startProxyServer } = await import('../src/proxy/server.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3561)
const MODEL = process.env.PROBE_MODEL ?? 'claude-haiku-4-5-20251001'

const proxyLog = []
for (const k of ['log', 'error', 'debug', 'warn']) console[k] = (...a) => { proxyLog.push(a.map(String).join(' ')) }

const failures = []
const check = (ok, label, detail) => {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// A per-run value that makes the whole cacheable prefix — tools INCLUDED —
// unique to this execution. An upstream prompt-cache entry outlives a run, and
// tools render at position 0, so a fixed tools block would read back on turn 1
// no matter what nonce the system text carried (measured: 5,661 tokens read on
// turn 1 from a previous run's identical tools). Cacheability of the tools is
// part of what is measured, so the nonce has to reach them.
const RUN = randomUUID()

// A tool the client owns. The loop's first call to it is the anchor Meridian
// derives the session key from; the same tool lets the model emit a forwarded
// call, which arms the passthrough checkpoint the second claim is about.
const READ_TOOL = {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file from disk. Read exactly one file per call.',
    parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute path' } }, required: ['file_path'] },
  },
}

// Filler tools, as e2e-responses-developer-cache.mjs uses them: the prompt
// prefix has to clear Anthropic's minimum cacheable length before any cache
// accounting appears at all. Measured without them, every round of both arms
// reported cache_read=0 cache_write=0 and the claim was untestable.
const FILLER = Array.from({ length: 22 }, (_, i) => ({
  type: 'function',
  function: {
    name: `bridge_tool_${i}`,
    description: `Bridge tool ${i}. [cache-run ${RUN}] ` + 'Filler to give the prompt prefix real mass so a re-written prefix is visible in the numbers rather than lost in noise. '.repeat(6),
    parameters: { type: 'object', properties: { arg: { type: 'string', description: 'An argument.' } } },
  },
}))
const TOOLS = [READ_TOOL, ...FILLER]

// Two prefixes that share no wording, so neither arm can read a cache the other
// warmed, with the run nonce in each as well.
const para = (label) => `[cache-run ${label} nonce ${RUN}] ` + (
  'Meridian routes Anthropic-compatible traffic from local coding clients to a subscription-backed Claude backend. '
  + 'Preserving session identity lets a resumed conversation reuse the upstream prompt cache instead of paying to re-read the same prefix on every turn. '
  + 'This paragraph is deliberately long and unchanging so that it forms a stable cacheable prefix for measurement. '
).repeat(120)
const PREFIX_LOOP = para('loop')
const PREFIX_CONTROL = para('control')

const FILES = { 'alpha.txt': 'ALPHA-VALUE', 'bravo.txt': 'BRAVO-VALUE', 'charlie.txt': 'CHARLIE-VALUE' }
for (const [name, body] of Object.entries(FILES)) Bun.write(join(WORKDIR, name), body + '\n')

/** One OpenAI-shaped chat completion. No session header is ever sent. */
async function post(messages, tools) {
  const before = proxyLog.length
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 512, stream: false, tools, messages }),
  })
  const body = await res.json().catch(() => null)
  const lines = proxyLog.slice(before)
  const requestLine = lines.find(l => l.includes('[PROXY]') && l.includes('adapter=') && l.includes('msgCount=')) ?? ''
  const usageLine = lines.find(l => l.includes('[PROXY]') && l.includes('usage:')) ?? ''
  const checkpointLines = lines.filter(l => /"event":"passthrough\.checkpoint_(resume_preferred|replay)"/.test(l))
  const usage = body?.usage ?? {}
  const details = usage.prompt_tokens_details ?? {}
  const forwarded = (body?.choices?.[0]?.message?.tool_calls ?? []).map(c => c.id)
  return {
    status: res.status,
    prompt: usage.prompt_tokens ?? 0,
    cached: details.cached_tokens ?? 0,
    write: usage.cache_write_tokens ?? details.cache_write_tokens ?? 0,
    lineage: /lineage=(\S+)/.exec(requestLine)?.[1] ?? '?',
    diverged: /diverged=(\S+)/.exec(requestLine)?.[1] ?? undefined,
    msgCount: Number(/msgCount=(\d+)/.exec(requestLine)?.[1] ?? 0),
    tools: Number(/tools=(\d+)/.exec(requestLine)?.[1] ?? 0),
    usageLine,
    checkpointLines,
    forwarded,
    requestLine,
    lines,
  }
}

function report(label, info, prev) {
  const pct = info.prompt ? Math.round(100 * info.cached / info.prompt) : 0
  const prevPct = prev?.prompt ? Math.round(100 * info.cached / prev.prompt) : null
  say(`  ${label.padEnd(22)} http=${info.status} lineage=${info.lineage.padEnd(13)}`
    + ` tools=${String(info.tools).padStart(2)} msgs=${String(info.msgCount).padStart(2)}`
    + ` prompt=${String(info.prompt).padStart(6)} cached=${String(info.cached).padStart(6)} (${String(pct).padStart(2)}%`
    + `${prevPct !== null ? `, ${prevPct}% of prev prompt` : ''}) write=${String(info.write).padStart(6)}`)
  if (info.requestLine) say(`      | ${info.requestLine}`)
  if (info.usageLine) say(`      | ${info.usageLine}`)
  for (const l of info.checkpointLines) say(`      | ${l}`)
  return info
}

// ---------------------------------------------------------------------------
// The loop arm. Turn 1 is the client's opening request, before any tool call:
// cold, no derived key. Every later turn appends the client's own
// `assistant.tool_calls` plus its `role:"tool"` result, with the FIRST call id
// stable for the life of the loop — the anchor the derived key hashes.
// ---------------------------------------------------------------------------
async function runLoopArm() {
  const messages = [
    { role: 'system', content: 'You are a terse assistant. ' + PREFIX_LOOP },
    { role: 'user', content: 'Read these three files ONE AT A TIME, waiting for each result before the next call: '
      + Object.keys(FILES).map(f => join(WORKDIR, f)).join(', ')
      + '. After the third, reply with the three contents separated by commas.' },
  ]
  const rounds = []
  let prev
  for (let turn = 1; turn <= 5; turn++) {
    const info = report(`loop turn ${turn}`, await post(messages, TOOLS), prev)
    rounds.push(info)
    prev = info
    if (turn === 5) break
    // The client's own tool call. Its id is the client's, not one Meridian
    // forwarded, which is exactly what leaves the checkpoint unsettled; the
    // first one stays in the replayed history and keeps the derived key steady.
    const file = ['alpha.txt', 'bravo.txt', 'charlie.txt', 'alpha.txt'][turn - 1]
    const callId = `call_probe_${turn}_${file.replace('.txt', '')}`
    messages.push({
      role: 'assistant', content: null,
      tool_calls: [{ id: callId, type: 'function', function: { name: 'read', arguments: JSON.stringify({ file_path: join(WORKDIR, file) }) } }],
    })
    messages.push({ role: 'tool', tool_call_id: callId, content: FILES[file] })
    await new Promise(r => setTimeout(r, 2500)) // let the upstream cache write commit
  }
  return rounds
}

// ---------------------------------------------------------------------------
// The control arm. Same shape, no tool call anywhere, no tools declared, so no
// derived key exists and the packed path is the only one left.
// ---------------------------------------------------------------------------
async function runControlArm() {
  const messages = [
    { role: 'system', content: 'You are a terse assistant. ' + PREFIX_CONTROL },
    { role: 'user', content: 'Reply with exactly the word ALPHA.' },
  ]
  const rounds = []
  let prev
  for (let turn = 1; turn <= 5; turn++) {
    const info = report(`control turn ${turn}`, await post(messages, []), prev)
    rounds.push(info)
    prev = info
    if (turn === 5) break
    messages.push({ role: 'assistant', content: 'ALPHA' })
    messages.push({ role: 'user', content: `Now reply with exactly the word STEP${turn + 1}.` })
    await new Promise(r => setTimeout(r, 2500))
  }
  return rounds
}

let inst
try {
  inst = await startProxyServer({ port: PORT, host: '127.0.0.1' })

  say(`\n=== headerless OpenAI tool-loop identity (model=${MODEL}) ===`)
  say(`  proxy on 127.0.0.1:${PORT}, state under ${WORKDIR}, credentials read-only\n`)

  const loop = await runLoopArm()
  say('')
  const control = await runControlArm()

  say(`\n=== verdict ===`)

  // --- loop arm ---
  check(loop.every(r => r.status === 200), 'every loop turn completed',
    `http=${loop.map(r => r.status).join(',')}`)
  check(loop[0].cached === 0, 'loop turn 1 starts cold (nothing read from cache)',
    `cached=${loop[0].cached} of ${loop[0].prompt} prompt tokens`)
  check(loop[0].write >= 0.9 * loop[0].prompt, 'loop turn 1 writes its whole prefix',
    `write=${loop[0].write} of ${loop[0].prompt}`)

  // THE CLAIM. From turn 2 on, each turn reads back the previous turn's whole
  // prompt from cache — the continuation Meridian derives is real.
  const continuations = loop.slice(1)
  const reads = continuations.map(r => r.prompt ? r.cached / r.prompt : 0)
  check(continuations.every((r, i) => r.cached >= 0.9 * loop[i].prompt),
    'every loop turn from the second reads ≥90% of the previous turn\'s prompt from cache',
    continuations.map((r, i) => `t${i + 2}: ${r.cached} of ${loop[i].prompt} = ${Math.round(100 * r.cached / loop[i].prompt)}%`).join(', '))
  check(reads.every(v => v >= 0.9), 'each loop turn is itself ≥90% cached',
    reads.map((v, i) => `t${i + 2}=${Math.round(v * 100)}%`).join(' '))

  // Writes limited to the new-turn delta: the appended exchange, not the prompt.
  check(continuations.every(r => r.write <= 0.15 * r.prompt),
    'loop continuations write only the new-turn delta',
    continuations.map((r, i) => `t${i + 2}: ${r.write} (${Math.round(100 * r.write / r.prompt)}% of prompt)`).join(', '))

  // The regression this branch exists to prevent: a tool round taking the
  // headerless bypass, which skips lookup and rewrites the prefix. Turn 2 is
  // the first turn under the derived key, so `new` there is expected; every
  // later turn must be a continuation, and no turn may diverge.
  check(loop.slice(2).every(r => r.lineage === 'continuation'),
    'every loop turn after the first tool round resumes (lineage=continuation)',
    loop.map((r, i) => `t${i + 1}=${r.lineage}`).join(' '))
  const bypass = loop.filter(r => String(r.diverged).includes('headerless-tool-result'))
  check(bypass.length === 0, 'no loop turn takes the headerless-tool-result bypass',
    bypass.length ? `t${bypass.map(b => loop.indexOf(b) + 1).join(',t')}` : 'none')

  // Second claim: where the model forwarded a tool call, its checkpoint could
  // not be settled by the client's own ids, and the continuation was preferred
  // rather than rebuilt. Model-dependent, so reported as evidence, not asserted.
  const resumedUnsettled = loop.flatMap(r => r.checkpointLines).filter(l => l.includes('checkpoint_resume_preferred'))
  const demoted = loop.flatMap(r => r.checkpointLines).filter(l => l.includes('checkpoint_replay'))
  say(`  note  unsettled-checkpoint resumes observed: ${resumedUnsettled.length}`
    + ` (${resumedUnsettled.length ? 'derived key preferred the continuation' : 'the model forwarded no tool call this run'})`)
  if (demoted.length) say(`  note  WARNING: ${demoted.length} turn(s) demoted to a fresh replay`)

  // --- control arm ---
  check(control.every(r => r.status === 200), 'every control turn completed',
    `http=${control.map(r => r.status).join(',')}`)
  check(control.every(r => r.lineage === 'new'), 'the control stays on the packed path every turn',
    control.map((r, i) => `t${i + 1}=${r.lineage}`).join(' '))
  check(control.every(r => r.cached === 0), 'the control reads nothing back from cache',
    control.map((r, i) => `t${i + 1}=${r.cached}`).join(' '))
  check(control.every(r => r.write >= 0.9 * r.prompt), 'the control rewrites the whole prompt every turn',
    control.map((r, i) => `t${i + 1}: write=${r.write} of ${r.prompt}`).join(', '))

  if (failures.length) {
    say(`\n  FAIL: ${failures.length} check(s)`)
    for (const f of failures) say(`    - ${f}`)
    say('\n  recent proxy diagnostics:')
    for (const l of proxyLog.filter(l => l.includes('[PROXY]')).slice(-14)) say(`    ${l}`)
  } else {
    say('\n  PASS: the headerless loop resumes and reuses its prompt cache;')
    say('        the packed control rebuilds every turn, as it must')
  }
} finally {
  if (inst) await inst.close()
  // Transcripts the SDK wrote for this run live under a directory named after
  // the scratch WORKDIR, so this removes only what this run created.
  let removed = 0
  if (existsSync(TRANSCRIPT_DIR)) {
    removed = readdirSync(TRANSCRIPT_DIR).length
    rmSync(TRANSCRIPT_DIR, { recursive: true, force: true })
  }
  const leftOver = existsSync(TRANSCRIPT_DIR)
  rmSync(WORKDIR, { recursive: true, force: true })
  say(`\n=== cleanup ===`)
  say(`  proxy instance closed; scratch state ${existsSync(WORKDIR) ? 'STILL PRESENT' : 'removed'} (${WORKDIR})`)
  say(`  SDK transcripts: ${removed} removed from ${TRANSCRIPT_DIR}`
    + `${leftOver ? ' — DIRECTORY STILL PRESENT' : ' (directory gone)'}`)
  say(`  port ${PORT}: ${(await fetch(`http://127.0.0.1:${PORT}/health`).then(() => 'STILL LISTENING').catch(() => 'free'))}`)
}

process.exit(failures.length ? 1 : 0)
