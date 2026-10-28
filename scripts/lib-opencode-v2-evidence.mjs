import assert from 'node:assert/strict'

export function clientAnswer(stdout) {
  const events = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  assert(!events.some(event => event.type === 'error'), 'Client reported an error')
  const text = events.filter(event => event.type === 'text' && typeof event.part?.text === 'string')
    .map(event => event.part.text).join('')
  assert(text.trim(), 'Client returned no assistant text')
  assert(!/\b(?:safety (?:filter|classifier)|third.party apps|out of extra usage|cannot comply|can['’]t reproduce)\b/i.test(text),
    'Client returned a refusal, not the required completion')
  return text
}

export function requireAnswer(stdout, expected) {
  const text = clientAnswer(stdout)
  assert.equal(text.trim(), expected, 'Assistant text did not equal the required result')
  return text
}

export function requireLiveAdmission(profiles, usage, now) {
  assert(Array.isArray(profiles.profiles) && profiles.profiles.length === 1
    && profiles.profiles[0].id === profiles.activeProfile, 'Use a dedicated single-profile proxy; pool routing must not escape the usage grant')
  assert(usage && !usage.stale && !usage.error && Number.isSafeInteger(usage.fetchedAt)
    && now - usage.fetchedAt >= 0 && now - usage.fetchedAt < 300_000, 'Fresh included-capacity evidence is required')
  assert.equal(usage.extraUsage?.isEnabled, false, 'Paid Extra Usage must remain disabled')
  assert(['five_hour', 'seven_day'].every(type => usage.windows.some(window => window.type === type
    && typeof window.utilization === 'number' && Number.isFinite(window.utilization)
    && window.utilization >= 0 && window.utilization < 1)), 'Known included allowance is required')
}

export function requireSuccessfulTurn(messages) {
  const user = messages.findLastIndex(message => message.type === 'user')
  const assistant = messages.findLastIndex(message => message.type === 'assistant')
  const idle = messages.findLastIndex(message => message.type === 'idle')
  assert(user >= 0 && assistant > user && idle > assistant, 'Terminal evidence predates the current user turn')
  assert.equal(messages[assistant].finish, 'stop', 'Assistant turn did not finish successfully')
  assert.equal(messages[idle].outcome, 'succeeded', 'Client turn did not settle successfully')
}

export function correlatedModels(requestIds, telemetry) {
  const ids = new Set(requestIds)
  return telemetry.filter(row => ids.has(row.requestId)).map(row => row.model)
}

export function sseErrorObserver(onError) {
  const decoder = new TextDecoder()
  let pending = ''
  return chunk => {
    pending = (pending + decoder.decode(chunk, { stream: true })).replaceAll('\r\n', '\n')
    let boundary
    while ((boundary = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, boundary)
      pending = pending.slice(boundary + 2)
      const lines = frame.split('\n')
      let payload
      try { payload = JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')) }
      catch { payload = undefined }
      if (lines.some(line => /^event:\s*error\s*$/.test(line)) || payload?.type === 'error') {
        onError(typeof payload?.error?.type === 'string' ? payload.error.type : 'provider_error')
      }
    }
  }
}

export function streamResponse(upstream, controller, { limit = 4 * 1024 * 1024, signal = controller.signal, onChunk } = {}) {
  const reader = upstream.body.getReader()
  let total = 0
  let settle
  const done = new Promise(resolve => { settle = resolve })
  let finished = false
  let downstream
  const finish = () => { if (!finished) { finished = true; signal.removeEventListener('abort', abort); settle() } }
  const abort = () => {
    const error = signal.reason instanceof Error ? signal.reason : new Error('Upstream response aborted')
    downstream.error(error)
    void reader.cancel(error).catch(() => undefined).finally(finish)
  }
  signal.addEventListener('abort', abort, { once: true })
  const body = new ReadableStream({
    start(output) { downstream = output },
    async pull(output) {
      try {
        const next = await reader.read()
        if (signal.aborted) throw signal.reason
        if (next.done) { output.close(); finish(); return }
        total += next.value.byteLength
        assert(total <= limit, 'Test response exceeded its byte budget')
        onChunk?.(next.value)
        output.enqueue(next.value)
      } catch (error) {
        controller.abort(error)
        await reader.cancel().catch(() => undefined)
        finish()
        output.error(error)
      }
    },
    async cancel(reason) { controller.abort(); try { await reader.cancel(reason) } finally { finish() } },
  })
  if (signal.aborted) abort()
  return { response: new Response(body, { status: upstream.status, headers: upstream.headers }), done }
}
