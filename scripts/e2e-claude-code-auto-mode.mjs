#!/usr/bin/env bun
// Live: does a Claude Code conversation keep resuming while auto mode's
// permission classifier runs beside it — using the REAL Claude Code CLI?
//
// The classifier sends the conversation's own `metadata.user_id` session id
// with a two-message transcript of its own. Read as a turn, it classified
// `unrelated-history`, fresh-replayed and overwrote the conversation's
// mapping, so the next real turn diverged too and no turn ever resumed. It
// also queued behind the running turn on the session lease.
//
// Direct claude-code adapter (no gateway), passthrough as Claude Code runs it.
// The client gets its own CLAUDE_CONFIG_DIR and a dummy bearer token; the
// proxy keeps its real Claude Max authentication. The child environment is
// scrubbed of `CLAUDE*` variables so running this from inside Claude Code
// cannot hand the client a live session.
//
// Auto mode is gated to models that support it, so the main model defaults to
// `sonnet`. The gate asserts that classifier requests actually occurred, so a
// model or prompt that never triggers the classifier FAILS instead of passing
// vacuously.
//
//   bun scripts/e2e-claude-code-auto-mode.mjs
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

const WORKDIR = realpathSync(mkdtempSync(join(tmpdir(), 'mccauto-')))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, 'store'))

const { startProxyServer } = await import('../src/proxy/server.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3558)
const MODEL = process.env.PROBE_MODEL ?? 'sonnet'

const proxyLog = []
for (const k of ['log', 'error', 'debug', 'warn']) console[k] = (...a) => { proxyLog.push(a.map(String).join(' ')) }
const PROXY_PORT = PORT + 1
const inst = await startProxyServer({ port: PROXY_PORT, host: '127.0.0.1' })

// The client talks to a recording relay in front of the proxy. The proxy log
// never prints headers, so without it turn 4 could not tell "the request-class
// header decided" from "the shape matched anyway".
const requestClasses = []
const relay = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  idleTimeout: 255,
  fetch(req) {
    const url = new URL(req.url)
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      requestClasses.push(req.headers.get('x-claude-code-request-class') ?? 'none')
    }
    url.port = String(PROXY_PORT)
    return fetch(url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      duplex: 'half',
      timeout: false,
      decompress: false,
    })
  },
})

const failures = []
const check = (ok, label, detail) => {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const requestLines = () => proxyLog
  .filter(l => l.includes('adapter=') && l.includes('msgCount='))
  .map(l => l.replace(/^\[PROXY\] \S+ /, ''))
const isAux = l => l.includes('diverged=independent-request:auxiliary-request')
const toolCount = l => Number(/ tools=(\d+)/.exec(l)?.[1] ?? 0)
const brief = l => l.replace(/ sdkActive=\S+ sdkQueued=\S+/, '').replace(/ msgs=.*/, '')

function childEnv(configDir, extra = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^CLAUDE(CODE|_)/.test(key)) delete env[key]
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
    ANTHROPIC_AUTH_TOKEN: 'meridian-e2e-dummy',
    ...extra,
  }
}

// Spawned asynchronously and drained concurrently: spawnSync deadlocks once
// the client fills a pipe while it waits on the proxy (see E55).
async function runClient(cwd, configDir, args, extraEnv) {
  const proc = Bun.spawn([CLI, ...args, '--model', MODEL, '--permission-mode', 'auto'], {
    cwd,
    env: childEnv(configDir, extraEnv),
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

async function turn(label, cwd, configDir, args, extraEnv) {
  const from = requestLines().length
  const classFrom = requestClasses.length
  const result = await runClient(cwd, configDir, args, extraEnv)
  const lines = requestLines().slice(from)
  const classes = requestClasses.slice(classFrom)
  say(`\n  ${label} (${lines.length} proxy requests, request-class: ${classes.join(',')}) exit=${result.status}: ${result.out.slice(0, 60)}`)
  for (const l of lines) say(`    ${brief(l)}`)
  return { ...result, lines, classes }
}

say(`\n=== Claude Code auto-mode classifier isolation ===`)
say(`  client: ${version}   adapter: claude-code   model: ${MODEL}   mode: auto`)

const SESSION = randomUUID()
const CONFIG = realpathSync(mkdtempSync(join(tmpdir(), 'mccautoconf-')))
const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), 'mccautoproj-')))
// Outside the project, so a write there is not auto-allowed.
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'mccautoout-')))
writeFileSync(join(PROJECT, 'README.md'), 'scratch project\n')

