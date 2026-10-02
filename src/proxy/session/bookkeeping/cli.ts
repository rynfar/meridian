import { existsSync } from "node:fs"
import { join } from "node:path"
import { inspectBookkeeping, inspectionDirectory, BookkeepingOwnerMismatchError } from "./inspect"
import type { Inspection } from "./inspect"
import { migrateBookkeeping } from "./migration"
import { exportBookkeepingJson } from "./exportJson"
import { abortBookkeepingMigration } from "./abortMigration"
import { recanonicalizeBookkeeping } from "./recanonicalize"
import { barrierBytes, observeMaintenancePhases, readJournal, SOURCE_NAMES } from "./maintenanceJournal"
import { protectedBytes, readExportJournal } from "./exportJournal"
import { BookkeepingBusyError, BookkeepingMaintenanceRequiredError, errorCode } from "./storagePaths"
import { BookkeepingBarrierReplacedError } from "./barrier"
import { preflightLegacyMigration, refuseUnjournaledDatabase } from "./maintenancePreflight"
import { SessionStoreLockTimeoutError } from "../storeErrors"
import { SessionLifecycleLockError } from "../lifecycleErrors"
import { recoverGuardRetirements } from "./guardRecovery"
import { recoverBootstrapAliases } from "./bootstrapRecovery"

const HELP = `meridian-bookkeeping <inspect|migrate|export-json|recanonicalize|abort-migration|recover-guard-retirement|recover-bootstrap>
  --session-dir <directory> [--json] [--writers-stopped]
Stop and drain all writers before maintenance. migrate requires --writers-stopped
(missing attestation exits 2). inspect is read-only and may run beside a live proxy.
Exit codes: 0 done/already target; 2 usage; 3 refused before transition (old binary safe
only if the starting state was legacy); 4 barriers/export active: do NOT start an old
binary; 5 corrupt/unreadable state or replaced barrier; 6 caller/directory uid mismatch.
After 4: resume migrate, abort-migration for pre-database or provably empty PREPARED state, or resume export-json.
Never remove barriers manually. Both *.json.lock files contain a JSON line:
{"backend":"sqlite","migration_id":"<uuid>","format":"meridian-bookkeeping-barrier-v1",
"instruction":"Stop all writers; use meridian-bookkeeping export-json. Never delete this barrier manually."}
This is deliberately NOT a legacy canonical pid/incarnation/token lock owner.
--json includes timings.total_ms and timings.phases (phase and duration_ms).
Gate files without incarnations are unknown. Both documents' .tmp-<pid>-<uuid> files
are inventoried with bytes/digest, empty or not: a live local PID refuses; otherwise unknown.
migrate --writers-stopped archives unknown/dead residues under bookkeeping-cycles/<migration_id>/residue/;
the attestation includes stopped deletion/SDK children. Live candidates refuse with their path.
Post-READY unknown gates require export-json --writers-stopped; this journals and archives them, never infers child death.
Published maintenance guards are permanent. Historical guard-retirement intents refuse all ordinary commands.
recover-guard-retirement --writers-stopped cancels intents only after restoring and exclusively locking the ORIGINAL inode;
a different public guard or missing original inode refuses (operator-approved coherent backup restore, never manual unlink).
In-process inspect refuses while any local SQLite owner exists; invoke the CLI in a separate process.
Bootstrap link-window residues are reported read-only as kind=bootstrap-alias (not a READY certification).
recover-bootstrap --writers-stopped takes exclusive ownership and retires only proven-dead private aliases;
live/unknown/missing owner or foreign inode refuses even with attestation. migrate/export-json with the
explicit stopped flag also perform this recovery before their normal phase checks. Never unlink public SQLite names.
`
const COMMANDS = ["inspect", "migrate", "export-json", "recanonicalize", "abort-migration", "recover-guard-retirement", "recover-bootstrap"]
class UsageError extends Error {}
function parse(args: string[]) {
  const command = args[0]
  if (!command || !COMMANDS.includes(command)) throw new UsageError("unknown or missing command")
  let directory: string | undefined
  let json = false
  let writersStopped = false
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--session-dir" && directory === undefined && args[index + 1]
      && !args[index + 1]!.startsWith("--")) directory = args[++index]
    else if (arg === "--json" && !json) json = true
    else if (arg === "--writers-stopped" && ["migrate", "export-json", "recover-guard-retirement", "recover-bootstrap"].includes(command) && !writersStopped) writersStopped = true
    else throw new UsageError(`unexpected argument: ${arg}`)
  }
  if (!directory) throw new UsageError("--session-dir is required")
  if (["migrate", "recover-guard-retirement", "recover-bootstrap"].includes(command) && !writersStopped) throw new UsageError(`${command} requires --writers-stopped`)
  return { command, directory, json, writersStopped }
}

function unsafeState(directory: string): boolean {
  const exported = readExportJournal(directory, true)
  const migration = readJournal(directory, true)
  if (migration && SOURCE_NAMES.some((source) => {
    const path = join(directory, source + ".lock")
    const releasing = migration.releases?.[source]?.name
    return Boolean(releasing && existsSync(join(directory, releasing)))
      || (existsSync(path) && protectedBytes(path, false, true).toString("utf8") === barrierBytes(migration.id))
  })) return true
  return Boolean(exported && exported.phase !== "EXPORTED")
    || Boolean(migration && !["PREPARED", "ABORTED"].includes(migration.phase) && exported?.phase !== "EXPORTED")
}

