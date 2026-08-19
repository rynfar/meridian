/**
 * How this proxy was started, so a page that needs a restart can say HOW.
 *
 * The telemetry stores are built once at startup, so changing where telemetry
 * is kept takes effect on the next start and not before. A settings page that
 * says "restart to apply" and stops there has handed the reader a puzzle: the
 * unit is named by whoever installed it, `systemctl restart` without `--user`
 * silently addresses a different manager, and a proxy started by hand has no
 * unit at all. All of that is already written in /proc/self/cgroup.
 *
 * Linux-only by nature; everywhere else this reports `unknown` and the page
 * falls back to "restart Meridian", which is the honest answer there.
 *
 * Leaf module: the parsing is pure and separately testable, and the single
 * read is wrapped so a missing or unreadable cgroup file degrades to
 * `unknown` rather than throwing during a settings fetch.
 */

import { readFileSync } from "node:fs"

export type SupervisionKind = "systemd-user" | "systemd-system" | "unknown"

export interface Supervision {
  kind: SupervisionKind
  /** Unit name, e.g. "meridian-dev.service". Null when not under a unit. */
  unit: string | null
  /** Exactly what to run to apply a restart-scoped change, or null when
   *  nothing can be named with confidence. */
  restartCommand: string | null
}

const UNKNOWN: Supervision = { kind: "unknown", unit: null, restartCommand: null }

/** The user manager's own unit, which every user service nests under and which
 *  is never the answer to "which unit am I". */
const USER_MANAGER = /^user@\d+\.service$/

/**
 * Read the unit out of a cgroup file's contents.
 *
 * Handles both hierarchies: cgroup v2 writes one `0::/path` line, v1 writes
 * several `id:controllers:/path` lines. Taking the substring after the last
 * colon yields the path in either case.
 *
 * A `.scope` leaf (`session-2.scope`, `init.scope`) is deliberately NOT a
 * match: a scope is how systemd accounts for a process it did not launch, so
 * a proxy started by hand in a terminal lands in one. Reporting that as a unit
 * would print a `systemctl restart session-2.scope` that fails.
 */
export function parseSupervision(cgroup: string): Supervision {
  const paths = cgroup
    .split("\n")
    .map(line => line.slice(line.lastIndexOf(":") + 1).trim())
    .filter(path => path.startsWith("/"))
  if (paths.length === 0) return UNKNOWN

  const isUser = paths.some(path => path.split("/").some(part => USER_MANAGER.test(part)))
  const isSystem = !isUser && paths.some(path => path.startsWith("/system.slice/"))
  if (!isUser && !isSystem) return UNKNOWN

  for (const path of paths) {
    const unit = path
      .split("/")
      .filter(part => part.endsWith(".service") && !USER_MANAGER.test(part))
      .pop()
    if (!unit) continue
    return isUser
      ? { kind: "systemd-user", unit, restartCommand: `systemctl --user restart ${unit}` }
      : { kind: "systemd-system", unit, restartCommand: `sudo systemctl restart ${unit}` }
  }
  return UNKNOWN
}

export function detectSupervision(): Supervision {
  try {
    return parseSupervision(readFileSync("/proc/self/cgroup", "utf-8"))
  } catch {
    // No procfs (macOS, Windows, a locked-down container). Nothing to report,
    // and a settings page must still render.
    return UNKNOWN
  }
}
