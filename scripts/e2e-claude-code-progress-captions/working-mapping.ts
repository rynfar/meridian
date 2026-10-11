/** Observe exactly the selected adapter's working slot; never borrow a root slot. */
export class MappingObservationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "MappingObservationError"
  }
}

export function selectWorkingMapping<T>(
  adapterSessionId: string | undefined,
  profileId: string,
  snapshot: Readonly<Record<string, T>>,
): { adapterSessionId: string; key: string; mapping: T } {
  if (!adapterSessionId) throw new MappingObservationError("working-adapter-session-missing")
  if (!profileId) throw new MappingObservationError("working-profile-missing")
  const key = profileId === "default" ? adapterSessionId : `${profileId}:${adapterSessionId}`
  if (!Object.hasOwn(snapshot, key)) throw new MappingObservationError("owned-working-mapping-missing")
  const mapping = snapshot[key]
  if (mapping === undefined || mapping === null) throw new MappingObservationError("owned-working-mapping-missing")
  return { adapterSessionId, key, mapping }
}
