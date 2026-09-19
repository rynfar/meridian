import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { startProxyServer } from '../dist/server.js'
import { createImageFixture } from './lib-antigravity-image-checks.mjs'
const root = await mkdtemp(join(tmpdir(), 'meridian-agy-media-'))
console.log(`Artifacts: ${root}`)
const model = process.env.E2E_AGY_MODEL || 'gemini-3.8-flash-low'
const report = { model, platform: process.platform, node: process.version, passed: [] }
const command = (bin, args) => { const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 90000 }); assert.equal(result.status, 0, result.stderr); return result.stdout }
let proxy
try {
  proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { allowToolBridge: true, maxConcurrent: 2 } })
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const url = `http://127.0.0.1:${proxy.server.address().port}`
  const send = async (name, content, expected, extra = {}) => {
    const response = await fetch(url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content }], ...extra }), signal: AbortSignal.timeout(180000) })
    const answer = await response.json()
    await writeFile(join(root, name + '.json'), JSON.stringify({ status: response.status, answer }, null, 2))
    assert.equal(response.status, 200, JSON.stringify(answer))
    assert(answer.content.filter(block => block.type === "text").map(block => block.text).join("").toLowerCase().includes(expected.toLowerCase()), JSON.stringify(answer))
    report.passed.push(name); console.log('PASS', name)
  }
  const code = 'PDF_' + randomUUID().slice(0, 8).toUpperCase()
  const pdf = join(root, 'receipt.pdf')
  command(process.env.E2E_PYTHON || 'python3', ['-c', 'from reportlab.pdfgen import canvas\nimport sys\nc=canvas.Canvas(sys.argv[1]);c.setFont("Helvetica",30);c.drawString(60,650,sys.argv[2]);c.save()', pdf, code])
  await send('pdf', [{ type: 'text', text: 'Read the attached PDF page and return its exact code.' }, { type: 'document', title: 'Receipt', source: { type: 'base64', media_type: 'application/pdf', data: (await readFile(pdf)).toString('base64') } }], code)
  await send('url-image', [{ type: 'text', text: 'Which programming language is named in this logo?' }, { type: 'image', source: { type: 'url', url: 'https://www.python.org/static/community_logos/python-logo.png' } }], 'python')
  const audio = join(root, 'speech.aiff'), wave = join(root, 'speech.wav')
  command('say', ['-o', audio, 'The delivery code is maple river orange.'])
  command('ffmpeg', ['-v', 'error', '-i', audio, '-ar', '16000', '-ac', '1', wave])
  await send('audio-transcript', [{ type: 'text', text: 'Return only the three-word delivery code spoken in the attachment.' }, { type: 'audio', source: { type: 'base64', media_type: 'audio/wav', data: (await readFile(wave)).toString('base64') } }], 'maple river orange')
  const image = await createImageFixture(root, 'video-code')
  const video = join(root, 'clip.mp4')
  command('ffmpeg', ['-v', 'error', '-loop', '1', '-i', image.path, '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video])
  await send('video-frames', [{ type: 'text', text: 'Return only the six characters visibly printed in the video.' }, { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: (await readFile(video)).toString('base64') } }], image.expected)
  await send('numeric-enum-schema', 'Return count 2 in the required JSON schema.', '"count":2', { stop_sequences: ['NEVER_MATCH'], output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { count: { type: 'integer', enum: [1, 2] } }, required: ['count'], additionalProperties: false } } } })
} catch (error) { report.error = String(error); throw error }
finally { await proxy?.close(); await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)) }
