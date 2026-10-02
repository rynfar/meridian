import Database from "libsql"
import { SessionLifecycleCorruptError } from "../lifecycleErrors"

export const BOOKKEEPING_APPLICATION_ID = 0x4d53424b
export const BOOKKEEPING_SCHEMA_VERSION = 1
export const RESOURCE_STATES = ["prepared", "live", "retired", "deleting", "deleted"] as const

/** libsql 0.5 get()/pluck() differs from better-sqlite3; use the row-array API. */
export function pragmaValue(db: Database.Database, name: string): unknown {
  const rows = db.pragma(name) as Array<Record<string, unknown>>
  return rows[0] && Object.values(rows[0])[0]
}

const integer = (name: string, optional = false, minimum = 0) =>
  `${name} INTEGER ${optional ? "" : "NOT NULL"} CHECK (${name} BETWEEN ${minimum} AND 9007199254740991)`
const json = (name: string, optional = true) =>
  `${name} TEXT ${optional ? "" : "NOT NULL"} CHECK (${name} IS NULL OR
    (json_valid(${name}) AND json_type(${name}) = 'object'))`

const statements = [
  `CREATE TABLE schema_meta (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), format TEXT NOT NULL CHECK(format='meridian-session-bookkeeping'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1), migration_id TEXT,
    source_digests_json TEXT CHECK(source_digests_json IS NULL OR json_valid(source_digests_json)),
    phase TEXT NOT NULL, store_meta_version INTEGER NOT NULL CHECK(store_meta_version IN (1,3))
  ) STRICT`,
  `CREATE TABLE resources (
    key TEXT PRIMARY KEY NOT NULL, generation TEXT UNIQUE NOT NULL,
    config_dir TEXT NOT NULL, project_dir TEXT, session_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','live','retired','deleting','deleted')),
    ${integer("created_at")}, ${integer("updated_at")}, ${integer("attempts")},
    ${integer("next_attempt_at", true)}, last_error TEXT, deletion_token TEXT,
    ${json("deletion_owner_json")}, ${json("deletion_executor_json")},
    ${integer("deletion_process_group_id", true, 1)}, ${integer("row_version", false, 1)},
    CHECK(state='deleting' OR (deletion_token IS NULL AND deletion_owner_json IS NULL
      AND deletion_executor_json IS NULL AND deletion_process_group_id IS NULL)),
    CHECK(deletion_executor_json IS NULL OR
      (deletion_owner_json IS NOT NULL AND deletion_process_group_id IS NOT NULL)),
    CHECK(deletion_process_group_id IS NULL OR deletion_executor_json IS NOT NULL)
  ) STRICT`,
  `CREATE TABLE resource_leases (
    resource_key TEXT NOT NULL REFERENCES resources(key) ON DELETE CASCADE,
    token TEXT NOT NULL CHECK(length(token)>0), purpose TEXT CHECK(purpose='publication'),
    ${json("owner_json", false)}, ${json("executor_json")},
    executor_recoverable INTEGER CHECK(executor_recoverable IN (0,1)), ${integer("created_at")},
    PRIMARY KEY(resource_key,token),
    CHECK(purpose IS NULL OR (executor_json IS NULL AND executor_recoverable IS NULL)),
    CHECK(executor_recoverable IS NULL OR executor_json IS NOT NULL)
  ) STRICT`,
  `CREATE TABLE fence_slots (
    namespace TEXT NOT NULL CHECK(namespace IN ('lifecycle','store')), slot TEXT NOT NULL,
    ${integer("counter")}, CHECK(namespace='store' OR counter>0), PRIMARY KEY(namespace,slot)
  ) STRICT`,
  `CREATE TABLE mappings (
    key TEXT PRIMARY KEY NOT NULL, claude_session_id TEXT NOT NULL CHECK(length(claude_session_id)>0),
    ${integer("revision", true, 1)}, generation_id TEXT CHECK(length(generation_id)>0),
    ${integer("created_at")}, ${integer("last_used_at")}, ${integer("message_count")},
    lineage_hash TEXT, previous_claude_session_id TEXT, ${json("context_usage_json")},
    passthrough_tool_call_assistant_uuid TEXT,
    passthrough_tool_call_ids_json TEXT CHECK(passthrough_tool_call_ids_json IS NULL OR
      (json_valid(passthrough_tool_call_ids_json) AND json_type(passthrough_tool_call_ids_json)='array')),
    ${json("current_locator_json")}, ${json("previous_locator_json")},
    generation_token TEXT NOT NULL, legacy_denial INTEGER NOT NULL CHECK(legacy_denial IN (0,1)),
    object_index INTEGER NOT NULL CHECK(object_index BETWEEN 0 AND 4294967295),
    insertion_order INTEGER NOT NULL UNIQUE CHECK(insertion_order BETWEEN 1 AND 9007199254740991)
  ) STRICT`,
  `CREATE TABLE mapping_history (
    mapping_key TEXT PRIMARY KEY NOT NULL REFERENCES mappings(key) ON DELETE CASCADE,
    encoding TEXT NOT NULL CHECK(encoding IN ('history','legacy-entry')),
    history_json TEXT NOT NULL CHECK(json_valid(history_json) AND json_type(history_json)='object')
  ) STRICT`,
  `CREATE TABLE mapping_pins (
    mapping_key TEXT NOT NULL REFERENCES mappings(key) ON DELETE CASCADE,
    slot TEXT NOT NULL CHECK(slot IN ('current','previous')), resource_key TEXT NOT NULL,
    generation TEXT, PRIMARY KEY(mapping_key,slot)
  ) STRICT`,
  `CREATE TABLE priority_assignments (
    route_key TEXT PRIMARY KEY NOT NULL, profile_id TEXT NOT NULL, last_human_turn_digest TEXT NOT NULL,
    ${integer("last_human_turn_issued_at")}, mapping_key TEXT NOT NULL, mapping_generation TEXT NOT NULL,
    generation_id TEXT NOT NULL, ${integer("updated_at")},
    insertion_order INTEGER NOT NULL UNIQUE CHECK(insertion_order BETWEEN 1 AND 9007199254740991)
  ) STRICT`,
  `CREATE TABLE priority_attempts (
    route_key TEXT PRIMARY KEY NOT NULL, blocked INTEGER NOT NULL CHECK(blocked IN (0,1)),
    blocked_turn_digest TEXT, ${integer("blocked_turn_issued_at", true)},
    pending_turn_digest TEXT, ${integer("pending_turn_issued_at", true)}, owner_token TEXT,
    generation_id TEXT NOT NULL, ${integer("updated_at")}
  ) STRICT`,
  `CREATE TABLE priority_rollbacks (
    route_key TEXT PRIMARY KEY NOT NULL REFERENCES priority_assignments(route_key) ON DELETE CASCADE,
    mapping_key TEXT NOT NULL, mapping_generation TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE bookkeeping_counts (kind TEXT PRIMARY KEY NOT NULL, ${integer("value")}) STRICT`,
  `CREATE TABLE legacy_exports (
    kind TEXT NOT NULL CHECK(kind IN ('resource','mapping')), key TEXT NOT NULL,
    projection_digest TEXT NOT NULL CHECK(length(projection_digest)=64),
    ${json("entry_json", false)}, PRIMARY KEY(kind,key)
  ) STRICT`,
  `CREATE TRIGGER resources_delete_export AFTER DELETE ON resources BEGIN
    DELETE FROM legacy_exports WHERE kind='resource' AND key=OLD.key; END`,
  `CREATE TRIGGER mappings_delete_export AFTER DELETE ON mappings BEGIN
    DELETE FROM legacy_exports WHERE kind='mapping' AND key=OLD.key; END`,
  "CREATE INDEX resources_due ON resources(state,coalesce(next_attempt_at,0),updated_at,key)",
  "CREATE INDEX retired_order ON resources(updated_at,key,next_attempt_at) WHERE state='retired'",
  "CREATE INDEX resources_deleted ON resources(updated_at DESC,key) WHERE state='deleted'",
  "CREATE INDEX resources_prepared ON resources(updated_at,key) WHERE state='prepared'",
  "CREATE INDEX resources_live ON resources(key) WHERE state='live'",
  "CREATE INDEX mappings_claude ON mappings(claude_session_id,legacy_denial,last_used_at DESC,object_index,insertion_order)",
  "CREATE INDEX mappings_lru ON mappings(last_used_at,key)",
  "CREATE INDEX rollback_mapping ON priority_rollbacks(mapping_key)",
  "CREATE INDEX pins_resource ON mapping_pins(resource_key,generation,mapping_key)",
  "CREATE INDEX assignments_mapping ON priority_assignments(mapping_key)",
]

