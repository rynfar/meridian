#!/usr/bin/env node
// Replay shim: on a history replay whose prompt asks for REPEAT_COMPLETED, request the call the tail already
// completed again (as Gemini does after a backend replacement), then answer with what that call returned.
const Module = require('node:module')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const path = join(__dirname, 'agy-cli.cjs')
const anchor = "let answer = replayedResults.length"
const injected = `
  if (prompt.includes('REPEAT_COMPLETED') && replayedResults.length) {
    const done = history.at(-2).content.find(b => b.type === 'tool_use')
    const text = r => (v => typeof v === 'string' ? v : v.map(b => b.text).join(''))(JSON.parse(r.content[0].text).meridian_client_result)
    const seen = [text(await rpc('tools/call', { name: done.name, arguments: done.input }))]
    if (prompt.includes('REPEAT_TWICE')) seen.push(text(await rpc('tools/call', { name: done.name, arguments: done.input })))
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'REPLAYED:' + seen.join('|') } })
    emit({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 120, output_tokens: 10 } } })
    return emit({ event: 'result', result: { status: 'SUCCESS' } })
  }
  `
const source = readFileSync(path, 'utf8').replace(/^#!.*\n/, '')
if (!source.includes(anchor)) throw new Error('agy-cli.cjs changed; update the replay shim anchor')
const mod = new Module(path, null)
mod.filename = path
mod.paths = Module._nodeModulePaths(__dirname)
mod._compile(source.replace(anchor, injected + anchor), path)
