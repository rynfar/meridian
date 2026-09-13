#!/usr/bin/env bun
// Real HTTP → Agent SDK → Claude Max gate. The SDK observer delegates every query.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, symlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spyOn } from 'bun:test'
const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-cwd-e2e-')))
const proxyCwd = join(root, 'proxy')
mkdirSync(proxyCwd)
for (const key of Object.keys(process.env)) if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: proxyCwd, MERIDIAN_PASSTHROUGH: '1', MERIDIAN_TELEMETRY_PERSIST: '0' })
mkdirSync(join(root,'config'),{recursive:true})
writeFileSync(join(root,'config','sdk-features.json'), JSON.stringify({opencode:{clientSystemPrompt:false},pi:{clientSystemPrompt:false}}))
const require = createRequire(join(repo, 'package.json'))
const sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href)
const actualQuery = sdk.query
const queries = []
const observer = spyOn(sdk, 'query').mockImplementation(input => {
  queries.push({ cwd: input.options.cwd, system: input.options.systemPrompt })
  return actualQuery(input)
})
const { startProxyServer } = await import(pathToFileURL(join(repo, 'dist/server.js')).href)
const proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true })
const url = `http://127.0.0.1:${proxy.server.address().port}/v1/messages`
const results = []
const escapePath = value => value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
async function send(body, headers) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type':'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) })
  const raw = await response.text()
  assert.equal(response.status, 200, raw)
  if (!body.stream) return JSON.parse(raw)
  const blocks = []
  let stop_reason
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    const event = JSON.parse(line.slice(5))
    assert(!event.error, line)
    if (event.type === 'content_block_start') blocks[event.index] = { ...event.content_block, json: '' }
    if (event.type === 'content_block_delta') {
      const block = blocks[event.index]
      if (event.delta.type === 'text_delta') block.text += event.delta.text
      if (event.delta.type === 'thinking_delta') block.thinking += event.delta.thinking
      if (event.delta.type === 'signature_delta') block.signature += event.delta.signature
      if (event.delta.type === 'input_json_delta') block.json += event.delta.partial_json
    }
    if (event.type === 'message_delta') stop_reason = event.delta.stop_reason
  }
  return { stop_reason, content: blocks.filter(Boolean).map(({json,...block}) => block.type === 'tool_use' ? { ...block,input:json ? JSON.parse(json) : block.input } : block) }
}
const onlyPi = process.argv.includes('--pi-only')
const onlyParent = process.argv.includes('--parent-only')
try {
  for (const stream of [false,true]) for (const kind of onlyParent ? ['pi-parent'] : onlyPi ? ['pi'] : ['opencode','pi','pi-parent','sdk']) {
    const isPi = kind.startsWith('pi')
    const clientCwd = kind === 'pi-parent' ? `${proxyCwd}/link/..` : kind === 'pi' ? `${proxyCwd}\\` : 'C:\\client\\project'
    if (kind === 'pi') mkdirSync(clientCwd,{recursive:true})
    if (kind === 'pi-parent' && !stream) {
      mkdirSync(join(root,'other','child'),{recursive:true})
      symlinkSync(join(root,'other','child'),join(proxyCwd,'link'),'dir')
      assert.notEqual(statSync(clientCwd).ino,statSync(proxyCwd).ino)
    }
    const receipt = `CWD_${crypto.randomUUID()}`
    const file = isPi ? `${clientCwd}/receipt.txt` : `${clientCwd}\\receipt.txt`
    writeFileSync(join(proxyCwd,'receipt.txt'),kind === 'sdk' ? receipt : 'WRONG_PROXY_FILE')
    if (isPi) {
      writeFileSync(file,receipt)
      assert.equal(readFileSync(join(proxyCwd,'receipt.txt'),'utf8'),'WRONG_PROXY_FILE')
    }
    const headers = { 'x-meridian-agent': isPi ? 'pi' : 'opencode', 'x-opencode-session': crypto.randomUUID(), 'x-session-affinity': crypto.randomUUID() }
    process.env.MERIDIAN_PASSTHROUGH = kind === 'sdk' ? '0' : '1'
    const system = isPi ? `Current working directory: ${clientCwd}` : `<env>\nWorking directory: ${clientCwd}\n</env>`
    const clientPromptMarker = 'CLIENT_INSTRUCTIONS_SUPPRESSED_BY_FIXTURE'
    const messages = [{role:'user',content: kind === 'sdk'
      ? 'Use the proxy-managed read tool to read receipt.txt in the SDK execution directory. Then give the exact receipt and report separately the client directory and SDK directory. Do not use other tools.'
      : 'Use read to read receipt.txt from the client working directory. Then give the exact receipt. Do not use other tools or guess the file content. Preserve every character of the reported directory: in a POSIX path, a backslash is a literal filename character, not a separator.'}]
    if (isPi) messages[0].content += ' Form the file path by appending the literal suffix /receipt.txt to the exact client directory string; do not remove its final character.'
    const body = {model:'haiku',max_tokens:1000,stream,system:system+'\n'+clientPromptMarker,messages,...(kind === 'sdk' ? {} : {tools:[{name:'read',description:'Read a client file by absolute path',input_schema:{type:'object',properties:{path:{type:'string'}},required:['path']}}]})}
    const start = queries.length
    let response = await send(body,headers)
    console.log(JSON.stringify({kind,stream,phase:'initial',response:{...response,content:response.content.filter(block => block.type !== 'thinking')}}))
    if (kind !== 'sdk') {
      const calls = response.content.filter(block => block.type === 'tool_use')
      assert.equal(calls.length,1)
      assert.equal(calls[0].name,'read')
      assert.equal(calls[0].input.path,file)
      const content = isPi ? readFileSync(file,'utf8') : receipt
      response = await send({...body,messages:[...messages,{role:'assistant',content:response.content},{role:'user',content:[{type:'tool_result',tool_use_id:calls[0].id,content}]}]},headers)
    }
    const answer = response.content.filter(block => block.type === 'text').map(block => block.text).join('')
    assert(answer.includes(receipt),answer)
    for (const query of queries.slice(start)) {
      assert.equal(query.cwd,proxyCwd)
      const append = typeof query.system === 'string' ? query.system : query.system.append
      assert(!append.includes(clientPromptMarker),'Client prompt suppression was not active')
      assert(append.includes(`Working directory: ${escapePath(clientCwd)}\n</env>`),'Actual SDK query lost independent client CWD')
      assert(append.includes(kind === 'sdk' ? 'SDK tools run in the proxy execution environment' : 'Client-managed tools run in the client environment'))
    }
    results.push({kind,stream,clientCwd,proxyCwd,receipt,answer})
    console.log(JSON.stringify({passed:results.at(-1)}))
  }
  console.log(JSON.stringify({result:'PASS',root,results,queries:queries.length}))
} finally { await proxy.close(); observer.mockRestore() }
