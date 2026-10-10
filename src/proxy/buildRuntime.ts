import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ZodError } from "zod"
import { detectBuildSource, getBuildInfo, isUpdateAvailable, type BuildInfo } from "./buildInfo"
import { buildManifestSchema, readCertifiedBuild } from "./buildArtifacts"
import { BuildProvenanceError, snapshotSource, sourceIdentity } from "./buildSnapshot"
import { compareLocalBuilds, type BuildState, type BuildStatus } from "./localBuildInfo"
import { createBuildObserver, observeInWorker } from "./buildObserver"

declare const MERIDIAN_ARTIFACT_IDENTITY: unknown

function packageRoot(modulePath: string): string {
  let current = dirname(fileURLToPath(modulePath))
  while (!existsSync(join(current, "package.json"))) {
    const parent = dirname(current)
    if (parent === current) throw new BuildProvenanceError("invalid")
    current = parent
  }
  return current
}

function unavailable(error: unknown): BuildState {
  if (error instanceof BuildProvenanceError) return error.reason === "building" ? "building" : "invalid"
  if (error instanceof Error && "code" in error) return error.code === "ENOENT" ? "missing" : "invalid"
  if (error instanceof SyntaxError || error instanceof ZodError) return "invalid"
  throw error
}

export function captureBuildRuntime(input: {
  readonly modulePath: string
  readonly root: string
  readonly embedded?: unknown
  readonly env?: NodeJS.ProcessEnv
  readonly background?: boolean
}) {
  const source = input.modulePath.includes("node_modules") ? "npm" : detectBuildSource(input.modulePath, input.env?.MERIDIAN_BUILD_SOURCE)
  const fallback = getBuildInfo({ version: "unknown", modulePath: input.modulePath, env: input.env ?? {} })
  let captured: Readonly<BuildInfo>
  if (source === "npm") captured = Object.freeze({ ...fallback, source })
  else if (input.embedded !== undefined) {
    const embedded = buildManifestSchema.shape.build.safeParse(input.embedded)
    try {
      const disk = readCertifiedBuild(input.root)
      if (!embedded.success || JSON.stringify(disk.build) !== JSON.stringify(embedded.data)) throw new BuildProvenanceError("invalid")
      captured = Object.freeze({ ...embedded.data, source })
    } catch (error) {
      unavailable(error)
      captured = Object.freeze({ ...fallback, source, version: embedded.success ? embedded.data.version : "unknown", kind: "artifact", certification: "unknown" })
    }
  } else if (/\/dist\//.test(input.modulePath)) {
    captured = Object.freeze({ ...fallback, source })
  } else {
    try {
      const snapshot = snapshotSource(input.root)
      captured = Object.freeze({ ...snapshot, source, kind: "source", displayVersion: `${snapshot.releaseVersion ?? snapshot.version}+source` })
    } catch (error) {
      unavailable(error)
      let identity = {}
      try { identity = sourceIdentity(input.root) } catch (identityError) { unavailable(identityError) }
      captured = Object.freeze({ ...fallback, ...identity, source, kind: "source" })
    }
  }
  const runtime = captured
  const comparable = (runtime.certification === "verified" && !!runtime.counterScope) || !!runtime.sourceHash
  const observer = input.background && source !== "npm" && comparable ? createBuildObserver(() => observeInWorker(input.root, runtime.kind)) : undefined
  return {
    local: source !== "npm",
    info(version?: string, latest?: string): BuildInfo {
      const current = version ?? runtime.version
      return { ...runtime, version: current, ...(latest ? { latest, updateAvailable: isUpdateAvailable(current, latest) } : {}) }
    },
    status(): BuildStatus {
      if (source === "npm" || !comparable) return { runtime, state: "unknown" }
      if (observer) {
        const observation = observer.read()
        return observation.latest ? { runtime, latest: observation.latest, ...compareLocalBuilds(runtime, observation.latest) } : { runtime, state: observation.state }
      }
      try {
        const latest: BuildInfo = runtime.kind === "source"
          ? { ...snapshotSource(input.root), source, kind: "source" }
          : readCertifiedBuild(input.root).build
        return { runtime, latest, ...compareLocalBuilds(runtime, latest) }
      } catch (error) { return { runtime, state: unavailable(error) } }
    },
  }
}

export const buildRuntime = captureBuildRuntime({
  modulePath: import.meta.url,
  root: packageRoot(import.meta.url),
  embedded: typeof MERIDIAN_ARTIFACT_IDENTITY === "undefined" ? undefined : MERIDIAN_ARTIFACT_IDENTITY,
  env: { ...process.env },
  background: true,
})
