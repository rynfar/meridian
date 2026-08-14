export interface SessionTurnLease {
  readonly waitedMs: number
  /**
   * True when a turn committed under `scopeKey` while this request waited.
   * Scoped because one client session id can back several independent
   * conversations — one per profile — and a commit under one profile says
   * nothing about the lineage a queued request from another profile carries.
   */
  advancedWhileWaiting(scopeKey: string): boolean
  markCommitted(scopeKey: string): void
  release(): void
}

interface SessionTurnWaiter {
  readonly arrivedAt: number
  readonly versions: Map<string, number>
  readonly resolve: (lease: SessionTurnLease) => void
  readonly reject: (error: Error) => void
  readonly signal?: AbortSignal
  abortListener?: () => void
}

interface SessionTurnState {
  held: boolean
  /** Commit counter per profile-scoped session key sharing this client id. */
  versions: Map<string, number>
  waiters: SessionTurnWaiter[]
}

function cancellationError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException(
    typeof reason === "string" && reason ? reason : "The request was cancelled",
    "AbortError",
  )
}

/** Serialize turns for one reliable logical client-session identity. */
export class SessionTurnCoordinator {
  private readonly turns = new Map<string, SessionTurnState>()

  get size(): number {
    return this.turns.size
  }

  acquire(key: string, signal?: AbortSignal): Promise<SessionTurnLease> {
    if (signal?.aborted) return Promise.reject(cancellationError(signal.reason))

    let state = this.turns.get(key)
    if (!state) {
      state = { held: false, versions: new Map(), waiters: [] }
      this.turns.set(key, state)
    }

    const arrivedAt = Date.now()
    // Snapshot on ARRIVAL, not on grant: "advanced while waiting" is measured
    // against the state this request was built from.
    const arrivedVersions = new Map(state.versions)
    if (!state.held && state.waiters.length === 0) {
      state.held = true
      return Promise.resolve(this.createLease(key, state, arrivedAt, arrivedVersions))
    }

    return new Promise<SessionTurnLease>((resolve, reject) => {
      const waiter: SessionTurnWaiter = {
        arrivedAt,
        versions: arrivedVersions,
        resolve,
        reject,
        signal,
      }
      if (signal) {
        waiter.abortListener = () => {
          const index = state!.waiters.indexOf(waiter)
          if (index === -1) return
          state!.waiters.splice(index, 1)
          reject(cancellationError(signal.reason))
          this.cleanup(key, state!)
        }
        signal.addEventListener("abort", waiter.abortListener, { once: true })
      }
      state!.waiters.push(waiter)
    })
  }

  private createLease(
    key: string,
    state: SessionTurnState,
    arrivedAt: number,
    arrivedVersions: Map<string, number>,
  ): SessionTurnLease {
    let released = false
    // Per scope, not a single flag: one turn legitimately stores its session
    // more than once (silent-turn recovery re-commits), and that must count as
    // one advancement — but a commit under a different scope is its own event.
    const committedScopes = new Set<string>()
    return {
      waitedMs: Date.now() - arrivedAt,
      // Safe to read lazily: only the current holder can commit, so nothing
      // can advance between this lease being granted and being released.
      advancedWhileWaiting: (scopeKey: string) =>
        (state.versions.get(scopeKey) ?? 0) > (arrivedVersions.get(scopeKey) ?? 0),
      markCommitted: (scopeKey: string) => {
        if (released || committedScopes.has(scopeKey)) return
        committedScopes.add(scopeKey)
        state.versions.set(scopeKey, (state.versions.get(scopeKey) ?? 0) + 1)
      },
      release: () => {
        if (released) return
        released = true
        state.held = false
        while (state.waiters.length > 0) {
          const waiter = state.waiters.shift()!
          if (waiter.abortListener && waiter.signal) {
            waiter.signal.removeEventListener("abort", waiter.abortListener)
          }
          if (waiter.signal?.aborted) {
            waiter.reject(cancellationError(waiter.signal.reason))
            continue
          }
          state.held = true
          waiter.resolve(this.createLease(key, state, waiter.arrivedAt, waiter.versions))
          return
        }
        this.cleanup(key, state)
      },
    }
  }

  private cleanup(key: string, state: SessionTurnState): void {
    if (!state.held && state.waiters.length === 0 && this.turns.get(key) === state) {
      this.turns.delete(key)
    }
  }
}

/** Process-wide coordinator; cache eviction must never clear active leases. */
export const processSessionTurns = new SessionTurnCoordinator()
