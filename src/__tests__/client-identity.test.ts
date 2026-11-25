import { expect, test } from "bun:test"
import { readClientAttribution } from "../proxy/clientIdentity"

const metadata = {
  "x-meridian-installation": "20261124T0612Z-x7f9qp",
  "x-meridian-device": " Möntréal\t Laptop ",
}

test.each([
  ["voice-ai/0.9.3+Build_1", { client: { name: "voice-ai", version: "0.9.3+Build_1", installation: "20261124T0612Z-x7f9qp", device: "Mntral Laptop" }, purpose: "chat" }],
  ["Code/1", { purpose: "chat" }],
  ["voice-ai/", { purpose: "chat" }],
  ["voice-ai/1/2", { purpose: "chat" }],
  ["a".repeat(33), { purpose: "chat" }],
  [`voice-ai/${"a".repeat(65)}`, { purpose: "chat" }],
  [null, { purpose: "chat" }],
] as const)("parses client declaration %s", (header, expected) => {
  const headers = new Headers({ ...metadata, "x-meridian-purpose": "chat" })
  if (header !== null) headers.set("x-meridian-client", header)
  expect(readClientAttribution(headers)).toEqual(expected)
})

test.each(["chat", "title", "compaction", "summary", "subagent", "review", "helper", "test"])("records purpose %s", (purpose) => {
  expect(readClientAttribution(new Headers({ "x-meridian-purpose": purpose }))).toEqual({ purpose })
})

test.each(["warm", "keepalive", "CHAT", "custom"])("normalizes external purpose %s to other", (purpose) => {
  expect(readClientAttribution(new Headers({ "x-meridian-purpose": purpose }))).toEqual({ purpose: "other" })
})

test("validates installation and device independently of a valid bare client name", () => {
  const headers = new Headers({
    "x-meridian-client": "opencode",
    "x-meridian-installation": "a".repeat(65),
    "x-meridian-device": ` é${"m".repeat(70)}`,
    "x-meridian-purpose": "",
  })
  expect(readClientAttribution(headers)).toEqual({ client: { name: "opencode", device: "m".repeat(64) } })
})

test("omits an invalid installation and a device with no printable ASCII", () => {
  expect(readClientAttribution(new Headers({
    "x-meridian-client": "voice-ai",
    "x-meridian-installation": "two words",
    "x-meridian-device": "é",
  }))).toEqual({ client: { name: "voice-ai" } })
  expect(readClientAttribution(new Headers())).toEqual({})
})
