#!/usr/bin/env node
// Deterministic official-CLI protocol fixture. Never contacts a model service.
const { spawnSync } = require('node:child_process')
const { readFileSync, appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
let contextFrameIndex
const emit = value => {
  if (contextFrameIndex !== undefined && value.step_update) {
    value = { ...value, step_update: { step_index: contextFrameIndex + 1, ...value.step_update } }
  }
  process.stdout.write(JSON.stringify(value) + '\n')
}
const nativePrompts = []
async function main(inputPrompt) {
  if (args[0] === '--version') return console.log(process.env.AGY_FIXTURE_VERSION || '1.5.13')
  if (args[0] === 'models') return console.log('fixture-model\tFixture Model\nfixture-model-high\tFixture High\ngemini-fixture-low\tGemini Low\ngemini-fixture-medium\tGemini Medium\ngemini-fixture-high\tGemini High')
  let prompt = args[args.indexOf('-p') + 1]
  if (inputPrompt !== undefined) prompt = inputPrompt
  nativePrompts.push(prompt)
  if (inputPrompt !== undefined && process.env.AGY_FIXTURE_CONTEXT_LOG) {
    contextFrameIndex = (nativePrompts.length - 1) * 2
    if (process.env.AGY_FIXTURE_CONTEXT_PRIMING !== 'no-marker') {
      emit({ event: 'step_update', step_update: { step_type: 'user_input', step_index: contextFrameIndex } })
    }
    appendFileSync(process.env.AGY_FIXTURE_CONTEXT_LOG, JSON.stringify({ pid: process.pid, prompt }) + '\n')
    if (prompt.startsWith('History loading step.')) {
      const result = spawnSync(process.execPath, ['policy.cjs'], {
        input: JSON.stringify({ toolCall: { name: 'call_mcp_tool', args: { ServerName: 'meridian_client', ToolName: 'lookup' } } }),
        encoding: 'utf8',
      })
      if (JSON.parse(result.stdout).decision !== 'deny') throw new Error('History loading allowed a client tool')
      const mode = process.env.AGY_FIXTURE_CONTEXT_PRIMING
      if (mode === 'tool-frame') {
        emit({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'lookup' } })
      }
      if (mode === 'rpc') {
        const config = JSON.parse(readFileSync('.agents/mcp_config.json', 'utf8'))
        const response = await fetch(config.mcpServers.meridian_client.serverUrl, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 770, method: 'tools/call', params: { name: 'lookup', arguments: { key: 'priming' } } }),
        })
        const reply = await response.json()
        if (!reply.error?.message.includes('disabled during Antigravity history loading')) {
          throw new Error('Priming MCP dispatch was not denied')
        }
      }
      if (mode !== 'silent') emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'PRIMING_ACK' } })
      emit({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', usage: { input_tokens: 100, output_tokens: 1 } } })
      return emit({ event: 'result', result: { status: 'SUCCESS' } })
    }
    if (prompt.startsWith('The earlier input steps')) {
      emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'STALE_ACK', step_index: contextFrameIndex - 1 } })
      const policy = spawnSync(process.execPath, ['policy.cjs'], {
        input: JSON.stringify({ toolCall: { name: 'call_mcp_tool', args: { ServerName: 'meridian_client', ToolName: 'lookup' } } }),
        encoding: 'utf8',
      })
      if (JSON.parse(policy.stdout).decision !== 'allow') throw new Error('Final input did not restore client tool policy')
    }
  }
  if (prompt === '/config' && process.env.AGY_FIXTURE_CONFIG_EXIT) return process.exit(2)
  if (prompt === '/config') return emit({ conversation_id: '', status: 'SUCCESS', duration_seconds: 0, num_turns: 0, response: 'customModelsConfig\t' + (process.env.AGY_FIXTURE_CUSTOM ? '{"fixture":{}}' : '') + '\nmodelProvider\t' + (process.env.AGY_FIXTURE_API ? 'gemini' : '') + '\nuseG1Credits\tfalse' })
  if (prompt === '/usage') return emit({command:{data:{groups:[{name:'Gemini Models',buckets:[{id:'gemini-5h',window:'5h',remaining_fraction:0.75,reset_time:'2099-01-01T00:00:00Z'}]}]}}})
  if (prompt.includes('POLICY_PROBE')) {
    const check = (input, decision) => {
      const child = spawnSync(process.execPath, ['policy.cjs'], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' })
      if (child.status !== 0 || JSON.parse(child.stdout).decision !== decision) throw new Error('Policy mismatch: ' + child.stdout)
    }
    check({toolCall:{name:'view_file',args:{AbsolutePath:'/etc/passwd'}}}, 'deny')
    check({toolCall:{name:'run_command',args:{CommandLine:'id'}}}, 'deny')
    check({toolCall:{name:'call_mcp_tool',args:{ServerName:'other',ToolName:'lookup'}}}, 'deny')
    check({toolCall:{name:'call_mcp_tool',args:{ServerName:'meridian_client',ToolName:'unknown'}}}, 'deny')
    check('invalid JSON', 'deny')
    check({toolCall:{name:'call_mcp_tool',args:{ServerName:'meridian_client',ToolName:'lookup'}}}, 'allow')
  }
  if (prompt.includes('IMAGE_PROBE')) {
    const paths = JSON.parse(readFileSync('attachment-paths.json', 'utf8'))
    if (paths.length !== 1 || !prompt.includes(paths[0]) || prompt.includes('iVBORw0KGgo')) throw new Error('Image reference missing or bytes leaked')
    for (const [path, decision] of [[paths[0], 'allow'], ['/etc/passwd', 'deny'], [paths[0] + '/../policy.cjs', 'deny']]) {
      const result = spawnSync(process.execPath, ['policy.cjs'], { input: JSON.stringify({ toolCall: { name: 'view_file', args: { AbsolutePath: path } } }), encoding: 'utf8' })
      if (JSON.parse(result.stdout).decision !== decision) throw new Error('Image policy mismatch')
    }
  }
  if (prompt.includes('EFFORT_PROBE') && args[args.indexOf('--effort') + 1] !== 'high') throw new Error('Native effort flag missing')
  emit({ event: 'init' })
  if (prompt.includes('RATE_LIMIT')) return emit({event:'result',result:{status:'ERROR',error:'Quota exhausted; retry in 45 seconds'}})
  if (prompt.includes('HANG')) { setInterval(() => {}, 1000); return }
  if (prompt.includes('MALFORMED')) { console.log('not JSON'); return }
  if (prompt.includes('DENIED')) return emit({ event: 'result', result: { status: 'SUCCESS', denied_actions: [{ action: 'mcp' }] } })
  const config = JSON.parse(readFileSync('.agents/mcp_config.json', 'utf8'))
  const url = config.mcpServers.meridian_client.serverUrl
  let nextId = 0
  const rpc = async (method, params, retryId) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: retryId ?? ++nextId, method, params }) })
    const value = await response.json()
    if (value.error) throw new Error(value.error.message)
    return value.result
  }
  const { tools } = await rpc('tools/list')
  if (prompt.includes('MODEL_DELAY')) await new Promise(resolve => setTimeout(resolve, 3100))
  if (prompt.includes('CLIENT_LEDGER_BOUNDARY')) {
    for (let at = 0; at < 2; at++) {
      try {
        await rpc('tools/call', { name: tools[0].name, arguments: { key: at } })
        throw new Error('Invalid tool unexpectedly succeeded')
      } catch (error) {
        if (!String(error.message).includes('Invalid arguments for lookup')) throw error
      }
    }
    const batch = tools.find(tool => tool.name === 'meridian_parallel')
    try {
      await rpc('tools/call', { name: batch.name, arguments: { calls: [{ name: 'lookup', arguments: { key: 'a' } }, { name: 'lookup', arguments: { key: 'b' } }] } })
      throw new Error('Full replay ledger admitted another batch')
    } catch (error) {
      if (!String(error.message).includes('exceeded 2 tool calls')) throw error
    }
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'LEDGER_BOUNDARY_PRESERVED' } })
    return emit({ event: 'result', result: { status: 'SUCCESS' } })
  }
  const longLoop = prompt.match(/CLIENT_TOOL_LOOP_(\d+)/)
  if (longLoop) {
    try {
      for (let at = 0; at < Number(longLoop[1]); at++) {
        const params = { name: tools[0].name, arguments: { key: String(at) } }
        const first = await rpc('tools/call', params)
        const repeated = await rpc('tools/call', params, nextId)
        if (JSON.stringify(first) !== JSON.stringify(repeated)) throw new Error('Duplicate MCP result changed')
      }
    } catch (error) { console.error(error.message); return process.exit(1) }
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'LONG_LOOP_COMPLETE' } })
    return emit({ event: 'result', result: { status: 'SUCCESS' } })
  }
  const longBatchLoop = prompt.match(/CLIENT_BATCH_LOOP_(\d+)/)
  if (longBatchLoop) {
    const batch = tools.find(tool => tool.name === 'meridian_parallel')
    try {
      for (let at = 0; at < Number(longBatchLoop[1]); at += 16) {
        const params = { name: batch.name, arguments: { calls: Array.from({ length: Math.min(16, Number(longBatchLoop[1]) - at) }, (_, index) => ({ name: 'lookup', arguments: { key: String(at + index) } })) } }
        const first = await rpc('tools/call', params)
        const repeated = await rpc('tools/call', params, nextId)
        if (JSON.stringify(first) !== JSON.stringify(repeated)) throw new Error('Duplicate batch result changed')
      }
    } catch (error) { console.error(error.message); return process.exit(1) }
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'LONG_LOOP_COMPLETE' } })
    return emit({ event: 'result', result: { status: 'SUCCESS' } })
  }
  if (prompt.includes('UNICODE_CHUNKS')) {
    const { request } = require('node:http')
    const input = { key: 'café/你好/🧪.txt' }
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params: { name: tools[0].name, arguments: input } }))
    const split = body.indexOf(Buffer.from('🧪')) + 2
    const result = await new Promise((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
        let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve(JSON.parse(text)))
      })
      req.on('error', reject)
      req.write(body.subarray(0, split))
      setTimeout(() => req.end(body.subarray(split)), 50)
    })
    if (result.error) throw new Error(result.error.message)
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'UNICODE_OK' } })
    return emit({ event: 'result', result: { status: 'SUCCESS' } })
  }
  if (prompt.includes('INVALID_TOOL_ARGS')) {
    let rejected = false
    try { await rpc('tools/call', { name: tools[0].name, arguments: { key: 7 } }) }
    catch (error) { if (!String(error).includes('Invalid arguments')) throw error; rejected = true }
    if (!rejected) throw new Error('Invalid arguments reached the client')
  }
  if (prompt.includes('MCP_BATCH') || prompt.includes('MCP_SESSIONS')) {
    let results
    if (prompt.includes('MCP_BATCH')) {
      const batch = tools.find(tool => tool.name === 'meridian_parallel')
      let invalid = false
      try { await rpc('tools/call', { name: batch.name, arguments: { calls: [{ name: 'lookup', arguments: { key: 'a' } }, { name: 'lookup', arguments: { key: 7 } }] } }) }
      catch (error) { if (!String(error).includes('Invalid arguments')) throw error; invalid = true }
      if (!invalid) throw new Error('Invalid batch reached the client')
      const params = { name: batch.name, arguments: { calls: ['a', 'b'].map(key => ({ name: 'lookup', arguments: { key } })) } }
      results = await Promise.all([rpc('tools/call', params, 100), rpc('tools/call', params, 100)])
    } else {
      async function session() {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) })
        await response.json(); return response.headers.get('mcp-session-id')
      }
      const sessions = await Promise.all([session(), session()])
      if (!sessions[0] || !sessions[1] || sessions[0] === sessions[1]) throw new Error('Missing independent MCP sessions')
      results = await Promise.all(sessions.map(async (session, i) => {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-session-id': session }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lookup', arguments: { key: ['a', 'b'][i] } } }) })
        const value = await response.json(); if (value.error) throw new Error(value.error.message); return value.result
      }))
    }
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: JSON.stringify(results) } })
    return emit({ event: 'result', result: { status: 'SUCCESS' } })
  }
  const history = JSON.parse(prompt.split('Client conversation:\n').at(-1))
  const lastContent = history.at(-1).content
  const replayedResults = Array.isArray(lastContent) ? lastContent.filter(b => b.type === 'tool_result') : []
  let answer = replayedResults.length ? replayedResults.map(b => (b.is_error ? 'FAILED:' : '') + b.content).join('|') : 'READY'
  if (!replayedResults.length && tools.length && !prompt.includes("SKIP_TOOLS")) {
    emit({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 100, output_tokens: 5 } } })
    const calls = Array.from({ length: prompt.includes('PARALLEL2') ? 2 : 1 }, (_, n) => rpc('tools/call', { name: tools[0].name, arguments: { key: `probe${n}` } }))
    if (prompt.includes('RPC_RETRY')) calls.push(rpc('tools/call', {name:tools[0].name,arguments:{key:'probe0'}},2))
    const results = await Promise.all(calls)
    if (prompt.includes('FAIL_CONTINUATION_504')) { setInterval(() => {}, 1000); return }
    if (prompt.includes('FAIL_CONTINUATION')) {
      const error = prompt.includes('_503') ? 'Service unavailable' : prompt.includes('_429') ? 'Quota exhausted; retry in 1 seconds' : prompt.includes('_401') ? 'Authentication required' : 'Fixture process lost after receiving tool results'
      return emit({ event: 'result', result: { status: 'ERROR', error } })
    }
    if (prompt.includes('LARGE_NEXT_TOOL')) await Promise.all([0, 1].map(() => rpc('tools/call', { name: tools[0].name, arguments: { key: 'x'.repeat(700000) } })))

    if (prompt.includes('MODEL_DELAY')) await new Promise(resolve => setTimeout(resolve, 3100))
    if (prompt.includes('NEXT_TOOL')) await rpc('tools/call', { name: tools[0].name, arguments: { key: 'next' } })
    if (prompt.includes('STEERING')) {
      const followup = JSON.parse(results[0].content[0].text).meridian_client_followup
      answer = JSON.stringify(followup)
    } else answer = results.map(result => (result.isError ? 'FAILED:' : '') + ((value) => typeof value === 'string' ? value : value.map(b => b.text).join(''))(JSON.parse(result.content[0].text).meridian_client_result)).join('|')
  }
  if (prompt.includes('NATIVE_SECOND')) {
    if (nativePrompts.length !== 2 || prompt.includes('NATIVE_FIRST')) throw new Error('Native continuation replayed history or spawned another process')
    answer = 'NATIVE_REUSED'
  }
  emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: answer } })
  emit({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 120, output_tokens: 10, cache_read_tokens: 20 } } })
  const schemaPath = args.includes('--json-schema') && args[args.indexOf('--json-schema') + 1]
  if (schemaPath) JSON.parse(readFileSync(schemaPath, 'utf8'))
  emit({ event: 'result', result: { status: 'SUCCESS', ...(schemaPath && !prompt.includes('MISSING_STRUCTURED') ? { structured_output: prompt.includes('BAD_STRUCTURED') ? { output: { answer } } : { answer } } : {}) } })
  if (prompt.includes('BAD_EXIT')) process.exitCode = 1
  if (prompt.includes('LINGER')) setInterval(() => {}, 1000)
}
async function run() {
  if (!args.includes('--input-format')) return main()
  const lines = require('node:readline').createInterface({ input: process.stdin })
  for await (const line of lines) await main(JSON.parse(line).message.content)
}
run().catch(error => { console.error(error); process.exitCode = 1 })
