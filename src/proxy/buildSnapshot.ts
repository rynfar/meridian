import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, readlinkSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { compareVersions } from "./buildInfo"
import { repositoryLinks } from "./localBuildInfo"

import { BuildProvenanceError } from "./buildProvenanceError"
import { fingerprintBudget, hashFileInto, readProvenanceText } from "./buildFingerprint"
export { BuildProvenanceError } from "./buildProvenanceError"

export function gitOutput(root: string, args: readonly string[], timeout = 2000): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
  if (result.status !== 0) throw new BuildProvenanceError("git")
  return result.stdout.trimEnd()
}

/** The commit a source tree runs, without its content fingerprint: what a
 *  runtime still reports when the fingerprint does not fit its two-second
 *  budget, as on a heavily loaded host. Not comparable, since a sha alone
 *  cannot tell an edited tree from the one that started. */
export function sourceIdentity(root: string) {
  const git = (args: readonly string[]) => gitOutput(root, args)
  if (realpathSync(git(["rev-parse", "--show-toplevel"])) !== realpathSync(root)) throw new BuildProvenanceError("invalid")
  const sha = git(["rev-parse", "HEAD"])
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"])
  let dirty: boolean | undefined
  try { dirty = git(["status", "--porcelain=v1", "--untracked-files=all"]).length > 0 }
  catch (error) { if (!(error instanceof BuildProvenanceError)) throw error }
  let remote = ""
  try { remote = git(["config", "--get", "remote.origin.url"]) }
  catch (error) { if (!(error instanceof BuildProvenanceError)) throw error }
  return {
    sha, ...(branch !== "HEAD" ? { branch } : {}), ...(dirty !== undefined ? { dirty } : {}),
    ...repositoryLinks(remote, branch !== "HEAD" ? branch : undefined, sha),
  }
}

export function snapshotSource(root: string) {
  const budget = fingerprintBudget()
  const git = (args: readonly string[]) => gitOutput(root, args, Math.min(2000, budget.remainingMs()))
  if (realpathSync(git(["rev-parse", "--show-toplevel"])) !== realpathSync(root)) throw new BuildProvenanceError("invalid")
  const version = z.object({ version: z.string() }).parse(JSON.parse(readProvenanceText(join(root, "package.json"), 1024 * 1024))).version
  const sha = git(["rev-parse", "HEAD"])
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"])
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"])
  const files = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean).sort()
  const hash = createHash("sha256").update(sha).update("\0").update(branch).update("\0").update(status)
  for (const file of new Set(files)) {
    budget.entry()
    hash.update("\0").update(file).update("\0")
    try {
      const path = join(root, file)
      const stat = lstatSync(path)
      hash.update(String(stat.mode)).update("\0")
      if (stat.isSymbolicLink()) hash.update(readlinkSync(path))
      else if (stat.isFile()) hashFileInto(hash, path, budget)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") hash.update("deleted")
      else throw error
    }
  }
  let remote = ""
  let releaseVersion: string | undefined
  try { remote = git(["config", "--get", "remote.origin.url"]) }
  catch (error) { if (!(error instanceof BuildProvenanceError)) throw error }
  try {
    const tag = git(["describe", "--tags", "--abbrev=0", "--match", "meridian-v[0-9]*", "--match", "v[0-9]*"])
    const tagVersion = /^(?:meridian-)?v(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.exec(tag)?.[1]
    // The release commit bumps package.json, so a reachable tag older than it
    // means newer tags were never fetched, not that the tree descends from it.
    if (tagVersion && compareVersions(tagVersion, version) >= 0) releaseVersion = tagVersion
  } catch (error) { if (!(error instanceof BuildProvenanceError)) throw error }
  return {
    version, sha, ...(branch !== "HEAD" ? { branch } : {}), dirty: status.length > 0,
    sourceHash: hash.digest("hex"), ...(releaseVersion ? { releaseVersion } : {}),
    ...repositoryLinks(remote, branch !== "HEAD" ? branch : undefined, sha),
  }
}
