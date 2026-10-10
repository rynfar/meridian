import { describe, expect, it } from "bun:test"

// Each query connects the MCP server it is handed to its own transport and
// holds that connection until the query closes. A child runs the real Agent
// SDK, isolated from the suite's process-global SDK mocks, as in
// passthrough-declared-schema.test.ts.
function runAgainstRealSdk(body: string) {
  const moduleUrl = new URL("../proxy/passthroughTools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict";
    import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
    import { createPassthroughMcpServer } from ${JSON.stringify(moduleUrl)};
    const passthrough = createPassthroughMcpServer([
      { name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    ]);
    async function connect(server) {
      const client = new Client({ name: "test", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(b); await client.connect(a);
      return client;
    }
    ${body}
  `
  const child = Bun.spawnSync({ cmd: [process.execPath, "-e", script], stdout: "pipe", stderr: "pipe" })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
}

describe("passthrough MCP server per query", () => {
  it("lets two live queries connect servers built from one tool set", () => {
    runAgainstRealSdk(`
      const first = await connect(passthrough.createServer());
      const second = await connect(passthrough.createServer());
      try {
        const listed = (await first.listTools()).tools;
        assert.deepEqual(listed.map(tool => tool.name), ["bash"]);
        assert.deepEqual((await second.listTools()).tools, listed);
      } finally { await first.close(); await second.close(); }
    `)
  })

  it("refuses a second live connection to the same server", () => {
    runAgainstRealSdk(`
      const server = passthrough.createServer();
      const first = await connect(server);
      try {
        await assert.rejects(connect(server), /Already connected to a transport/);
      } finally { await first.close(); }
    `)
  })
})
