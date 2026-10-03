/**
 * Header host label - which machine this instance runs on, beside the status.
 *
 * Serialized with `.toString()` into the header's inline script, like
 * buildBadge.ts, so it must stay self-contained. It takes `unknown` because
 * the browser hands it `/health`'s raw `hostname` field, which is absent
 * unless the `showHostname` setting is on.
 *
 * Shows the first DNS label: `nwkr-desktop.example.net` and `Mac.local` name
 * the machine by their first part, and the full name is on hover. An address
 * is shown whole, since its first label names nothing.
 */

export interface HostLabelView {
  readonly text: string
  readonly title: string
}

export function hostLabelView(hostname: unknown): HostLabelView | null {
  if (typeof hostname !== "string") return null
  const full = hostname.trim()
  if (!full) return null
  const isAddress = /^[0-9.]+$/.test(full) || full.includes(":")
  const text = isAddress ? full : full.split(".")[0] || full
  return { text, title: "Running on " + full }
}
