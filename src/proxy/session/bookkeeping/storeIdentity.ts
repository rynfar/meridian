// Kept independent of connection.ts: importing the JSON facade must not load a native SQL backend.
import { assertBookkeepingRuntimeIdentityChangeAllowed } from "./runtimeIdentity"
let scopes = 0

export function assertBookkeepingIdentityChangeAllowed(): void {
  if (scopes) throw new Error("cannot change session store identity during a bookkeeping transaction")
  assertBookkeepingRuntimeIdentityChangeAllowed()
}

export function assertLegacyStoreAccessAllowed(): void {
  if (scopes) throw new Error("JSON session store cannot run inside a bookkeeping transaction; select a SQL backend")
}

export function enterBookkeepingIdentityScope(): () => void {
  scopes++
  let released = false
  return () => {
    if (!released) {
      released = true
      scopes--
    }
  }
}
