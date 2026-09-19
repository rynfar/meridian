import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { AgAttachments } from "../proxy/backends/antigravityAttachments"
import { parseAgRequest } from "../proxy/backends/antigravityProtocol"

const roots: string[] = []
const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII="
const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data } }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
describe("Antigravity image attachments", () => {
  it("parses a multi-megabyte attachment in production Node without regex stack overflow", () => {
    const moduleUrl = new URL("../proxy/backends/antigravityProtocol.ts", import.meta.url).href
    const script = `import {parseAgRequest} from ${JSON.stringify(moduleUrl)};
      const data=Buffer.alloc(4*1024*1024).toString('base64');
      parseAgRequest({model:'fixture',messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/png',data}}]}]});`
    const result = spawnSync("node", ["--experimental-transform-types", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 })
    expect(result.status, result.stderr).toBe(0)
  })
  it("deduplicates exact bytes, restricts permissions and strips bytes from prompts/results", async () => {
    const root = await mkdtemp(join(tmpdir(), "meridian-attachments-test-")); roots.push(root)
    const attachments = new AgAttachments(root)
    const messages = await attachments.messages([{ role: "user", content: [image, { type: "text", text: "context" }] }])
    const result = await attachments.toolResult({ type: "tool_result", tool_use_id: "id", content: [image, { type: "text", text: "caption" }] })
    const paths: string[] = JSON.parse(await readFile(join(root, "attachment-paths.json"), "utf8"))
    expect(paths).toHaveLength(1)
    expect(await readFile(paths[0]!)).toEqual(Buffer.from(data, "base64"))
    expect((await stat(paths[0]!)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(messages)).toContain(paths[0]!)
    expect(JSON.stringify(result)).toContain(paths[0]!)
    expect(JSON.stringify([messages, result])).not.toContain(data)
    expect(JSON.stringify(result)).toContain("caption")
  })
  it("rejects remote sources, malformed base64 and wrong media signatures", async () => {
    const request = (source: unknown) => ({ model: "fixture", messages: [{ role: "user", content: [{ type: "image", source }] }] })
    expect(() => parseAgRequest(request({ type: "url", url: "http://localhost/private" }))).toThrow()
    expect(() => parseAgRequest(request({ ...image.source, data: "not base64" }))).toThrow()
    const root = await mkdtemp(join(tmpdir(), "meridian-attachments-test-")); roots.push(root)
    await expect(new AgAttachments(root).content([{ ...image, source: { ...image.source, media_type: "image/jpeg" } }])).rejects.toThrow("media_type")
  })
})
