#!/usr/bin/env bun
// OpenCode 2.0.16 -> installed Meridian V2 plugin -> real SDK -> Sonnet 5.5,
// with a conversation larger than 200k tokens (#1212).
//
// Sonnet 5+ serves a native 1M window on plain `sonnet`. Meridian advertised
// and budgeted it at 200k, which cost a long session twice:
//
//   - the V2 plugin copies `/v1/models` into OpenCode's catalog, so the client
//     compacted at 200k;
//   - a fresh replay (here: after a proxy restart) was trimmed to the 200k
//     budget before it reached the SDK.
//
// Run the same script against unchanged main and against the fix. Unchanged
// main must FAIL the window, compaction and trim checks; the fix must pass
// them all. Assertions are on requests, headers, logs and token counts, never
// on what the model wrote.
//
// Two attached files of filler build the history, then the proxy is replaced by
// a fresh one with an empty session store so the third turn is a full replay.
// Costs roughly 700k Sonnet input tokens per run and needs a logged-in Claude
// subscription. Set E2E_FILL_CHARS small for a cheap wiring rehearsal; the
// token checks are then reported but cannot pass.
//
// The server-side OpenCode scrub plugin is required: without it the upstream
// refuses real OpenCode traffic as Extra Usage before any of this is tested.
//
//   npm run build
//   E2E_OPENCODE_BIN=/abs/opencode E2E_PLUGIN_PATH=/abs/opencode-scrub/dist/index.js \
//     E2E_MERIDIAN_ROOT=$PWD bun scripts/e2e-sonnet-native-context.mjs
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveOpenCodeScrub, verifyOpenCodeScrub } from './lib-opencode-scrub-preflight.mjs'

const client = process.env.E2E_OPENCODE_BIN
assert(client, 'Set E2E_OPENCODE_BIN to the exact OpenCode 2.0.16 executable')
const scrub = resolveOpenCodeScrub(process.env.E2E_PLUGIN_PATH, process.env.E2E_SCRUB_VERSION)
const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const meridian = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
const model = 'claude-sonnet-5-5'
const fillChars = Number(process.env.E2E_FILL_CHARS ?? 300_000)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-sonnet-native-context-')))
const project = join(root, 'project')
const config = join(root, 'opencode')
const meridianConfig = join(root, 'meridian')
for (const path of [project, config, meridianConfig]) mkdirSync(path)
writeFileSync(join(meridianConfig, 'plugins.json'), JSON.stringify({ plugins: [{ path: scrub.path, enabled: true }] }), { mode: 0o600 })

// Word-like filler tokenizes close to ordinary prose, so the size is predictable.
const ancient = `ANCIENT_${randomUUID()}`
const words = ['harbor', 'lantern', 'meadow', 'orchard', 'granite', 'willow', 'copper', 'thistle', 'ember', 'quarry', 'saddle', 'timber']
function filler(seed, header) {
  const lines = [header]
  let size = header.length
  for (let line = 0; size < fillChars; line++) {
    const hash = createHash('sha256').update(`${seed}:${line}`).digest()
    const text = Array.from(hash.subarray(0, 12), byte => words[byte % words.length]).join(' ')
    lines.push(text)
    size += text.length + 1
  }
  return lines.join('\n')
}
writeFileSync(join(project, 'archive-1.txt'), filler('one', `Archive one. Receipt ${ancient}.`))
writeFileSync(join(project, 'archive-2.txt'), filler('two', 'Archive two.'))

const attestationKey = randomBytes(32).toString('base64url')
const proxyEnv = { ...process.env }
for (const key of Object.keys(proxyEnv)) if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete proxyEnv[key]
Object.assign(proxyEnv, {
  E2E_PROXY_MODULE: pathToFileURL(join(repo, 'dist/server.js')).href,
  MERIDIAN_CONFIG_DIR: meridianConfig,
  MERIDIAN_TELEMETRY_PERSIST: '0',
  MERIDIAN_PASSTHROUGH: '1',
  MERIDIAN_OPENCODE_ATTESTATION_KEY: attestationKey,
  PWD: project,
  INIT_CWD: project,
})

