/**
 * Live session-tree registry: parent→child linkage for in-flight requests.
 *
 * Cancellation in meridian is per-HTTP-request — `requestAbort.ts` forwards one
 * socket's abort into that request's SDK abort controller. A harness that spawns
 * subagents (Prime Agent's RLM children) sends each child as an INDEPENDENT
 * request on its own session key, so a user cancelling the parent left every
 * child running: holding an SDK permit, holding its turn lease, and billing the
 * subscription until its own socket closed or the lease watchdog tripped.
 *
 * This registry is the missing link. A client that knows its own tree stamps the
 * immediate parent alongside the child's session id (`metadata.user_id` →
 * `{ session_id, parent_session_id }`, read by `adapters/claudecode.ts`), and
 * the server registers that linkage for the lifetime of the request.
 *
 * Three properties are deliberate:
 *
 *   1. **Live requests only.** An entry exists between "request admitted" and
 *      "request settled", nothing longer. There is no persistent tree: a session
 *      that was seen once but has no request in flight is not a cancellation
 *      target, because there is nothing to cancel. That keeps the registry
 *      bounded by concurrency rather than by conversation history.
 *   2. **Abort, not completion.** Only an actual abort of a node propagates. A
 *      parent turn that finishes normally leaves its children alone — a child
 *      routinely outlives the parent turn that spawned it.
 *   3. **Self-gating.** Propagation can only reach a request that declared a
 *      parent, so a client that does not stamp linkage is unaffected with no
 *      config flag to set.
 *
 * Pure bookkeeping: no HTTP, no I/O, no logging. The caller supplies the abort
 * handle and owns the eviction/telemetry discipline that follows an abort.
 */

/** Handle returned by `register`; removes the entry when the request settles. */
export interface SessionTreeRegistration {
  /** Remove this request from the registry. Idempotent. */
  release(): void
}

export interface SessionTreeEntry {
  /** Request id, for logging and for the cancellation result. */
  readonly requestId: string
  /** This request's client-session key, exactly as the adapter derived it. */
  readonly sessionKey: string
  /** The IMMEDIATE parent's session key, when the client stamped linkage. */
  readonly parentKey?: string
  /**
   * Abort this request. Must route through the same abort path a client
   * disconnect uses, so the eviction, permit release, and lease release that
   * follow are the existing ones rather than a parallel implementation.
   */
  readonly abort: (reason?: unknown) => void
}

export interface SessionTreeStats {
  /** Live requests currently registered. */
  tracked: number
  /** Of those, how many declared a parent (i.e. are cancellation targets). */
  linked: number
  /** Cancellations that aborted at least one live request, since start. */
  propagations: number
  /** Descendant requests aborted by an ancestor's cancellation, since start. */
  cancelledDescendants: number
}

/** What a cancellation actually reached. Empty when the subtree was idle. */
export interface SessionTreeCancellation {
  /** Session keys whose live requests were aborted, nearest-first. */
  readonly keys: readonly string[]
  /** Request ids aborted, in the order they were aborted. */
  readonly requestIds: readonly string[]
}

const EMPTY_CANCELLATION: SessionTreeCancellation = { keys: [], requestIds: [] }

/**
 * Depth cap for the ancestry walk.
 *
 * `parentKey` comes off the wire, so the forest is only a forest by convention:
 * a buggy or hostile client can stamp a cycle (A→B→A) or an absurdly deep chain.
 * The visited set already makes cycles terminate; this bounds the honest-but-
 * pathological case so one cancellation can never walk unboundedly.
 */
const MAX_SUBTREE_DEPTH = 64

/** Shorten a session key for logs. Keys can be full UUIDs or client-chosen. */
export function truncateSessionKey(key: string, length = 8): string {
  return key.length > length ? `${key.slice(0, length)}…` : key
}

interface CancelOptions {
  /** Also abort live requests running under the origin key itself. */
  readonly includeSelf?: boolean
  readonly reason?: unknown
}

/**
 * Registry of live requests and their declared parent links.
 *
 * Keyed by an internal token rather than by request id: `x-request-id` is
 * client-supplied, so two concurrent requests can legitimately arrive carrying
 * the same one, and a colliding key would silently unregister the wrong entry.
 */
export class SessionTreeRegistry {
  private nextToken = 1
  private readonly entries = new Map<number, SessionTreeEntry>()
  /** parentKey → tokens of live children. Index for the subtree walk. */
  private readonly childrenByParent = new Map<string, Set<number>>()
  private propagations = 0
  private cancelledDescendants = 0

