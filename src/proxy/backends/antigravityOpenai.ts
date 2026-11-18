import { estimateAgTokens } from './antigravityTokens'
import { AgOpenaiMedia } from './antigravityOpenaiMedia'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createSseTranslator, translateOpenAiToAnthropic, translateAnthropicToOpenAi, type AnthropicResponse, type AnthropicSseEvent } from '../openai'
import { createResponsesSseTranslator, translateResponsesToAnthropic, translateAnthropicToResponses, buildResponsesToolAliases, responsesToolAlias, resolveCodexThreadIdentity } from '../openaiResponses'
import type { AgResponseJobs, AgResponseEvent } from './antigravityJobs'
import { AntigravityError, parseAgRequest } from './antigravityProtocol'
import { AgResponseStore, agResponseScope } from './antigravityResponses'

const json = z.record(z.string(), z.unknown())
const args = z.string().refine(value => { try { return json.safeParse(JSON.parse(value)).success } catch { return false } }, 'Tool arguments must be a JSON object')
const functionTool = z.object({ name: z.string(), description: z.string().optional(), parameters: json.default({ type: 'object', properties: {} }), strict: z.boolean().optional() }).strict()
const audioPart = z.object({ type: z.literal('input_audio'), input_audio: z.object({ data: z.string(), format: z.enum(['wav', 'mp3']) }).strict() }).strict()
const filePart = z.object({ type: z.literal('input_file'), file_data: z.string(), filename: z.string().optional() }).strict()
const part = z.discriminatedUnion('type', [
  audioPart,
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string().refine(value => value.startsWith('data:image/') || value.startsWith('https://'), 'Image must be a data URL or public HTTPS URL'), detail: z.enum(['auto', 'low', 'high']).optional() }) }).strict(),
])
const choice = z.union([z.enum(['auto', 'none', 'required']), z.object({ type: z.literal('function'), function: z.object({ name: z.string() }).strict() }).strict()])
const format = z.discriminatedUnion('type', [z.object({ type: z.literal('text') }).strict(), z.object({ type: z.literal('json_schema'), json_schema: z.object({ name: z.string(), schema: json, strict: z.boolean().optional(), description: z.string().optional() }).strict() }).strict()])
const chatSchema = z.object({
  model: z.string(), messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.union([z.string(), z.array(part)]).nullable().optional(), tool_call_id: z.string().optional(), tool_calls: z.array(z.object({ id: z.string(), type: z.literal('function'), function: z.object({ name: z.string(), arguments: args }).strict() }).strict()).optional() }).strict()).min(1),
  tools: z.array(z.object({ type: z.literal('function'), function: functionTool }).strict()).optional(),
  tool_choice: choice.optional(), parallel_tool_calls: z.boolean().optional(),
  stream: z.boolean().optional(), stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
  max_tokens: z.number().int().positive().optional(), max_completion_tokens: z.number().int().positive().optional(),
  reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(), response_format: format.optional(),
  temperature: z.number().optional(), top_p: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(), n: z.literal(1).optional(), store: z.literal(false).optional(), user: z.string().optional(),
}).strict()
const responsePart = z.discriminatedUnion('type', [
  audioPart, filePart,
  z.object({ type: z.enum(['input_text', 'output_text']), text: z.string(), annotations: z.array(z.unknown()).optional() }).strict(),
  z.object({ type: z.literal('input_image'), image_url: z.string().refine(value => value.startsWith('data:image/') || value.startsWith('https://'), 'Image must be a data URL or public HTTPS URL'), detail: z.enum(['auto', 'low', 'high']).optional() }).strict(),
])
const customTool = z.object({ type: z.literal('custom'), name: z.string(), description: z.string().optional(), format: z.union([
  z.object({ type: z.literal('text') }).strict(),
  z.object({ type: z.literal('grammar'), syntax: z.enum(['lark', 'regex']), definition: z.string().max(65536) }).strict(),
]).optional() }).strict()
const responseTool = z.union([functionTool.extend({ type: z.literal('function') }), customTool])
const responsesSchema = z.object({
  model: z.string(), instructions: z.string().optional(),
  input: z.union([z.string(), z.array(z.union([
    z.object({ type: z.literal('message').optional(), phase: z.enum(['commentary', 'final_answer']).optional(), id: z.string().optional(), status: z.string().optional(), role: z.enum(['user', 'assistant', 'system', 'developer']), content: z.union([z.string(), z.array(responsePart)]) }).strict(),
    z.object({ type: z.literal('function_call'), call_id: z.string(), name: z.string(), arguments: args, namespace: z.string().optional(), id: z.string().optional(), status: z.string().optional() }).strict(),
    z.object({ type: z.literal('custom_tool_call'), call_id: z.string(), name: z.string(), namespace: z.string().optional(), input: z.string(), id: z.string().optional(), status: z.string().optional() }).strict(),
    z.object({ type: z.literal('custom_tool_call_output'), id: z.string().optional(), status: z.string().optional(), call_id: z.string(), output: z.string() }).strict(),
    z.object({ type: z.literal('function_call_output'), id: z.string().optional(), status: z.string().optional(), call_id: z.string(), output: z.union([z.string(), z.array(responsePart)]) }).strict(),
  ]))]),
  tools: z.array(z.union([responseTool, z.object({ type: z.literal('namespace'), name: z.string(), description: z.string().optional(), tools: z.array(responseTool) }).strict()])).optional(),
  tool_choice: z.union([z.enum(['auto', 'none', 'required']), z.object({ type: z.enum(['function', 'custom']), name: z.string(), namespace: z.string().optional() }).strict()]).optional(),
  parallel_tool_calls: z.boolean().optional(), stream: z.boolean().optional(), max_output_tokens: z.number().int().positive().optional(),
  reasoning: z.object({ effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(), summary: z.literal('auto').optional() }).strict().optional(),
  include: z.array(z.literal('reasoning.encrypted_content')).optional(),
  prompt_cache_key: z.string().max(256).optional(), client_metadata: z.record(z.string(), z.string()).optional(),
  text: z.object({ format: z.union([z.object({ type: z.literal('text') }).strict(), z.object({ type: z.literal('json_schema'), name: z.string(), schema: json, strict: z.boolean().optional() }).strict()]) }).strict().optional(),
  background: z.boolean().optional(),
  previous_response_id: z.string().min(1).max(128).nullable().optional(),
  temperature: z.number().optional(), top_p: z.number().optional(), store: z.boolean().optional(), metadata: z.record(z.string(), z.string()).optional(),
}).strict()

