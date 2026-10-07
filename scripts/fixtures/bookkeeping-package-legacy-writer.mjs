import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const [packageRoot, directory] = process.argv.slice(2)
process.env.MERIDIAN_SESSION_DIR = directory
process.env.MERIDIAN_BOOKKEEPING = "json"
process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "0"
const api = await import(pathToFileURL(join(packageRoot, "dist/server.js")).href)
// The independently installed OLD package's public cache reset attempts a
// persistent JSON write through its own unchanged legacy lock implementation.
api.clearSessionCache()
process.exit(existsSync(join(directory, "sessions.json")) ? 0 : 73)
