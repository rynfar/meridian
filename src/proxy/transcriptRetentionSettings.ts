/**
 * GET/PUT /settings/api/transcripts: the opt-in transcript retention period
 * (transcriptRetention.ts) behind the /settings card.
 *
 * Resolved on every request, so unlike telemetry there is no pending-restart
 * state: `effective` is what the next SDK child gets, unless its config root's
 * own settings.json names a period. Writes accept a browser request only from
 * this server's own pages (src/sameOrigin.ts); the contract is recorded in
 * .agents/references/api-contract.md.
 */

import { isSameOriginRequest } from "../sameOrigin"
import { getSetting, setSetting } from "../settings"
import {
  DEFAULT_TRANSCRIPT_RETENTION_DAYS,
  isTranscriptRetentionDays,
  meridianTranscriptRetention,
  TRANSCRIPT_RETENTION_LIMITS,
  transcriptRetentionEnvSource,
} from "./transcriptRetention"

export function transcriptRetentionSettingsState() {
  const saved = getSetting("transcriptRetentionDays")
  const effective = meridianTranscriptRetention()
  return {
    saved: isTranscriptRetentionDays(saved) ? saved : null,
    effective,
    envOverride: effective.source === "env",
    envSources: { transcriptRetentionDays: transcriptRetentionEnvSource() },
    default: DEFAULT_TRANSCRIPT_RETENTION_DAYS,
    limits: TRANSCRIPT_RETENTION_LIMITS,
  }
}

export async function transcriptRetentionSettingsResponse(request: Request, log: (line: string) => void): Promise<Response> {
  const headers = { "Cache-Control": "no-store" }
  if (request.method === "GET") return Response.json(transcriptRetentionSettingsState(), { headers })

  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Transcript retention settings require a same-origin request" }, { status: 403, headers })
  }
  let input: unknown
  try { input = await request.json() }
  catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }) }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Response.json({ error: "Settings must be a JSON object" }, { status: 400, headers })
  }
  const value = (input as Record<string, unknown>).transcriptRetentionDays
  if (value !== undefined) {
    if (value !== null && value !== 0 && !isTranscriptRetentionDays(value)) {
      const { min, max } = TRANSCRIPT_RETENTION_LIMITS
      return Response.json({
        error: `transcriptRetentionDays must be an integer between ${min} and ${max}, or 0 or null to turn retention off`,
      }, { status: 400, headers })
    }
    setSetting("transcriptRetentionDays", value === null || value === 0 ? undefined : value)
  }
  const state = transcriptRetentionSettingsState()
  log(`[PROXY] Transcript retention updated: ${state.effective.days === 0 ? "off" : `${state.effective.days}d`} (${state.effective.source})`)
  return Response.json(state, { headers })
}
