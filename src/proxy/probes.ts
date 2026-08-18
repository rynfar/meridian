/**
 * Liveness and readiness as two DIFFERENT questions, because the existing
 * `/health` answers a third one and is wrong when used as either.
 *
 * `/health` verifies the ACTIVE profile's auth: it spawns `claude auth status`
 * and returns 503 when that profile is logged out. As a liveness probe that is
 * a restart loop waiting to happen - a logged-out account is not fixed by
 * killing the process, and a supervisor pointed at it will keep killing a
 * perfectly healthy proxy until somebody re-authenticates. As a readiness probe
 * it is wrong in the other direction: it inspects one profile out of however
 * many are configured, and its own catch-all answers `degraded` with status
 * **200**, so an instance that cannot verify auth at all reads as ready.
 *
 * So:
 *
 *   /livez   is this PROCESS still turning - would a restart help?
 *   /readyz  should traffic be sent to THIS instance rather than another?
 *
 * Named after kube-apiserver's own endpoints, and shaped like them - plain
 * text `ok`, with `?verbose` listing every check - so a Kubernetes probe, a
 * Caddy `health_uri` and a person with curl all read the same thing.
 */

export type ProbeKind = "livez" | "readyz"

export interface ProbeCheck {
  readonly name: string
  readonly ok: boolean
  /** Why it failed. Absent when it passed. */
  readonly detail?: string
}

export interface ProbeReport {
  readonly ok: boolean
  readonly checks: readonly ProbeCheck[]
}

/**
 * Liveness passes unconditionally, and that is the design rather than a stub.
 *
 * Reaching this function at all means the event loop is turning and the HTTP
 * server is answering, which is the entire question. Every dependency added
 * here - a subprocess, a credential file, a reachable upstream - is another
 * way for this process to be killed over somebody else's outage, and a
 * liveness probe that restarts a working process is strictly worse than no
 * liveness probe at all.
 */
export function livenessReport(): ProbeReport {
  return { ok: true, checks: [] }
}

export interface ReadinessInput {
  /** Profiles this instance would actually serve from. */
  readonly profileCount: number
  /** Whether a Claude executable resolves for this instance. */
  readonly claudeExecutableResolved: boolean
}

/**
 * Readiness admits only checks that are PER-INSTANCE.
 *
 * The point of readiness is to move traffic somewhere better, so a check that
 * two instances fail together cannot move it anywhere - it can only take every
 * instance out at once and turn a clear error into a 502. That is why the
 * credentials are deliberately not checked here even though a proxy with no
 * usable token serves nothing: instances share those files, so an outage of
 * them is not a reason to prefer one instance over another, and the honest
 * answer to the caller is the provider's own 401 rather than a gateway error.
 *
 * What remains is genuinely local to one process:
 *
 *   profiles           an instance whose configuration and whose
 *                      `profiles.json` are both empty has no account to serve
 *                      from, while a neighbour reading a populated one is
 *                      fine. In a container that is entirely per-instance: the
 *                      file lives under that container's own HOME, so a
 *                      missing mount takes exactly one replica out.
 *   claude-executable  resolved from `MERIDIAN_CLAUDE_PATH`, this install's
 *                      own `node_modules`, or its platform package - all
 *                      per-instance, and without one no request can be served
 *                      (#478).
 */
export function readinessReport(input: ReadinessInput): ProbeReport {
  const checks: ProbeCheck[] = [
    {
      name: "profiles",
      ok: input.profileCount > 0,
      ...(input.profileCount > 0 ? {} : { detail: "no profiles configured" }),
    },
    {
      name: "claude-executable",
      ok: input.claudeExecutableResolved,
      ...(input.claudeExecutableResolved
        ? {}
        : { detail: "no Claude executable resolved (set MERIDIAN_CLAUDE_PATH or install @anthropic-ai/claude-code)" }),
    },
  ]
  return { ok: checks.every(c => c.ok), checks }
}

/**
 * kube-apiserver's own output shape: `[+]name ok` per check, a verdict line,
 * and a bare `ok` when everything passed and nobody asked for detail.
 *
 * The terse form is the one a load balancer polls every few seconds, so it
 * stays two bytes; the failing form names the checks that failed even without
 * `?verbose`, because a 503 nobody can explain is a 503 somebody disables.
 */
export function renderProbe(kind: ProbeKind, report: ProbeReport, verbose: boolean): string {
  const line = (c: ProbeCheck) => (c.ok ? `[+]${c.name} ok` : `[-]${c.name} failed: ${c.detail ?? "unknown"}`)
  if (!verbose) {
    if (report.ok) return "ok\n"
    return `${report.checks.filter(c => !c.ok).map(line).join("\n")}\n${kind} check failed\n`
  }
  const lines = report.checks.map(line)
  lines.push(`${kind} check ${report.ok ? "passed" : "failed"}`)
  return `${lines.join("\n")}\n`
}
