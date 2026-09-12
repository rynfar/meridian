/**
 * The account's plan, as Anthropic reports it for a given access token.
 *
 * Shared by the two moments a plan can be learned: an interactive login, which
 * has just minted a token, and a token refresh, which has just minted another.
 * It lives in its own module rather than in profileCli.ts because profileCli
 * already imports tokenRefresh for the credential store, so the refresh path
 * importing back would close a cycle.
 *
 * This is a leaf module — one authenticated GET, no imports.
 */

/**
 * Where the account's plan comes from — not the token endpoint.
 *
 * Everything Claude Code reads off a token response is `access_token`,
 * `refresh_token`, `expires_in`, `scope`, `account.{uuid,email_address}` and
 * `organization.uuid`. It derives `subscriptionType` / `rateLimitTier` from a
 * separate authenticated GET here, then writes them into the same
 * `.credentials.json` Meridian shares with it — so a headless login has to ask
 * for them too. Note the host differs from the token endpoint; reached with
 * the `user:profile` scope, which every login already requests.
 */
const OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"

interface OAuthProfileResponse {
  organization?: {
    organization_type?: string | null
    rate_limit_tier?: string | null
  } | null
}

export interface OAuthPlanFields {
  subscriptionType?: string
  rateLimitTier?: string
}

/**
 * Translate Anthropic's wire `organization_type` into the vocabulary the Claude
 * CLI writes on disk — the wire value is prefixed (`claude_max`), the stored one
 * is not (`max`). Mirroring the CLI's own mapping is what keeps a credential
 * file Meridian writes indistinguishable from one `claude login` wrote, which
 * matters because `claude auth status` reads it back and is what ultimately
 * feeds `/profiles/list`, `/health` and the `max`-only branch of `/v1/models`.
 *
 * An unrecognized or absent type yields undefined so the caller omits the key,
 * rather than inventing a plan for an account it could not identify.
 */
export function subscriptionTypeFromOrganizationType(
  organizationType: string | null | undefined,
): string | undefined {
  switch (organizationType) {
    case "claude_max": return "max"
    case "claude_pro": return "pro"
    case "claude_team": return "team"
    case "claude_enterprise": return "enterprise"
    default: return undefined
  }
}

export function extractPlanFields(profile: OAuthProfileResponse | null | undefined): OAuthPlanFields {
  const subscriptionType = subscriptionTypeFromOrganizationType(profile?.organization?.organization_type)
  const rateLimitTier = profile?.organization?.rate_limit_tier
  return {
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(rateLimitTier ? { rateLimitTier } : {}),
  }
}

/**
 * Whether a stored credential is still missing plan information.
 *
 * Either field being absent counts, because they answer different questions
 * and arrive from different writers: `claude login` records `subscriptionType`
 * but not always `rateLimitTier`, and only `rateLimitTier` distinguishes Max 5x
 * from Max 20x. Requiring both means a file half-filled by the CLI still gets
 * completed.
 */
export function planFieldsMissing(fields: OAuthPlanFields | null | undefined): boolean {
  return !fields?.subscriptionType || !fields?.rateLimitTier
}

/**
 * Best-effort plan lookup for a valid access token. Never throws and never
 * fails its caller: a profile whose plan is unknown is strictly better than no
 * profile at all, and every consumer already treats it as optional.
 */
export async function fetchOAuthPlanFields(accessToken: string): Promise<OAuthPlanFields> {
  let response: Response
  try {
    response = await fetch(OAUTH_PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    console.warn(`[meridian] Could not read the account plan: ${err instanceof Error ? err.message : err}`)
    return {}
  }

  if (!response.ok) {
    console.warn(`[meridian] Could not read the account plan (${response.status}).`)
    return {}
  }

  try {
    return extractPlanFields(await response.json() as OAuthProfileResponse)
  } catch (err) {
    console.warn(`[meridian] Account plan response was not valid JSON: ${err instanceof Error ? err.message : err}`)
    return {}
  }
}
