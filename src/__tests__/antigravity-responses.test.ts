import { describe, it, expect, afterEach } from 'bun:test'
import { AgResponseStore, agResponseScope } from '../proxy/backends/antigravityResponses'
import { agOpenai } from '../proxy/backends/antigravityOpenai'
import { createAntigravityServer } from '../proxy/backends/antigravity'
import { AntigravityRuntime } from '../proxy/backends/antigravityRuntime'
import { DEFAULT_PROXY_CONFIG } from '../proxy/types'
import { fileURLToPath } from 'node:url'

const value = { id: 'first', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] }] }
const input = [{ role: 'user', content: 'hello' }]
const scope = agResponseScope(new Headers())
describe('Antigravity bounded Responses state', () => {
  it('isolates history snapshots, credentials, deletion and fixed expiry', () => {
    let now = 1
    const store = new AgResponseStore({ entries: 2, bytes: 4096, entryBytes: 2048, ttlMs: 10 }, () => now)
    store.put('first', scope, input, value)
    store.get('first', scope).input.push('changed')
    expect(store.get('first', scope).input).toEqual(input)
    expect(() => store.get('first', 'another')).toThrow('not found')
    expect(() => store.delete('first', 'another')).toThrow('not found')
    now = 11
    expect(() => store.get('first', scope)).toThrow('not found')
    store.put('second', scope, input, value)
    expect(store.delete('second', scope)).toEqual({ id: 'second', object: 'response', deleted: true })
    expect(() => store.get('second', scope)).toThrow('not found')
    expect(agResponseScope(new Headers({ authorization: 'Bearer secret' }))).toBe(agResponseScope(new Headers({ 'x-api-key': 'secret' })))
  })
  it('bounds entry count and bytes and clears on shutdown', () => {
    const store = new AgResponseStore({ entries: 2, bytes: 500, entryBytes: 400, ttlMs: 10 })
    for (const id of ['one', 'two', 'three']) store.put(id, scope, input, value)
    expect(() => store.get('one', scope)).toThrow('not found')
    store.put('large', scope, [], { text: 'x'.repeat(300) })
    expect(() => store.get('two', scope)).toThrow('not found')
    expect(() => store.put('oversize', scope, [], { text: 'x'.repeat(401) })).toThrow('budget')
    expect(store.get('large', scope).response.text).toHaveLength(300)
    store.clear()
    expect(() => store.get('large', scope)).toThrow('not found')
  })
})