const observed = []
const proxies = []
let proxyURL
async function startProxy(label) {
  let proxy
  const ready = new Promise((resolveReady, rejectReady) => {
    proxy = Bun.spawn([process.execPath, join(import.meta.dir, 'e2e-opencode-proxy-host.mjs')], {
      cwd: project, env: { ...proxyEnv, MERIDIAN_SESSION_DIR: join(root, `sessions-${label}`) }, stdout: 'pipe', stderr: 'pipe',
      ipc(message) { if (message.port) resolveReady(message.port) },
    })
    proxy.exited.then(code => rejectReady(new Error(`Meridian exited before readiness: ${code}`)))
  })
  const output = Promise.all([new Response(proxy.stdout).text(), new Response(proxy.stderr).text()])
  const port = await Promise.race([ready, Bun.sleep(30_000).then(() => { throw Error('Meridian readiness timeout') })])
  proxyURL = `http://127.0.0.1:${port}`
  const entry = { label, proxy, output, url: proxyURL, stopped: false }
  proxies.push(entry)
  return entry
}
// Telemetry and the diagnostic log live in the proxy process, so read them
// before it goes away.
async function stopProxy(entry) {
  if (entry.stopped) return entry
  entry.stopped = true
  try {
    entry.requests = await (await fetch(`${entry.url}/telemetry/requests?limit=200`)).json()
    entry.logs = await (await fetch(`${entry.url}/telemetry/logs?limit=500`)).text()
  } catch (error) { entry.telemetryError = String(error) }
  entry.proxy.kill()
  await entry.proxy.exited
  const [stdout, stderr] = await entry.output
  writeFileSync(join(root, `meridian-${entry.label}.stdout`), stdout)
  writeFileSync(join(root, `meridian-${entry.label}.stderr`), stderr)
  writeFileSync(join(root, `telemetry-${entry.label}.json`), JSON.stringify(entry.requests ?? null, null, 2))
  writeFileSync(join(root, `logs-${entry.label}.txt`), entry.logs ?? '')
  entry.trimmed = `${entry.logs ?? ''}\n${stdout}\n${stderr}`.includes('replay_trimmed')
  return entry
}

