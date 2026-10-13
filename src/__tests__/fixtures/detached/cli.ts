// Process-lifecycle fixture: real supervisor/control/store, no SDK or credentials.
import { createServer } from "node:http"
import { runDetachedSupervisor } from "../../../cli/detachedSupervisor"
import { runDetachedCommand, detachedCommandSucceeded } from "../../../cli/detachedCommand"
import { detachedChildControl } from "../../../cli/detachedChild"

const host = "127.0.0.1"
const port = Number(process.env.MERIDIAN_PORT)
const action = process.argv[2]
if (action === "__detached-supervisor") {
  await runDetachedSupervisor(process.argv[1]!, host, port)
  process.exit(0)
} else if (action === "__detached-child") {
  const control = detachedChildControl()
  const server = createServer((request, response) => {
    response.end(request.url === "/readyz" ? "ok" : "fixture")
  })
  let stopping = false
  control.attach(() => {
    if (stopping) return
    stopping = true
    console.log("fixture graceful stop")
    server.close(() => process.exit(0))
  })
  if (!control.requested) server.listen(port, host, () => {
    console.log("fixture stdout ready")
    console.error("fixture stderr ready")
    control.ready()
  })
} else if (action === "start" || action === "stop") {
  const result = await runDetachedCommand(action, process.argv[1]!, host, port)
  console.log(JSON.stringify(result))
  process.exit(detachedCommandSucceeded(result) ? 0 : 1)
} else throw new Error("Unknown fixture command")
