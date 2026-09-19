import type { Server } from "node:http"
import type { ProfileConfig } from "./profiles"

export interface AntigravityOptions {
  executable?: string
  /** Explicit consent to the auto-approval + deny-hook tool bridge. */
  allowToolBridge?: boolean
  maxConcurrent?: number
  turnTimeoutMs?: number
  /** Retain matching ordinary conversations in a live official CLI process. */
  reuseConversations?: boolean
  /** Explicit opt-in until an authenticated Windows live gate is available. */
  allowUnverifiedWindows?: boolean
  /** Native actions execute inside agy, outside client approval dialogs. */
  allowNativeBrowser?: boolean
  /** Installed Chrome DevTools MCP 1.9.0 executable; never downloaded at request time. */
  browserMcpExecutable?: string
  allowNativeSubagents?: boolean
  pendingToolTimeoutMs?: number
}

export interface ProxyConfig {
  /** Defaults to Claude. Antigravity is an opt-in, subscription-account CLI backend. */
  backend?: "claude" | "antigravity" | "combined"
  antigravity?: AntigravityOptions
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
  /** Plugin auto-discovery directory. Defaults to ~/.config/meridian/plugins/. */
  pluginDir?: string
  /** Plugin config file path. Defaults to ~/.config/meridian/plugins.json. */
  pluginConfigPath?: string
  /**
   * Install process-level uncaughtException/unhandledRejection handlers that
   * log and swallow socket-level errors (EPIPE, ECONNRESET, etc.) instead of
   * crashing the host process. Defaults to false to preserve any handlers a
   * library consumer has already installed; the bundled CLI passes `true`.
   */
  installProcessErrorHandlers?: boolean
  /**
   * Cap concurrent SDK subprocess spawns for THIS instance only. Left unset
   * (the default), instances share one process-wide budget from
   * `MERIDIAN_MAX_CONCURRENT` — spawning many subprocesses at once is what
   * exhausts the host, and that limit is a property of the process, not of any
   * one proxy. Set this only when an embedder deliberately wants an isolated
   * budget per instance.
   */
  maxConcurrent?: number
}

/** Read backend selection at instance creation, rather than module import. */
export function resolveBackendConfig(config: Partial<ProxyConfig>): ProxyConfig {
  const backend = config.backend ?? process.env.MERIDIAN_BACKEND ?? "claude"
  if (backend !== "claude" && backend !== "antigravity" && backend !== "combined") throw new Error("MERIDIAN_BACKEND must be claude, antigravity or combined")
  return {
    ...DEFAULT_PROXY_CONFIG, ...config, backend,
    ...(backend !== "claude" ? { antigravity: {
      executable: process.env.MERIDIAN_AGY_PATH,
      allowToolBridge: process.env.MERIDIAN_AGY_ALLOW_TOOL_BRIDGE === "1",
      allowNativeBrowser: process.env.MERIDIAN_AGY_ALLOW_NATIVE_BROWSER === "1",
      browserMcpExecutable: process.env.MERIDIAN_AGY_BROWSER_MCP_PATH,
      allowNativeSubagents: process.env.MERIDIAN_AGY_ALLOW_NATIVE_SUBAGENTS === "1",
      maxConcurrent: process.env.MERIDIAN_AGY_MAX_CONCURRENT === undefined ? undefined : Number(process.env.MERIDIAN_AGY_MAX_CONCURRENT),
      turnTimeoutMs: process.env.MERIDIAN_AGY_TURN_TIMEOUT_MS === undefined ? undefined : Number(process.env.MERIDIAN_AGY_TURN_TIMEOUT_MS),
      pendingToolTimeoutMs: process.env.MERIDIAN_AGY_TOOL_TIMEOUT_MS === undefined ? undefined : Number(process.env.MERIDIAN_AGY_TOOL_TIMEOUT_MS),
      ...config.antigravity,
    } } : {}),
  }
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
  /** Load plugins from disk and wire them into the request pipeline */
  initPlugins?(): Promise<void>
  /** Release optional backend resources when embedding app.fetch directly. */
  closeBackend?(): Promise<void>
  /**
   * Stop admitting new `/v1/messages` requests (fast-fails with 503) and
   * report `/health` as `draining`. Used by `startProxyServer`'s `close()`
   * to drain in-flight requests before the HTTP server actually shuts down.
   */
  beginDrain?(): void
  /** Revoke durable writes and abort work that outlived the shutdown grace. */
  forceAbortInFlight?(): void
  /** Count of requests admitted past the draining gate that haven't finished yet. */
  getInFlightCount?(): number
  /** Run one fail-closed transcript maintenance sweep. */
  sweepSessionGc?(): Promise<void>
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: 3456,
  host: "127.0.0.1",
  debug: (process.env.MERIDIAN_DEBUG ?? process.env.CLAUDE_PROXY_DEBUG) === "1",
  idleTimeoutSeconds: 120,
  // Suppress routine [PROXY] operational stderr (for embedded/TUI hosts like
  // opencode-with-claude). Off by default so standalone runs keep full logging.
  silent: (process.env.MERIDIAN_SILENT ?? process.env.CLAUDE_PROXY_SILENT) === "1",
  profiles: undefined,
  defaultProfile: undefined,
  version: undefined,
}
