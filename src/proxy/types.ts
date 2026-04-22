import type { Server } from "node:http"
import type { ProfileConfig } from "./profiles"

export interface ProxyConfig {
  port: number
  host: string
  debug: boolean
  idleTimeoutSeconds: number
  silent: boolean
  /** Named auth profiles for multi-account support */
  profiles?: ProfileConfig[]
  /** Default profile ID when no header is sent */
  defaultProfile?: string
  /** Package version, exposed via /health endpoint */
  version?: string
  /**
   * Persistent SDK sessions (opt-in). When true, meridian holds one live
   * `query()` per logical session across HTTP requests, avoiding the
   * `resume`-path byte drift that causes prompt-cache misses. See
   * `openspec/changes/persistent-sdk-sessions/` for the full design.
   * Defaults to false so today's request-per-process behaviour is preserved.
   */
  persistentSessions?: boolean
  /** Idle timeout (ms) before an unused SessionRuntime is evicted. Default 15 min. */
  persistentSessionIdleMs?: number
  /** Hard cap on concurrent live SessionRuntime instances. Default 32. */
  persistentSessionMaxLive?: number
  /**
   * Wait cap (ms) on per-session mutex acquisition. Requests that queue
   * behind another turn longer than this get HTTP 429 with Retry-After.
   * Default 30 s.
   */
  persistentSessionMutexWaitMs?: number
  /**
   * Opt-in per-handler idle timeout (ms) for pending deferred-handler
   * promises. When set, a pending handler whose `tool_use_id` has not been
   * resolved within this interval has its promise rejected so the SDK
   * unblocks.
   *
   * **Default: unset (`Infinity`).** Earlier versions defaulted to 900 000
   * ms, which silently rejected handlers for tools that legitimately ran
   * long (cargo builds, subagent dispatches, benchmarks). Because the timer
   * fires on wall-clock elapsed time with no signal from the client, it
   * cannot distinguish "tool is still working" from "client abandoned the
   * tool" and so was wrong by default. Session-level abandonment is now
   * caught by the idle-eviction sweep (`persistentSessionIdleMs`) which is
   * gated on `pendingCount === 0` so pending-handler runtimes are never
   * evicted silently; graceful shutdown (`ProxyInstance.close`) rejects all
   * pending handlers unconditionally within its 10 s budget.
   *
   * Operators who want a hard per-handler ceiling (e.g. cost-bounding on
   * shared deployments) may opt in by setting this field. Leaving it unset
   * is the correct default for single-user workflows.
   */
  persistentPendingExecutionTimeoutMs?: number
}

export interface ProxyInstance {
  /** The underlying http.Server */
  server: Server
  /** The resolved proxy configuration */
  config: ProxyConfig
  /** Gracefully shut down the proxy server and clean up resources */
  close(): Promise<void>
}

/** Return type of createProxyServer — avoids leaking Hono internals to consumers */
export interface ProxyServer {
  /** The HTTP app — pass `app.fetch` to your server of choice */
  app: { fetch: (request: Request, ...rest: any[]) => Response | Promise<Response> }
  /** The resolved proxy configuration */
  config: ProxyConfig
  /**
   * Optional cleanup hook that tears down internal resources held by the
   * server (live persistent runtimes, periodic sweeper, etc.). Callers that
   * spin up a raw `createProxyServer()` without `startProxyServer()` should
   * invoke this on shutdown to avoid leaked timers + orphaned SDK
   * subprocesses. `startProxyServer().close()` calls this automatically.
   */
  cleanup?: () => Promise<void>
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: 3456,
  host: "127.0.0.1",
  debug: (process.env.MERIDIAN_DEBUG ?? process.env.CLAUDE_PROXY_DEBUG) === "1",
  idleTimeoutSeconds: 120,
  silent: false,
  profiles: undefined,
  defaultProfile: undefined,
  version: undefined,
  persistentSessions: false,
  persistentSessionIdleMs: 900_000,      // 15 min
  persistentSessionMaxLive: 32,
  persistentSessionMutexWaitMs: 30_000,  // 30 s
  // persistentPendingExecutionTimeoutMs intentionally unset — a pending
  // handler lives as long as its client is still engaged with the session.
  // See the field's doc-comment for the full rationale.
}
