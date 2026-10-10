import { createServer } from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { query } from '@anthropic-ai/claude-agent-sdk'
const mode = JSON.parse(readFileSync(new URL('./mode.json', import.meta.url), 'utf8'))
const logger = new AsyncLocalStorage(), counters = new Map(), sessions = new Map()
let requests = 0
export async function startProxyServer(config) {
  const server = createServer(async (request, response) => {
    const run = async () => {
      const bytes = []; for await (const chunk of request) bytes.push(chunk)
      const body = JSON.parse(Buffer.concat(bytes).toString()), actor = request.headers['x-claude-code-agent-id'] ?? 'main'
      const classifier = request.headers['x-claude-code-request-class'] === 'auxiliary'
      const count = classifier ? 0 : (counters.get(actor) ?? 0) + 1
      if (!classifier) counters.set(actor, count)
      const tool = (id, name, input) => ({ type: 'tool_use', id, name, input })
      let tools = [], text
      if (classifier) text = 'allow'
      else if (actor === 'main' && count === 1) tools = ['alpha', 'beta'].map(label => tool('launch-' + label, 'Agent', { subagent_type: 'general-purpose', run_in_background: false, prompt: label + '-1 ' + label + '-2' }))
      else if (actor !== 'main' && count <= 2) tools = [tool(actor + '-' + count, 'Bash', { command: body.commands[count - 1] })]
      else if (actor !== 'main' && count === 3 && (mode.handbackScenario || mode.legacyHandback) && !mode.missingHandback) {
        const message = mode.wrongHandbackMessage && actor === 'alpha' ? 'beta-1\nbeta-2' : actor + '-1\n' + actor + '-2'
        tools = [tool(actor + '-handback', mode.unknownClosingTool ? 'OtherFinish' : 'SubagentHandback', { message, ...(mode.handbackRecipient ? { recipient: 'synthetic-other-parent' } : {}) })]
        if (mode.duplicateHandback) tools.push(tool(actor + '-duplicate-handback', 'SubagentHandback', { message }))
      }
      else if (actor !== 'main' && count === 3 && (mode.unexpectedClientTool || mode.changedClientToolName || mode.changedClientToolInput)) tools = [tool(actor + '-unexpected', 'SendMessage', { recipient: 'synthetic-parent', content: actor + '-1 ' + actor + '-2' })]
      else if (actor === 'main' && count === 3) tools = [tool('parent-write', 'Bash', { command: body.commands[0] })]
      else text = actor === 'main' ? count === 2 ? 'DONE' : 'AGAIN' : actor + '-1 ' + actor + '-2'
      if (mode.sharedParentReport && actor === 'main' && count === 1) { tools[0].input.prompt = 'alpha-1 alpha-2 beta-1 beta-2'; tools[1].input.prompt = 'synthetic unrelated task' }
      if (mode.changedCommand && tools[0]?.name === 'Bash') tools[0].input.command += ' && echo changed-command'
      const resume = classifier ? mode.borrowedClassifierSession ? sessions.get('main') : undefined : sessions.get(actor)
      let native
      const options = { model: mode.wrongClassifierModel && classifier ? 'claude-sonnet-4-6' : body.model, ...(resume ? { resume } : {}), maxTurns: 1,
        env: { CLAUDE_CONFIG_DIR: config.profiles[0].claudeConfigDir }, pathToClaudeCodeExecutable: process.env.MERIDIAN_CLAUDE_PATH,
        mcpServers: classifier ? {} : { oc: { type: 'sdk', name: 'oc' } }, allowedTools: classifier ? [] : body.tools.map(tool => 'mcp__oc__' + tool.name),
        hooks: { PreToolUse: [{ hooks: [async event => {
          if (mode.ownedCheckpoint && event.tool_use_id === tools.at(-1)?.id) await native.interrupt()
          return { decision: 'block', reason: '__DENIAL__' }
        }] }] } }
      const input = { prompt: JSON.stringify({ tools, text, request: ++requests }), options }
      native = query(input)
      if (mode.duplicateBeforeConsume) query(input)
      let session
      try { for await (const event of native) if (event.type === 'result') session = event.session_id }
      catch (error) { if (!mode.ownedCheckpoint) throw error }
      finally { if (mode.ownedCheckpoint) native.close() }
      if (mode.duplicateQuery) query(input)
      if (!classifier) sessions.set(actor, session)
      console.log('[PROXY] ' + request.headers['x-request-id'] + ' adapter=claude-code msgCount=2 tools=' + tools.length + ' lineage=' + (resume ? 'continuation' : 'new') + ' diverged=' + (classifier && !mode.classifierNotIsolated ? 'independent-request:auxiliary-request' : 'none') + ' session=' + (resume ? resume.slice(0, 8) : 'new') + ' sessionWait=' + (classifier && mode.classifierWait ? 20 : 0) + 'ms')
      if (actor !== 'main' && count === 1) await new Promise(resolve => setTimeout(resolve, 100))
      response.writeHead(200, { 'content-type': 'application/json' })
      if (mode.changedClientToolName && tools[0]?.name === 'SendMessage') tools[0].name = 'TaskStop'
      if (mode.changedClientToolInput && tools[0]?.name === 'SendMessage') tools[0].input = { recipient: 'synthetic-parent', content: 'synthetic-changed-http-input' }
      response.end(JSON.stringify({ type: 'message', role: 'assistant', content: tools.length ? tools : [{ type: 'text', text }], stop_reason: tools.length ? 'tool_use' : 'end_turn' }))
    }
    try {
      if (mode.noLoggerContext) await run()
      else await logger.run({ endpoint: '/v1/messages', requestId: request.headers['x-request-id'] }, run)
    } catch { response.writeHead(500); response.end('{}') }
  })
  server.listen(config.port, config.host)
  return { server, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
