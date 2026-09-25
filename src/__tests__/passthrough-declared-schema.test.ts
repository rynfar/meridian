import { describe, expect, it } from "bun:test"

// What the model reads is the tools/list answer of the Agent SDK's own MCP
// server, rendered by the SDK's bundled Zod — not this repo's `zod`. An
// in-process `z.toJSONSchema` shares this module's metadata registry and so
// cannot see a description the SDK's renderer drops; only the real server
// over the real protocol can. A child isolates it from the suite's
// process-global SDK mocks, as in passthrough-input-coercion.test.ts.
function runAgainstRealSdk(body: string) {
  const moduleUrl = new URL("../proxy/passthroughTools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict";
    import { isDeepStrictEqual } from "node:util";
    import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
    import { createPassthroughMcpServer } from ${JSON.stringify(moduleUrl)};
    ${body}
  `
  const child = Bun.spawnSync({ cmd: [process.execPath, "-e", script], stdout: "pipe", stderr: "pipe" })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
}

// The same shapes a real report-style tool declares: descriptions on nested
// object properties and on array-item properties, an integer, a map-shaped
// object, nested `additionalProperties: false`, and optional parameters.
const DECLARED = `
  const properties = {
    query: { type: "string", description: "top-level string" },
    limit: { type: "integer", description: "optional integer row cap" },
    options: {
      type: "object",
      description: "optional nested options",
      properties: {
        mode: { type: "string", enum: ["fast", "exact"], description: "nested enum" },
        depth: { type: "integer", description: "nested optional integer" },
        label: { type: "string", description: "nested optional string" },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    steps: {
      type: "array",
      description: "ordered steps",
      items: {
        type: "object",
        description: "one step",
        properties: {
          id: { type: "string", description: "array-item property" },
          note: { type: "string", description: "optional array-item property" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    totals: {
      type: "object",
      description: "name -> number",
      additionalProperties: { type: "number" },
    },
  };
  const required = ["query", "steps", "totals"];
  const declared = JSON.stringify({ properties, required });
`

function listed(tool: string) {
  return `
    const { server } = createPassthroughMcpServer([${tool}]);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(b); await client.connect(a);
  `
}

describe("passthrough advertises the client's declared schema", () => {
  it("advertises every declared property subtree unchanged, at every depth", () => {
    runAgainstRealSdk(`
      ${DECLARED}
      ${listed(`{ name: "report", input_schema: { type: "object", properties, required } }`)}
      try {
        const schema = (await client.listTools()).tools[0].inputSchema;
        assert.deepEqual(schema.required, required);
        const differs = Object.keys(properties).filter(key => !isDeepStrictEqual(schema.properties[key], properties[key]));
        const advertised = Object.fromEntries(differs.map(key => [key, schema.properties[key]]));
        assert.deepEqual(differs, [], "advertised differently from the declared schema: " + JSON.stringify(advertised));
        // Rendering must not write into the client's request object, which also
        // keys the tool-set cache and drives input repair.
        assert.equal(JSON.stringify({ properties, required }), declared);
      } finally { await client.close(); await server.instance.close(); }
    `)
  })

  it("keeps validating and repairing arguments against the same schema", () => {
    runAgainstRealSdk(`
      ${DECLARED}
      ${listed(`{ name: "report", input_schema: { type: "object", properties, required } }`)}
      try {
        const args = { query: "q", limit: "3", steps: '[{"id":"a"}]', totals: '{"n":1}' };
        assert(!(await client.callTool({ name: "report", arguments: args })).isError);
        assert((await client.callTool({ name: "report", arguments: { ...args, limit: "1.5" } })).isError);
        const { steps, ...missingRequired } = args;
        assert((await client.callTool({ name: "report", arguments: missingRequired })).isError);
      } finally { await client.close(); await server.instance.close(); }
    `)
  })

  it("keeps the converted rendering for a subtree that references $defs", () => {
    // The SDK builds the root from a raw shape, so a client's root $defs never
    // reach the model; advertising the $ref verbatim would leave it dangling.
    runAgainstRealSdk(`
      const properties = {
        linked: { description: "points into $defs", $ref: "#/$defs/Linked" },
        plain: { type: "object", properties: { x: { type: "string", description: "nested" } } },
      };
      ${listed(`{ name: "refs", input_schema: { type: "object", properties, $defs: { Linked: { type: "string" } } } }`)}
      try {
        const schema = (await client.listTools()).tools[0].inputSchema;
        assert.equal(schema.properties.linked.$ref, undefined);
        assert.equal(schema.properties.linked.description, "points into $defs");
        assert.deepEqual(schema.properties.plain, properties.plain);
      } finally { await client.close(); await server.instance.close(); }
    `)
  })
})
