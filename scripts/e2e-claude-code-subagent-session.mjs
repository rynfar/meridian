#!/usr/bin/env bun
// Live: does a Claude Code conversation keep resuming while Agent-tool
// subagents run beside it — using the REAL Claude Code CLI?
//
// A subagent sends its parent's own `metadata.user_id` session id while
// running a multi-turn conversation of its own. Under one session key the
// parent and every subagent read as `unrelated-history` to one another, so
// nothing resumed, and they all queued on one turn lease. The CLI stamps
// `x-claude-code-agent-id` on every subagent request; the adapter keys a
// subagent `<sid>:agent:<agentId>`.
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

const WORKDIR = realpathSync(mkdtempSync(join(tmpdir(), 'mccsub-')))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, 'store'))

const { startProxyServer } = await import('../src/proxy/server.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3560)
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
      const id = `e72-${++relaySeq}`
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
const brief = r => `${r.agent === 'main' ? 'main' : `agent:${r.agent.slice(0, 8)}`} ${r.line
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
  }
}

// Spawned asynchronously and drained concurrently: spawnSync deadlocks once
// the client fills a pipe while it waits on the proxy (see E55). Default
// permission mode with the probe's tools pre-allowed, so no auto-mode
// classifier runs and every request here is a main or subagent turn (E71
// covers the classifier).
async function runClient(cwd, configDir, args) {
  const proc = Bun.spawn([
    CLI, ...args, '--model', MODEL, '--permission-mode', 'default',
    '--allowedTools', 'Bash(echo:*)', 'Agent',
  ], {
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

async function turn(label, cwd, configDir, args) {
  const from = records().length
  const result = await runClient(cwd, configDir, args)
  const recs = records().slice(from)
  say(`\n  ${label} (${recs.length} proxy requests) exit=${result.status}: ${result.out.slice(0, 60)}`)
  for (const r of recs) say(`    ${brief(r)}`)
  return { ...result, recs }
}

say(`\n=== Claude Code Agent-tool subagent session isolation ===`)
say(`  client: ${version}   adapter: claude-code   model: ${MODEL}`)

const SESSION = randomUUID()
const CONFIG = realpathSync(mkdtempSync(join(tmpdir(), 'mccsubconf-')))
const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), 'mccsubproj-')))
writeFileSync(join(PROJECT, 'README.md'), 'scratch project\n')

const t1 = await turn('turn 1 (two parallel subagents)', PROJECT, CONFIG, [
  '-p', [
    'Use the Agent tool to launch two general-purpose subagents in parallel, in a single message,',
    'both in the foreground (run_in_background false).',
    'Subagent ALPHA must run the shell command `echo alpha-1`, then in a separate Bash call run',
    '`echo alpha-2`, then report both outputs.',
    'Subagent BETA must do the same with `echo beta-1` and `echo beta-2`.',
    'When both have reported, reply with exactly the word DONE.',
  ].join(' '),
  '--session-id', SESSION,
])
const t2 = await turn('turn 2 (--resume)', PROJECT, CONFIG, [
  '--resume', SESSION,
  '-p', 'Reply with exactly the word AGAIN.',
])

const turns = [t1, t2]
const all = turns.flatMap(t => t.recs)
const mains = all.filter(r => r.agent === 'main' && toolCount(r) > 0 && !isAux(r))
const subagentRecs = all.filter(r => r.agent !== 'main' && r.agent !== 'unknown' && !isAux(r))
const byAgent = new Map()
for (const r of subagentRecs) byAgent.set(r.agent, [...(byAgent.get(r.agent) ?? []), r])

say('')
check(turns.every(t => t.status === 0), 'every client invocation succeeded',
  turns.map(t => t.status).join(',') + (t1.err ? ` stderr=${t1.err.slice(0, 160)}` : ''))
check(t1.out.includes('DONE') && t2.out.includes('AGAIN'), 'every turn answered',
  turns.map(t => JSON.stringify(t.out.slice(0, 20))).join(' '))
check(all.every(r => r.agent !== 'unknown'), 'every proxy request line maps to a relayed request',
  `${all.filter(r => r.agent === 'unknown').length} unmapped`)

// 1. Subagents actually ran, each over several turns. Without this the rest
//    would pass on a run that never exercised the bug.
const multiTurn = [...byAgent.values()].filter(rs => rs.length >= 2)
check(byAgent.size >= 2 && multiTurn.length >= 2, 'at least two subagents ran multi-turn conversations',
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
  say('  PASS: Agent-tool subagents no longer break Claude Code session resume')
}
relay.stop(true)
await inst.close()
process.exit(failures.length ? 1 : 0)
