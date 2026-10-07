import { mkdirSync, writeFileSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"

/** Acceptance output wins over the development artifact directory when both are set. */
export function writeBenchArtifact(name: string, value: unknown): void {
  const directory = process.env.BOOKKEEPING_ACCEPTANCE_OUT || process.env.BOOKKEEPING_BENCH_ARTIFACTS
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n")
}
export function buildNodeFixture(name: string, output: string, directory: string) {
  symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "junction")
  return Bun.build({
    entrypoints: [resolve("src/__tests__/fixtures", name)],
    target: "node",
    naming: output,
    outdir: directory,
    external: ["libsql"],
  })
}
