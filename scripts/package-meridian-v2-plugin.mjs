import { cpSync, mkdirSync } from "node:fs"

const source = "plugin/meridian-v2/package.json"
const target = "dist/meridian-v2"

mkdirSync(target, { recursive: true })
cpSync(source, `${target}/package.json`)
