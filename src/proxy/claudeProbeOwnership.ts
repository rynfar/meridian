import { AsyncLocalStorage } from "node:async_hooks"
import { AuthStatusProcessFailure, type AuthStatusProcess } from "./authStatusProcess"

interface ProbeScope {
  active(): void
  own(process: AuthStatusProcess): void
  stop(): Promise<void>
  confirmed(): boolean
}

const context = new AsyncLocalStorage<ProbeScope>()

/** Settings probes and resolver leases belong to their request and instance. */
export function assertClaudeProbeActive(): void { context.getStore()?.active() }
export function ownClaudeProbe(process: AuthStatusProcess): void { context.getStore()?.own(process) }

export function createClaudeProbeOwner() {
  let closed = false
  let closing: Promise<void> | undefined
  const scopes = new Set<ProbeScope>()
  return {
    async run<T>(signal: AbortSignal, callback: () => Promise<T>): Promise<T> {
      if (scopes.size >= 32) throw new Error("Claude executable resolution is busy; retry after pending requests finish")
      let retired = false
      const processes = new Set<AuthStatusProcess>()
      const scope: ProbeScope = {
        active() {
          if (closed || retired || signal.aborted) throw new AuthStatusProcessFailure("cancelled")
        },
        own(process) {
          processes.add(process)
          void process.joined.then(() => {
            processes.delete(process)
            if (retired && processes.size === 0) scopes.delete(scope)
          })
        },
        async stop() {
          retired = true
          const owned = [...processes]
          const results = await Promise.allSettled(owned.map(process => process.cancel()))
          // A released shared lease is sufficient; its sibling retains the
          // child. A failed last-owner join retains this scope for shutdown.
          let index = 0
          for (const process of owned) {
            if (results[index++]?.status === "fulfilled") processes.delete(process)
          }
          if (results.some(result => result.status === "rejected")) throw new AuthStatusProcessFailure("join")
        },
        confirmed: () => processes.size === 0,
      }
      scope.active(); scopes.add(scope)
      const abort = () => { void scope.stop().catch(() => undefined) }
      signal.addEventListener("abort", abort, { once: true })
      let firstFailure: unknown, failed = false
      let value: T | undefined
      try {
        value = await context.run(scope, callback)
        scope.active()
      } catch (error) { firstFailure = error; failed = true }
      signal.removeEventListener("abort", abort)
      try { await scope.stop() }
      catch (error) { if (!failed) { firstFailure = error; failed = true } }
      if (scope.confirmed()) scopes.delete(scope)
      if (failed) throw firstFailure
      return value!
    },
    close(): Promise<void> {
      closed = true
      closing ??= (async () => {
        const results = await Promise.allSettled([...scopes].map(scope => scope.stop()))
        if (results.some(result => result.status === "rejected")) throw new AuthStatusProcessFailure("join")
      })()
      return closing
    },
  }
}
