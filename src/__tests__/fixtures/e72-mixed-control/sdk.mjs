// Marked synthetic SDK. No native dependency, auth or model access.
import { readFileSync } from 'node:fs'
const mode = JSON.parse(readFileSync(new URL('../../../mode.json', import.meta.url), 'utf8'))
let sequence = 0
export function query({ prompt, options }) {
  const input = JSON.parse(prompt), session = options.resume ?? 'owned-' + String(++sequence).padStart(8, '0')
  const id = 'generation-' + sequence + '-' + input.request, content = input.tools.length ? input.tools : [{ type: 'text', text: input.text }]
  return {
    close() {},
    async interrupt() {},
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: session, mcp_servers: Object.keys(options.mcpServers).map(name => ({ name, status: 'connected' })), tools: options.allowedTools }
      yield { type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id, model: options.model } } }
      if (mode.ownedCheckpoint) {
        for (const [index, block] of content.entries()) {
          yield { type: 'stream_event', session_id: session, event: { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, name: 'mcp__oc__' + block.name } : block } }
          yield { type: 'stream_event', session_id: session, event: { type: 'content_block_stop', index } }
        }
        yield { type: 'assistant', session_id: session, uuid: 'owned-uuid-' + id, message: { id, model: options.model, content: content.map(block => block.type === 'tool_use' ? { ...block, name: 'mcp__oc__' + block.name } : block), usage: { input_tokens: 20, output_tokens: 10 } } }
        yield { type: 'stream_event', session_id: session, event: { type: 'message_delta', delta: { stop_reason: input.tools.length ? 'tool_use' : 'end_turn' } } }
        yield { type: 'stream_event', session_id: session, event: { type: 'message_stop' } }
        for (const tool of input.tools) {
          const event = { hook_event_name: 'PreToolUse', session_id: session, tool_use_id: tool.id, tool_name: 'mcp__oc__' + tool.name, tool_input: tool.input }
          for (const matcher of options.hooks.PreToolUse) for (const hook of matcher.hooks) await hook(event, tool.id, {})
          yield { type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: tool.id, is_error: true }] } }
        }
        yield { type: 'result', subtype: input.tools.length ? 'error_max_turns' : 'success', is_error: input.tools.length > 0, num_turns: input.tools.length ? 2 : 1, ...(input.tools.length ? { terminal_reason: 'aborted_tools', errors: ['owned synthetic stop'] } : {}), total_cost_usd: 0.001, session_id: session }
        if (input.tools.length) throw new Error(mode.ownedWrongIteratorError ? 'unrelated synthetic error' : 'Claude Code returned an error result: owned synthetic stop')
        return
      }
      for (const tool of input.tools) {
        const event = { tool_use_id: tool.id, tool_name: 'mcp__oc__' + tool.name, tool_input: tool.input }
        for (const matcher of options.hooks.PreToolUse) for (const hook of matcher.hooks) await hook(event, tool.id, {})
      }
      yield { type: 'assistant', session_id: session, message: { id, model: options.model, content: content.map(block => block.type === 'tool_use' ? { ...block, name: 'mcp__oc__' + block.name } : block), usage: { input_tokens: 20, output_tokens: 10 } } }
      yield { type: 'stream_event', session_id: session, event: { type: 'message_delta', delta: { stop_reason: input.tools.length ? 'tool_use' : 'end_turn' } } }
      yield { type: 'stream_event', session_id: session, event: { type: 'message_stop' } }
      yield { type: 'result', subtype: input.tools.length ? 'error_max_turns' : 'success', is_error: input.tools.length > 0, num_turns: input.tools.length ? 2 : 1, ...(input.tools.length ? { terminal_reason: 'max_turns' } : {}), total_cost_usd: 0.001, session_id: session }
    },
  }
}
