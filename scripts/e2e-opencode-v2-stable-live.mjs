#!/usr/bin/env bun
// OpenCode 2.0.16 -> installed Meridian V2 plugin -> real SDK/model.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const client = process.env.E2E_OPENCODE_BIN
assert(client, 'Set E2E_OPENCODE_BIN to the exact OpenCode 2.0.16 executable')
const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
if (process.env.E2E_EXPECT_MERIDIAN_VERSION) assert.equal(version, process.env.E2E_EXPECT_MERIDIAN_VERSION)
const model = process.env.E2E_MODEL ?? 'claude-haiku-4-5'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-opencode-v2-stable-')))
const project = join(root, 'project')
const config = join(root, 'opencode')
const meridianConfig = join(root, 'meridian')
for (const path of [project, config, meridianConfig]) mkdirSync(path)
const marker = `OC2_STABLE_${randomUUID()}`
const variantMarker = `VARIANT_${randomUUID()}`
const fileReceipt = `FILE_RECEIPT_${randomUUID()}`
const forkMarker = `FORK_ONLY_${randomUUID()}`
const generateMarker = `GENERATE_${randomUUID()}`
writeFileSync(join(project, 'fixture.txt'), fileReceipt)
const attestationKey = process.env.E2E_ATTESTATION_KEY ?? randomBytes(32).toString('base64url')
const proxyEnv = { ...process.env }
for (const key of Object.keys(proxyEnv)) if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete proxyEnv[key]
Object.assign(proxyEnv, {
  E2E_PROXY_MODULE: pathToFileURL(join(repo, 'dist/server.js')).href,
  MERIDIAN_CONFIG_DIR: meridianConfig,
  MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_TELEMETRY_PERSIST: '0',
  MERIDIAN_PASSTHROUGH: '1',
  MERIDIAN_OPENCODE_ATTESTATION_KEY: attestationKey,
  PWD: project,
  INIT_CWD: project,
})
const observed = []
let proxy
let proxyOutput
let relay
try {
  let proxyURL = process.env.E2E_PROXY_URL
  if (!proxyURL) {
    const ready = new Promise((resolveReady, rejectReady) => {
      proxy = Bun.spawn([process.execPath, join(import.meta.dir, 'e2e-opencode-proxy-host.mjs')], {
        cwd: project, env: proxyEnv, stdout: 'pipe', stderr: 'pipe',
        ipc(message) { if (message.port) resolveReady(message.port) },
      })
      proxy.exited.then(code => rejectReady(new Error(`Meridian exited before readiness: ${code}`)))
    })
    proxyOutput = Promise.all([new Response(proxy.stdout).text(), new Response(proxy.stderr).text()])
    const proxyPort = await Promise.race([ready, Bun.sleep(30_000).then(() => { throw Error('Meridian readiness timeout') })])
    proxyURL = `http://127.0.0.1:${proxyPort}`
  }
  assert(new URL(proxyURL).protocol === 'http:', 'E2E proxy must use local HTTP')
  relay = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === 'GET' ? undefined : await request.arrayBuffer()
    if (url.pathname === '/v1/messages' && body) {
      let parsed
      try { parsed = JSON.parse(new TextDecoder().decode(body)) } catch { parsed = undefined }
      const messages = JSON.stringify(parsed?.messages ?? [])
      observed.push({
        path: url.pathname,
        model: parsed?.model,
        effort: parsed?.effort,
        systemBlockLengths: Array.isArray(parsed?.system) ? parsed.system.map(block => block.text?.length ?? 0) : [],
        session: request.headers.get('x-opencode-session'),
        agent: request.headers.get('x-opencode-agent-name'),
        mode: request.headers.get('x-opencode-agent-mode'),
        source: request.headers.get('x-meridian-source'),
        attested: request.headers.has('x-meridian-opencode-turn'),
        hasMarker: messages.includes(marker),
        hasVariantMarker: messages.includes(variantMarker),
        hasFileReceipt: messages.includes(fileReceipt),
        hasForkMarker: messages.includes(forkMarker),
        hasGenerateMarker: messages.includes(generateMarker),
        hasToolUse: messages.includes('"tool_use"'),
        hasToolResult: messages.includes('"tool_result"'),
      })
    }
    const upstream = await fetch(`${proxyURL}${url.pathname}${url.search}`, {
      method: request.method, headers: request.headers,
      ...(body === undefined ? {} : { body }),
    })
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
  } })
  const relayURL = `http://127.0.0.1:${relay.port}`
  const plugin = join(repo, 'dist', 'meridian-v2')
  writeFileSync(join(config, 'opencode.json'), JSON.stringify({
    model: `anthropic/${model}`,
    providers: { anthropic: { settings: { apiKey: 'local-e2e', baseURL: `${relayURL}/v1` },
      models: { [model]: { name: model, limit: { context: 200000, output: 4096 } } } } },
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
    OPENCODE_SERVER_PASSWORD: 'local-e2e',
    MERIDIAN_CONFIG_DIR: meridianConfig,
    MERIDIAN_OPENCODE_ATTESTATION_KEY: attestationKey,
    PWD: project,
    INIT_CWD: project,
  })
  const versionRun = Bun.spawnSync([client, '--version'], { env: clientEnv })
  assert.equal(versionRun.exitCode, 0)
  assert.equal(new TextDecoder().decode(versionRun.stdout).trim(), 'opencode v2.0.16')
  const setup = Bun.spawnSync(['node', join(repo, 'dist', 'cli.js'), 'setup', '--v2', '--opencode-bin', client],
    { cwd: project, env: clientEnv })
  assert.equal(setup.exitCode, 0, `Meridian setup rejected 2.0.16: ${new TextDecoder().decode(setup.stderr)}`)
  const configured = JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8'))
  assert.deepEqual(configured.plugins.map(path => realpathSync(path)), [realpathSync(plugin)],
    'Setup did not install the packaged V2 plugin exactly once')
  async function runClient(label, flags, prompt) {
    const run = Bun.spawn([client, 'run', '--standalone', '--auto', '--format', 'json', ...flags, prompt], {
      cwd: project, env: clientEnv, stdout: 'pipe', stderr: 'pipe',
    })
    const timeout = setTimeout(() => run.kill(), 180_000)
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited,
    ]).finally(() => clearTimeout(timeout))
    writeFileSync(join(root, `${label}.stdout`), stdout)
    writeFileSync(join(root, `${label}.stderr`), stderr)
    writeFileSync(join(root, 'requests.json'), JSON.stringify(observed, null, 2))
    assert.equal(code, 0, `${label}: OpenCode exit ${code}; see ${root}/${label}.stderr`)
    return stdout
  }
  const first = await runClient('first', ['--model', `anthropic/${model}`],
    `Reply with exactly ${marker}. Do not call any tools.`)
  assert(first.includes('"type":"text"'), `No model response text; see ${root}/first.stdout`)
  const primary = observed.find(row => row.hasMarker && row.session && row.agent === 'build' && row.mode === 'primary')
  assert(primary?.attested, `No attested primary request: ${JSON.stringify(observed)}`)
  assert(observed.some(row => row.hasMarker && row.agent === 'title' && row.mode === 'subagent' && !row.session),
    `Title job was not detached: ${JSON.stringify(observed)}`)

  const beforeResume = observed.length
  const resumed = await runClient('resumed', ['--session', primary.session, '--model', `anthropic/${model}`],
    'Repeat the exact OC2_STABLE marker from the previous user message. Do not call tools.')
  assert(resumed.includes('"type":"text"'), `No resumed model response text; see ${root}/resumed.stdout`)
  assert(observed.slice(beforeResume).some(row => row.session === primary.session && row.agent === 'build' && row.attested && row.hasMarker),
    'Resumed primary request lost the prior user marker or signed turn identity')

  await runClient('variant', ['--model', `anthropic/${model}#xhigh`],
    `Reply with exactly ${variantMarker}. Do not call any tools.`)
  assert(observed.some(row => row.hasVariantMarker && row.effort === 'xhigh' && row.agent === 'build' && row.attested),
    `Discovered xhigh effort did not reach Meridian with the fixture input: ${JSON.stringify(observed)}`)

  const beforeTool = observed.length
  await runClient('tool', ['--model', `anthropic/${model}`],
    'Use the read tool to open fixture.txt in the current directory, then report its exact contents.')
  assert(observed.slice(beforeTool).some(row => row.hasFileReceipt && row.hasToolResult && row.agent === 'build'),
    `The real read tool result did not reach the model: ${JSON.stringify(observed.slice(beforeTool))}`)

  const beforeFork = observed.length
  await runClient('fork', ['--session', primary.session, '--fork', '--model', `anthropic/${model}`],
    `In this fork, acknowledge the marker ${forkMarker}. Do not use tools.`)
  const fork = observed.slice(beforeFork).find(row => row.hasForkMarker && row.agent === 'build' && row.session)
  assert(fork && fork.session !== primary.session, `Fork reused the source session: ${JSON.stringify(observed.slice(beforeFork))}`)
  assert.equal(fork.attested, false, 'A fork must not receive a root human-turn attestation')
  const beforeOriginal = observed.length
  await runClient('original', ['--session', primary.session, '--model', `anthropic/${model}`],
    'Continue the original conversation with a brief answer. Do not use tools.')
  assert(observed.slice(beforeOriginal).some(row => row.session === primary.session && row.agent === 'build' && !row.hasForkMarker),
    `Original session contains the fork-only marker: ${JSON.stringify(observed.slice(beforeOriginal))}`)

  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') })
  const apiPort = reservation.port
  await reservation.stop(true)
  const server = Bun.spawn([client, 'serve', '--hostname', '127.0.0.1', '--port', String(apiPort)], {
    cwd: project, env: clientEnv, stdout: 'pipe', stderr: 'pipe',
  })
  const serverOutput = Promise.all([new Response(server.stdout).text(), new Response(server.stderr).text()])
  const authorization = `Basic ${Buffer.from('opencode:local-e2e').toString('base64')}`
  const base = `http://127.0.0.1:${apiPort}`
  const headers = { authorization, 'content-type': 'application/json' }
  try {
    let ready = false
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const response = await fetch(`${base}/api/session/${primary.session}`, { headers, signal: AbortSignal.timeout(1000) })
        if (response.ok) { ready = true; break }
      } catch (error) { if (server.exitCode !== null) throw error }
      await Bun.sleep(100)
    }
    assert(ready, 'OpenCode 2.0.16 API server did not load the persisted session')
    const beforeGenerate = observed.length
    const generated = await fetch(`${base}/api/session/${primary.session}/generate`, {
      method: 'POST', headers, body: JSON.stringify({ prompt: `Explain the marker ${generateMarker} briefly.` }),
      signal: AbortSignal.timeout(120_000),
    })
    const generatedBody = await generated.text()
    assert(generated.ok, `Session generate failed: ${generated.status} ${generatedBody.slice(0, 300)}`)
    assert.equal(typeof JSON.parse(generatedBody).data?.text, 'string')
    assert(observed.slice(beforeGenerate).some(row => row.hasGenerateMarker && row.agent === 'generate'
      && row.mode === 'subagent' && row.source === 'subagent-generate' && !row.session && !row.attested),
    `Transient generate was not detached: ${JSON.stringify(observed.slice(beforeGenerate))}`)

    const beforeCompaction = observed.length
    const compact = await fetch(`${base}/api/session/${primary.session}/compact`, {
      method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(120_000),
    })
    const compactBody = await compact.text()
    assert(compact.ok, `Session compaction admission failed: ${compact.status} ${compactBody.slice(0, 300)}`)
    const settled = await fetch(`${base}/api/experimental/session/${primary.session}/wait`, {
      method: 'POST', headers, signal: AbortSignal.timeout(120_000),
    })
    assert(settled.ok, `Session compaction did not settle: ${settled.status}`)
    assert(observed.slice(beforeCompaction).some(row => row.session === primary.session
      && row.source === 'subagent-compaction' && row.mode === 'primary' && !row.attested),
    `Compaction changed the root identity or tier: ${JSON.stringify(observed.slice(beforeCompaction))}`)
  } finally {
    server.kill()
    await server.exited
    const [stdout, stderr] = await serverOutput
    writeFileSync(join(root, 'server.stdout'), stdout)
    writeFileSync(join(root, 'server.stderr'), stderr)
  }
  writeFileSync(join(root, 'requests.json'), JSON.stringify(observed, null, 2))
  console.log(JSON.stringify({ result: 'PASS', root, client: '2.0.16', meridian: version, model,
    requests: observed.length, primary: observed.filter(row => row.agent === 'build'),
    auxiliary: observed.filter(row => row.agent === 'generate' || row.source === 'subagent-compaction') }))
} finally {
  relay?.stop(true)
  if (proxy) {
    proxy.kill()
    await proxy.exited
    if (proxyOutput) {
      const [stdout, stderr] = await proxyOutput
      writeFileSync(join(root, 'meridian.stdout'), stdout)
      writeFileSync(join(root, 'meridian.stderr'), stderr)
    }
  }
}
