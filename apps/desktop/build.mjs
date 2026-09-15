import { build } from 'esbuild'
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises'
await mkdir('dist', { recursive: true })
await Promise.all([
  build({ entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'electron-liquid-glass'] }),
  build({ entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ entryPoints: ['src/renderer.ts'], outfile: 'dist/renderer.js', bundle: true, platform: 'browser', format: 'iife' }),
  build({ entryPoints: ['src/runner.ts'], outfile: 'dist/runner.mjs', bundle: true, platform: 'node', format: 'esm' }),
  copyFile('src/index.html', 'dist/index.html'),
  copyFile('src/style.css', 'dist/style.css'),
  copyFile('../../assets/icon-512.png', 'dist/icon.png'),
])
const tokens = await readFile('../../src/telemetry/profileBar.ts', 'utf8')
const theme = tokens.match(/export const desktopThemeCss = `([\s\S]*?)`/)
if (!theme) throw new Error('Missing canonical desktop theme')
await writeFile('dist/theme.css', theme[1])
