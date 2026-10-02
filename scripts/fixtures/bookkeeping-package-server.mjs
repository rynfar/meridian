import { once } from "node:events"
import { pathToFileURL } from "node:url"
import { join } from "node:path"

const [packageRoot, directory, mode, instances = "1"] = process.argv.slice(2)
if (directory !== "default") process.env.MERIDIAN_SESSION_DIR = directory
process.env.MERIDIAN_BOOKKEEPING = mode
process.env.MERIDIAN_ROUTING = "manual"
process.env.MERIDIAN_SESSION_GC_GRACE_MS = "3600000"
const api = await import(pathToFileURL(join(packageRoot, "dist", "server.js")).href)
const proxy = await api.startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
if (!proxy.server.address()) await once(proxy.server, "listening")
const second = instances === "2" ? await api.startProxyServer({ port: 0, host: "127.0.0.1", silent: true }) : undefined
if (second && !second.server.address()) await once(second.server, "listening")
if (second) {
  const response = await fetch(`http://127.0.0.1:${proxy.server.address().port}/health`)
  if (response.status !== 200) throw new Error("first owner stopped serving after second startup")
  await second.close()
  const afterClose = await fetch(`http://127.0.0.1:${proxy.server.address().port}/health`)
  if (afterClose.status !== 200) throw new Error("closing second owner stopped first")
}
process.send({ type: "ready", url: `http://127.0.0.1:${proxy.server.address().port}` })
let closing = false
async function close() {
  if (closing) return
  closing = true
  await proxy.close()
  process.exit(0)
}
process.on("message", message => {
  if (message.type === "close") void close().catch(error => { console.error(error); process.exit(1) })
})
process.on("disconnect", () => { void close().catch(() => process.exit(1)) })
