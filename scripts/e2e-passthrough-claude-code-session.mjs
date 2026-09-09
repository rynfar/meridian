#!/usr/bin/env bun
// Live: does a Claude Code session behind a gateway keep the exemption it has
// on a direct connection — using the REAL Claude Code CLI as the client?
//
// The headerless tool-result bypass exempts `adapterBase === "claude-code"`,
// because Claude Code owns its tool loop but still expects Meridian to resume
// the backing SDK session. Behind LiteLLM the passthrough heuristic claims the
// request first, so that exemption was lost — and LiteLLM owns the
// `x-litellm-*` namespace for its own Langfuse session tracking and does not
// forward `x-litellm-session-id` upstream on the `anthropic/` provider route,
// so there was no session key either. Every tool round of the whole agentic
// loop took the bypass (#820).
//
// @StanChmielewski measured 35k-56k cache-write tokens per turn with
// `cache_read` pinned at 30629, against 46-53 tokens on a direct connection;
// one 764-turn session accumulated 90M cache-creation tokens, and a fresh
// 5-hour Max window drained in about two hours of ordinary work.
//
// Why this gate needs the real CLI, and why it changed the fix. The obvious
// change was to read `x-claude-code-session-id` as a session key. That header
// is real — verified against 2.1.266 that it is the CLI session UUID, pinned
// exactly by `--session-id`. But this gate, driving the actual client, showed
// the CLI reusing one session id across the auxiliary requests it makes
// alongside a conversation: two unrelated first messages under one key,
// classified `unrelated-history`, and then refused with HTTP 400 "This session
// advanced while the request was waiting." That turns a silent inefficiency
// into a hard client failure. No hand-written request would have found it.
//
// So the header identifies the CLIENT and nothing else. Adapter selection is
// untouched — routing gateway traffic to the claude-code adapter would swap
// tool handling, MCP naming and prompt shape for every existing LiteLLM user
// and move their cache prefix — and keying stays on the conversation
// fingerprint, exactly as a direct Claude Code request already does.
//
// `MERIDIAN_DEFAULT_AGENT=passthrough` resolves the ambiguous `claude-cli/`
// User-Agent to the passthrough adapter, which reproduces the reported
// topology without a LiteLLM instance: same adapter, same absent
// `x-litellm-session-id`, same real client. A real gateway would also rewrite
// the User-Agent and relay the body, which this gate does not model.
//
// The client runs with its own CLAUDE_CONFIG_DIR and a dummy bearer token; the
// proxy keeps its real Claude Max authentication. Needs Claude Max and the
// `claude` CLI on PATH, and costs a few cents of real tokens. Skips cleanly
// with a non-zero exit if the CLI is missing.
//
//   bun scripts/e2e-passthrough-claude-code-session.mjs
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setSessionStoreDir } from '../src/proxy/sessionStore.ts'

const say = console.log.bind(console)

const which = spawnSync('command', ['-v', 'claude'], { shell: true, encoding: 'utf8' })
if (which.status !== 0 || !which.stdout.trim()) {
  say('SKIP: the `claude` CLI is not on PATH; this gate drives the real client')
  process.exit(1)
}
const CLI = which.stdout.trim()
const version = spawnSync(CLI, ['--version'], { encoding: 'utf8' }).stdout.trim()

const WORKDIR = realpathSync(mkdtempSync(join(tmpdir(), 'mccsess-')))
process.env.MERIDIAN_WORKDIR = WORKDIR
const STORE = join(WORKDIR, 'store')
setSessionStoreDir(STORE)
process.env.MERIDIAN_PASSTHROUGH = '1'
// Resolve the ambiguous `claude-cli/` User-Agent to the passthrough adapter,
// which is where a gateway would have landed it.
process.env.MERIDIAN_DEFAULT_AGENT = 'passthrough'

