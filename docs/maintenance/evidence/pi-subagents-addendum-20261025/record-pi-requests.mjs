import http from "node:http"
import { appendFileSync } from "node:fs"
const target = "http://127.0.0.1:3456"
http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  if (req.url.startsWith("/v1/messages")) {
    try {
      const j = JSON.parse(body.toString())
      const sys = typeof j.system === "string" ? [j.system] : (j.system ?? []).map(b => b.text)
      const msgSys = (j.messages ?? []).filter(m => m.role === "system").map(m => typeof m.content === "string" ? m.content : m.content.map(b => b.text).join(""))
      const all = [...sys, ...msgSys]
      const idx = all.map(t => t.indexOf("<active_agent"))
      appendFileSync("/tmp/pi-rec/log.jsonl", JSON.stringify({
        source: req.headers["x-meridian-source"] ?? null, affinity: req.headers["x-session-affinity"], attest: !!req.headers["x-meridian-opencode-turn"],
        systemBlocks: all.length, markerIndexPerBlock: idx, firstChars: all.map(t => t.slice(0, 80)),
        markerContext: all.map(t => { const i = t.indexOf("<active_agent"); return i < 0 ? null : t.slice(Math.max(0, i - 60), i + 60) }),
      }) + "\n")
    } catch (e) { appendFileSync("/tmp/pi-rec/log.jsonl", JSON.stringify({ parseError: String(e) }) + "\n") }
  }
  const headers = { ...req.headers }; delete headers.host; delete headers["content-length"]
  const up = await fetch(target + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body })
  res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding"].includes(k))))
  if (up.body) for await (const c of up.body) res.write(c)
  res.end()
}).listen(3497, "127.0.0.1")
