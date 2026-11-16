#!/usr/bin/env bun
// Live: does a Claude Code conversation keep resuming while NAMED agents
// (in-process teammates, `Agent` with a `name`) run beside it — using the
// REAL Claude Code CLI?
//
// A teammate sends its parent's own `metadata.user_id` session id, like an
// Agent-tool subagent, but its `x-claude-code-agent-id` is `<name>@<team>`.
// The adapter used to reject that shape and key the teammate by the bare
// session id, so parent and teammates overwrote one another's mapping
// (`unrelated-history` on every turn, full-history replay, no prompt cache)
// and queued on one turn lease. Companion of E72
// (e2e-claude-code-subagent-session.mjs).
//
// Direct claude-code adapter (no gateway), passthrough as Claude Code runs it.
// The client gets its own CLAUDE_CONFIG_DIR and a dummy bearer token; the
// proxy keeps its real Claude Max authentication. The child environment is
// scrubbed of `CLAUDE*` variables so running this from inside Claude Code
// cannot hand the client a live session.
//
// A recording relay in front of the proxy stamps each request with its own
// x-request-id and records the agent id it carried: the proxy log never prints
// headers, and the request id is how a log line is tied back to its agent.
//
// The gate asserts that at least two distinct subagents actually ran, so a
// model that never spawns them FAILS instead of passing vacuously.
//
//   bun scripts/e2e-claude-code-subagent-session.mjs
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

const WORKDIR = realpathSync(mkdtempSync(join(tmpdir(), 'mcctm-')))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, 'store'))

const { startProxyServer } = await import('../src/proxy/server.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3570)
const MODEL = process.env.PROBE_MODEL ?? 'sonnet'
const MAX_WAIT_MS = 1000

const proxyLog = []
for (const k of ['log', 'error', 'debug', 'warn']) console[k] = (...a) => { proxyLog.push(a.map(String).join(' ')) }
const PROXY_PORT = PORT + 1
const inst = await startProxyServer({ port: PROXY_PORT, host: '127.0.0.1' })

const agentOf = new Map()
let relaySeq = 0
const relay = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  idleTimeout: 255,
  fetch(req) {
    const url = new URL(req.url)
    const headers = new Headers(req.headers)
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      const id = `e74-${++relaySeq}`
      headers.set('x-request-id', id)
      agentOf.set(id, req.headers.get('x-claude-code-agent-id') ?? 'main')
    }
    url.port = String(PROXY_PORT)
    return fetch(url, {
      method: req.method,
      headers,
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

// One record per proxy request line, tied to the agent id the relay saw.
const records = () => proxyLog
  .map(l => /^\[PROXY\] (\S+) (adapter=.*msgCount=.*)$/.exec(l))
  .filter(Boolean)
  .map(([, id, line]) => ({ id, agent: agentOf.get(id) ?? 'unknown', line }))
const isAux = r => r.line.includes('diverged=independent-request:auxiliary-request')
const toolCount = r => Number(/ tools=(\d+)/.exec(r.line)?.[1] ?? 0)
const waitMs = r => Number(/ sessionWait=(\d+)ms/.exec(r.line)?.[1] ?? 0)
const brief = r => `${r.agent === 'main' ? 'main' : `agent:${r.agent.slice(0, 24)}`} ${r.line
  .replace(/ sdkActive=\S+ sdkQueued=\S+/, '').replace(/ msgs=.*/, '')}`
const describe = r => `msgCount=${/msgCount=(\d+)/.exec(r.line)?.[1]} lineage=${/lineage=(\S+)/.exec(r.line)?.[1]}`
  + ` diverged=${/diverged=(\S+)/.exec(r.line)?.[1] ?? 'none'}`

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
    // Named agents become in-process teammates only with agent teams on;
    // otherwise the CLI runs them as plain subagents (E72's shape).
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  }
}

// In-process teammates exist only in the interactive REPL: `-p` runs a named
// agent as a plain subagent (E72's shape) even with agent teams on. So the
// client runs under tmux, with onboarding and workspace trust pre-seeded in
// its isolated config dir, and each turn is typed into the pane. Default
// permission mode with the probe's tools pre-allowed, so no auto-mode
// classifier runs (E71 covers it).
// A private tmux socket: the probe never touches the user's own tmux server.
const TMUX = `e74-${process.pid}`
const tmux = (...args) => spawnSync('tmux', ['-L', TMUX, ...args], { encoding: 'utf8' })
const pane = () => tmux('capture-pane', '-p', '-J', '-S', '-2000', '-t', TMUX).stdout ?? ''
const sleep = ms => new Promise(r => setTimeout(r, ms))
// An assistant line holding only the marker word (the typed prompt holds more).
const answered = word => pane().split('\n').filter(l => new RegExp(`^\\W*${word}\\W*$`).test(l)).length

function startClient(cwd, configDir, sessionId) {
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    theme: 'dark',
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }))
  const env = childEnv(configDir)
  const exports = Object.entries(env)
    .filter(([k]) => /^(PATH|HOME|USER|LANG|LC_ALL|TERM|TMPDIR|ANTHROPIC_.*|CLAUDE_.*)$/.test(k))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
  const cmd = `cd ${JSON.stringify(cwd)} && exec env -i ${exports} ${JSON.stringify(CLI)} --model ${MODEL}`
    + ` --session-id ${sessionId} --permission-mode default --allowedTools 'Bash(echo:*)' Agent SendMessage`
  const r = tmux('new-session', '-d', '-s', TMUX, '-x', '200', '-y', '50', cmd)
  if (r.status !== 0) throw new Error(`tmux: ${r.stderr}`)
}

