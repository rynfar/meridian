import { cpSync, mkdirSync } from "node:fs"

// The OpenCode plugin packages ship as compiled ESM beside dist/cli.js. Their
// manifests are copied verbatim so an installed CLI resolves index.js without
// falling back to TypeScript, which Node cannot load from node_modules.
const plugins = ["meridian", "meridian-v2"]

for (const name of plugins) {
  const source = `plugin/${name}/package.json`
  const target = `dist/${name}`

  mkdirSync(target, { recursive: true })
  cpSync(source, `${target}/package.json`)
}
