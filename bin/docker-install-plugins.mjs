#!/usr/bin/env node
// Installs npm plugin packages listed in MERIDIAN_PLUGINS and registers each
// in the Meridian plugin manifest, so containers can pick up plugins from an
// env var without a custom image build.
//
// MERIDIAN_PLUGINS is a comma-separated list of npm package specs, e.g.
//   MERIDIAN_PLUGINS="@rynfar/meridian-plugin-hermes-scrub,@rynfar/meridian-plugin-pi-scrub@1.2.0"
//
// Installs into ~/.config/meridian (the same directory the docs tell
// non-Docker users to `npm install` into) and writes/updates plugins.json at
// MERIDIAN_PLUGIN_CONFIG, or ~/.config/meridian/plugins.json by default.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"

const specsRaw = process.env.MERIDIAN_PLUGINS ?? ""
const specs = specsRaw.split(",").map(s => s.trim()).filter(Boolean)

if (specs.length === 0) {
  process.exit(0)
}

const configDir = join(homedir(), ".config", "meridian")
const manifestPath = process.env.MERIDIAN_PLUGIN_CONFIG ?? join(configDir, "plugins.json")

mkdirSync(configDir, { recursive: true })

console.log(`[docker-install-plugins] Installing: ${specs.join(", ")}`)
execFileSync("npm", ["install", "--no-audit", "--no-fund", ...specs], {
  cwd: configDir,
  stdio: "inherit",
})

// Split a spec like "@scope/name@1.2.3" or "name@1.2.3" into its package name,
// ignoring any trailing version/tag. A version marker is the last "@" that
// isn't the leading scope marker.
function packageNameFromSpec(spec) {
  const at = spec.lastIndexOf("@")
  return at > 0 ? spec.slice(0, at) : spec
}

// Node's own module resolution (exports map, conditions, main fallback,
// subpath patterns) rather than hand-rolling it — a hardcoded "dist/index.js"
// guess only holds for the official @rynfar/meridian-plugin-* packages.
const resolve = createRequire(join(configDir, "noop.js")).resolve

const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf-8"))
  : { plugins: [] }
if (!Array.isArray(manifest.plugins)) manifest.plugins = []

for (const spec of specs) {
  const packageName = packageNameFromSpec(spec)
  // realpath'd: require.resolve() resolves through symlinks (e.g. macOS's
  // /tmp -> /private/tmp), so packageDir must match that or the prefix
  // check below silently never matches.
  const packageDir = realpathSync(join(configDir, "node_modules", packageName))
  const entryPath = resolve(packageName)

  // Drop any prior entry for this package (reinstalls/upgrades) before
  // re-adding it, so re-running this script doesn't pile up duplicates.
  // Match on a path boundary, not a bare prefix — "meridian-plugin-hermes"
  // is a string-prefix of "meridian-plugin-hermes-scrub"'s directory.
  manifest.plugins = manifest.plugins.filter(entry => !entry.path.startsWith(packageDir + "/"))
  manifest.plugins.push({ path: entryPath, enabled: true })
  console.log(`[docker-install-plugins] Registered ${packageName} -> ${entryPath}`)
}

mkdirSync(dirname(manifestPath), { recursive: true })
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
