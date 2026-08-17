export interface RequestAbortLink {
  controller: AbortController
  abort: (reason?: unknown) => void
  detach: () => void
}

/** Forward an HTTP request abort into the SDK query lifecycle. */
export function linkRequestAbort(signal: AbortSignal): RequestAbortLink {
  const controller = new AbortController()
  let attached = false

  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const forwardAbort = () => abort(signal.reason)

  if (signal.aborted) {
    forwardAbort()
  } else {
    signal.addEventListener("abort", forwardAbort, { once: true })
    attached = true
  }

  return {
    controller,
    abort,
    detach: () => {
      if (!attached) return
      signal.removeEventListener("abort", forwardAbort)
      attached = false
    },
  }
}

/**
 * Tracks live request abort links so a shutdown can abort every in-flight SDK
 * query at once. Deliberately not a module-global: one registry per proxy
 * instance, so an embedder running two proxies cannot have one instance's
 * shutdown tear down the other's requests.
 */
export interface RequestAbortRegistry {
  /** Create a tracked abort link for one HTTP request. */
  link(signal: AbortSignal): RequestAbortLink
  /** Abort every tracked link that is not already aborted. Returns how many were aborted. */
  abortAll(reason?: unknown): number
  /** Number of links still tracked (i.e. requests that have not detached yet). */
  size(): number
}

export function createRequestAbortRegistry(): RequestAbortRegistry {
  const links = new Set<RequestAbortLink>()

  return {
    link(signal: AbortSignal): RequestAbortLink {
      const inner = linkRequestAbort(signal)
      const tracked: RequestAbortLink = {
        controller: inner.controller,
        abort: (reason?: unknown) => inner.abort(reason),
        // Untracking is unconditional even though linkRequestAbort's detach is
        // a no-op for an already-aborted signal — otherwise a request that
        // arrived pre-aborted would stay in the registry forever.
        detach: () => {
          inner.detach()
          links.delete(tracked)
        },
      }
      links.add(tracked)
      return tracked
    },
    abortAll(reason?: unknown): number {
      let aborted = 0
      for (const link of [...links]) {
        if (link.controller.signal.aborted) continue
        link.abort(reason)
        aborted++
      }
      return aborted
    },
    size: () => links.size,
  }
}
