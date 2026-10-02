import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { captureProcessIncarnation } from "../../proxy/session/processIncarnation"

/** Synthetic legacy candidates, gates and interrupted-write files. */
export function seedResidueInventory(directory: string): string[] {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
  const files: Record<string, string> = {}
  const incarnation = captureProcessIncarnation()
  if (!incarnation) throw new Error("fixture requires OS-backed process incarnation")
  for (let i = 0; i < 4; i++) files[`session-gc.json.lock.candidate-186548-${uuid(i)}`] = JSON.stringify({
    incarnation: { ...incarnation, pid: 186548, bootId: "00000000-0000-0000-0000-000000000001" },
  })
  files[`deletion-gates/${uuid(4)}.go`] = "go\n"
  for (let i = 0; i < 14; i++) files[`sdk-process-gates/186548-${uuid(i + 5)}.gate`] = "#!/bin/sh\nexit 0\n"
  for (let i = 0; i < 3; i++) files[`session-gc.json.tmp-2147483647-${uuid(i + 19)}`] = ""
  files[`session-gc.json.tmp-2147483647-${uuid(22)}`] = '{"version":2,"partial":"sidecar"}'
  files[`sessions.json.tmp-2147483647-${uuid(23)}`] = '{"partial":"store"}'
  for (const name of ["deletion-gates", "sdk-process-gates", "turn-locks"]) {
    mkdirSync(join(directory, name), { mode: 0o700 })
  }
  for (let i = 0; i < 42; i++) writeFileSync(join(directory, "turn-locks", `${i}.lock`), `turn-${i}`, { mode: 0o600 })
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(directory, name), bytes, { mode: 0o600 })
  return Object.keys(files)
}
