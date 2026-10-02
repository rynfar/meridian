import { spawnSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { createRequire } from "node:module"
import { buildStore, certifyBuild, type BuildManifest } from "../src/proxy/buildArtifacts"
import { BuildProvenanceError, snapshotSource } from "../src/proxy/buildSnapshot"

const root = resolve(import.meta.dir, "..")
function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" })
  if (result.status !== 0) throw new BuildProvenanceError("gate")
}

function build(identity?: BuildManifest["build"]): void {
  const common = ["--target", "node", "--splitting", "--external", "@anthropic-ai/claude-agent-sdk", "--external", "jsonc-parser", "--entry-naming", "[name].js"]
  run("bun", ["build", "bin/cli.ts", "bin/session-bookkeeping.ts", "src/proxy/server.ts", "plugin/meridian-v2.ts", "--outdir", "dist", ...common, "--external", "libsql", ...(identity ? ["--define", `MERIDIAN_ARTIFACT_IDENTITY=${JSON.stringify(identity)}`] : [])])
  run("bun", ["build", "src/proxy/buildObservationWorker.ts", "--outdir", "dist", ...common])
  run("bun", ["build", "plugin/meridian/index.js", "--outdir", "dist/meridian", ...common])
  run("bun", ["build", "plugin/meridian-v2/index.js", "--outdir", "dist/meridian-v2", ...common])
  run("node", ["scripts/package-opencode-plugins.mjs"])
  run("node", [createRequire(import.meta.url).resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json"])
  run("node", ["scripts/fix-bun-exports.mjs"])
  for (const entry of ["cli.js", "server.js", "buildObservationWorker.js", "meridian-v2.js", "meridian/index.js", "meridian-v2/index.js"]) run("node", ["--check", `dist/${entry}`])
  if (!existsSync(resolve(root, "dist/proxy/server.d.ts"))) throw new BuildProvenanceError("gate")
}

export function canCertifyBuild(directory: string): boolean {
  if (!existsSync(resolve(directory, ".git"))) return false
  try {
    buildStore(directory)
    snapshotSource(directory)
    return true
  } catch (error) {
    if (error instanceof BuildProvenanceError && error.reason === "git") return false
    throw error
  }
}

if (import.meta.main) {
  if (canCertifyBuild(root)) {
    const manifest = certifyBuild(root, build)
    console.log(`Certified local build ${manifest.build.counter} (${manifest.build.attemptId})`)
  } else {
    console.warn("Local Git provenance unavailable; building uncertified archive")
    rmSync(resolve(root, "dist"), { recursive: true, force: true })
    build()
    console.log("Built source archive without local Git provenance")
  }
}
