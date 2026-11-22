import { z } from "zod"

type OAuthResetGrantKind = "full" | "fable" | "unknown"

interface OAuthResetGrantMetadata {
  readonly kind: OAuthResetGrantKind
  readonly providerType?: string
  readonly clears?: readonly string[]
  readonly givesBackWeekly?: boolean
  readonly description?: string
  readonly percentUsed?: Readonly<Record<string, number>>
}

export interface OAuthBankedResetGrant extends Partial<OAuthResetGrantMetadata> {
  id: string | null
  resetsLeft: number
  expiresAt: number | null
  /** Epoch ms the grant becomes usable, or null when absent/unreadable. */
  startsAt: number | null
  /** Provider's flags; null when absent or not a boolean. */
  paused: boolean | null
  usableNow: boolean | null
}

export interface OAuthBankedResets {
  eligible: boolean
  /** Provider's reason the account is ineligible, or null when absent/unreadable. */
  ineligibleReason: string | null
  /** The grant the provider would redeem next; null unless it names a listed grant. */
  nextGrantId: string | null
  grants: OAuthBankedResetGrant[]
}

const grantMetadataSchema = z.object({
  type: z.string().optional().catch(undefined),
  clears: z.unknown().optional(),
  gives_back_weekly: z.boolean().optional().catch(undefined),
  label: z.string().optional().catch(undefined),
  percent_used: z.record(z.string(), z.number().min(0).max(100).optional().catch(undefined)).optional().catch(undefined),
})
const clearWindowsSchema = z.array(z.string().min(1)).nullish()
const FABLE_LAUNCH_GRANTS = new Set(["launch-2610-fable", "launch-2610-fable-6mo", "launch-2610-fable-12mo"])

export function parseResetGrantMetadata(grant: object, id: string | null): OAuthResetGrantMetadata {
  const metadata = grantMetadataSchema.parse(grant)
  const parsedClears = clearWindowsSchema.safeParse(metadata.clears)
  const clears = parsedClears.success ? parsedClears.data ?? undefined : undefined
  const scopeMissing = parsedClears.success && clears === undefined
  const givesBackWeekly = metadata.gives_back_weekly
  const percentUsed = metadata.percent_used === undefined ? undefined : Object.fromEntries(
    Object.entries(metadata.percent_used).filter((entry): entry is [string, number] => entry[0].length > 0 && entry[1] !== undefined),
  )

  let kind: OAuthResetGrantKind = "unknown"
  if (clears?.includes("seven_day") || (scopeMissing && id === "full-reset-2611" && givesBackWeekly !== true)) {
    kind = "full"
  } else if (id !== null && FABLE_LAUNCH_GRANTS.has(id) && givesBackWeekly !== false
    && (scopeMissing || (clears?.includes("seven_day_overage_included")
      && clears.every(window => window === "seven_day_overage_included" || window === "five_hour")))) {
    kind = "fable"
  }

  return {
    kind,
    ...(metadata.type === undefined ? {} : { providerType: metadata.type }),
    ...(clears === undefined ? {} : { clears }),
    ...(givesBackWeekly === undefined ? {} : { givesBackWeekly }),
    ...(metadata.label === undefined ? {} : { description: metadata.label }),
    ...(percentUsed === undefined ? {} : { percentUsed }),
  }
}