async function type(text) {
  tmux('send-keys', '-t', TMUX, '-l', text)
  await sleep(500)
  tmux('send-keys', '-t', TMUX, 'Enter')
}

async function turn(label, text, word, timeoutMs = 300000) {
  const from = records().length
  const before = answered(word)
  await type(text)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && answered(word) <= before) await sleep(2000)
  await sleep(3000)
  const ok = answered(word) > before
  const recs = records().slice(from)
  say(`\n  ${label} (${recs.length} proxy requests) answered=${ok}`)
  for (const r of recs) say(`    ${brief(r)}`)
  return { status: ok ? 0 : 1, out: ok ? word : pane().slice(-400), err: '', recs }
}

say(`\n=== Claude Code in-process teammate session isolation ===`)
say(`  client: ${version}   adapter: claude-code   model: ${MODEL}   mode: interactive (tmux)`)

const SESSION = randomUUID()
const CONFIG = realpathSync(mkdtempSync(join(tmpdir(), 'mcctmconf-')))
const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), 'mcctmproj-')))
writeFileSync(join(PROJECT, 'README.md'), 'scratch project\n')

startClient(PROJECT, CONFIG, SESSION)
await sleep(8000)
const t1 = await turn('turn 1 (two named teammates)', [
  'Use the Agent tool twice in a single message to spawn two NAMED general-purpose agents:',
  'one with name "alpha" and one with name "beta" (set the `name` parameter).',
  'Agent alpha must run the shell command `echo alpha-1`, then in a separate Bash call run',
  '`echo alpha-2`, then report both outputs back to you.',
  'Agent beta must do the same with `echo beta-1` and `echo beta-2`.',
  'Wait until both have reported, then reply with exactly the word DONE and nothing else.',
].join(' '), 'DONE')
const t2 = await turn('turn 2 (same session)', 'Reply with exactly the word AGAIN and nothing else.', 'AGAIN', 120000)
await type('/exit')
await sleep(2000)
tmux('kill-server')  // the private socket's server only

const turns = [t1, t2]
const all = turns.flatMap(t => t.recs)
const mains = all.filter(r => r.agent === 'main' && toolCount(r) > 0 && !isAux(r))
const subagentRecs = all.filter(r => r.agent !== 'main' && r.agent !== 'unknown' && !isAux(r))
const byAgent = new Map()
for (const r of subagentRecs) byAgent.set(r.agent, [...(byAgent.get(r.agent) ?? []), r])

