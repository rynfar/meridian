#!/usr/bin/env node
// Scripted stand-in for the Anthropic Messages API (no model). Records what the
// inner Claude Code CLI sends and answers with deterministic policy:
//  - a deferred tool (defer_loading:true) is callable only once a tool_reference
//    in the conversation names it (the API's tool_reference semantics);
//  - receipt seen in the latest tool_result -> final text answer;
//  - callable *ledger_update tool not yet called -> call it;
//  - otherwise search once (prefer the client's mcp__oc__ToolSearch, else the
//    built-in ToolSearch), then give up with "TOOL NOT AVAILABLE".
// Prompt markers CHAIN-MODE / PARALLEL-MODE ask for ledger_update and ledger_audit
// one after the other, or both in one response.
// usage: scripted-upstream.mjs <port> <record.jsonl>
import { createServer } from "node:http"
import { appendFileSync } from "node:fs"
import { createHash } from "node:crypto"
const [port, recordFile] = process.argv.slice(2)
let seq = 0
const blocks = c => Array.isArray(c) ? c : typeof c === "string" ? [{ type: "text", text: c }] : []
function summarize(body) {
  const messages = (body.messages ?? []).map(m => ({ role: m.role, parts: blocks(m.content).map(b => {
    if (b.type === "tool_use") return { type: "tool_use", name: b.name }
    if (b.type === "tool_result") return { type: "tool_result", parts: blocks(b.content).map(p => p.type === "tool_reference" ? { type: "tool_reference", tool_name: p.tool_name } : { type: p.type, text: (p.text ?? "").slice(0, 200) }) }
    if (b.type === "tool_reference") return { type: "tool_reference", tool_name: b.tool_name }
    if (b.type === "text") return { type: "text", len: (b.text ?? "").length, head: (b.text ?? "").slice(0, 120) }
    return { type: b.type }
  }) }))
  return { model: body.model, stream: !!body.stream, tool_count: (body.tools ?? []).length,
    tools_sha: createHash("sha256").update(JSON.stringify(body.tools ?? [])).digest("hex").slice(0, 16),
    reference_notes: [...JSON.stringify(body.messages ?? []).matchAll(/\[Tool reference: ([^\]]+)\]/g)].map(m => m[1]),
    tools: (body.tools ?? []).map(t => ({ name: t.name, ...(t.defer_loading !== undefined ? { defer_loading: t.defer_loading } : {}), ...(t.type ? { type: t.type } : {}) })),
    messages }
}
function decide(body) {
  const tools = body.tools ?? []
  const msgs = body.messages ?? []
  const referenced = new Set()
  const calls = []
  const receipts = []
  let userText = ""
  for (const m of msgs) for (const b of blocks(m.content)) {
    if (b.type === "tool_use") calls.push(b)
    if (b.type === "text" && m.role === "user") userText += b.text ?? ""
    if (b.type === "tool_result") for (const p of blocks(b.content)) {
      if (p.type === "tool_reference") referenced.add(p.tool_name)
      for (const r of (p.text ?? "").match(/RECEIPT-[A-Za-z0-9_-]+/g) ?? []) receipts.push(r)
    }
  }
  if (tools.length === 0) return { kind: "text", text: receipts.at(-1) ?? "ok" }
  const mode = /PARALLEL-MODE/.test(userText) ? "parallel" : /CHAIN-MODE/.test(userText) ? "chain" : "single"
  const targets = mode === "single" ? ["ledger_update"] : ["ledger_update", "ledger_audit"]
  if (targets.every(t => receipts.some(r => r.includes(`-${t}-`)))) return { kind: "text", text: targets.map(t => receipts.find(r => r.includes(`-${t}-`))).join(" ") }
  const callable = t => t.defer_loading !== true || referenced.has(t.name)
  const toolFor = t => tools.find(x => x.name.endsWith(`ledger__${t}`) && callable(x))
  const pending = targets.filter(t => !calls.some(c => c.name.endsWith(t)))
  const want = mode === "parallel" ? pending : pending.slice(0, 1)
  // BARE-NAME: copy the name from a "[Tool reference: X]" note verbatim, as a
  // model might, instead of the registered tool name.
  const note = /BARE-NAME/.test(userText) && msgs.flatMap(m => blocks(m.content)).flatMap(b => b.type === "tool_result" ? blocks(b.content) : []).map(p => (p.text ?? "").match(/\[Tool reference: ([^\]]+)\]/)).find(Boolean)
  if (note && want.length && !calls.some(c => c.name === note[1])) return { kind: "tools", calls: [{ name: note[1], input: { realm: "r1", node_id: "7" } }] }
  if (want.length && want.every(toolFor)) return { kind: "tools", calls: want.map(t => ({ name: toolFor(t).name, input: { realm: "r1", node_id: "7" } })) }
  const clientSearch = tools.find(t => t.name === "mcp__oc__ToolSearch")
  const builtinSearch = tools.find(t => t.name === "ToolSearch")
  const search = clientSearch ?? builtinSearch
  const searched = calls.filter(c => /ToolSearch$/.test(c.name)).map(c => String(c.input?.query ?? "")).join(" ")
  const missing = want.filter(t => !toolFor(t) && !searched.includes(t))
  if (search && missing.length) {
    const names = missing.map(t => search === clientSearch ? `mcp__ledger__${t}` : `mcp__oc__mcp__ledger__${t}`)
    return { kind: "tools", calls: [{ name: search.name, input: { query: `select:${names.join(",")}`, max_results: 5 } }] }
  }
  return { kind: "text", text: "TOOL NOT AVAILABLE" }
}
function sse(res, model, d) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  const id = `msg_fake_${++seq}`
  ev("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
  if (d.kind === "tools") {
    d.calls.forEach((c, i) => {
      ev("content_block_start", { index: i, content_block: { type: "tool_use", id: `toolu_fake_${seq}_${i}`, name: c.name, input: {} } })
      ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } })
      ev("content_block_stop", { index: i })
    })
  } else {
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: d.text } })
    ev("content_block_stop", { index: 0 })
  }
  ev("message_delta", { delta: { stop_reason: d.kind === "tools" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } })
  ev("message_stop", {})
  res.end()
}
function json(res, model, d) {
  ++seq
  const content = d.kind === "tools" ? d.calls.map((c, i) => ({ type: "tool_use", id: `toolu_fake_${seq}_${i}`, name: c.name, input: c.input })) : [{ type: "text", text: d.text }]
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({ id: `msg_fake_${seq}`, type: "message", role: "assistant", model, content, stop_reason: d.kind === "tools" ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }))
}
createServer((req, res) => {
  let raw = ""
  req.on("data", c => raw += c)
  req.on("end", () => {
    const path = (req.url ?? "").split("?")[0]
    if (req.method === "POST" && path === "/v1/messages") {
      let body
      try {
        body = JSON.parse(raw)
      } catch (error) {
        appendFileSync(recordFile, JSON.stringify({ at: new Date().toISOString(), path, malformed: String(error) }) + "\n")
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "malformed JSON body" } }))
      }
      const d = decide(body)
      appendFileSync(recordFile, JSON.stringify({ at: new Date().toISOString(), path, ...summarize(body), decision: d }) + "\n")
      return body.stream ? sse(res, body.model, d) : json(res, body.model, d)
    }
    if (path === "/v1/messages/count_tokens") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ input_tokens: 100 })) }
    appendFileSync(recordFile, JSON.stringify({ at: new Date().toISOString(), method: req.method, path }) + "\n")
    res.writeHead(200, { "content-type": "application/json" }); res.end("{}")
  })
}).listen(Number(port), "127.0.0.1")
