/**
 * What startup says about a runtime that cannot stop a cancelled request.
 *
 * Under Bun, the node:http server @hono/node-server serves with is never told
 * of a client that goes away before the first byte of its response: neither
 * the socket nor the response closes, and the request's signal never aborts.
 * A request cancelled while the model is still thinking (Esc in Claude Code,
 * an orchestrator stopping subagents still starting) then runs on to the end
 * of its turn, on the account's allowance. Under Node the server hears the
 * client go and the request stops. The supervisor runs the build under Node,
 * and the source under Bun only when there is no build.
 *
 * The behaviour was checked only on the Bun releases in PROBED_BUN_VERSIONS,
 * so the warning names them instead of claiming it for every Bun. It still
 * prints on any Bun, because nothing shows a later release fixed it.
 */
export const PROBED_BUN_VERSIONS = ["1.2.20", "1.3.11", "1.3.14"] as const

export function runtimeCancelWarning(versions: Partial<NodeJS.ProcessVersions> = process.versions): string | undefined {
  if (!versions.bun) return undefined
  return `[PROXY] Running under Bun ${versions.bun}: Bun's HTTP server (checked on Bun ${PROBED_BUN_VERSIONS.join(", ")}) `
    + "does not report a client that goes away before the first byte of a response, so a request cancelled "
    + "while the model is still thinking runs on to the end of its turn, on the account's allowance. "
    + "Run the proxy under Node to stop it: from a source checkout, npm run build && npm run start; "
    + "from an npm install, start meridian with Node (not bunx --bun)."
}