  register(entry: SessionTreeEntry): SessionTreeRegistration {
    const token = this.nextToken++
    this.entries.set(token, entry)
    // A self-link is meaningless and would make a node its own descendant, so
    // it is dropped at the index rather than defended against on every walk.
    const indexedParent = entry.parentKey && entry.parentKey !== entry.sessionKey
      ? entry.parentKey
      : undefined
    if (indexedParent) {
      let siblings = this.childrenByParent.get(indexedParent)
      if (!siblings) {
        siblings = new Set()
        this.childrenByParent.set(indexedParent, siblings)
      }
      siblings.add(token)
    }
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.entries.delete(token)
        if (!indexedParent) return
        const siblings = this.childrenByParent.get(indexedParent)
        if (!siblings) return
        siblings.delete(token)
        if (siblings.size === 0) this.childrenByParent.delete(indexedParent)
      },
    }
  }

  /** Live requests whose ancestry chain reaches `sessionKey`, nearest first. */
  descendantsOf(sessionKey: string): SessionTreeEntry[] {
    const visitedKeys = new Set<string>([sessionKey])
    let frontier = [sessionKey]
    const found: SessionTreeEntry[] = []
    for (let depth = 0; depth < MAX_SUBTREE_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = []
      for (const parentKey of frontier) {
        const tokens = this.childrenByParent.get(parentKey)
        if (!tokens) continue
        for (const token of tokens) {
          const entry = this.entries.get(token)
          if (!entry) continue
          found.push(entry)
          // Several live requests can share one child key (a queued turn behind
          // the running one). Descend through that key only once.
          if (visitedKeys.has(entry.sessionKey)) continue
          visitedKeys.add(entry.sessionKey)
          next.push(entry.sessionKey)
        }
      }
      frontier = next
    }
    return found
  }

  /** Live requests running under `sessionKey` itself. */
  liveRequestsFor(sessionKey: string): SessionTreeEntry[] {
    const found: SessionTreeEntry[] = []
    for (const entry of this.entries.values()) {
      if (entry.sessionKey === sessionKey) found.push(entry)
    }
    return found
  }

  /**
   * Abort every live request below `sessionKey`, transitively.
   *
   * The origin request is left alone: it is already being torn down by whatever
   * triggered this, and aborting it a second time would be a no-op at best.
   */
  cancelDescendants(sessionKey: string, reason?: unknown): SessionTreeCancellation {
    return this.cancel(sessionKey, { reason })
  }

  /** Abort live requests for `sessionKey` AND everything below it. */
  cancelSubtree(sessionKey: string, reason?: unknown): SessionTreeCancellation {
    return this.cancel(sessionKey, { reason, includeSelf: true })
  }

  private cancel(sessionKey: string, options: CancelOptions): SessionTreeCancellation {
    const descendants = this.descendantsOf(sessionKey)
    const targets = options.includeSelf
      ? [...this.liveRequestsFor(sessionKey), ...descendants]
      : descendants
    if (targets.length === 0) return EMPTY_CANCELLATION

    const keys: string[] = []
    const requestIds: string[] = []
    for (const entry of targets) {
      // One entry's abort handle must never strand its siblings. The caller's
      // handle runs arbitrary teardown; a throw here is its problem, not the
      // rest of the subtree's.
      try {
        entry.abort(options.reason)
      } catch {
        // Recorded as cancelled regardless: the entry was targeted, and its
        // request settles through its own path either way.
      }
      if (!keys.includes(entry.sessionKey)) keys.push(entry.sessionKey)
      requestIds.push(entry.requestId)
    }
    this.propagations++
    this.cancelledDescendants += descendants.length
    return { keys, requestIds }
  }

  stats(): SessionTreeStats {
    let linked = 0
    for (const entry of this.entries.values()) {
      if (entry.parentKey) linked++
    }
    return {
      tracked: this.entries.size,
      linked,
      propagations: this.propagations,
      cancelledDescendants: this.cancelledDescendants,
    }
  }

  /** Reset process-scoped state between tests. */
  clear(): void {
    this.entries.clear()
    this.childrenByParent.clear()
    this.propagations = 0
    this.cancelledDescendants = 0
  }
}

/**
 * Process-wide registry.
 *
 * Session keys are a process-wide namespace (`processSessionTurns` serializes
 * turns on the same basis), and a parent and its child can be served by
 * different ProxyServer instances in one process, so per-instance registries
 * would lose exactly the links that matter.
 */
export const processSessionTree = new SessionTreeRegistry()
