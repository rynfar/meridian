/**
 * The slice of `@microsoft/copilot-sdk` the Copilot backend uses.
 *
 * Meridian does not depend on the SDK. Its per-platform runtime package is
 * about 185 MB, and Nix's every-platform node_modules tree would fetch all of
 * them. The operator installs the SDK; it is loaded only when MERIDIAN_COPILOT=1.
 */
import { createRequire } from "node:module"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"

export const COPILOT_SDK_PACKAGE = "@microsoft/copilot-sdk"
/** The SDK release the backend's event and RPC handling was verified against. */
export const VERIFIED_COPILOT_SDK_VERSION = "2.0.1"

export interface CopilotModel {
  id: string
  name?: string
  vendor?: string
  policy?: { state?: string }
  billing?: { multiplier?: number }
  supportedReasoningEfforts?: string[]
}

export interface CopilotSessionEvent { type: string; data: Record<string, any> }

export interface CopilotSessionHandle {
  on(handler: (event: CopilotSessionEvent) => void): () => void
  send(options: { prompt: string }): Promise<unknown>
  abort(): Promise<void>
  disconnect(): Promise<void>
  rpc: { tools: { handlePendingToolCall(input: { requestId: string; result: string }): Promise<{ success: boolean }> } }
}

export interface CopilotToolDefinition {
  name: string
  description?: string
  parameters: Record<string, unknown>
  defer: "never"
  skipPermission: true
  overridesBuiltInTool: true
}

export interface CopilotSessionConfig {
  model: string
  inference?: { reasoningEffort: string }
  systemMessage: { mode: "replace"; content: string }
  filesystem: { workingDirectory: string }
  tools: { definitions: CopilotToolDefinition[]; availableTools: string[] }
  instructions: { skipCustomInstructions: true }
  hooks: { enableRepositoryHooks: false }
  permissions: { onRequest: () => { kind: "denied-interactively-by-user" } }
  events: { streaming: true }
}

export interface CopilotClientHandle {
  start(): Promise<void>
  stop(): Promise<unknown>
  listModels(): Promise<CopilotModel[]>
  getAuthStatus(): Promise<{ isAuthenticated: boolean; login?: string; statusMessage?: string }>
  createSession(config: CopilotSessionConfig): Promise<CopilotSessionHandle>
}

export interface CopilotSdk {
  version?: string
  createClient(options: { baseDirectory: string }): CopilotClientHandle
}

interface SdkModule {
  CopilotClient: new (options: Record<string, unknown>) => CopilotClientHandle
  RuntimeConnection: { forSpawnedStdio(options: { baseDirectory: string; env: Record<string, string | undefined> }): unknown }
}

/** Meridian's own keys and Claude credentials never reach the Copilot runtime. */
export function copilotRuntimeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(MERIDIAN_|ANTHROPIC_|CLAUDE_)/.test(name)))
}

/**
 * Resolve the SDK from MERIDIAN_COPILOT_SDK_PATH (its package directory), then
 * from Meridian's own module resolution. The SDK signs in as the user logged in
 * to Copilot; Meridian never hands it a token or API key.
 */
export async function loadCopilotSdk(sdkPath?: string): Promise<CopilotSdk> {
  let specifier: string = COPILOT_SDK_PACKAGE
  let version: string | undefined
  try {
    if (sdkPath && !isAbsolute(sdkPath)) throw new Error("MERIDIAN_COPILOT_SDK_PATH must be an absolute path.")
    const manifestPath = sdkPath ? join(sdkPath, "package.json") : `${COPILOT_SDK_PACKAGE}/package.json`
    const require = createRequire(sdkPath ? pathToFileURL(join(sdkPath, "package.json")) : import.meta.url)
    const manifest = require(manifestPath) as { version?: string; name?: string }
    if (manifest.name !== COPILOT_SDK_PACKAGE) throw new Error(`${sdkPath} is not ${COPILOT_SDK_PACKAGE}.`)
    version = manifest.version
    if (sdkPath) specifier = pathToFileURL(require.resolve(sdkPath)).href
  } catch (error) {
    throw new Error(`The Copilot backend needs ${COPILOT_SDK_PACKAGE}. Install it (npm install -g ${COPILOT_SDK_PACKAGE}) and set MERIDIAN_COPILOT_SDK_PATH to its package directory. ${error instanceof Error ? error.message : String(error)}`)
  }
  const sdk = await import(specifier) as SdkModule
  if (typeof sdk.CopilotClient !== "function" || typeof sdk.RuntimeConnection?.forSpawnedStdio !== "function") throw new Error(`${COPILOT_SDK_PACKAGE} ${version ?? ""} does not expose CopilotClient and RuntimeConnection.forSpawnedStdio.`)
  return {
    version,
    createClient: ({ baseDirectory }) => new sdk.CopilotClient({
      // "empty" starts without Copilot's own prompt, tools or MCP servers.
      mode: "empty",
      // A child process: a runtime failure cannot take Meridian down with it.
      runtime: sdk.RuntimeConnection.forSpawnedStdio({ baseDirectory, env: copilotRuntimeEnv() }),
      github: { useLoggedInUser: true },
    }),
  }
}
