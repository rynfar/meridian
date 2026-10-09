import { describe, expect, it } from "bun:test"

// Each query connects the MCP server it is handed to its own transport and
// holds that connection until the query closes. A child runs the real Agent
// SDK, isolated from the suite's process-global SDK mocks, as in
// passthrough-declared-schema.test.ts.
function runAgainstRealSdk(body: string) {
  const moduleUrl = new URL("../proxy/passthroughTools.ts", import.meta.url).href
  const queryUrl = new URL("../proxy/query.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict";
    import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
    import { createPassthroughMcpServer } from ${JSON.stringify(moduleUrl)};
    import { buildQueryOptions } from ${JSON.stringify(queryUrl)};
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
  it("keeps both options-builder transports and their full catalog independent", () => {
    runAgainstRealSdk(`
      const tools = [
        { name: "bash", defer_loading: false, input_schema: {
          type: "object", properties: { command: { type: "string" } }, required: ["command"],
        } },
        { name: "mcp__oc__read_path", defer_loading: true, input_schema: {
          type: "object", properties: { options: {
            type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"],
          } }, required: ["options"],
        } },
        { name: "read_path", input_schema: {
          type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"],
        } },
      ];
      const originalTools = structuredClone(tools);
      const catalog = createPassthroughMcpServer(tools, ["bash"]);
      function buildServer(stream) {
        const options = buildQueryOptions({
          prompt: "transport fixture", model: "claude-opus-5-5", workingDirectory: process.cwd(),
          systemContext: "", claudeExecutable: "/unused/claude", passthrough: true, stream,
          sdkAgents: {}, cleanEnv: {}, hasDeferredTools: catalog.hasDeferredTools,
          passthroughMcp: catalog, isUndo: false, blockedTools: [], incompatibleTools: [],
          mcpServerName: "oc", allowedMcpTools: [],
        }).options;
        const server = options.mcpServers?.oc;
        assert.equal(server?.type, "sdk");
        return server;
      }
      const firstServer = buildServer(false);
      const secondServer = buildServer(true);
      assert.notEqual(firstServer.instance, secondServer.instance);
      const first = await connect(firstServer);
      let second;
      try {
        second = await connect(secondServer);
        const listed = (await first.listTools()).tools;
        const names = catalog.toolNames.map(name => name.slice(catalog.prefix.length));
        assert.deepEqual(listed.map(tool => tool.name), names);
        assert.equal(new Set(names).size, tools.length, "colliding aliases must remain distinct");
        assert.equal(catalog.clientNameByAlias.get("read_path"), "read_path");
        assert.equal(catalog.clientNameByAlias.get("read_path_2"), "mcp__oc__read_path");
        assert(names.includes("read_path_2"), "namespace collision must use a numbered alias");
        assert.deepEqual((await second.listTools()).tools, listed);
        const bash = listed.find(tool => tool.name === "bash");
        assert.deepEqual(bash.inputSchema.required, ["command"]);
        assert.equal(bash._meta["anthropic/alwaysLoad"], true);
        const nested = listed.find(tool => catalog.clientNameByAlias.get(tool.name) === "mcp__oc__read_path");
        assert.deepEqual(nested.inputSchema.properties.options.required, ["paths"]);
        assert.equal(nested._meta?.["anthropic/alwaysLoad"], undefined);
        const invalid = await second.callTool({ name: "bash", arguments: {} });
        assert.equal(invalid.isError, true, "required-input validation must remain active");
        await first.close();
        assert.deepEqual((await second.listTools()).tools, listed, "closing one query must retain the other catalog");
        const called = await second.callTool({ name: "bash", arguments: { command: "fixture" } });
        assert.notEqual(called.isError, true);
        assert.deepEqual(called.content, [{ type: "text", text: "passthrough" }]);
        assert.deepEqual(tools, originalTools, "registration must not mutate the client schema");
      } finally {
        await first.close();
        await second?.close();
        await firstServer.instance.close();
        await secondServer.instance.close();
      }
    `)
  })

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
