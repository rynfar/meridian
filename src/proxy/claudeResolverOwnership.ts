import { AuthStatusProcessFailure, type AuthStatusProcess } from './authStatusProcess'

export interface ClaudeResolutionScope {
  active(): void
  own(process: AuthStatusProcess): AuthStatusProcess
}

/** One shared resolution has independent leases, including direct SDK callers. */
export function createClaudeResolution(run: (scope: ClaudeResolutionScope) => Promise<string>) {
  const users = new Set<object>()
  const processes = new Set<AuthStatusProcess>()
  let cancelled = false
  let joinedSeen = false
  let failed = false
  let resolveJoined!: () => void
  const joined = new Promise<void>(resolve => { resolveJoined = resolve })
  const scope: ClaudeResolutionScope = {
    active() {
      if ([...processes].some(process => !process.isJoined())) throw new AuthStatusProcessFailure('join')
      if (cancelled) throw new AuthStatusProcessFailure('cancelled')
    },
    own(process) {
      // Every admission checks active synchronously before spawning. Register
      // before awaiting so last-lease cancellation always has the exact handle.
      processes.add(process)
      return process
    },
  }
  const result = Promise.resolve().then(() => { scope.active(); return run(scope) })
  void result.catch(() => { failed = true })
  // Settlement does not establish subprocess custody. Unknown joins retain the
  // shared slot even after a bounded result/cancel rejection.
  void result.catch(() => undefined).then(async () => {
    await Promise.all([...processes].map(process => process.joined))
    joinedSeen = true; resolveJoined()
  })
  return {
    result, joined, isJoined: () => joinedSeen,
    hasUnconfirmedFailure: () => failed && !joinedSeen,
    acquire(): AuthStatusProcess {
      const lease = {}
      users.add(lease)
      let released = false
      let cancellation: Promise<void> | undefined
      return {
        result, joined, isJoined: () => joinedSeen,
        cancel() {
          if (released) return cancellation ?? Promise.resolve()
          released = true; users.delete(lease)
          // Another profile/instance or direct resolver caller retains custody.
          if (users.size > 0 || joinedSeen) return cancellation = Promise.resolve()
          cancelled = true
          cancellation = Promise.all([...processes].map(process => process.cancel())).then(() => joined)
          void cancellation.catch(() => undefined)
          return cancellation
        },
      }
    },
  }
}
