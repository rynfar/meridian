import { claudeCodeSessionKey } from "/Users/rynfar/repos/meridian-claude-subagent-1231-20261004/src/proxy/adapters/claudecode.ts"
import { checkParameters } from "/Users/rynfar/repos/meridian-sqlite-opt-in-correction-1277-20261004/src/proxy/session/bookkeeping/connection.ts"
for (const session_id of ["synthetic-root", "synthetic\u0000root"]) {
 const key = claudeCodeSessionKey("synthetic-agent", { metadata: { user_id: { session_id } } })
 if (!key || key.includes("\u0000")) throw new Error("producer injected scalar NUL")
 checkParameters([key])
}
console.log(JSON.stringify({status:"representable",keyContainsNul:false,controls:2}))