/** Provider-specific validation prevents generic converters silently dropping unsupported fields. */
export async function agOpenai(request: Request, raw: unknown, responses: boolean, messages: (request: Request) => Promise<Response>, store: AgResponseStore, jobs?: AgResponseJobs, execution?: { id?: string; background?: boolean; countTokens?: boolean }): Promise<Response> {
  const parsed = responses ? responsesSchema.safeParse(raw) : chatSchema.safeParse(raw)
  if (!parsed.success) throw new AntigravityError('Unsupported OpenAI request: ' + parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  const data = parsed.data
  const responseRequest = 'input' in data ? data : undefined
  if (responseRequest?.tools) {
    const names = new Set<string>()
    for (const tool of responseRequest.tools) for (const nested of tool.type === 'namespace' ? tool.tools : [tool]) {
      const alias = tool.type === 'namespace' ? responsesToolAlias(tool.name, nested.name) : nested.type === 'custom' ? responsesToolAlias(undefined, nested.name) : nested.name
      if (names.has(alias)) throw new AntigravityError('Ambiguous or duplicate tool alias: ' + alias)
      names.add(alias)
    }
  }
  const grammars: Record<string, { syntax: 'regex' | 'lark'; definition: string }> = {}
  for (const tool of responseRequest?.tools ?? []) for (const nested of tool.type === 'namespace' ? tool.tools : [tool]) if (nested.type === 'custom' && nested.format?.type === 'grammar') grammars[responsesToolAlias(tool.type === 'namespace' ? tool.name : undefined, nested.name)] = { syntax: nested.format.syntax, definition: nested.format.definition }
  const scope = agResponseScope(request.headers)
  let savedInput: unknown[] = []
  if (responseRequest) {
    const incoming = typeof responseRequest.input === 'string' ? [{ role: 'user', content: responseRequest.input }] : responseRequest.input
    let prefix: unknown[] = []
    if (responseRequest.previous_response_id) {
      const previous = store.get(responseRequest.previous_response_id, scope)
      prefix = [...previous.input, ...z.array(z.unknown()).parse(previous.response.output)]
    }
    // Only input/output items carry forward. Instructions, tools and controls
    // belong to this request, matching Responses API continuation semantics.
    const input = [...prefix, ...incoming]
    if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) throw new AntigravityError('Expanded Responses history exceeds 8 MiB; send compacted full input without previous_response_id', 413)
    responseRequest.input = responsesSchema.shape.input.parse(input)
    savedInput = structuredClone(input)
  }
  const responseLog: AgResponseEvent[] = []
  let responseLogBytes = 0
  const decorate = (value: Record<string, unknown>, terminal = false) => {
    if (!responseRequest) return value
    Object.assign(value, {
      background: execution?.background ?? false,
      store: responseRequest.store !== false, previous_response_id: responseRequest.previous_response_id ?? null,
      instructions: responseRequest.instructions ?? null, metadata: responseRequest.metadata ?? {},
      tools: responseRequest.tools ?? [], tool_choice: responseRequest.tool_choice ?? 'auto',
      parallel_tool_calls: responseRequest.parallel_tool_calls ?? true,
    })
    if (terminal && responseRequest.store !== false) {
      if (request.signal.aborted) throw new AntigravityError('Request cancelled', 499, 'api_error')
      store.put(String(value.id), scope, savedInput, value, responseLog.length ? responseLog : undefined)
    }
    return value
  }
  // Preserve URL sources through the shared data-URL converter without doing
  // network I/O before runtime admission and attachment cancellation are active.
  const urls = new Map<string, string>()
  const imagePlaceholder = (url: string): string => {
    if (!url.startsWith('https://')) return url
    const data = Buffer.from('meridian-url:' + randomUUID()).toString('base64')
    urls.set(data, url)
    return 'data:image/png;base64,' + data
  }
  if ('messages' in data) {
    for (const message of data.messages) if (Array.isArray(message.content)) for (const part of message.content) if (part.type === 'image_url') part.image_url.url = imagePlaceholder(part.image_url.url)
  } else if (Array.isArray(data.input)) {
    for (const item of data.input) {
      const content = 'content' in item ? item.content : 'output' in item ? item.output : undefined
      if (Array.isArray(content)) for (const part of content) if (part.type === 'input_image') part.image_url = imagePlaceholder(part.image_url)
    }
  }
  const media = new AgOpenaiMedia()
  const normalizePart = (part: z.infer<typeof responsePart>) => part.type === 'input_audio' ? { type: 'input_text' as const, text: media.audio(part.input_audio.data, part.input_audio.format) } : part.type === 'input_file' ? { type: 'input_text' as const, text: media.file(part.file_data, part.filename) } : part
  const chat = 'messages' in data ? { ...data, messages: data.messages.map(message => ({ ...message, content: Array.isArray(message.content) ? message.content.map(part => part.type === 'input_audio' ? { type: 'text' as const, text: media.audio(part.input_audio.data, part.input_audio.format) } : part) : message.content })) } : undefined
  const resp = 'input' in data ? { ...data, input: Array.isArray(data.input) ? data.input.map(item => 'content' in item ? { ...item, content: typeof item.content === 'string' ? item.content : item.content.map(normalizePart) } : item.type === 'function_call_output' ? { ...item, output: typeof item.output === 'string' ? item.output : item.output.map(normalizePart) } : item) : data.input } : undefined
  const translated = chat ? translateOpenAiToAnthropic({ ...chat, messages: chat.messages.map(message => ({ ...message, content: message.content ?? "" })) }, { preserveConversationHistory: true, preserveThinkingText: true }) : translateResponsesToAnthropic(resp!)
  if (!translated) throw new AntigravityError('OpenAI request has no supported conversation')
  for (const message of translated.messages) if (message.role === 'assistant' && Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use')) message.content = message.content.filter(block => block.type !== 'text' || block.text !== '')
  const selection = data.tool_choice
  const selectedName = typeof selection === 'object' ? 'function' in selection ? selection.function.name : selection.namespace || selection.type === 'custom' ? responsesToolAlias(selection.namespace, selection.name) : selection.name : undefined
  const toolChoice = selection === 'none' ? { type: 'none' } : selection === 'required' ? { type: 'any' } : typeof selection === 'object' ? { type: 'tool', name: selectedName } : { type: 'auto' }
  if (data.parallel_tool_calls === false && toolChoice.type !== 'none') Object.assign(toolChoice, { disable_parallel_tool_use: true })
  const effort = chat?.reasoning_effort ?? resp?.reasoning?.effort
  const outputFormat = resp?.text?.format
  const restoreImages = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(restoreImages)
    if (!value || typeof value !== 'object') return value
    const object = value as Record<string, unknown>
    if (object.type === 'image' && object.source && typeof object.source === 'object') {
      const source = object.source as Record<string, unknown>
      const url = typeof source.data === 'string' ? urls.get(source.data) : undefined
      if (url) return { type: 'image', source: { type: 'url', url } }
    }
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, restoreImages(child)]))
  }
  const body = { ...translated, ...(Object.keys(grammars).length ? { meridian_tool_grammars: grammars } : {}), ...(resp ? { meridian_session_key: resolveCodexThreadIdentity(resp, request.headers.get('x-codex-turn-metadata') ?? undefined).sessionKey } : {}), messages: media.restore(restoreImages(translated.messages)), tool_choice: toolChoice,
    ...(chat?.stop !== undefined ? { stop_sequences: typeof chat.stop === 'string' ? [chat.stop] : chat.stop } : {}),
    output_config: { ...translated.output_config, ...(effort ? { effort } : {}), ...(outputFormat?.type === 'json_schema' ? { format: { type: 'json_schema', schema: outputFormat.schema } } : {}) },
  }
  const validatedBody = parseAgRequest(body)
  if (execution?.countTokens) return Response.json({ object: 'response.input_tokens', ...estimateAgTokens(validatedBody) }, { headers: { 'x-meridian-token-count': 'estimate' } })
  if (responseRequest?.background) {
    if (!jobs) throw new AntigravityError('Background response service unavailable', 503)
    if (responseRequest.store === false) throw new AntigravityError('Background responses require store: true')
    const rawObject = json.parse(raw)
    const queued = jobs.start(scope, savedInput, data.model, (signal, id) => agOpenai(new Request(request.url, { method: 'POST', headers: request.headers, signal }), { ...rawObject, background: false, stream: true }, true, messages, store, jobs, { id, background: true }))
    return data.stream ? jobs.stream(String(queued.id), scope, -1, request.signal) : Response.json(queued)
  }
  const upstream = await messages(new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body), signal: request.signal }))
  if (!upstream.ok) return upstream
  const ctx = { toolAliases: buildResponsesToolAliases(resp?.tools), responseId: execution?.id ?? 'resp_agy_' + randomUUID().replaceAll('-', ''), completionId: 'chatcmpl-agy-' + randomUUID(), model: data.model, created: Math.floor(Date.now() / 1000), includeUsage: chat?.stream_options?.include_usage }
  if (!data.stream) {
    const value = await upstream.json() as AnthropicResponse
    return Response.json(responses ? decorate(translateAnthropicToResponses({ ...value, content: value.content?.map(block => ({ ...block })) }, ctx), true) : translateAnthropicToOpenAi(value, ctx.completionId, ctx.model, ctx.created))
  }
  if (!upstream.body) throw new AntigravityError('Missing upstream stream', 502, 'api_error')
  const chatTranslate = createSseTranslator(ctx)
  const responseTranslate = createResponsesSseTranslator(ctx)
  const encoder = new TextEncoder()
  let pending = ''
  let failed = false
  let finished = false
  const stream = upstream.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, Uint8Array>({
    transform(chunk, controller) {
      pending += chunk
      if (pending.length > 1024 * 1024) throw new Error('OpenAI stream frame exceeded 1 MiB')
      let boundary: number
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2)
        const line = frame.split('\n').find(line => line.startsWith('data: '))
        if (!line) continue
        const event = JSON.parse(line.slice(6)) as AnthropicSseEvent & { error?: unknown }
        if (event.type === 'message_stop') finished = true
        if (event.type === 'error') {
          failed = true
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: 'error', error: event.error })}\n\n`))
        } else if (responses) {
          for (const item of responseTranslate(event)) {
            responseLogBytes += Buffer.byteLength(JSON.stringify(item.data))
            if (responseLogBytes > 8 * 1024 * 1024 || responseLog.length >= 50000) throw new Error('Response event log exceeds its budget')
            responseLog.push(item.data as AgResponseEvent)
            if (item.data.response) item.data.response = decorate(json.parse(item.data.response), !failed && ['response.completed', 'response.incomplete'].includes(item.event))
            if (responseRequest?.store !== false && !failed && ['response.completed', 'response.incomplete'].includes(item.event)) store.put(ctx.responseId, scope, savedInput, json.parse(item.data.response), responseLog)
            controller.enqueue(encoder.encode(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`))
          }
        } else {
          const item = chatTranslate(event)
          if (item) controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`))
          if (event.type === 'message_stop') {
            const usage = chatTranslate.buildUsageChunk()
            if (usage) controller.enqueue(encoder.encode(`data: ${JSON.stringify(usage)}\n\n`))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          }
        }
      }
    },
    flush() {
      if (pending.trim()) throw new Error('Incomplete upstream SSE frame')
      if (!finished && !failed) throw new Error('Upstream stream ended before message_stop')
    },
  }))
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' } })
}