say('')
check(turns.every(t => t.status === 0), 'every client invocation succeeded',
  turns.map(t => t.status).join(',') + (t1.err ? ` stderr=${t1.err.slice(0, 160)}` : ''))
check(t1.status === 0 && t2.status === 0, 'every turn answered',
  turns.map(t => JSON.stringify(t.out.slice(0, 20))).join(' '))
check(all.every(r => r.agent !== 'unknown'), 'every proxy request line maps to a relayed request',
  `${all.filter(r => r.agent === 'unknown').length} unmapped`)

// 1. Teammates actually ran, each over several turns. Without this the rest
//    would pass on a run that never exercised the bug.
const multiTurn = [...byAgent.values()].filter(rs => rs.length >= 2)
const teammates = [...byAgent.keys()].filter(a => a.includes('@'))
check(teammates.length >= 2, 'at least two in-process teammates (name@team agent ids) made requests',
  teammates.join(' ') || [...byAgent.keys()].join(' ') || 'none')
check(byAgent.size >= 2 && multiTurn.length >= 2, 'at least two agents ran multi-turn conversations',
  [...byAgent].map(([a, rs]) => `${a.slice(0, 8)}×${rs.length}`).join(' ') || 'none')

// 2. THE FIX, subagent side: every subagent turn after its first resumes that
//    subagent's own session.
const brokenSub = [...byAgent.values()].flatMap(rs => rs.slice(1)).filter(r => !r.line.includes('lineage=continuation'))
check(multiTurn.length > 0 && brokenSub.length === 0, 'every subagent turn after its first resumes its own session',
  brokenSub.length ? brokenSub.map(r => `${r.agent.slice(0, 8)} ${describe(r)}`).join(' | ')
    : `${subagentRecs.length - byAgent.size} of ${subagentRecs.length - byAgent.size} resumed`)

// 3. THE FIX, parent side: every main request after the conversation's first
//    continues, across all subagent activity.
const brokenMain = mains.slice(1).filter(r => !r.line.includes('lineage=continuation'))
check(mains.length > 1 && brokenMain.length === 0, 'every main request after the first resumes the conversation',
  brokenMain.length ? brokenMain.map(describe).join(' | ') : `${mains.length - 1} of ${mains.length - 1} resumed`)

// 4. Nothing collides, nothing waits on someone else's lease.
const collided = all.filter(r => /diverged=(unrelated-history|concurrent-race)/.test(r.line))
check(collided.length === 0, 'no request collides with another flow',
  collided.length ? collided.map(brief).join(' | ') : `across ${all.length} requests`)
const slow = [...mains, ...subagentRecs].filter(r => waitMs(r) > MAX_WAIT_MS)
check(slow.length === 0, `no main or subagent request waited over ${MAX_WAIT_MS}ms on a session lease`,
  slow.length ? slow.map(r => `${brief(r).split(' ')[0]} sessionWait=${waitMs(r)}ms`).join(' | ')
    : `max ${Math.max(0, ...[...mains, ...subagentRecs].map(waitMs))}ms`)
const refused = turns.filter(t => /API Error: 4\d\d/.test(`${t.out}\n${t.err}`))
check(refused.length === 0, 'no invocation was refused with a 4xx',
  refused.length ? refused.map(t => t.out.slice(0, 90)).join(' | ') : 'all accepted')

say(`\n=== verdict ===`)
if (failures.length) {
  say(`  FAIL: ${failures.length} check(s)`)
  for (const f of failures) say(`    - ${f}`)
  say('\n  recent proxy diagnostics:')
  for (const l of proxyLog.filter(l => l.includes('[PROXY]')).slice(-16)) say(`    ${l.slice(0, 220)}`)
} else {
  say('  PASS: in-process teammates no longer break Claude Code session resume')
}
relay.stop(true)
await inst.close()
process.exit(failures.length ? 1 : 0)
