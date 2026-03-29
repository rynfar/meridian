import type { ProfileConfig, ProfileType, ProxyConfig } from "./types"

export const DEFAULT_PROFILE_ID = "default"

export interface ResolvedProfile {
  id: string
  type: ProfileType
  claudeExecutable?: string
  env: Record<string, string | undefined>
}

function getProfileType(profile: ProfileConfig): ProfileType {
  return profile.type ?? "claude-max"
}

function getEnvValue(directValue: string | undefined, envName: string | undefined): string | undefined {
  if (directValue) return directValue
  if (!envName) return undefined
  return process.env[envName]
}

function buildProfileEnv(profile: ProfileConfig): Record<string, string | undefined> {
  const type = getProfileType(profile)

  if (type === "api") {
    return {
      ANTHROPIC_API_KEY: getEnvValue(profile.apiKey, profile.apiKeyEnv),
      ANTHROPIC_BASE_URL: profile.baseUrl,
      ANTHROPIC_AUTH_TOKEN: getEnvValue(profile.authToken, profile.authTokenEnv),
    }
  }

  return {
    ...(profile.claudeConfigDir ? { CLAUDE_CONFIG_DIR: profile.claudeConfigDir } : {}),
  }
}

export function resolveProfile(config: ProxyConfig, requestedProfileId?: string): ResolvedProfile {
  const configuredProfiles = config.profiles ?? []

  if (configuredProfiles.length === 0) {
    return {
      id: requestedProfileId ?? config.defaultProfile ?? DEFAULT_PROFILE_ID,
      type: "claude-max",
      env: {},
    }
  }

  const resolvedId = requestedProfileId ?? config.defaultProfile ?? configuredProfiles[0]!.id
  const profile = configuredProfiles.find((candidate) => candidate.id === resolvedId)
  if (!profile) {
    throw new Error(`Unknown profile: ${resolvedId}`)
  }

  return {
    id: profile.id,
    type: getProfileType(profile),
    claudeExecutable: profile.claudeExecutable,
    env: buildProfileEnv(profile),
  }
}
