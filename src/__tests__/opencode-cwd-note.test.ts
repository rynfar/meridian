/** Captured OpenCode V1/V2 request-shape coverage for client CWD extraction. */
import { describe, expect, it } from "bun:test"
import type { Context } from "hono"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { openCodeAdapter } from "../proxy/adapters/opencode"

const V1_FIXTURE = join(import.meta.dir, "fixtures", "opencode-request.json")
const V2_FIXTURE = join(import.meta.dir, "fixtures", "opencode-v2-request.json")
const v1Body = JSON.parse(readFileSync(V1_FIXTURE, "utf8"))
const v2Capture = JSON.parse(readFileSync(V2_FIXTURE, "utf8"))
const v2Body = v2Capture.body

const V1_CLIENT_CWD = "C:\\projects\\example-app"
const V2_CLIENT_CWD = "C:\\projects\\example-v2-app"

function systemText(body: { system?: unknown }): string {
  if (typeof body.system === "string") return body.system
  if (!Array.isArray(body.system)) return ""
  return body.system
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
}

function contextWith(headers: Record<string, string>): Context {
  return { req: { header: (name: string) => headers[name] } } as unknown as Context
}

describe("OpenCode client CWD extraction", () => {
  it("keeps the captured V1 environment shape non-empty and exact", () => {
    expect(Array.isArray(v1Body.system)).toBe(true)
    expect(v1Body.system).toHaveLength(1)
    expect(systemText(v1Body)).toContain(`<env>\n  Working directory: ${V1_CLIENT_CWD}`)
    expect(openCodeAdapter.extractClientWorkingDirectory?.(v1Body)).toBe(V1_CLIENT_CWD)
  })

  it("covers the exact supported V2 beta request shape", () => {
    expect(v2Capture.capture).toMatchObject({
      client: "@opencode-ai/cli",
      version: "0.0.0-beta-18314",
      userAgent: "opencode/beta/0.0.0-beta-18314/cli",
      requestUrl: "/messages?beta=true",
    })
    expect(v2Capture.capture.omissions).toEqual([
      "tools",
      "system text outside the environment block",
    ])
    expect(Array.isArray(v2Body.system)).toBe(true)
    expect(v2Body.system).toHaveLength(2)
    expect(systemText(v2Body)).toContain(`<env>\n  Current conversation session ID: ses_v2fixture\n  Working directory: ${V2_CLIENT_CWD}`)
    expect(openCodeAdapter.extractClientWorkingDirectory?.(v2Body)).toBe(V2_CLIENT_CWD)
  })

  it("marks the OpenCode environment as independent from a network proxy", () => {
    expect(openCodeAdapter.clientEnvironmentMayDifferFromProxy).toBe(true)
  })

  it("keeps a keyed OpenCode identity stable across both request shapes", () => {
    const session = "ses_cwd_fixture"
    const context = contextWith({ "x-opencode-session": session })
    expect(openCodeAdapter.getSessionId(context, v1Body)).toBe(session)
    expect(openCodeAdapter.getSessionId(context, v2Body)).toBe(session)
  })
})
