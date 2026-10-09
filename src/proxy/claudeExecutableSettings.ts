/**
 * GET and PUT /settings/api/claude-executable: which Claude Code executable
 * runs each turn (see claudeExecutablePreference.ts).
 *
 * The state names what the next turn runs, and what each choice would run,
 * with versions, so the choice can be made before it is applied. A change
 * applies to the next turn: the PUT resolves the newly chosen executable
 * before answering, and turns already running finish on the one they started
 * with. Authentication belongs to the caller's settings-route boundary.
 */

import { isAbsolute } from "node:path"
import { isSameOriginRequest } from "../sameOrigin"
import { loadSettings, saveSettings, type MeridianSettings } from "../settings"
import { CLAUDE_EXECUTABLE_MODES, isClaudeExecutableMode, resolveClaudeExecutablePreference } from "./claudeExecutablePreference"
import { assertClaudeProbeActive } from "./claudeProbeOwnership"
import { AuthStatusProcessFailure } from "./authStatusProcess"
import {
  describeClaudeExecutableCandidates,
  readClaudeVersion,
  resolveClaudeExecutableInfoAsync,
  type ClaudeExecutableCandidate,
  type ClaudeExecutableSource,
} from "./models"

async function candidateAt(path: string, source: ClaudeExecutableSource): Promise<ClaudeExecutableCandidate> {
  const answer = await readClaudeVersion(path)
  return "version" in answer
    ? { path, source, version: answer.version }
    : { path, source, version: null, detail: answer.error }
}

export async function claudeExecutableSettingsState() {
  const saved = loadSettings()
  const preference = resolveClaudeExecutablePreference(saved?.claudeExecutable, saved?.claudeExecutablePath)
  const customPath = typeof saved?.claudeExecutablePath === "string" ? saved.claudeExecutablePath : null
  const envPath = process.env.MERIDIAN_CLAUDE_PATH || null
  // Resolve under the saved preference first, so `active` is what the next
  // turn runs even when another process saved it.
  let activeError: string | undefined
  const activeInfo = await resolveClaudeExecutableInfoAsync(preference).catch((err: unknown) => {
    if (err instanceof AuthStatusProcessFailure && err.reason === "join") throw err
    activeError = err instanceof Error ? err.message : String(err)
    return null
  })
  assertClaudeProbeActive()
  const [candidates, custom, envOverride] = await Promise.all([
    describeClaudeExecutableCandidates(),
    customPath
      ? candidateAt(customPath, "custom")
      : Promise.resolve<ClaudeExecutableCandidate>({ path: null, source: null, version: null, detail: "no path chosen" }),
    envPath ? candidateAt(envPath, "env") : Promise.resolve(null),
  ])
  const described = [candidates.system, candidates.bundled, custom, envOverride]
    .find(candidate => candidate?.path === activeInfo?.path && candidate?.version)
  const active = activeInfo
    ? (described ? { ...activeInfo, version: described.version } : await candidateAt(activeInfo.path, activeInfo.source))
    : null
  return {
    mode: preference.mode,
    modes: CLAUDE_EXECUTABLE_MODES,
    customPath,
    active,
    ...(activeError ? { activeError } : {}),
    envOverride,
    candidates: { system: candidates.system, bundled: candidates.bundled, custom },
  }
}

/** Why a path cannot be the custom executable, or null when it can. */
async function customPathProblem(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return `${path} is not an absolute path`
  const answer = await readClaudeVersion(path)
  return "error" in answer ? `${path} cannot run Claude Code: ${answer.error}` : null
}

export async function claudeExecutableSettingsResponse(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" }
  if (request.method === "GET") return Response.json(await claudeExecutableSettingsState(), { headers })

  // This chooses the binary every turn runs, with every tool permitted, so a
  // foreign page that reaches an unkeyed local server must not be able to.
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Claude Code executable settings require a same-origin request" }, { status: 403, headers })
  }
  let input: unknown
  try { input = await request.json() }
  catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }) }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Response.json({ error: "Settings must be a JSON object" }, { status: 400, headers })
  }
  const { mode, path } = input as Record<string, unknown>
  if (mode !== undefined && mode !== null && !isClaudeExecutableMode(mode)) {
    return Response.json({ error: `mode must be one of: ${CLAUDE_EXECUTABLE_MODES.join(", ")}, or null to unset` }, { status: 400, headers })
  }
  if (path !== undefined && path !== null && typeof path !== "string") {
    return Response.json({ error: "path must be a string, or null to unset" }, { status: 400, headers })
  }

  const saved = loadSettings()
  const nextMode = mode === undefined ? saved?.claudeExecutable : mode
  const givenPath = typeof path === "string" && path.trim() !== "" ? path.trim() : undefined
  const nextPath = path === undefined ? saved?.claudeExecutablePath : givenPath
  if (nextMode === "custom" && !nextPath) {
    return Response.json({ error: "custom needs the absolute path of a Claude Code executable" }, { status: 400, headers })
  }
  // Vet a path as it is given, and the saved one as custom is chosen: nothing
  // is stored that the next turn would fail to run.
  if (givenPath !== undefined || (mode === "custom" && nextPath)) {
    const problem = await customPathProblem((givenPath ?? nextPath)!)
    if (problem) return Response.json({ error: problem }, { status: 400, headers })
  }

  assertClaudeProbeActive()
  // The version check yielded. Re-read immediately before the synchronous
  // merge/write so another API/CLI writer cannot change the validated pair.
  const latest = loadSettings()
  if (latest?.claudeExecutable !== saved?.claudeExecutable || latest?.claudeExecutablePath !== saved?.claudeExecutablePath) {
    return Response.json({ error: "Claude executable selection changed while checking the path; reload and retry" }, { status: 409, headers })
  }

  const patch: Partial<MeridianSettings> = {}
  if (mode !== undefined) patch.claudeExecutable = mode ?? undefined
  if (path !== undefined) patch.claudeExecutablePath = givenPath
  saveSettings(patch)
  return Response.json(await claudeExecutableSettingsState(), { headers })
}
