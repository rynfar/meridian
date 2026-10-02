#!/usr/bin/env node
import { runBookkeepingCli } from "../src/proxy/session/bookkeeping/cli"

process.exitCode = await runBookkeepingCli(process.argv.slice(2))
