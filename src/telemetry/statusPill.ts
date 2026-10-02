/**
 * Header health pill - what the shared site header says about this instance.
 *
 * Serialized with `.toString()` into the header's inline script, like
 * buildBadge.ts, so it must stay self-contained: no references outside its
 * own body. It takes `unknown` because the browser hands it raw `/health`
 * JSON; a field that is absent or malformed falls back to the plain status.
 *
 * An unreachable upstream outranks every other reading. When the resolver dies
 * the auth check behind `status` tends to fail too, and "Degraded" or
 * "Offline" would send the reader to `claude login` for what is a network
 * problem on this host.
 */

export interface StatusPillView {
  /** The dot's class: healthy green, degraded yellow, unhealthy red. */
  readonly tone: "healthy" | "degraded" | "unhealthy"
  readonly text: string
  /** Hover text; empty when there is nothing to add to `text`. */
  readonly title: string
  /** Render the whole pill as an alert rather than a calm status line. */
  readonly alert: "outage" | "recovering" | null
}

export function statusPillView(health: unknown): StatusPillView {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
  }
  function time(value: unknown): string | null {
    if (typeof value !== "string") return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
  }

  if (!isRecord(health)) return { tone: "unhealthy", text: "Offline", title: "", alert: null }
  const tone = health.status === "healthy" ? "healthy" : health.status === "degraded" ? "degraded" : "unhealthy"
  const plain: StatusPillView = {
    tone,
    text: tone === "healthy" ? "Operational" : tone === "degraded" ? "Degraded" : "Offline",
    title: "",
    alert: null,
  }
  const upstream = isRecord(health.upstream) && isRecord(health.upstream.claude) ? health.upstream.claude : null
  if (!upstream) return plain
  const lastError = typeof upstream.lastErrorKind === "string" ? upstream.lastErrorKind : null
  const lastAnswered = time(upstream.lastReachedAt)

  if (upstream.state === "unreachable") {
    const override = isRecord(upstream.override) ? time(upstream.override.until) : null
    const failures = typeof upstream.consecutiveFailures === "number" ? upstream.consecutiveFailures : null
    const lines = override
      ? ["Forced unreachable by a test override until " + override + "."]
      : [
        "Meridian cannot reach Anthropic from this host, so load balancers are told to send traffic elsewhere.",
        "Failing since: " + (time(upstream.failingSince) ?? time(upstream.since) ?? "unknown"),
        "Last error: " + (lastError ?? "connection") + (failures !== null ? " (" + failures + " connection failure" + (failures === 1 ? "" : "s") + ")" : ""),
        "Last answered: " + (lastAnswered ?? "never since start"),
      ]
    const holdUntil = time(upstream.holdUntil)
    if (holdUntil) lines.push("Requests are let back in at " + holdUntil + " unless failures continue.")
    return { tone: "unhealthy", text: "Can't reach Anthropic", title: lines.join("\n"), alert: "outage" }
  }

  if (upstream.state === "probing") {
    return {
      tone: "degraded",
      text: "Rechecking Anthropic",
      title: [
        "Anthropic was unreachable from this host" + (lastError ? " (last error: " + lastError + ")" : "") + ".",
        "Requests are let through again; the next one shows whether it is back.",
        "Last failure: " + (time(upstream.lastFailureAt) ?? "unknown"),
      ].join("\n"),
      alert: "recovering",
    }
  }

  return plain
}
