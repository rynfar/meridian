import { withBookkeepingRead, withBookkeepingWrite } from "./transaction"
import type { BookkeepingReader, BookkeepingTransaction } from "./types"

/** No implicit initialization, no LRU: the initialized directory identifies the engine connection. */
export function withStoreRead<T>(directory: string, operation: (reader: BookkeepingReader) => T): T {
  return withBookkeepingRead(directory, operation)
}

/** Native timeout 0; joins only explicit store/publication scopes. Store operations own their afterCommit hooks. */
export function withStoreWrite<T>(directory: string, operation: (tx: BookkeepingTransaction) => T): T {
  return withBookkeepingWrite(directory, { scope: "store" }, operation)
}