// A shell write is not auto-allowed the way reads are, so it goes to the
// classifier. Each turn asks for one.
const t1 = await turn('turn 1', PROJECT, CONFIG, [
  '-p', `Run the shell command \`date > ${OUTSIDE}/stamp1.txt\`, then reply with exactly the word ONE.`,
  '--session-id', SESSION,
])
const t2 = await turn('turn 2 (--resume)', PROJECT, CONFIG, [
  '--resume', SESSION,
  '-p', `Run the shell command \`date > ${OUTSIDE}/stamp2.txt\`, then reply with exactly the word TWO.`,
])
const t3 = await turn('turn 3 (--resume)', PROJECT, CONFIG, [
  '--resume', SESSION,
  '-p', 'Reply with exactly the word THREE.',
])
// Exact detection: with gateway hint headers on, the CLI names its request
// class and the header decides instead of the classifier's shape.
const t4 = await turn('turn 4 (--resume, request-class header)', PROJECT, CONFIG, [
  '--resume', SESSION,
  '-p', `Run the shell command \`date > ${OUTSIDE}/stamp4.txt\`, then reply with exactly the word FOUR.`,
], { CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1' })

const turns = [t1, t2, t3, t4]
const all = turns.flatMap(t => t.lines)
const isMain = l => toolCount(l) > 0 && !isAux(l)

say('')
check(turns.every(t => t.status === 0), 'every client invocation succeeded',
  turns.map(t => t.status).join(',') + (t1.err ? ` stderr=${t1.err.slice(0, 160)}` : ''))
check(t1.out.includes('ONE') && t2.out.includes('TWO') && t3.out.includes('THREE') && t4.out.includes('FOUR'),
  'every turn answered', turns.map(t => JSON.stringify(t.out.slice(0, 20))).join(' '))

// 1. The classifier actually ran and was recognised. Without this the rest
//    would pass on a run that never exercised the bug.
const aux = all.filter(isAux)
check(aux.length > 0, 'the auto-mode classifier ran and was isolated as auxiliary',
  `${aux.length} auxiliary request(s) of ${all.length}`)
// Turns 1-3 run with the CLI's defaults, where the header is absent, so their
// isolation is the shape path's. Turn 4 sends it on every request, so a header
// that disagreed with the shape would show here: each request the client
// labelled `auxiliary` must be isolated, and nothing else.
check([t1, t2, t3].every(t => t.classes.every(c => c === 'none')),
  'turns 1-3 send no request-class header (shape path)',
  [t1, t2, t3].map(t => t.classes.join(',')).join(' | '))
check(t4.classes.length > 0 && t4.classes.every(c => c !== 'none'),
  'turn 4 sends a request-class header on every request', t4.classes.join(','))
const labelledAux = t4.classes.filter(c => c === 'auxiliary').length
check(labelledAux > 0 && t4.lines.filter(isAux).length === labelledAux,
  'the request-class header path isolates exactly the requests labelled auxiliary',
  `${labelledAux} labelled auxiliary, ${t4.lines.filter(isAux).length} isolated in turn 4`)

// 2. THE FIX. Every main request after the conversation's very first one
//    continues the stored session. The classifier fires mid-turn, between a
//    tool call and its result, so checking only each turn's first request
//    misses the damage: on the baseline that request still resumes and the
//    one after the classifier diverges.
const mains = all.filter(isMain)
const broken = mains.slice(1).filter(l => !l.includes('lineage=continuation'))
check(mains.length > 1 && broken.length === 0, 'every main request after the first resumes the conversation',
  broken.length
    ? broken.map(l => `msgCount=${/msgCount=(\d+)/.exec(l)?.[1]} lineage=${/lineage=(\S+)/.exec(l)?.[1]} diverged=${/diverged=(\S+)/.exec(l)?.[1] ?? 'none'}`).join(' | ')
    : `${mains.length - 1} of ${mains.length - 1} resumed`)

// 3. Nothing collides any more.
const collided = all.filter(l => /diverged=(unrelated-history|concurrent-race)/.test(l))
check(collided.length === 0, 'no request collides with the conversation',
  collided.length ? collided.map(brief).join(' | ') : `across ${all.length} requests`)
const refused = turns.filter(t => /API Error: 4\d\d/.test(`${t.out}\n${t.err}`))
check(refused.length === 0, 'no invocation was refused with a 4xx',
  refused.length ? refused.map(t => t.out.slice(0, 90)).join(' | ') : 'all accepted')

// Reported, not asserted: how long classifier requests waited on the session.
say('  note  classifier sessionWait: '
  + (aux.map(l => /sessionWait=(\S+)/.exec(l)?.[1]).join(', ') || 'n/a'))

say(`\n=== verdict ===`)
if (failures.length) {
  say(`  FAIL: ${failures.length} check(s)`)
  for (const f of failures) say(`    - ${f}`)
  say('\n  recent proxy diagnostics:')
  for (const l of proxyLog.filter(l => l.includes('[PROXY]')).slice(-16)) say(`    ${l.slice(0, 220)}`)
} else {
  say('  PASS: auto mode no longer breaks Claude Code session resume')
}
relay.stop(true)
await inst.close()
process.exit(failures.length ? 1 : 0)
