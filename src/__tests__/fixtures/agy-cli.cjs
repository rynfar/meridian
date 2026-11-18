#!/usr/bin/env node
// Deterministic official-CLI protocol fixture. Never contacts a model service.
const { spawnSync } = require('node:child_process')
const { readFileSync, existsSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
let nativeStreamStep, nativeStreamCid, deferredNativeText
const emit = value => {
  if (nativeStreamStep !== undefined && value.event === 'step_update') value = { ...value, step_update: { conversation_id: nativeStreamCid, step_index: nativeStreamStep, ...value.step_update } }
  process.stdout.write(JSON.stringify(value) + '\n')
}
const nativePrompts = []
const nativeConversationId = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : require('node:crypto').randomUUID()
async function main(inputPrompt) {
  if (args[0] === '--version') return console.log(process.env.AGY_FIXTURE_VERSION || '1.2.7')
  if (args[0] === 'models') return console.log('fixture-model\tFixture Model\nfixture-model-high\tFixture High\ngemini-fixture-low\tGemini Low\ngemini-fixture-medium\tGemini Medium\ngemini-fixture-high\tGemini High')
  let prompt = args[args.indexOf('-p') + 1]
  if (inputPrompt !== undefined) prompt = inputPrompt
  nativePrompts.push(prompt)
  const native = inputPrompt !== undefined && process.env.AGY_FIXTURE_NATIVE_RECORDS ? require('./agy-native-record.cjs') : undefined
  const nativeTurn = native?.input(process.env.HOME, nativeConversationId, prompt)
  if (nativeTurn) {
    nativeStreamStep = nativeTurn.inputIdx; nativeStreamCid = nativeConversationId
    emit({ event: 'init', conversation_id: nativeConversationId })
    const stale = deferredNativeText; deferredNativeText = undefined
    if (stale) emit({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: stale.step, text_delta: stale.text + '\n' } })
    emit({ event: 'step_update', step_update: { step_type: 'user_input', state: 'DONE' } })
    if (stale && !stale.taggedOnly) {
      emit({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: stale.step, planner_response: { response: stale.text } } })
      // Untagged delayed output cannot establish ownership in the next turn.
      process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: stale.text + '\n' } }) + '\n')
    }
  } else { nativeStreamStep = undefined; nativeStreamCid = undefined }
  if (prompt === '/config' && process.env.AGY_FIXTURE_CONFIG_EXIT) return process.exit(2)
  if (prompt === '/config') return emit({ command: { data: { config: { customModelsConfig: process.env.AGY_FIXTURE_CUSTOM ? { fixture: {} } : {}, modelProvider: process.env.AGY_FIXTURE_API ? 'gemini' : '', useG1Credits: false } } } })
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
  if (!nativeTurn) emit({ event: 'init' })
  if (prompt.includes('RATE_LIMIT')) return emit({event:'result',result:{status:'ERROR',error:'Quota exhausted; retry in 45 seconds'}})
  if (prompt.includes('HANG')) { setInterval(() => {}, 1000); return }
  if (prompt.includes('MALFORMED')) { console.log('not JSON'); return }
  if (prompt.includes('DENIED')) return emit({ event: 'result', result: { status: 'SUCCESS', denied_actions: [{ action: 'mcp' }] } })
  if (prompt.includes('FOREIGN_CID_RESULT')) return emit({ event: 'result', result: { status: 'SUCCESS', conversation_id: require('node:crypto').randomUUID() } })
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
    const priorToolStep = nativeTurn ? native.answer(nativeTurn, 'Prior tool narration', { tool: true }) : undefined
    if (priorToolStep !== undefined) nativeStreamStep = priorToolStep
    if (prompt.includes('STRUCTURED_PROSE')) emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'I will look this up before answering.' } })
    emit({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 100, output_tokens: 5 } } })
    const calls = Array.from({ length: prompt.includes('PARALLEL2') ? 2 : 1 }, (_, n) => rpc('tools/call', { name: tools[0].name, arguments: { key: `probe${n}` } }))
    if (prompt.includes('RPC_RETRY')) calls.push(rpc('tools/call', {name:tools[0].name,arguments:{key:'probe0'}},2))
    if (priorToolStep !== undefined && prompt.includes('DEFER_TOOL_TEXT')) {
      void (async () => {
        const gate = process.env.AGY_FIXTURE_TOOL_GATE
        if (!gate) throw new Error('Missing deferred-tool fixture gate')
        while (!existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 1))
        emit({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: priorToolStep, text_delta: 'QUEUED_PRE_TOOL' } })
        writeFileSync(gate + '.emitted', '')
      })()
    }
    const results = await Promise.all(calls)
    if (priorToolStep !== undefined && prompt.includes('DEFER_TOOL_TEXT')) emit({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: priorToolStep, text_delta: 'STALE_PRE_TOOL' } })
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
  const exact = [...prompt.matchAll(/TURN_ANSWER_([A-Z0-9_]+)/g)].at(-1)
  if (exact) answer = exact[1]
  const schemaTransport = args.includes('--json-schema')
  if (nativeTurn && !prompt.includes('NATIVE_EMPTY_AFTER_TOOL')) nativeStreamStep = native.answer(nativeTurn, prompt.includes('NATIVE_RECORD_EMPTY') ? '' : prompt.includes('BAD_NATIVE_JSON') ? 'PRIVATE_INVALID_JSON' : prompt.includes('WRONG_NATIVE_SCHEMA') ? '{"answer":123}' : schemaTransport ? JSON.stringify({ answer }) : answer, { thinking: 'PRIVATE_REASONING_NEVER_RETURN', ...(prompt.includes('NATIVE_RECORD_WRONG_EXEC') ? { execution: require('node:crypto').randomUUID() } : {}) })
  const hidden = /NATIVE_RECORD_ONLY|NATIVE_RECORD_EMPTY|NATIVE_RECORD_WRONG_EXEC|NATIVE_EMPTY_AFTER_TOOL|FINAL_RESPONSE_SNAPSHOT|FINAL_RESULT_SNAPSHOT|FINAL_LATE_RESPONSE|FINAL_UNRECOGNIZED/.test(prompt)
  if (prompt.includes('FINAL_MULTISTEP_SNAPSHOT')) {
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'First planner step. ' } })
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', planner_response: { response: 'First planner step. ' } } })
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: answer } })
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', planner_response: { response: answer } } })
  }
  else if (prompt.includes('FINAL_RESPONSE_SNAPSHOT')) emit({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', planner_response: { response: answer, modified_response: answer } } })
  else if (prompt.includes('FINAL_UNRECOGNIZED')) emit({ event: 'step_update', step_update: { step_type: 'assistant_output', final_content: { public_text: answer } } })
  else if (!hidden) {
    const frame = { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: answer + (prompt.includes('CURRENT_NEWLINE') ? '\n' : '') } }
    if (prompt.includes('UNSCOPED_CURRENT_TEXT')) process.stdout.write(JSON.stringify(frame) + '\n')
    else emit(frame)
  }
  emit({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 120, output_tokens: 10, cache_read_tokens: 20 } } })
  const schemaPath = args.includes('--json-schema') && args[args.indexOf('--json-schema') + 1]
  if (schemaPath) JSON.parse(readFileSync(schemaPath, 'utf8'))
  emit({ event: 'result', result: { status: 'SUCCESS', ...(prompt.includes('FINAL_RESULT_SNAPSHOT') ? { planner_response: { response: answer } } : {}), ...(prompt.includes('STALE_RESULT_SNAPSHOT') ? { response: 'FIRST_ONLY\n' + answer + '\n' } : {}), ...(schemaPath && !prompt.includes('MISSING_STRUCTURED') ? { structured_output: prompt.includes('BAD_STRUCTURED') ? { output: { answer } } : { answer } } : {}) } })
  if (prompt.includes('FINAL_LATE_RESPONSE')) { await new Promise(resolve => setTimeout(resolve, 5)); emit({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', planner_response: { response: answer } } }) }
  if (nativeTurn && prompt.includes('NATIVE_DEFERRED_CURSOR')) deferredNativeText = { step: nativeStreamStep, text: answer, taggedOnly: prompt.includes('NATIVE_DEFERRED_TAGGED_ONLY') }
  if (prompt.includes('BAD_EXIT')) process.exitCode = 1
  if (prompt.includes('LINGER')) setInterval(() => {}, 1000)
}
async function run() {
  if (!args.includes('--input-format')) return main()
  const lines = require('node:readline').createInterface({ input: process.stdin })
  for await (const line of lines) await main(JSON.parse(line).message.content)
}
run().catch(error => { console.error(error); process.exitCode = 1 })
