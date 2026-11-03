import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const production = process.env.MERIDIAN_DESKTOP_DEV !== '1'
await mkdir('dist', { recursive: true })

// Renderers: React entry points, bundled for the sandboxed browser windows.
// NODE_ENV selects React's production build and removes `process` references.
const renderer = entry => ({
  entryPoints: [entry.from], outfile: entry.to, bundle: true, platform: 'browser', format: 'iife', target: 'chrome130',
  jsx: 'automatic', minify: production, sourcemap: production ? false : 'inline', legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
})

await Promise.all([
  build({ entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'electron-liquid-glass'] }),
  build({ entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ entryPoints: ['src/runner.ts'], outfile: 'dist/runner.mjs', bundle: true, platform: 'node', format: 'esm' }),
  build(renderer({ from: 'src/ui/window.tsx', to: 'dist/window.js' })),
  build(renderer({ from: 'src/ui/tray.tsx', to: 'dist/tray.js' })),
  copyFile('src/index.html', 'dist/index.html'),
  copyFile('src/tray.html', 'dist/tray.html'),
  copyFile('../../assets/icon-512.png', 'dist/icon.png'),
  ...['', '@2x', '@3x'].map(scale => copyFile(`../../assets/trayTemplate${scale}.png`, `dist/trayTemplate${scale}.png`)),
])

// Colour tokens: the canonical desktop light/dark set, plus the provider
// brands from the web theme (DESIGN §2), so no stylesheet carries a literal.
const tokens = await readFile('../../src/telemetry/profileBar.ts', 'utf8')
const theme = tokens.match(/export const desktopThemeCss = `([\s\S]*?)`/)
if (!theme) throw new Error('Missing canonical desktop theme')
const web = tokens.match(/export const themeCss = `([\s\S]*?)`/)
const brand = name => {
  const value = web?.[1].match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]
  if (!value) throw new Error(`Missing --${name} brand token`)
  return `--${name}: ${value.trim()};`
}
await writeFile('dist/theme.css', `${theme[1]}\n  :root { ${brand('claude')} ${brand('chatgpt')} }\n`)

// Tailwind v4 compiles src/ui/styles.css (tokens mapped through @theme) into dist/ui.css.
const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('@tailwindcss/cli/package.json')), 'dist/index.mjs')
await promisify(execFile)(process.execPath, [cli, '--input', 'src/ui/styles.css', '--output', 'dist/ui.css', ...(production ? ['--minify'] : [])], { maxBuffer: 16 * 1024 * 1024 })
const css = await readFile('dist/ui.css', 'utf8')
// Colours come from the tokens only: fail the build if a literal slips into a
// stylesheet rule. Tailwind's own --tw-* defaults and the minifier's #0000
// spelling of `transparent` are not colours of ours.
const ours = css.replace(/@property[^{]*\{[^}]*\}/g, '').replace(/--tw-[\w-]+:[^;}]*/g, '').replace(/#0000\b/g, 'transparent').replace(/@supports[^{]*\{/g, '{')
const literal = ours.match(/#[0-9a-fA-F]{3,8}\b(?![\w-])|\brgba?\(\s*\d/)
if (literal) throw new Error(`dist/ui.css contains a colour literal (${literal[0]}); use the theme tokens.`)