const response = { id: 'msg', type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: 'reply' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
const request = () => new Request('http://local/v1/responses', { method: 'POST' })
describe('Antigravity Responses translation and persistence', () => {
  it('chains and forks input/output, replacing rather than inheriting instructions and tools', async () => {
    const store = new AgResponseStore()
    const seen: Record<string, unknown>[] = []
    const messages = async (req: Request) => { seen.push(await req.json() as Record<string, unknown>); return Response.json(response) }
    const first = await (await agOpenai(request(), { model: 'fixture-model', input: 'first', instructions: 'old instruction' }, true, messages, store)).json() as Record<string, unknown>
    expect(first.store).toBe(true)
    const second = await (await agOpenai(request(), { model: 'fixture-model', input: 'second', previous_response_id: first.id, instructions: 'new instruction', store: false }, true, messages, store)).json() as Record<string, unknown>
    expect(seen[1]!.system).toBe('new instruction')
    expect(JSON.stringify(seen[1]!.messages)).toContain('first')
    expect(JSON.stringify(seen[1]!.messages)).toContain('reply')
    expect(second.previous_response_id).toBe(first.id)
    expect(() => store.get(String(second.id), scope)).toThrow('not found')
    await agOpenai(request(), { model: 'fixture-model', input: 'fork', previous_response_id: first.id }, true, messages, store)
    expect(seen[2]!.system).toBeUndefined()
    expect(JSON.stringify(seen[2]!.messages)).not.toContain('second')
  })
  it('rejects missing and oversized expanded history before model admission', async () => {
    const store = new AgResponseStore()
    let calls = 0
    const messages = async () => { calls++; return Response.json(response) }
    await expect(agOpenai(request(), { model: 'fixture-model', input: 'hello', previous_response_id: 'missing' }, true, messages, store)).rejects.toThrow('not found')
    store.put('large', scope, [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024) }], value)
    await expect(agOpenai(request(), { model: 'fixture-model', input: 'hello', previous_response_id: 'large' }, true, messages, store)).rejects.toThrow('8 MiB')
    expect(calls).toBe(0)
  })
  it('stores original HTTPS image URLs, not temporary translation placeholders', async () => {
    const store = new AgResponseStore()
    const result = await (await agOpenai(request(), { model: 'fixture-model', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/image.png' }] }] }, true, async () => Response.json(response), store)).json() as Record<string, unknown>
    expect(JSON.stringify(store.get(String(result.id), scope).input)).toContain('https://example.com/image.png')
    expect(JSON.stringify(store.get(String(result.id), scope).input)).not.toContain('meridian-url:')
  })
  it('cancels the upstream reader without publishing unfinished state', async () => {
    const store = new AgResponseStore()
    let cancelled = false
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'message_start', message: response })}\n\n`)) },
      cancel() { cancelled = true },
    })
    const result = await agOpenai(request(), { model: 'fixture-model', input: 'hello', stream: true }, true, async () => new Response(upstream), store)
    const reader = result.body!.getReader()
    const first = await reader.read()
    const frame = new TextDecoder().decode(first.value).split('\n').find(line => line.startsWith('data: '))!
    const id = JSON.parse(frame.slice(6)).response.id
    await reader.cancel()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cancelled).toBe(true)
    expect(() => store.get(id, scope)).toThrow('not found')
  })
  it('rejects a stream ending without a terminal message', async () => {
    const result = await agOpenai(request(), { model: 'fixture-model', input: 'hello', stream: true }, true, async () => new Response(''), new AgResponseStore())
    await expect(result.text()).rejects.toThrow('message_stop')
  })
  it('saves streamed terminal responses and leaves failed streams unstored', async () => {
    const store = new AgResponseStore()
    const events = [
      { type: 'message_start', message: response },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: response.usage },
      { type: 'message_stop' },
    ]
    for (const fail of [false, true]) {
      const frames = fail ? [...events.slice(0, 2), { type: 'error', error: { message: 'failed' } }] : events
      const result = await agOpenai(request(), { model: 'fixture-model', input: 'hello', stream: true, metadata: { tag: 'test' } }, true, async () => new Response(frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')), store)
      const wire = await result.text()
      const data = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      const id = data.find(event => event.type === 'response.created').response.id
      if (fail) expect(() => store.get(id, scope)).toThrow('not found')
      else {
        const terminal = data.find(event => event.type === 'response.completed').response
        expect(store.get(id, scope).response).toEqual(terminal)
        expect(terminal.metadata).toEqual({ tag: 'test' })
      }
    }
  })
})

const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0)) await close() })
describe.skipIf(process.platform === 'win32')('Antigravity stored Responses HTTP/CLI', () => {
  it('retrieves, continues, deletes and isolates server instances with the actual adapter', async () => {
    const runtime = new AntigravityRuntime({ executable: fileURLToPath(new URL('./fixtures/agy-cli.cjs', import.meta.url)), allowToolBridge: true })
    const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity' }, runtime)
    closing.push(server.closeBackend)
    const post = (body: unknown) => server.app.fetch(new Request('http://local/v1/responses', { method: 'POST', body: JSON.stringify(body) }))
    const firstHttp = await post({ model: 'fixture-model', input: 'NATIVE_FIRST' })
    expect(firstHttp.status).toBe(200)
    const first = await firstHttp.json() as { id: string }
    const get = await server.app.fetch(new Request('http://local/v1/responses/' + first.id))
    expect(get.status).toBe(200)
    expect(get.headers.get('cache-control')).toBe('no-store')
    expect(await get.json()).toEqual(first)
    const secondHttp = await post({ model: 'fixture-model', input: 'NATIVE_SECOND', previous_response_id: first.id })
    expect(secondHttp.status).toBe(200)
    expect(await secondHttp.text()).toContain('NATIVE_REUSED')
    expect(runtime.reused).toBe(1)
    const deletion = await server.app.fetch(new Request('http://local/v1/responses/' + first.id, { method: 'DELETE' }))
    expect(deletion.status).toBe(200)
    expect((await post({ model: 'fixture-model', input: 'third', previous_response_id: first.id })).status).toBe(404)
    const privateHttp = await post({ model: 'fixture-model', input: 'Hello', store: false })
    const privateResponse = await privateHttp.json() as { id: string }
    expect((await server.app.fetch(new Request('http://local/v1/responses/' + privateResponse.id))).status).toBe(404)
    expect((await server.app.fetch(new Request('http://local/v1/responses/' + first.id, { headers: { authorization: 'Bearer other' } }))).status).toBe(404)
  }, 30000)
})