const { startProxyServer } = await import('../src/proxy/server.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3557)
const MODEL = process.env.PROBE_MODEL ?? 'claude-haiku-4-5-20251001'

const proxyLog = []
for (const k of ['log', 'error', 'debug', 'warn']) console[k] = (...a) => { proxyLog.push(a.map(String).join(' ')) }
const inst = await startProxyServer({ port: PORT, host: '127.0.0.1' })

const failures = []
const check = (ok, label, detail) => {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** One client project per conversation, plus its own CLI config dir. */
function clientDir(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mccproj-')))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body + '\n')
  return dir
}

const requestLines = () => proxyLog
  .filter(l => l.includes('adapter=') && l.includes('msgCount='))
  .map(l => l.replace(/^\[PROXY\] \S+ /, ''))

/**
 * Run the real Claude Code CLI against this proxy.
 *
 * The child environment is scrubbed of the harness's own `CLAUDE*` variables.
 * Anyone running this gate from inside Claude Code would otherwise hand the
 * client a live messaging socket and a foreign session id, and it would be
 * talking to the wrong session rather than to this proxy.
 */
function childEnv(configDir) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^CLAUDE(CODE|_)/.test(key)) delete env[key]
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
    ANTHROPIC_AUTH_TOKEN: 'meridian-e2e-dummy',
  }
}

/**
 * Spawned asynchronously and drained concurrently, NOT with `spawnSync`:
 * `spawnSync` deadlocks here. The client keeps writing while it waits on the
 * proxy, and a synchronous parent never reads the pipes, so both sides block
 * once a buffer fills. Measured as an indefinite hang with no output at all.
 */
