// Built Meridian with an observer on the real SDK query: records only whether
// the prompt carries the skill receipt, never prompt text. Delegates unchanged.
import { spyOn } from 'bun:test'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendFileSync } from 'node:fs'
const require = createRequire(fileURLToPath(process.env.E2E_PROXY_MODULE))
const sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href)
const actual = sdk.query
const receipt = process.env.E2E_SKILL_RECEIPT
const record = (promptType, text) => appendFileSync(process.env.E2E_SDK_LOG, JSON.stringify({
  event: 'query',
  promptType,
  promptChars: text.length,
  hasReceipt: text.includes(receipt),
  hasSkillWrapper: text.includes('<skill_content'),
}) + '\n')
spyOn(sdk, 'query').mockImplementation(input => {
  if (typeof input.prompt === 'string') {
    record('string', input.prompt)
    return actual(input)
  }
  const source = input.prompt
  // Structured prompts are observed as they stream through, without buffering.
  const observed = (async function* () {
    let text = ''
    for await (const message of source) {
      text += JSON.stringify(message.message?.content ?? '')
      record('iterable', text)
      yield message
    }
  })()
  return actual({ ...input, prompt: observed })
})
const { startProxyServer } = await import(process.env.E2E_PROXY_MODULE)
// The independently installed OpenCode scrub plugin, as in the E67 V2 gate.
const plugins = process.env.E2E_PLUGIN_CONFIG ? { pluginConfigPath: process.env.E2E_PLUGIN_CONFIG, pluginDir: process.env.E2E_PLUGIN_DIR } : {}
const proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true, ...plugins })
process.send({ port: proxy.server.address().port })
process.on('SIGTERM', async () => { try { await proxy.close(); process.exit(0) } catch (error) { console.error(error); process.exit(1) } })
