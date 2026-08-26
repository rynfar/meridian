export interface ProfileActivationAttribution {
  readonly source: string
  readonly userAgent?: string | null
  readonly origin?: string | null
}

export interface ProfileActivationDeps {
  readonly getActiveProfileId: () => string | undefined
  readonly setActiveProfile: (profileId: string) => void
  readonly clearActiveProfile: () => void
  readonly clearSessionCache: () => void
  readonly logEvent: (event: string, fields: Record<string, unknown>) => void
  readonly logLine: (message: string) => void
}

export function activateProfile(
  profileId: string | undefined,
  attribution: ProfileActivationAttribution,
  deps: ProfileActivationDeps,
): void {
  const previousProfile = deps.getActiveProfileId() ?? null
  if (profileId) deps.setActiveProfile(profileId)
  else deps.clearActiveProfile()
  deps.clearSessionCache()
  deps.logEvent("profile.switched", {
    from: previousProfile,
    to: profileId ?? null,
    source: attribution.source,
    userAgent: attribution.userAgent ?? null,
    origin: attribution.origin ?? null,
  })
  deps.logLine(`[PROXY] Active profile switched to: ${profileId ?? "none"} (from ${previousProfile ?? "unset"}, source: ${attribution.source}) (session cache cleared)`)
}