async function runClient(cwd, configDir, args) {
  const proc = Bun.spawn([CLI, ...args, '--model', MODEL, '--permission-mode', 'bypassPermissions'], {
    cwd,
    env: childEnv(configDir),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => proc.kill(), 300000)
  const [out, err, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { status, out: out.trim(), err: err.trim() }
}

say(`\n=== gateway-fronted Claude Code session identity ===`)
say(`  client: ${version}   adapter: passthrough   model: ${MODEL}`)

const SESSION = randomUUID()
const CONFIG = realpathSync(mkdtempSync(join(tmpdir(), 'mccconf-')))
const PROJECT = clientDir({ 'alpha.txt': 'ALPHA-VALUE' })

const before = requestLines().length
const first = await runClient(PROJECT, CONFIG, [
  '-p', 'Read alpha.txt and reply with exactly its contents.',
  '--session-id', SESSION,
  '--allowedTools', 'Read',
])
const firstLines = requestLines().slice(before)
say(`\n  turn 1 (${firstLines.length} proxy requests) exit=${first.status}: ${first.out.slice(0, 60)}`)
for (const l of firstLines) say(`    ${l.replace(/ sdkActive.*?msgCount=/, ' msgCount=').replace(/ msgs=.*/, '')}`)

const resumedFrom = requestLines().length
const second = await runClient(PROJECT, CONFIG, [
  '--resume', SESSION,
  '-p', 'Reply with exactly the word FINISHED.',
])
const secondLines = requestLines().slice(resumedFrom)
say(`\n  turn 2 after --resume (${secondLines.length} proxy requests) exit=${second.status}: ${second.out.slice(0, 60)}`)
for (const l of secondLines) say(`    ${l.replace(/ sdkActive.*?msgCount=/, ' msgCount=').replace(/ msgs=.*/, '')}`)

// A third invocation: an independent conversation in its own project
// directory, with the SAME prompt text. Keying is by fingerprint, so the
// client working directory is what has to keep these apart.
const OTHER = randomUUID()
const OTHER_CONFIG = realpathSync(mkdtempSync(join(tmpdir(), 'mccconf2-')))
const OTHER_PROJECT = clientDir({ 'alpha.txt': 'BRAVO-VALUE' })
const isoFrom = requestLines().length
const other = await runClient(OTHER_PROJECT, OTHER_CONFIG, [
  '-p', 'Read alpha.txt and reply with exactly its contents.',
  '--session-id', OTHER,
  '--allowedTools', 'Read',
])
const otherLines = requestLines().slice(isoFrom)
say(`\n  conversation 2, identical prompt, own directory, exit=${other.status}: ${other.out.slice(0, 60)}`)
for (const l of otherLines) say(`    ${l.replace(/ sdkActive.*?msgCount=/, ' msgCount=').replace(/ msgs=.*/, '')}`)

say('')
check(first.status === 0 && second.status === 0 && other.status === 0,
  'every client invocation succeeded',
  `exit=${first.status},${second.status},${other.status}${first.err ? ` stderr=${first.err.slice(0, 160)}` : ''}`)
check(first.out.includes('ALPHA-VALUE'), 'the tool loop actually ran and answered',
  `answer=${JSON.stringify(first.out.slice(0, 60))}`)
check(second.out.includes('FINISHED'), 'the --resumed invocation answered too',
  `answer=${JSON.stringify(second.out.slice(0, 60))}`)

// 1. THE BYPASS IS GONE. This is the line the fix removes.
const bypassed = requestLines().filter(l => l.includes('headerless-tool-result'))
check(bypassed.length === 0, 'no request takes the headerless tool-result bypass',
  bypassed.length ? `${bypassed.length} of ${requestLines().length} request(s) still bypassed`
    : `across ${requestLines().length} requests`)

// 2. Because the round is no longer bypassed, the end-of-turn store happens
//    and the following turn resumes. Before the fix nothing was ever written
//    under the key, so no later turn could resume either.
check(firstLines.some(l => /msgCount=[3-9]/.test(l)), 'the client ran a tool round',
  `${firstLines.length} request(s) in the first invocation`)
check(secondLines.some(l => l.includes('lineage=continuation')),
  'the turn after the tool round resumes the stored SDK session',
  secondLines.map(l => /lineage=(\S+)/.exec(l)?.[1]).join(', '))
// Reported, not asserted: the tool round ITSELF still classifies `not-found`.
// The entry stored at a passthrough early stop is a checkpoint boundary, which
// lineage lookup reports as missing by design, and the recovery path that
// should upgrade it does not fire on this adapter. That is a separate and
// larger defect — #996, where `pi` and `opencode` resume the identical shape —
// unchanged by this fix and identical with a forwarded `x-litellm-session-id`.
say('  note  the tool round itself reports diverged='
  + (firstLines.filter(l => /msgCount=[3-9]/.test(l))
      .map(l => /diverged=(\S+)/.exec(l)?.[1] ?? 'none').join(', ') || 'nothing')
  + ' — a passthrough checkpoint boundary is reported missing by design, unchanged here')

// 3. THE GUARD AGAINST THE FIX THAT LOOKED OBVIOUS. Keying on
//    `x-claude-code-session-id` put the CLI's auxiliary requests under the
//    same key as the conversation. Measured that way: `unrelated-history`,
//    then HTTP 400 "This session advanced while the request was waiting."
const collided = requestLines().filter(l => l.includes('diverged=unrelated-history'))
check(collided.length === 0, "the CLI's auxiliary requests do not collide with the conversation",
  collided.length ? `${collided.length} request(s) classified unrelated-history`
    : `no unrelated-history across ${requestLines().length} requests`)
const refused = [first, second, other].filter(r => /API Error: 4\d\d/.test(`${r.out}\n${r.err}`))
check(refused.length === 0, 'no invocation was refused with a 4xx',
  refused.length ? refused.map(r => r.out.slice(0, 90)).join(' | ') : 'all invocations accepted')

// 4. Two conversations in different directories stay apart. With no session
//    key the fingerprint's working-directory component is what does this.
check(other.out.includes('BRAVO-VALUE') && !other.out.includes('ALPHA-VALUE'),
  'a second conversation with the same prompt does not inherit the first',
  `answer=${JSON.stringify(other.out.slice(0, 60))}`)
check(otherLines.length > 0 && !otherLines.some(l => l.includes('lineage=continuation')),
  'its first turns start fresh rather than resuming the other conversation',
  otherLines.map(l => /lineage=(\S+)/.exec(l)?.[1]).join(', ') || '(no request)')

say(`\n=== verdict ===`)
if (failures.length) {
  say(`  FAIL: ${failures.length} check(s)`)
  for (const f of failures) say(`    - ${f}`)
  say('\n  recent proxy diagnostics:')
  for (const l of proxyLog.filter(l => l.includes('[PROXY]')).slice(-12)) say(`    ${l.slice(0, 200)}`)
} else {
  say('  PASS: a gateway-fronted Claude Code session resumes, and nothing collides')
}
await inst.close()
process.exit(failures.length ? 1 : 0)
