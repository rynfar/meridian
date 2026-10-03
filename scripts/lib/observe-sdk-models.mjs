// Observe real upstream message model IDs without replacing SDK messages or
// losing the Query object's bound methods (close, interrupt, etc.).
export function observeSdkModels(query, models, onMessage) {
  return new Proxy(query, { get(target, key) {
    if (key === Symbol.asyncIterator) return async function* () {
      for await (const message of query) {
        onMessage?.(message)
        const model = message.type === 'assistant' ? message.message?.model
          : message.type === 'stream_event' && message.event?.type === 'message_start' ? message.event.message?.model : undefined
        if (typeof model === 'string') models.add(model)
        yield message
      }
    }
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
