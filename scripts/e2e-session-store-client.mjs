#!/usr/bin/env bun
// Actual OpenCode -> SDK/model while session-store fsync waits on the disk.
// Requires an owned native credential directory and independently installed scrub.
// Logs only assertions; raw client output stays in the isolated private fixture.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import * as filePromises from 'node:fs/promises'
import * as fileSync from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { spyOn } from 'bun:test'
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { observeSdkModels } from './lib/observe-sdk-models.mjs'
const credentialDir = realpathSync(process.env.E2E_PROFILE_CLAUDE_DIR)
const scrub = realpathSync(process.env.E2E_PLUGIN_PATH)
const client = process.env.E2E_OPENCODE_BIN ?? 'opencode'
const model = process.env.E2E_MODEL ?? 'claude-opus-5-5'
const expectResponsive = process.env.E2E_EXPECT_RESPONSIVE !== '0'
const delayMs = 400
const testCancellation = process.env.E2E_CANCEL_DURING_WRITE === '1'
const sdkVersion = JSON.parse(readFileSync(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8')).version
const cliVersion = JSON.parse(readFileSync(new URL('../node_modules/@anthropic-ai/claude-code/package.json', import.meta.url), 'utf8')).version
const version = spawnSync(client, ['--version'], { encoding: 'utf8' })
assert.equal(version.status, 0, 'Cannot determine actual client version')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-session-store-client-')))
const project = join(root, 'project'), config = join(root, 'client-config')
for (const dir of [project, config, join(root, 'proxy-config'), join(root, 'plugins')]) mkdirSync(dir, {mode: 0o700})
const receipt = 'ACCOUNT-RECEIPT-' + randomUUID()
writeFileSync(join(project, 'receipt.txt'), receipt, {mode: 0o600})
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENCODE_CLAUDE_PROVIDER_)/.test(key)) delete process.env[key]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, 'proxy-config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: project, MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_NO_UPDATE_CHECK: '1',
  ...(process.env.E2E_CLAUDE_BIN ? { MERIDIAN_CLAUDE_PATH: realpathSync(process.env.E2E_CLAUDE_BIN) } : {}),
  MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_PASSTHROUGH: '1' })
