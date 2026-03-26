import type { Server } from "node:http"

export interface ProxyConfig {
  port: number
  host: string
  debug: boolean
  idleTimeoutSeconds: number
  silent: boolean
  profiles?: ProfileConfig[]
  defaultProfile?: string
}

export type ProfileType = "claude-max" | "api"

export interface ProfileConfig {
  id: string
  type?: ProfileType
  claudeConfigDir?: string
  claudeExecutable?: string
  apiKey?: string
  apiKeyEnv?: string
  baseUrl?: string
  authToken?: string
  authTokenEnv?: string
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
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: 3456,
  host: "127.0.0.1",
  debug: process.env.CLAUDE_PROXY_DEBUG === "1",
  idleTimeoutSeconds: 120,
  silent: false,
  profiles: undefined,
  defaultProfile: undefined,
}
