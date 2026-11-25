import { expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createProxyServer } from "../proxy/server"
import type { ProxyConfig } from "../proxy/types"

const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
const client = { name: "voice-ai-agy-check", version: "0.9.3", installation: "agy-egress-installation", device: "agy-egress-device" } as const
const headers = {
  "x-meridian-client": `${client.name}/${client.version}`,
  "x-meridian-installation": client.installation,
  "x-meridian-device": client.device,
  "x-meridian-purpose": "agy-egress-purpose",
  "x-meridian-session": "agy-egress-session",
  "X-Meridian-Attribution-Probe": "agy-egress-extension",
} as const
const model = "fixture-model"
const prompt = "Antigravity egress capture input"
const targets = [
  { backend: "antigravity", prefix: "", endpoint: "/v1/messages", input: { messages: [{ role: "user", content: prompt }], max_tokens: 32 } },
  { backend: "combined", prefix: "/antigravity", endpoint: "/v1/responses", input: { input: prompt } },
] as const

for (const { backend, prefix, endpoint, input } of targets) {
  it.skipIf(process.platform === "win32")(`${backend} keeps attribution in its request feed, not the agy invocation`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-attribution-"))
    const capturePath = join(root, "cli.jsonl")
    const statePath = backend === "antigravity" ? join(root, "state.sqlite") : undefined
    const config: Partial<ProxyConfig> = { backend, silent: true, antigravity: { executable, statePath, reuseConversations: false } }
    const markers = [...Object.values(headers), client.name]
    try {
      const prior = process.env.AGY_FIXTURE_EGRESS_CAPTURE
      let proxy: ReturnType<typeof createProxyServer>
      try {
        process.env.AGY_FIXTURE_EGRESS_CAPTURE = JSON.stringify({ path: capturePath, markers })
        proxy = createProxyServer(config)
      } finally {
        if (prior === undefined) delete process.env.AGY_FIXTURE_EGRESS_CAPTURE
        else process.env.AGY_FIXTURE_EGRESS_CAPTURE = prior
      }

      try {
        const response = await proxy.app.fetch(new Request(`http://localhost${prefix}${endpoint}`, {
          method: "POST", headers, body: JSON.stringify({ model, ...input }),
        }))
        expect(response.status).toBe(200)
        expect(await response.text()).toContain('"text":"READY"')

        const capture = await readFile(capturePath, "utf8")
        const invocations: readonly { readonly envKeys: readonly string[] }[] = capture.trim().split("\n").map(line => JSON.parse(line))
        expect(invocations).toContainEqual(expect.objectContaining({
          args: expect.arrayContaining(["--model", model]),
          stdin: expect.stringContaining(prompt),
          mcp: expect.stringContaining("meridian_client"),
        }))
        expect(invocations.flatMap(invocation => invocation.envKeys)).toEqual([])
        expect(capture).not.toMatch(/x[-_]meridian[-_]/i)
        for (const marker of markers) expect(capture).not.toContain(marker)

        const telemetry = new Request(`http://localhost${prefix}/telemetry/requests`)
        const rows = await (await proxy.app.fetch(telemetry)).json()
        expect(rows).toEqual([expect.objectContaining({ provider: "antigravity", model, client, purpose: "other" })])
        expect(JSON.stringify(rows)).not.toContain(headers["x-meridian-session"])
        expect(JSON.stringify(rows)).not.toContain(headers["X-Meridian-Attribution-Probe"])

        if (statePath) {
          await proxy.closeBackend?.()
          proxy = createProxyServer(config)
          expect(await (await proxy.app.fetch(telemetry)).json()).toEqual(rows)
        }
      } finally {
        await proxy.closeBackend?.()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
