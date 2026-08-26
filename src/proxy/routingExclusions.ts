export type RoutingPurpose = "work" | "warm"

type ResolveRoutingAccessInput = {
  readonly purpose: RoutingPurpose
  readonly availableProfileIds: readonly string[]
  readonly excludedProfileIds: readonly string[]
  readonly explicitProfileId?: string
}

export type RoutingAccess =
  | { readonly kind: "allowed"; readonly eligibleProfileIds: readonly string[] }
  | { readonly kind: "explicit_excluded"; readonly profileId: string }
  | { readonly kind: "no_eligible_profiles" }

export function parseRoutingExcludedProfiles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((profileId): profileId is string => typeof profileId === "string"))]
}

export function mergeRoutingExcludedProfiles(
  manualProfileIds: readonly string[],
  managedProfileIds: readonly string[],
): string[] {
  return [...new Set([...manualProfileIds, ...managedProfileIds])]
}

export function filterEligibleProfileIds(
  profileIds: readonly string[],
  excludedProfileIds: readonly string[],
): string[] {
  if (excludedProfileIds.length === 0) return [...profileIds]
  const excluded = new Set(excludedProfileIds)
  return profileIds.filter(profileId => !excluded.has(profileId))
}

export function resolveRoutingAccess(input: ResolveRoutingAccessInput): RoutingAccess {
  switch (input.purpose) {
    case "warm":
      return { kind: "allowed", eligibleProfileIds: [...input.availableProfileIds] }
    case "work": {
      const excluded = new Set(input.excludedProfileIds)
      if (input.explicitProfileId && excluded.has(input.explicitProfileId)) {
        return { kind: "explicit_excluded", profileId: input.explicitProfileId }
      }
      const eligibleProfileIds = filterEligibleProfileIds(
        input.availableProfileIds,
        input.excludedProfileIds,
      )
      return eligibleProfileIds.length > 0
        ? { kind: "allowed", eligibleProfileIds }
        : { kind: "no_eligible_profiles" }
    }
    default: {
      const exhaustive: never = input.purpose
      return exhaustive
    }
  }
}