for (const table of ["resources", "mappings", "priority_assignments", "priority_attempts"]) {
  const kind = (side: string) => (table === "resources" ? `'resources:' || ${side}.state` : `'${table}'`)
  statements.push(
    `CREATE TRIGGER ${table}_insert_count AFTER INSERT ON ${table} BEGIN
      UPDATE bookkeeping_counts SET value=value+1 WHERE kind=${kind("NEW")}; END`,
    `CREATE TRIGGER ${table}_delete_count AFTER DELETE ON ${table} BEGIN
      UPDATE bookkeeping_counts SET value=value-1 WHERE kind=${kind("OLD")}; END`,
  )
}
statements.push(`CREATE TRIGGER resources_state_count AFTER UPDATE OF state ON resources
  WHEN OLD.state != NEW.state BEGIN
  UPDATE bookkeeping_counts SET value=value-1 WHERE kind='resources:' || OLD.state;
  UPDATE bookkeeping_counts SET value=value+1 WHERE kind='resources:' || NEW.state; END`)
for (const event of ["INSERT", "UPDATE", "DELETE"]) {
  const predicate =
    event === "INSERT"
      ? "key=NEW.resource_key"
      : event === "DELETE"
        ? "key=OLD.resource_key"
        : "key IN (OLD.resource_key,NEW.resource_key)"
  statements.push(`CREATE TRIGGER leases_${event.toLowerCase()}_version AFTER ${event} ON resource_leases BEGIN
    UPDATE resources SET row_version=row_version+1 WHERE ${predicate}; END`)
}

