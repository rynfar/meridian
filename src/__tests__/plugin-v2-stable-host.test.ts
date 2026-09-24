import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import MeridianV2Plugin, { serializeCatalogCache } from "../../plugin/meridian-v2"
import { PRIORITY_ATTESTATION_HEADER } from "../../plugin/priority-attestation"
import { verifyPriorityAttestation } from "../proxy/priorityAttestation"

type StableDraft = {
  provider: { get(id: string): unknown }
  update(providerID: string, modelID: string, update: (entry: {
    name: string
    limit: { context: number }
    variants: Array<{ id: string; headers: Record<string, string>; body: { effort: string } }>
  }) => void): void
}

test("OpenCode 2.0.16 host loads without catalog and keeps model, title, and signed primary behavior", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meridian-oc2-stable-host-"))
  const savedConfig = process.env.MERIDIAN_CONFIG_DIR
  const savedKey = process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
  const key = Buffer.alloc(32, 19)
  process.env.MERIDIAN_CONFIG_DIR = directory
  process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = key.toString("base64url")
  let transform: ((draft: StableDraft) => void) | undefined
  const hooks = new Map<string, (input: {
    sessionID: string
    agent: string
    kind: string
    model: { providerID: string }
    request: Request
  }) => Promise<void>>()
  const disposed: string[] = []
  const createdAt = Date.now()
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "opencode-v2-catalog.json"), serializeCatalogCache([{
      providerID: "anthropic",
      baseURL: "http://127.0.0.1:3456/v1",
      models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, efforts: ["high"] }],
    }], createdAt))
    const host = {
      model: {
        transform: async (callback: (draft: StableDraft) => void) => {
          transform = callback
          return { dispose: async () => { disposed.push("model") } }
        },
        reload: async () => {},
      },
      provider: { get: async () => ({ settings: { baseURL: "http://127.0.0.1:3456/v1" } }) },
      event: { subscribe: () => (async function* () {})() },
      agent: { get: async () => ({ mode: "primary", hidden: false }) },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID }),
        context: async () => [{ id: "msg_human", type: "user", time: { created: createdAt } }],
        hook: async (name: string, callback: (input: {
          sessionID: string
          agent: string
          kind: string
          model: { providerID: string }
          request: Request
        }) => Promise<void>, options: { providerID: string }) => {
          hooks.set(`${options.providerID}:${name}`, callback)
          return { dispose: async () => { disposed.push(`${options.providerID}:${name}`) } }
        },
      },
    }
    const cleanup: unknown = await Reflect.apply(MeridianV2Plugin.setup, MeridianV2Plugin, [host])
    try {
      expect(transform).toBeDefined()
      const entry = { name: "old", limit: { context: 1 }, variants: [] as Array<{
        id: string; headers: Record<string, string>; body: { effort: string }
      }> }
      transform?.({
        provider: { get: () => ({ id: "anthropic" }) },
        update: (providerID, modelID, update) => {
          expect(providerID).toBe("anthropic")
          expect(modelID).toBe("claude-haiku-4-5")
          update(entry)
        },
      })
      expect(entry).toEqual({ name: "Claude Haiku 4.5", limit: { context: 200_000 },
        variants: [{ id: "high", headers: {}, body: { effort: "high" } }] })

      const http = hooks.get("anthropic:http.request")
      expect(http).toBeDefined()
      const primary = new Request("http://127.0.0.1/v1/messages")
      await http?.({ sessionID: "ses_root", agent: "build", kind: "primary",
        model: { providerID: "anthropic" }, request: primary })
      const signed = verifyPriorityAttestation(primary.headers.get(PRIORITY_ATTESTATION_HEADER) ?? undefined, key)
      expect(signed?.generation).toBe("oc2v2016")
      expect(signed?.sessionId).toBe("ses_root")
      expect(primary.headers.get("x-opencode-session")).toBe("ses_root")

      const title = new Request("http://127.0.0.1/v1/messages")
      await http?.({ sessionID: "ses_root", agent: "build", kind: "title",
        model: { providerID: "anthropic" }, request: title })
      expect(title.headers.get("x-opencode-session")).toBeNull()
      expect(title.headers.get("x-meridian-source")).toBe("subagent-title")
      expect(title.headers.get("x-opencode-agent-mode")).toBe("subagent")
      expect(title.headers.get(PRIORITY_ATTESTATION_HEADER)).toBeNull()

      const generated = new Request("http://127.0.0.1/v1/messages")
      await http?.({ sessionID: "ses_root", agent: "build", kind: "generate",
        model: { providerID: "anthropic" }, request: generated })
      expect(generated.headers.get("x-opencode-session")).toBeNull()
      expect(generated.headers.get("x-meridian-source")).toBe("subagent-generate")
      expect(generated.headers.get("x-opencode-agent-mode")).toBe("subagent")
      expect(generated.headers.get(PRIORITY_ATTESTATION_HEADER)).toBeNull()

      const compaction = new Request("http://127.0.0.1/v1/messages")
      await http?.({ sessionID: "ses_root", agent: "build", kind: "compaction",
        model: { providerID: "anthropic" }, request: compaction })
      expect(compaction.headers.get("x-opencode-session")).toBe("ses_root")
      expect(compaction.headers.get("x-meridian-source")).toBe("subagent-compaction")
      expect(compaction.headers.get("x-opencode-agent-mode")).toBe("primary")
      expect(compaction.headers.get(PRIORITY_ATTESTATION_HEADER)).toBeNull()
    } finally {
      if (typeof cleanup === "function") await cleanup()
    }
    expect(disposed).toContain("model")
  } finally {
    if (savedConfig === undefined) delete process.env.MERIDIAN_CONFIG_DIR
    else process.env.MERIDIAN_CONFIG_DIR = savedConfig
    if (savedKey === undefined) delete process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
    else process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = savedKey
    rmSync(directory, { recursive: true, force: true })
  }
})
