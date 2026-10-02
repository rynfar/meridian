import { runBookkeepingCli } from "../../proxy/session/bookkeeping/cli"

const directory = process.argv[2]!
for (let iteration = 0; iteration < 50; iteration++) {
  for (const [command, flags] of [["migrate", ["--writers-stopped"]], ["export-json", []]] as const) {
    const code = await runBookkeepingCli([command, "--session-dir", directory, "--json", ...flags])
    if (code !== 0) throw new Error(`iteration ${iteration} ${command}: exit ${code}`)
  }
}