const report = { result: 'RUNNING', root, client: undefined, meridian, model, fillChars, scrub: `${scrub.packageName}@${scrub.packageVersion}`, platform: `${process.platform}/${process.arch}`, checks: [] }
const check = (ok, label, detail) => {
  report.checks.push({ ok: Boolean(ok), label, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
let relay
try {
  let first = await startProxy('first')
  verifyOpenCodeScrub(await (await fetch(`${proxyURL}/plugins/list`)).json(), scrub)
  relay = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 255, async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === 'GET' ? undefined : await request.arrayBuffer()
    if (url.pathname === '/v1/models') observed.push({ path: url.pathname, agentHeader: request.headers.get('user-agent') })
    if (url.pathname === '/v1/messages' && body) {
      let parsed
      try { parsed = JSON.parse(new TextDecoder().decode(body)) } catch { parsed = undefined }
      observed.push({
        path: url.pathname,
        proxy: proxies.at(-1).label,
        model: parsed?.model,
        bytes: body.byteLength,
        messages: parsed?.messages?.length,
        session: request.headers.get('x-opencode-session'),
        agent: request.headers.get('x-opencode-agent-name'),
        mode: request.headers.get('x-opencode-agent-mode'),
        source: request.headers.get('x-meridian-source'),
        attested: request.headers.has('x-meridian-opencode-turn'),
        hasAncient: JSON.stringify(parsed?.messages ?? []).includes(ancient),
      })
    }
    const upstream = await fetch(`${proxyURL}${url.pathname}${url.search}`, {
      method: request.method, headers: request.headers,
      ...(body === undefined ? {} : { body }),
    })
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
  } })
  // The entry only makes the model routable. It must not carry a `limit`: V2
  // layers configured models over plugin transforms, so a window written here
  // would hide the one the plugin discovers from Meridian's `/v1/models`.
  writeFileSync(join(config, 'opencode.json'), JSON.stringify({
    model: `anthropic/${model}`,
    providers: { anthropic: { settings: { apiKey: 'local-e2e', baseURL: `http://127.0.0.1:${relay.port}/v1` },
      models: { [model]: { name: model } } } },
    share: 'disabled',
  }, null, 2))
  const clientEnv = { ...process.env }
  for (const key of Object.keys(clientEnv)) {
    if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_') || key.startsWith('ANTHROPIC_')) delete clientEnv[key]
  }
  for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) clientEnv[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase())
  Object.assign(clientEnv, {
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    MERIDIAN_CONFIG_DIR: meridianConfig,
    MERIDIAN_OPENCODE_ATTESTATION_KEY: attestationKey,
    PWD: project,
    INIT_CWD: project,
  })
  const versionRun = Bun.spawnSync([client, '--version'], { env: clientEnv })
  report.client = new TextDecoder().decode(versionRun.stdout).trim()
  assert.equal(report.client, 'opencode v2.0.16')
  const plugin = join(repo, 'dist', 'meridian-v2')
  const setup = Bun.spawnSync(['node', join(repo, 'dist', 'cli.js'), 'setup', '--v2', '--opencode-bin', client], { cwd: project, env: clientEnv })
  assert.equal(setup.exitCode, 0, `Meridian setup failed: ${new TextDecoder().decode(setup.stderr)}`)
  const configured = JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8'))
  assert.deepEqual(configured.plugins.map(path => realpathSync(path)), [realpathSync(plugin)],
    'Setup did not install the packaged V2 plugin exactly once')
  report.plugin = realpathSync(plugin)

  const advertised = (await (await fetch(`${proxyURL}/v1/models`)).json()).data.find(row => row.id === model)?.context_window
  report.advertisedWindow = advertised

  async function runClient(label, flags, prompt) {
    const run = Bun.spawn([client, 'run', '--standalone', '--auto', '--format', 'json', '--model', `anthropic/${model}`, ...flags, prompt], {
      cwd: project, env: clientEnv, stdout: 'pipe', stderr: 'pipe',
    })
    const timeout = setTimeout(() => run.kill(), 600_000)
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited,
    ]).finally(() => clearTimeout(timeout))
    writeFileSync(join(root, `${label}.stdout`), stdout)
    writeFileSync(join(root, `${label}.stderr`), stderr)
    writeFileSync(join(root, 'requests.json'), JSON.stringify(observed, null, 2))
    assert.equal(code, 0, `${label}: OpenCode exit ${code}; see ${root}/${label}.stderr`)
    return stdout
  }
  // fork-compaction since #1448; subagent-compaction from an older V2 plugin.
  const isCompaction = row => row.source === 'fork-compaction' || row.source === 'subagent-compaction'
  const primaryRows = () => observed.filter(row => row.path === '/v1/messages' && row.agent === 'build' && row.mode === 'primary' && !isCompaction(row))

  await runClient('turn-1', ['--file', join(project, 'archive-1.txt')], 'The attached archive is context only. Reply with exactly ACK-1 and do not call tools.')
  const session = primaryRows()[0]?.session
  assert(session, `No attested primary request: ${JSON.stringify(observed)}`)
  await runClient('turn-2', ['--session', session, '--file', join(project, 'archive-2.txt')], 'The attached archive is context only. Reply with exactly ACK-2 and do not call tools.')

  // A fresh proxy has no SDK session for this conversation, so the next turn
  // is a full replay of everything OpenCode still holds.
  first = await stopProxy(first)
  let second = await startProxy('second')
  const beforeReplay = observed.length
  await runClient('turn-3', ['--session', session], 'Reply with exactly ACK-3 and do not call tools.')
  verifyOpenCodeScrub(await (await fetch(`${proxyURL}/plugins/list`)).json(), scrub, true)
  second = await stopProxy(second)

  const replayRows = observed.slice(beforeReplay).filter(row => row.path === '/v1/messages')
  const replay = replayRows.filter(row => row.agent === 'build' && row.mode === 'primary' && !isCompaction(row) && row.session === session).at(-1)
  const compactions = observed.filter(isCompaction)
  const usage = (second.requests ?? []).map(row => ({
    model: row.model, requestModel: row.requestModel, status: row.status ?? row.statusCode, lineage: row.lineageType,
    input: (row.inputTokens ?? 0) + (row.cacheReadInputTokens ?? 0) + (row.cacheCreationInputTokens ?? 0),
  }))
  report.replay = replay
  report.compactions = compactions.length
  report.usage = usage
  const largestInput = Math.max(0, ...usage.map(row => row.input))

  console.log(`\n=== Sonnet native context (meridian ${meridian}, ${report.client}, ${report.platform}) ===`)
  check(observed.some(row => row.path === '/v1/models'), 'the V2 plugin fetched the proxy model catalog')
  check(replay?.attested, 'the replayed turn is a signed primary OpenCode request', JSON.stringify(replay))
  check(advertised === 1_000_000, 'Sonnet 5.5 is advertised with its native 1M window', `context_window=${advertised}`)
  check(compactions.length === 0, 'OpenCode did not compact the conversation below 1M', `compaction requests=${compactions.length}`)
  check(replay?.hasAncient, 'the client still sent the oldest archive on the replayed turn')
  check(!second.trimmed, 'Meridian did not trim the fresh replay', `replay_trimmed logged=${second.trimmed}`)
  check(largestInput > 200_000, 'the replayed turn reached the model with more than 200k input tokens', `input=${largestInput}`)
  report.result = report.checks.every(row => row.ok) ? 'PASS' : 'FAIL'
} catch (error) {
  report.result = 'FAIL'
  report.failure = String(error?.stack ?? error)
} finally {
  relay?.stop(true)
  for (const entry of proxies) await stopProxy(entry)
  writeFileSync(join(root, 'requests.json'), JSON.stringify(observed, null, 2))
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ result: report.result, root, failure: report.failure, failed: report.checks.filter(row => !row.ok).map(row => row.label) }))
  process.exitCode = report.result === 'PASS' ? 0 : 1
}