const schemaSql = statements.join(";\n") + ";"
const schemaRows = (db: Database.Database) =>
  db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all()
let expectedSchema: string | undefined

/** Validate the authored DDL, not just a version label on an arbitrary database. */
export function validateBookkeepingSchema(db: Database.Database, phase = "READY", full = true): void {
  if (expectedSchema === undefined) {
    const reference = new Database(":memory:")
    try {
      reference.exec(schemaSql)
      expectedSchema = JSON.stringify(schemaRows(reference))
    } finally {
      reference.close()
    }
  }
  const meta = db.prepare("SELECT * FROM schema_meta").all() as Array<Record<string, unknown>>
  if (
    pragmaValue(db, "application_id") !== BOOKKEEPING_APPLICATION_ID ||
    pragmaValue(db, "user_version") !== BOOKKEEPING_SCHEMA_VERSION ||
    meta.length !== 1 ||
    meta[0]?.schema_version !== BOOKKEEPING_SCHEMA_VERSION ||
    meta[0]?.format !== "meridian-session-bookkeeping" ||
    meta[0]?.phase !== phase ||
    JSON.stringify(schemaRows(db)) !== expectedSchema
  ) {
    throw new SessionLifecycleCorruptError(
      "bookkeeping schema/version/phase mismatch; export with the build that created it, then migrate",
    )
  }
  if (!full) return
  if (pragmaValue(db, "quick_check") !== "ok" || (db.pragma("foreign_key_check") as unknown[]).length) {
    throw new SessionLifecycleCorruptError("bookkeeping integrity check failed")
  }
  validateBookkeepingCounts(db)
}

export function validateBookkeepingCounts(db: Database.Database): void {
  const expected = [
    ...RESOURCE_STATES.map((state) => ({
      kind: `resources:${state}`,
      value: (db.prepare("SELECT count(*) AS n FROM resources WHERE state=?").get(state) as { n: number }).n,
    })),
    ...["mappings", "priority_assignments", "priority_attempts"].map((table) => ({
      kind: table,
      value: (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
    })),
  ].sort((a, b) => a.kind.localeCompare(b.kind))
  const actual = db.prepare("SELECT kind,value FROM bookkeeping_counts").all() as typeof expected
  actual.sort((a, b) => a.kind.localeCompare(b.kind))
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new SessionLifecycleCorruptError("bookkeeping counters disagree with rows")
}

export function initializeBookkeepingSchema(db: Database.Database, allowCreate = false): void {
  const empty = (db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number }).n === 0
  if (
    empty &&
    allowCreate &&
    pragmaValue(db, "user_version") === 0 &&
    pragmaValue(db, "application_id") === 0
  ) {
    db.exec(schemaSql)
    db.pragma(`application_id=${BOOKKEEPING_APPLICATION_ID}`)
    db.pragma(`user_version=${BOOKKEEPING_SCHEMA_VERSION}`)
    db.exec("INSERT INTO schema_meta VALUES(1,'meridian-session-bookkeeping',1,NULL,NULL,'READY',1)")
    for (const kind of [
      ...RESOURCE_STATES.map((state) => `resources:${state}`),
      "mappings",
      "priority_assignments",
      "priority_attempts",
    ]) {
      db.prepare("INSERT INTO bookkeeping_counts VALUES(?,0)").run(kind)
    }
  }
  validateBookkeepingSchema(db)
}
