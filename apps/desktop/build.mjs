import { build } from 'esbuild'
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises'
await mkdir('dist', { recursive: true })
await Promise.all([
  build({ entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'electron-liquid-glass'] }),
  build({ entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ entryPoints: ['src/renderer.ts'], outfile: 'dist/renderer.js', bundle: true, platform: 'browser', format: 'iife' }),
  build({ entryPoints: ['src/runner.ts'], outfile: 'dist/runner.mjs', bundle: true, platform: 'node', format: 'esm' }),
  build({ entryPoints: ['src/trayRenderer.ts'], outfile: 'dist/trayRenderer.js', bundle: true, platform: 'browser', format: 'iife' }),
  copyFile('src/tray.html', 'dist/tray.html'),
  copyFile('src/tray.css', 'dist/tray.css'),
  copyFile('src/index.html', 'dist/index.html'),
  copyFile('src/style.css', 'dist/style.css'),
  copyFile('../../assets/icon-512.png', 'dist/icon.png'),
  ...['', '@2x', '@3x'].map(scale => copyFile(`../../assets/trayTemplate${scale}.png`, `dist/trayTemplate${scale}.png`)),
])
const tokens = await readFile('../../src/telemetry/profileBar.ts', 'utf8')
const theme = tokens.match(/export const desktopThemeCss = `([\s\S]*?)`/)
if (!theme) throw new Error('Missing canonical desktop theme')
await writeFile('dist/theme.css', theme[1])

const providerTokens = await readFile('../../src/telemetry/providerView.ts', 'utf8')
const providerCss = providerTokens.match(/export const providerViewCss = `([\s\S]*?)`/)
if (!providerCss) throw new Error('Missing provider styles')
await writeFile('dist/providers.css', providerCss[1])
