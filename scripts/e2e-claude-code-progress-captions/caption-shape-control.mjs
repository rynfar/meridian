import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const need = (value, message) => { if (!value) throw new Error(message); };
const oldText = readFileSync(join(here, 'historical-caption-shape.txt'), 'utf8');
need(digest(oldText) === '1fd752fb4b120d6505e6056bf8c81f00aae3b52cc7eddf4770263046244d4d43', 'Historical caption recognizer changed');
const source = readFileSync(join(here, 'caption-native-gate.mjs'), 'utf8');
const currentText = source.slice(source.indexOf('const CAPTION_PREFIX ='), source.indexOf('function blocks(messages)'));
function compile(text) {
  return new Function(`${text}; return { captionShape, text: CAPTION_PREFIX + CAPTION_SUFFIX };`)();
}
const old = compile(oldText), current = compile(currentText);
need(old.text === current.text, 'Caption instruction changed');
const caption = { role: 'user', content: [{ type: 'text', text: current.text }] };
const frame = { role: 'system', content: '<total_tokens>14995313 tokens left</total_tokens>' };
const body = { stream: true, tools: [{ name: 'Read' }], messages: [caption, frame] };
const headers = new Headers({ 'x-claude-code-session-id': 'owned-control' });
const original = JSON.stringify(body);
need(old.captionShape(body, headers) === false, 'Original actual-wire false negative not reproduced');
need(current.captionShape(body, headers) === true, 'Corrected actual-wire caption unrecognized');
need(current.captionShape({ ...body, messages: [caption] }, headers), 'Existing caption behavior changed');
need(!current.captionShape(body, new Headers()), 'Budget frame gained non-native authority');
for (const messages of [
  [caption, frame, frame],
  [caption, { ...frame, content: frame.content + '\n' }],
  [caption, { ...frame, content: '<total_tokens>001 tokens left</total_tokens>' }],
  [caption, { ...frame, role: 'assistant' }],
  [caption, { ...frame, content: [{ type: 'text', text: frame.content }] }],
  [{ role: 'user', content: 'Continue ordinary work.' }, frame],
  [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'same', content: 'x' }, { type: 'tool_result', tool_use_id: 'same', content: 'y' }, { type: 'text', text: current.text }] }, frame],
]) need(!current.captionShape({ ...body, messages }, headers), 'Malformed or ordinary trailing message gained caption authority');
need(!current.captionShape({ ...body, stream: false }, headers), 'Unstreamed turn gained caption authority');
need(!current.captionShape({ ...body, tools: [] }, headers), 'Toolless turn gained caption authority');
need(JSON.stringify(body) === original, 'Observer mutated request');
console.log(JSON.stringify({ status: 'PASS', historicalRecognizerSha256: digest(oldText), currentRecognizerSha256: digest(currentText), historicalActualWireFalseNegativeReproduced: true, currentActualWireRecognized: true, existingAndNegativeBoundariesPreserved: true, requestUnchanged: true, modelCalls: 0, nativeChildren: 0, scope: 'Exact extracted observer functions on the preserved native wire shape; no live acceptance claim' }));