export async function runBookkeepingCli(args: string[], afterMigrationPreflightForTest?: () => void): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) { console.log(HELP); return 0 }
  const started = performance.now()
  let previous = started
  const phases: Array<{ phase: string; duration_ms: number }> = []
  const record = (phase: string) => {
    const now = performance.now()
    phases.push({ phase, duration_ms: now - previous })
    previous = now
  }
  let directory: string | undefined
  let before: Inspection | undefined
  let after: Inspection | undefined
  let result: unknown
  let failure: unknown
  let code = 0
  const stop = observeMaintenancePhases(record)
  try {
    const options = parse(args)
    directory = inspectionDirectory(options.directory)
    if (options.command === "migrate") refuseUnjournaledDatabase(directory)
    try { before = inspectBookkeeping(directory) } catch (error) {
      if (!["abort-migration", "recover-guard-retirement"].includes(options.command)) throw error
      // Invalid legacy JSON is the main reason to abort a pre-database migration.
      if (error instanceof BookkeepingBusyError || error instanceof BookkeepingOwnerMismatchError) throw error
    }
    record("inspect")
    const bootstrap = before?.temporary.filter(row => row.kind === "bootstrap-alias") ?? []
    if (options.command !== "inspect" && bootstrap.length) {
      if (!options.writersStopped || bootstrap.some(row => row.verdict !== "dead-incarnation"))
        throw new BookkeepingMaintenanceRequiredError("bootstrap alias requires dead-owner proof and recover-bootstrap --writers-stopped")
      recoverBootstrapAliases(directory, { writersStopped: true })
      before = inspectBookkeeping(directory)
      record("bootstrap-recovered")
    }
    if (options.command === "inspect") after = before
    else {
      const active = [...(before?.candidates ?? []), ...(before?.gates ?? []), ...(before?.temporary ?? [])].find((row) =>
        row.verdict === "live" || (row.verdict === "unknown" && !options.writersStopped))
      if (active && !(options.command === "migrate" && before?.phase === "ready")) {
        throw new BookkeepingMaintenanceRequiredError(`${active.verdict} candidate/gate/temporary residue: ${active.path}`)
      }
      if (options.command === "export-json" && before && !["ready", "exporting", "exported"].includes(before.phase)) {
        throw new BookkeepingMaintenanceRequiredError("export requires a READY migration journal")
      }
      if (options.command === "abort-migration" && before && !["barriers", "aborted"].includes(before.phase)) {
        throw new BookkeepingMaintenanceRequiredError("abort requires a BARRIERS migration journal")
      }
      if (options.command === "recanonicalize" && before?.phase !== "ready") {
        throw new BookkeepingMaintenanceRequiredError("recanonicalize requires READY")
      }
      if (options.command === "migrate") {
        if (before?.phase === "ready" && Object.values(before.barriers).some((value) => value !== "own")) {
          throw new Error("READY requires both own barriers")
        }
        if (before && ["legacy", "prepared", "exported", "aborted"].includes(before.phase)) {
          preflightLegacyMigration(directory)
        }
        result = before?.phase === "ready" ? { already_ready: true }
          : await migrateBookkeeping(directory, { writersStopped: options.writersStopped,
            afterPreflightForTest: afterMigrationPreflightForTest })
      } else if (options.command === "export-json") result = exportBookkeepingJson(directory, { writersStopped: options.writersStopped })
      else if (options.command === "recanonicalize") result = recanonicalizeBookkeeping(directory)
      else if (options.command === "recover-guard-retirement") recoverGuardRetirements(directory, { writersStopped: options.writersStopped })
      else if (options.command === "recover-bootstrap") recoverBootstrapAliases(directory, { writersStopped: options.writersStopped })
      else abortBookkeepingMigration(directory)
      // Abort preserves malformed source bytes; a successful abort need not make those bytes parseable.
      if (options.command === "abort-migration") {
        result = { phase: "aborted" }
        if (before) after = { ...before, phase: "aborted",
          barriers: Object.fromEntries(Object.keys(before.barriers).map((name) => [name, "none" as const])) }
      }
      else after = inspectBookkeeping(directory)
    }
  } catch (error) {
    failure = error
    if (error instanceof UsageError) code = 2
    else if (error instanceof BookkeepingOwnerMismatchError) code = 6
    else if (error instanceof BookkeepingBarrierReplacedError) code = 5
    else if (error instanceof SessionLifecycleLockError || error instanceof SessionStoreLockTimeoutError
      || error instanceof BookkeepingMaintenanceRequiredError
      || errorCode(error) === "ENOSPC") {
      try { code = directory && unsafeState(directory) ? 4 : 3 } catch { code = 5 }
    } else code = 5
  } finally { stop(); record("complete") }
  const output = { ...(after ?? before ?? { phase: code === 0 ? "aborted" : "corrupt",
    migration_id: null, cycle_id: null, cycle_number: null, archived_cycles: null,
    resources: null, mappings: null, sizes: null, barriers: null, candidates: null, gates: null, temporary: null }),
    ...(code === 5 ? { phase: "corrupt" } : {}), exit_code: code, result,
    ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
    ...(code === 4 ? { hint: "Do not start legacy writers. Resume migrate / abort-migration / export-json." } : {}),
    timings: { total_ms: performance.now() - started, phases } }
  if (args.includes("--json")) console.log(JSON.stringify(output))
  else console.log(JSON.stringify(output, null, 2))
  return code
}
