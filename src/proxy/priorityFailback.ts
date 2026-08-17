export type PromotionLockRelease = () => void

export class PriorityPromotionLockQueue {
  private readonly tails = new Map<string, Promise<void>>()

  async acquire(key: string, signal: AbortSignal): Promise<PromotionLockRelease> {
    const predecessor = this.tails.get(key) ?? Promise.resolve()
    let finishLease = (): void => {}
    const lease = new Promise<void>(resolve => { finishLease = resolve })
    const tail = predecessor.then(() => lease)
    this.tails.set(key, tail)
    const cleanup = (): void => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
    let detachAbort = (): void => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
      detachAbort = () => signal.removeEventListener("abort", onAbort)
    })
    try {
      await Promise.race([predecessor, aborted])
      signal.throwIfAborted()
    } catch (error) {
      detachAbort()
      finishLease()
      void tail.then(cleanup)
      throw error
    }
    detachAbort()
    let active = true
    return () => {
      if (!active) return
      active = false
      finishLease()
      void tail.then(cleanup)
    }
  }
}

export function holdPromotionLock(response: Response, signal: AbortSignal, release: PromotionLockRelease): Response {
  const body = response.body
  if (body === null) {
    release()
    return response
  }
  const reader = body.getReader()
  let active = true
  let detachAbort = (): void => {}
  const releaseOnce = (): void => {
    if (!active) return
    active = false
    detachAbort()
    release()
  }
  const onAbort = (): void => releaseOnce()
  if (signal.aborted) {
    releaseOnce()
  } else {
    signal.addEventListener("abort", onAbort, { once: true })
    detachAbort = () => signal.removeEventListener("abort", onAbort)
  }
  const lockedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          releaseOnce()
          controller.close()
          return
        }
        controller.enqueue(next.value)
      } catch (error) {
        releaseOnce()
        controller.error(error)
      }
    },
    async cancel(reason) {
      releaseOnce()
      await reader.cancel(reason)
    },
  })
  return new Response(lockedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
