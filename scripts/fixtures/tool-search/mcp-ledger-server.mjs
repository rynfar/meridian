#!/usr/bin/env node
// Tiny stdio MCP server (newline-delimited JSON-RPC) exposing 22 tools.
// Every tools/call is appended to $MCP_CALL_LOG as one JSON line.
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"
const LOG = process.env.MCP_CALL_LOG
const NAMES = ["create","read","update","delete","list","search","link","unlink","tag","untag","archive","restore",
  "lock","unlock","export","import","diff","merge","snapshot","rollback","audit","stats"].map(v => `ledger_${v}`)
const tools = NAMES.map(name => ({
  name,
  description: `Ledger operation ${name.slice(7)} on one node of a realm. Returns a receipt string.`,
  inputSchema: { type: "object", properties: { realm: { type: "string" }, node_id: { type: "string" } }, required: ["realm", "node_id"] },
}))
const send = msg => process.stdout.write(JSON.stringify(msg) + "\n")
createInterface({ input: process.stdin }).on("line", line => {
  let msg; try { msg = JSON.parse(line) } catch { return }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ledger", version: "1.0.0" } } })
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } })
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params ?? {}
    if (LOG) appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), name, args }) + "\n")
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `RECEIPT-${name}-${args?.realm}-${args?.node_id}-7f3a` }] } })
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
