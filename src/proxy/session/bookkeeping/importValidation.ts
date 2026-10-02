import Database from "libsql"
import { initializeBookkeepingSchema, validateBookkeepingSchema } from "./schema"
import { checkParameters, getRow } from "./connection"
import type { BookkeepingTransaction, SqlRow } from "./types"

/** Exercise the exact row codecs, bindings, triggers and constraints without publishing authority. */
export function validateImportTransaction(importRows: (tx: BookkeepingTransaction) => void): void {
  const db = new Database(":memory:")
  try {
    db.pragma("foreign_keys=ON")
    db.exec("BEGIN IMMEDIATE")
    initializeBookkeepingSchema(db, true)
    const tx: BookkeepingTransaction = {
      get: (sql, ...parameters) => getRow(db, sql, parameters),
      all(sql, ...parameters) {
        checkParameters(parameters)
        return db.prepare(sql).all(...parameters) as SqlRow[]
      },
      run(sql, ...parameters) {
        checkParameters(parameters)
        return db.prepare(sql).run(...parameters).changes
      },
      afterCommit() { throw new Error("import validation must not register effects") },
    }
    importRows(tx)
    validateBookkeepingSchema(db, "READY")
  } finally {
    try { if (db.inTransaction) db.exec("ROLLBACK") } finally { db.close() }
  }
}
