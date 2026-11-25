import type { RequestAttribution } from "../telemetry/types"

const clientHeader = /^([a-z][a-z0-9-]{0,31})(?:\/([A-Za-z0-9._+-]{1,64}))?$/
const installationHeader = /^[A-Za-z0-9._:-]{1,64}$/
const purposes: ReadonlySet<string> = new Set(["chat", "title", "compaction", "summary", "subagent", "review", "helper", "test"])
const attributionHeaders: readonly string[] = [
  "x-meridian-client", "x-meridian-installation", "x-meridian-device", "x-meridian-purpose", "x-meridian-session",
]

export function isClientAttributionHeader(name: string): boolean {
  return attributionHeaders.includes(name)
}

export function readClientAttribution(headers: Headers): RequestAttribution {
  const suppliedPurpose = headers.get("x-meridian-purpose")
  const purpose = suppliedPurpose ? { purpose: purposes.has(suppliedPurpose) ? suppliedPurpose : "other" } : {}
  const match = clientHeader.exec(headers.get("x-meridian-client") ?? "")
  const name = match?.[1]
  if (!name) return purpose

  const version = match?.[2]
  const installation = headers.get("x-meridian-installation")
  const device = headers.get("x-meridian-device")?.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 64)
  return {
    ...purpose,
    client: {
      name,
      ...(version ? { version } : {}),
      ...(installation && installationHeader.test(installation) ? { installation } : {}),
      ...(device ? { device } : {}),
    },
  }
}

export function internalClientAttributionHeaders(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const name of attributionHeaders) {
    const value = headers.get(name)
    if (value !== null) forwarded[name] = value
  }
  return forwarded
}
