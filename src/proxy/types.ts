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
   * Idle timeout (ms) for pending deferred-handler promises. When a client
   * abandons a passthrough tool call (never returns with tool_result), the
   * handler's promise is rejected after this interval so the SDK unblocks
   * and the runtime can be cleaned up. Default matches `persistentSessionIdleMs`.
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
  persistentPendingExecutionTimeoutMs: 900_000, // matches idle eviction
}
