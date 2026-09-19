import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function createImageFixture(root, name, { large = false } = {}) {
  const path = join(root, name + '.png')
  const result = spawnSync(process.env.E2E_PYTHON || 'python3', ['-c', `from PIL import Image, ImageDraw, ImageFont
import secrets,sys
code=secrets.token_hex(3).upper()
large=sys.argv[2]=='large'
im=Image.new('RGB',(1200,1200) if large else (720,160),'white')
ImageDraw.Draw(im).text((30,35),code,font=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc',72),fill='black')
im.save(sys.argv[1],compress_level=0 if large else 6)
print(code)`, path, large ? 'large' : 'small'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return { path, expected: result.stdout.trim(), data: (await readFile(path)).toString('base64') }
}

export async function verifyImageClients({ root, api, model, proxyUrl, report }) {
  const piVersion = spawnSync(process.env.E2E_PI_BIN || 'pi', ['--version'], { encoding: 'utf8' })
  assert.equal(piVersion.status, 0, piVersion.stderr)
  report.piVersion = piVersion.stdout.trim()
  const piConfig = join(root, 'pi-config'); await mkdir(piConfig)
  await writeFile(join(piConfig, 'models.json'), JSON.stringify({ providers: { 'meridian-agy': { baseUrl: proxyUrl, apiKey: 'local-fixture', api: 'anthropic-messages', models: [{ id: model.modelID, name: model.modelID, reasoning: false, input: ['text', 'image'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
  const env = { ...process.env, PI_CODING_AGENT_DIR: piConfig, PI_OFFLINE: '1', PI_TELEMETRY: '0' }
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|GEMINI_API_KEY|GOOGLE_API_KEY)/.test(key)) delete env[key]
  for (const tool of ['opencode', 'structured'].includes(process.env.E2E_IMAGE_CLIENT) ? [] : [false, true]) {
    const image = await createImageFixture(root, tool ? 'pi-read' : 'pi-input')
    const args = ['--provider', 'meridian-agy', '--model', model.modelID, '--thinking', 'off', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--system-prompt', 'Read the six characters visibly printed in the image. Reply with those exact characters.', ...(tool ? ['--tools', 'read'] : ['--no-tools']), '-p', ...(tool ? [`Use your read tool to inspect ${image.path}, then return the six visible characters.`] : ['@' + image.path, 'Return the six visible characters in the attached image.'])]
    const child = spawn(process.env.E2E_PI_BIN || 'pi', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d }); child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGTERM'), 180000)
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
    await writeFile(join(root, `pi-image-${tool ? 'read' : 'input'}.log`), stdout + '\n' + stderr)
    assert.equal(code, 0, stderr); assert(stdout.includes(image.expected), stdout + stderr)
    report.passed.push(`actual Pi ${tool ? 'read tool image result' : 'image attachment'}: random visual code`)
    console.log('PASS', report.passed.at(-1))
  }
  for (const tool of process.env.E2E_IMAGE_CLIENT === 'structured' ? [] : [false, true]) {
    const image = await createImageFixture(root, tool ? 'opencode-read' : 'opencode-input')
    const session = await api('/session', { title: 'Image capability acceptance' })
    const parts = tool ? [{ type: 'text', text: `Use your read tool to inspect ${image.path} and return only the six visible characters. Do not use any other tools.` }] : [{ type: 'text', text: 'Return only the six characters visibly printed in this attached image. Do not use client tools.' }, { type: 'file', mime: 'image/png', filename: 'attachment.png', url: 'data:image/png;base64,' + image.data }]
    const result = await api(`/session/${session.id}/message`, { model, parts })
    assert(!result.info?.error, JSON.stringify(result))
    const text = result.parts.filter(p => p.type === 'text').map(p => p.text).join('')
    assert(text.includes(image.expected), JSON.stringify(result))
    if (tool) {
      const history = await api(`/session/${session.id}/message`)
      const read = history.flatMap(message => message.parts).find(p => p.type === 'tool' && p.tool === 'read' && p.state.status === 'completed')
      assert(read, 'OpenCode must actually execute read')
      assert(read.state.attachments?.some(part => part.mime === 'image/png'), 'Read result must contain image bytes')
    }
    report.passed.push(`actual OpenCode ${tool ? 'read tool image result' : 'image attachment'}: random visual code`)
    console.log('PASS', report.passed.at(-1))
  }
  const session = await api('/session', { title: 'Structured output acceptance' })
  const result = await api(`/session/${session.id}/message`, { model, format: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' }, count: { type: 'integer' } }, required: ['answer', 'count'], additionalProperties: false }, retryCount: 0 }, parts: [{ type: 'text', text: 'Return answer READY and count 7 matching the requested schema.' }] })
  assert(!result.info?.error, JSON.stringify(result))
  assert.deepEqual(result.info.structured, { answer: 'READY', count: 7 })
  report.passed.push('actual OpenCode structured output through its schema tool')
  console.log('PASS', report.passed.at(-1))
}
