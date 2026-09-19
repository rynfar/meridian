import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { startProxyServer } from '../dist/server.js'
const root = await mkdtemp(join(tmpdir(), 'meridian-agy-native-tools-'))
console.log(`Artifacts: ${root}`)
const report = { platform: process.platform, model: 'gemini-3.8-flash-low', passed: [] }
const wrapper = join(root, 'agy-trace.cjs')
await writeFile(wrapper, `#!${process.execPath}
const {spawn}=require('node:child_process');const fs=require('node:fs');const args=process.argv.slice(2);const child=spawn('agy',args,{stdio:['pipe','pipe','pipe']});process.stdin.pipe(child.stdin);child.stdout.on('data',chunk=>{if(args.includes('--input-format'))fs.appendFileSync(${JSON.stringify(root)}+'/'+process.pid+'.ndjson',chunk);process.stdout.write(chunk)});child.stderr.pipe(process.stderr);child.on('close',code=>{if(args.includes('--input-format')&&fs.existsSync('policy-audit.jsonl'))fs.copyFileSync('policy-audit.jsonl',${JSON.stringify(root)}+'/'+process.pid+'.audit.jsonl');process.exitCode=code??1});child.on('error',error=>{console.error(error);process.exitCode=1});`, { mode: 0o700 })
const canary = 'PRIVATE_' + randomUUID()
const canaryPath = join(root, 'guard-canary.txt')
await writeFile(canaryPath, canary, { mode: 0o600 })
const receipt = 'BROWSER_' + randomUUID()
const site = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(`<h1>${receipt}</h1>`) })
site.listen(0, '127.0.0.1'); await once(site, 'listening')
const siteUrl = `http://127.0.0.1:${site.address().port}`
let proxy
try {
  proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { executable: wrapper, allowNativeBrowser: true, browserMcpExecutable: process.env.MERIDIAN_AGY_BROWSER_MCP_PATH, allowNativeSubagents: true, reuseConversations: false } })
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const url = `http://127.0.0.1:${proxy.server.address().port}`
  for (const [name, prompt, expected, tool] of [
    ['subagent', 'Use the native invoke_subagent tool to ask a self subagent to calculate 137 times 29. Wait for its answer and report the number. Do not calculate it yourself, and do not use file, shell or browser tools.', '3973', 'invoke_subagent'],
    ['browser', `Invoke the native browser subagent with TypeName browser and Workspace inherit to open ${siteUrl}, read the page and return its exact main heading. Wait for the browser subagent to complete before replying. The heading is a random code that is not in this prompt. Do not use shell tools or web search.`, receipt, 'invoke_subagent'],
  ]) {
    const response = await fetch(url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: report.model, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(180000) })
    const answer = await response.json()
    const activity = await (await fetch(url + '/telemetry/native-tools')).json()
    await writeFile(join(root, name + '.json'), JSON.stringify({ status: response.status, answer, activity }, null, 2))
    assert.equal(response.status, 200, JSON.stringify(answer))
    assert(JSON.stringify(answer.content).includes(expected), JSON.stringify(answer))
    assert(activity.some(event => event.name === tool && event.state === 'DONE'), JSON.stringify(activity))
    report.passed.push(name); console.log('PASS', name)
  }
  const guardResponse = await fetch(url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: report.model, messages: [{ role: 'user', content: `Invoke a self subagent with Workspace inherit. Ask it to attempt view_file on ${canaryPath} once and report whether the hook denies it. This is a disposable test fixture: do not use any client tool or workaround. Await the subagent and report the denial.` }] }), signal: AbortSignal.timeout(180000) })
  const guardAnswer = await guardResponse.json()
  await writeFile(join(root, 'guard.json'), JSON.stringify({ status: guardResponse.status, answer: guardAnswer }, null, 2))
  assert(!JSON.stringify(guardAnswer).includes(canary), 'Guarded child exposed a forbidden file')
  const audits = (await Promise.all((await readdir(root)).filter(file => file.endsWith('.audit.jsonl')).map(file => readFile(join(root, file), 'utf8')))).flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
  const parents = (await Promise.all((await readdir(root)).filter(file => file.endsWith('.ndjson')).map(file => readFile(join(root, file), 'utf8')))).flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).filter(event => event.event === 'init').map(event => event.conversation_id)
  assert(audits.some(event => event.name === 'view_file' && !event.allowed && event.conversationId && !parents.includes(event.conversationId)), 'No native child filesystem denial observed')
  report.passed.push('inherited child hook denies non-attachment file'); console.log('PASS inherited child guard')
  const previousRuns = new Set((await (await fetch(url + '/telemetry/native-tools')).json()).map(event => event.runId))
  const cancel = new AbortController()
  const longRequest = fetch(url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: report.model, messages: [{ role: 'user', content: 'Invoke a self subagent in Workspace inherit to write a 10000-word detailed tutorial on graph algorithms. Wait for the subagent to finish its complete tutorial before returning it. Do not use file, shell or browser tools.' }] }), signal: cancel.signal }).then(response => response.json()).catch(error => ({ cancelled: String(error) }))
  const deadline = Date.now() + 60000
  try {
    while (true) {
      const events = await (await fetch(url + '/telemetry/native-tools')).json()
      if (events.some(event => !previousRuns.has(event.runId) && event.name === 'invoke_subagent' && event.state === 'DONE')) break
      assert(Date.now() < deadline, 'Native subagent did not start before cancellation deadline')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  } finally { cancel.abort(); await longRequest }
  const stoppedBy = Date.now() + 10000
  while ((await (await fetch(url + '/health')).json()).activeProcesses) {
    assert(Date.now() < stoppedBy, 'Native cancellation retained an active CLI process')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  report.passed.push('cancellation after native child invocation releases active CLI process'); console.log('PASS native cancellation')

} catch (error) { report.error = String(error); throw error }
finally { await proxy?.close(); site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)) }
