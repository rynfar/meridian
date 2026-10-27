/**
 * Resolve the SDK subprocess `cwd:` option, falling back to a known-valid
 * path on the proxy host when the resolved working directory doesn't exist.
 *
 * Background — issue #381:
 *   When meridian runs on a remote machine (e.g. accessed over Tailscale)
 *   and the client (OpenCode/Crush/etc.) runs on a different machine, the
 *   adapter extracts the client's reported working directory and passes it
 *   to the SDK as `cwd:`. That path doesn't exist on the proxy host, so
 *   `child_process.spawn(claude, { cwd })` fails with ENOENT — which the
 *   SDK then reports as the misleading "Claude Code native binary not
 *   found at ..." error.
 *
 *   Falling back to the proxy's own `process.cwd()` lets the SDK spawn
 *   succeed; `clientWorkingDirectory` is tracked separately (and emitted
 *   into the model's context via buildCwdNote) so the model still hears
 *   about the user's real working directory.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { configDir } from "../configDir"

/**
 * An empty directory of Meridian's own, for clients whose tools run on their
 * side (Zed): the SDK subprocess reads no files there, so the directory only
 * has to carry nothing Claude Code would attach to a fresh session. Running
 * the subprocess in the proxy's checkout instead injected that repository's
 * CLAUDE.md and git status (branch, recent commits) into every conversation,
 * whatever project the client had open. Lives under the config directory
 * (`MERIDIAN_CONFIG_DIR` moves it with everything else) and is created on
 * first use.
 *
 * It holds an empty repository of its own (`.git` skeleton, no commits):
 * git otherwise walks up from the directory and reports whichever repository
 * encloses it — a home directory under version control showed its untracked
 * files to every conversation — so the walk has to stop here.
 */
export function neutralWorkingDirectory(root: string = configDir()): string {
  const dir = join(root, "workdir")
  const gitDir = join(dir, ".git")
  if (!existsSync(join(gitDir, "HEAD"))) {
    mkdirSync(join(gitDir, "objects"), { recursive: true })
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true })
    mkdirSync(join(gitDir, "refs", "tags"), { recursive: true })
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n")
    writeFileSync(join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n")
  }
  return dir
}

export interface CwdResolution {
  /** Path passed to the SDK as `cwd:`. Always exists on the proxy host. */
  workingDirectory: string
  /**
   * The originally-resolved path before existence validation. May not
   * exist on the proxy host. Used as `clientWorkingDirectory` for
   * fingerprint bucketing and the system-prompt cwdNote.
   */
  claimedWorkingDirectory: string
  /** True if `workingDirectory` differs from `claimedWorkingDirectory`. */
  fellBack: boolean
}

export interface ResolveCwdOpts {
  /** MERIDIAN_WORKDIR / CLAUDE_PROXY_WORKDIR (highest precedence). */
  envOverride: string | undefined
  /** Adapter's extracted client working directory. */
  adapterCwd: string | undefined
  /** Last-resort fallback. Must exist; typically `process.cwd()`. */
  fallback: string
  /** Injection point for tests. Defaults to `node:fs`'s existsSync. */
  exists?: (path: string) => boolean
}

export function resolveSdkWorkingDirectory(opts: ResolveCwdOpts): CwdResolution {
  const exists = opts.exists ?? existsSync
  const claimed = resolve(opts.envOverride || opts.adapterCwd || opts.fallback)
  const fallback = resolve(opts.fallback)
  if (exists(claimed)) {
    return { workingDirectory: claimed, claimedWorkingDirectory: claimed, fellBack: false }
  }
  return { workingDirectory: fallback, claimedWorkingDirectory: claimed, fellBack: true }
}
