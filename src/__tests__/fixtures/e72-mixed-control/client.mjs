#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
if (process.argv.includes('--version')) { console.log('2.1.287 (Claude Code)'); process.exit(0) }
const mode = JSON.parse(readFileSync(new URL('./mode.json', import.meta.url), 'utf8'))
const value = flag => process.argv[process.argv.indexOf(flag) + 1]
assert(value('--permission-mode') === 'auto' && value('--allowedTools') === 'Agent')
const session = value(process.argv.includes('--resume') ? '--resume' : '--session-id'), model = value('--model')
const file = process.env.CLAUDE_CONFIG_DIR + '/turn.json', turn = existsSync(file) ? 2 : 1
writeFileSync(file, String(turn))
const delimiter = String.fromCharCode(96), commands = [...value('-p').matchAll(new RegExp(delimiter + '([^' + delimiter + ']+)' + delimiter, 'g'))].map(match => match[1]), history = new Map()
const result = (id, content) => ({ type: 'tool_result', tool_use_id: id, content })
async function send(actor, results = [], classifier = false, callerReports = []) {
  const messages = [...(history.get(actor) ?? []), ...callerReports.map(content => ({ role: 'user', content })), { role: 'user', content: results.length ? results : 'continue' }]
  const body = { model: classifier ? 'claude-sonnet-5' : model, metadata: { user_id: JSON.stringify({ session_id: session }) },
    messages, stream: false, tools: classifier ? [] : [{ name: 'Agent' }, { name: 'Bash' }, ...((mode.handbackScenario || mode.legacyHandback) && actor !== 'main' && !mode.undeclaredHandback ? [{ name: 'SubagentHandback', input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] : [])],
    commands: turn === 2 ? commands : actor === 'alpha' ? commands.slice(0, 2) : commands.slice(2, 4) }
  if (classifier) {
    body.system = mode.forgedClassifier ? 'ordinary request' : 'You are a security monitor for autonomous AI coding agents.\n<cc_automode_permissions>\n</cc_automode_permissions>'
    body.stop_sequences = ['</block>']
  }
  const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(actor !== 'main' ? { 'x-claude-code-agent-id': actor } : {}), ...(classifier ? { 'x-claude-code-request-class': 'auxiliary' } : {}) }, body: JSON.stringify(body) })
  assert(response.ok)
  const answer = await response.json()
  if (!classifier) history.set(actor, [...messages, { role: 'assistant', content: answer.content }])
  return answer
}
function writeStamp(command) {
  const path = /date > '([^']+)'/.exec(command)?.[1]
  assert(path?.includes('/outside-project/') && path.startsWith('/'))
  if (!mode.missingWrite) writeFileSync(path, 'synthetic timestamp\n', { flag: 'wx', mode: 0o600 })
}
if (turn === 1) {
  await send('main')
  const child = async label => {
    const first = send(label)
    if (!mode.noClassifiers) await send('main', [], true)
    const answer = await first; writeStamp(answer.content[0].input.command)
    const second = await send(label, [result(label + '-1', label + '-1')]); writeStamp(second.content[0].input.command)
    await send(label, [result(label + '-2', label + '-2')])
    if (mode.handbackNotFinal) await send(label)
  }
  await Promise.all(['alpha', 'beta'].map(child))
  await send('main', ['alpha', 'beta'].map(label => {
    const report = label + '-1\n' + label + '-2'
    const content = mode.structuredParentHandback ? JSON.stringify({ agentId: label, handback: 'send', handbackReport: { text: report, warning: 'synthetic-private warning' }, content: [{ type: 'text', text: 'synthetic-private caller notification' }] })
      : mode.separateCallerHandback ? label + '-1 ' + label + '-2'
      : mode.sharedParentReport ? label === 'alpha' ? 'alpha-1\nalpha-2\nbeta-1\nbeta-2' : 'synthetic unrelated result'
      : mode.nativeFramedReport ? readFileSync(new URL('./native-frame.txt', import.meta.url), 'utf8').replaceAll('fixture-child', mode.wrongFramedActor ? 'wrong-child' : label).replaceAll('alpha-', label + '-').replace(mode.wrongFramedReport ? label + '-2' : 'not-in-frame', 'wrong-report')
      : mode.handbackScenario && !mode.handbackNotDelivered ? report : label + '-1 ' + label + '-2'
    return result('launch-' + label, content)
  }), false, mode.separateCallerHandback ? ['alpha-1\nalpha-2', 'beta-1\nbeta-2'] : [])
} else {
  const answer = await send('main')
  if (!mode.noClassifiers) await send('main', [], true)
  writeStamp(answer.content[0].input.command)
  await send('main', [result('parent-write', 'parent-2')])
}
console.log(turn === 1 ? 'DONE' : 'AGAIN')