let canceledSdkAborts = 0
const queries = [], servedModels = new Set(), realQuery = sdk.query
const observer = spyOn(sdk, 'query').mockImplementation(input => {
  input.options?.abortController?.signal.addEventListener('abort', () => { if (cancellationTriggered) canceledSdkAborts++ }, {once:true})
  queries.push({credentialDirectoryMatched:input.options?.env?.CLAUDE_CONFIG_DIR === credentialDir, resume:!!input.options?.resume})
  return observeSdkModels(realQuery(input), servedModels)
})
const pluginConfigPath = join(root, 'plugins.json')
writeFileSync(pluginConfigPath, JSON.stringify({plugins:[{path:scrub,enabled:true}]}), {mode:0o600})
let proxy, probeUrl, heldPublications = 0, responsiveProbes = 0, pendingDiskWaits = 0, failedProbes = 0, worstTimerLagMs = 0
let closedDuringWait = 0, socketClosedDuringWait = 0, closeFinishedDuringWait = 0
let activeClient, cancelArmed = false, cancellationTriggered = false, canceledRenames = 0
const originalRename = filePromises.rename
const renameObserver = spyOn(filePromises, 'rename').mockImplementation(async (...args) => {
  if (cancellationTriggered && String(args[1]) === join(root, 'sessions', 'sessions.json')) canceledRenames++
  return originalRename(...args)
})
const gateHandles = new WeakSet(), originalOpen = filePromises.open
const openObserver = spyOn(filePromises, 'open').mockImplementation(async (...args) => {
  const handle = await originalOpen(...args)
  if (String(args[0]).includes('/sessions.json.tmp-')) gateHandles.add(handle)
  return handle
})
const probe = await originalOpen(join(root, 'prototype-probe'), 'w')
const handlePrototype = Object.getPrototypeOf(probe), originalSync = handlePrototype.sync
await probe.close()
handlePrototype.sync = async function () {
  if (gateHandles.has(this)) {
    heldPublications++; pendingDiskWaits++
    if (cancelArmed && activeClient) {
      cancelArmed = false; cancellationTriggered = true
      activeClient.kill('SIGKILL')
    }
    const started = performance.now()
    await new Promise(resolve => setTimeout(resolve, delayMs))
    // Other HTTP routes must remain responsive before this publication completes.
    assert(performance.now() - started >= delayMs - 10)
    pendingDiskWaits--
  }
  return originalSync.call(this)
}
// The unchanged synchronous baseline receives the identical delay at the
// store temporary file's fsync. A due timer records the event-loop freeze.
const syncStoreFds = new Set(), originalOpenSync = fileSync.openSync, originalFsyncSync = fileSync.fsyncSync
const syncOpenObserver = spyOn(fileSync, 'openSync').mockImplementation((...args) => {
  const fd = originalOpenSync(...args)
  if (String(args[0]).includes('/sessions.json.tmp-')) syncStoreFds.add(fd)
  return fd
})
const syncObserver = spyOn(fileSync, 'fsyncSync').mockImplementation(fd => {
  if (syncStoreFds.delete(fd)) {
    heldPublications++; pendingDiskWaits++
    const started = performance.now()
    setTimeout(() => { worstTimerLagMs = Math.max(worstTimerLagMs, performance.now() - started) }, 0)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
    pendingDiskWaits--
  }
  return originalFsyncSync(fd)
})
const polling = setInterval(async () => {
  if (!probeUrl || !pendingDiskWaits) return
  try {
    const response = await fetch(probeUrl + '/livez', {signal: AbortSignal.timeout(1000)})
    if (response.status === 200 && (await response.text()).trim() === 'ok') { if (pendingDiskWaits) responsiveProbes++ }
  } catch (error) { failedProbes++ }
}, 10)
const { startProxyServer } = await import('../dist/server.js')
async function run(name, args, env) {
  const child = spawn(client, args, {cwd:project,env,stdio:['ignore','pipe','pipe']})
  activeClient = child
  let stdout='',stderr=''
  child.stdout.on('data', chunk => {stdout += chunk}); child.stderr.on('data', chunk => {stderr += chunk})
  const timeout = setTimeout(() => child.kill('SIGKILL'), 180000)
  const exit = await new Promise((accept,reject) => {child.once('error',reject);child.once('exit',accept)}).finally(()=>clearTimeout(timeout))
  writeFileSync(join(root,name+'.stdout'), stdout,{mode:0o600});writeFileSync(join(root,name+'.stderr'),stderr,{mode:0o600})
  const events = stdout.split('\n').filter(line=>line.startsWith('{')).flatMap(line=>{try{return[JSON.parse(line)]}catch(error){return[]}})
  return {exit,events,session:events.find(event=>typeof event.sessionID==='string')?.sessionID}
}
try {
  proxy = await startProxyServer({port:0,host:'127.0.0.1',silent:true,pluginConfigPath,pluginDir:join(root,'plugins'),
    profiles:[{id:'browser-created',claudeConfigDir:credentialDir}], defaultProfile:'browser-created'})
  if (!proxy.server.listening) await once(proxy.server,'listening')
  proxy.server.on('request', (request, response) => {
    if (request.method !== 'POST' || !request.url?.includes('/messages')) return
    response.once('close', () => { if (cancellationTriggered && pendingDiskWaits) { closedDuringWait++; if (response.writableFinished) closeFinishedDuringWait++ } })
    request.socket.once('close', () => { if (cancellationTriggered && pendingDiskWaits) socketClosedDuringWait++ })
  })
  const url = `http://127.0.0.1:${proxy.server.address().port}`; probeUrl = url
  const plugins = await (await fetch(url+'/plugins/list')).json()
  assert(plugins.plugins.some(plugin=>plugin.name==='opencode-scrub'&&plugin.status==='active'),'Scrub plugin inactive')
  writeFileSync(join(config,'opencode.json'),JSON.stringify({$schema:'https://opencode.ai/config.json',plugin:[resolve('dist/meridian')],
    model:`anthropic/${model}`,small_model:`anthropic/${model}`,share:'disabled',permission:'allow',
    provider:{anthropic:{options:{apiKey:'local-profile-gate',baseURL:url},models:{[model]:{name:model,limit:{context:200000,output:1024},
      reasoning:false,tool_call:true,modalities:{input:['text'],output:['text']}}}}}}),{mode:0o600})
  const env={...process.env,OPENCODE_CONFIG_DIR:config,OPENCODE_DISABLE_AUTOUPDATE:'1'}
  for(const kind of ['CONFIG','DATA','CACHE','STATE']) env['XDG_'+kind+'_HOME']=join(root,kind.toLowerCase())
  for(const key of Object.keys(env)) if(/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENCODE_CLAUDE_PROVIDER_)/.test(key)) delete env[key]
  const first=await run('first',['run','--format','json',`Use read to read ${join(project,'receipt.txt')} and repeat its exact contents.`],env)
  const firstText=first.events.filter(event=>event.type==='text').map(event=>event.part?.text??'').join('')
  assert.equal(first.exit,0,`First client failed; private artifacts: ${root}`)
  assert(first.session && firstText.includes(receipt), 'First real client did not return its tool receipt')
  const continued=first.session?await run('continued',['run','--format','json','--session',first.session,'Without tools, repeat the exact account receipt from the previous turn.'],env):null
  const continuedText=continued?.events.filter(event=>event.type==='text').map(event=>event.part?.text??'').join('')??''
  assert.equal(continued?.exit,0,`Continuation failed; private artifacts: ${root}`)
  assert(continuedText.includes(receipt), 'Real client continuation lost the tool receipt')
  let canceledExit
  if (testCancellation) {
    assert(expectResponsive, 'Cancellation probe requires the asynchronous writer')
    // Client exit can precede the proxy's stream cleanup. Finish earlier
    // turns before arming a fault aimed at the new client's own publication.
    const priorDeadline = Date.now() + 10000
    let priorJoined = false
    while (Date.now() < priorDeadline) {
      const inflight = await (await fetch(url + '/inflight')).json()
      if (!pendingDiskWaits && inflight.total === 0) { priorJoined = true; break }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert(priorJoined, 'Earlier client turns did not join before cancellation probe')
    cancelArmed = true
    const canceled = await run('canceled', ['run', '--format', 'json', 'Without tools, say READY.'], env)
    canceledExit = canceled.exit
    // Join the bounded injected disk wait and subsequent request cleanup.
    const deadline = Date.now() + 10000
    let joined = false
    while (Date.now() < deadline) {
      const inflight = await (await fetch(url + '/inflight')).json()
      if (!pendingDiskWaits && inflight.total === 0) { joined = true; break }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert(joined, 'Canceled request cleanup did not join')
    assert(cancellationTriggered && canceled.exit === null, 'Client was not killed during the store write')
    console.info(JSON.stringify({phase:'cancellation-observation',canceledRenames,canceledSdkAborts,closedDuringWait,socketClosedDuringWait,closeFinishedDuringWait}))
    assert.equal(canceledRenames, 0, 'Canceled client mapping was published before eviction')
  }
  const summary={result:'FAIL',testCancellation,cancellationTriggered,canceledRenames,canceledExit,canceledSdkAborts,closedDuringWait,socketClosedDuringWait,closeFinishedDuringWait,expectResponsive,delayMs,worstTimerLagMs,heldPublications,responsiveProbes,failedProbes,platform:`${process.platform}/${process.arch}`,bun:Bun.version,opencode:version.stdout.trim(),sdk:sdkVersion,claudeCode:cliVersion,model,
    firstExit:first.exit,continuedExit:continued?.exit,firstHasSession:!!first.session,
    toolCalls:first.events.filter(event=>event.type==='tool_use').length,firstReceipt:firstText.includes(receipt),continuedReceipt:continuedText.includes(receipt),
    allQueriesUseNewAccount:queries.length>0&&queries.every(query=>query.credentialDirectoryMatched),servedModels:[...servedModels],realSdkQueries:queries.length,
    resumed:queries.some(query=>query.resume),scrub:plugins.plugins.find(plugin=>plugin.name==='opencode-scrub')?.version,privateArtifacts:root}
  writeFileSync(join(root,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600})
  assert(heldPublications >= 2, 'Actual session-store disk waits missing')
  if (expectResponsive) assert(responsiveProbes > 0 && worstTimerLagMs === 0, 'HTTP did not run during session-store disk waits')
  else assert(responsiveProbes === 0 && worstTimerLagMs >= delayMs - 10, 'Unchanged synchronous baseline did not reproduce the freeze')
  assert(summary.toolCalls>0&&summary.firstReceipt&&summary.continuedReceipt,'Actual tool receipt or continuation missing')
  assert(summary.allQueriesUseNewAccount&&summary.resumed,'The new account was not used for all real SDK queries and resume')
  assert(servedModels.size>0&&[...servedModels].every(value=>value===model||value.startsWith(model+'-')),'Upstream response did not confirm the implicated model')
  summary.result='PASS';writeFileSync(join(root,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600});console.log(JSON.stringify(summary))
} finally {clearInterval(polling);await proxy?.close();observer.mockRestore();openObserver.mockRestore();syncOpenObserver.mockRestore();syncObserver.mockRestore();renameObserver.mockRestore();handlePrototype.sync=originalSync}
