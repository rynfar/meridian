let holders = 0
let directory: string | undefined

/** Addressing a retained runtime must not rediscover the default directory inside SQL scopes. */
export function retainedBookkeepingRuntimeDirectory(): string | undefined {
  return directory
}

export function retainBookkeepingRuntimeIdentity(resolvedDirectory: string): () => void {
  if (directory !== undefined && directory !== resolvedDirectory)
    throw new Error("cannot change session store directory while SQLite proxies are running")
  directory = resolvedDirectory
  holders++
  let released = false
  return () => {
    if (!released) {
      released = true
      holders--
      if (!holders) directory = undefined
    }
  }
}

export function assertBookkeepingRuntimeIdentityChangeAllowed(): void {
  if (holders) throw new Error("cannot change session store directory while SQLite proxies are running")
}
