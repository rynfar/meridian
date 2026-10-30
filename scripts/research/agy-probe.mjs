// Opt-in live research: uses the official agy CLI and existing account login.
// No SDK, API keys, credential reads, transcript edits, or production imports.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const mode = process.argv[2] || 'basic';
assert(['basic', 'tools', 'input', 'cancel'].includes(mode), 'case: basic|tools|input|cancel');
const model = process.env.AGY_RESEARCH_MODEL || 'gemini-3.8-flash-low';
const binary = process.env.AGY_RESEARCH_BIN || 'agy';
const root = await mkdtemp(join(tmpdir(), 'meridian-agy-'));
const children = new Set();
const servers = new Set();
const runs = [];
const report = { case: mode, model, platform: `${platform()}-${arch()}`, date: new Date().toISOString(), root, observations: [] };
console.log(`Artifacts: ${root}`);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function bounded(promise, ms = 65000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function killGroup(child, signal) {
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function launch(label, args, cwd = root) {
  const child = spawn(binary, [...args, '--model', model, '--output-format', 'stream-json', '--print-timeout', '45s'], {
    cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  children.add(child);
  const events = [], results = [], waiters = [];
  let stdout = '', stderr = '', parseError;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const event = JSON.parse(line);
      events.push(event);
      if (event.event === 'result') {
        results.push(event.result);
        waiters.shift()?.resolve(event.result);
      }
    } catch (error) { parseError = error; }
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      children.delete(child);
      for (const waiter of waiters) waiter.reject(new Error(`${label} exited before result: ${code}/${signal}`));
      resolve({ code, signal });
    });
  });
  // Observe errors immediately, even when waiting for a tool callback first.
  closed.catch(error => { parseError = error; });
  let consumed = 0;
  const run = {
    child, events, results, closed,
    send(content) { child.stdin.write(JSON.stringify({ event: 'user', message: { content } }) + '\n'); },
    async next() {
      if (results.length > consumed) return results[consumed++];
      const waiter = deferred(); waiters.push(waiter); consumed++;
      return bounded(waiter.promise);
    },
    async save() {
      await writeFile(join(root, `${label}.ndjson`), stdout);
      await writeFile(join(root, `${label}.stderr`), stderr);
      if (parseError) throw parseError;
    },
  };
  runs.push(run);
  return run;
}
function success(result, expected) {
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result));
  if (expected) assert.equal(result.response.trim(), expected);
}
async function one(label, prompt, extra = [], cwd = root) {
  const run = await launch(label, ['-p', prompt, ...extra], cwd);
  try {
    const result = await run.next();
    const exit = await bounded(run.closed);
    assert.equal(exit.code, 0);
    return { result, events: run.events };
  } finally { await run.save(); }
}
async function listen(handler) {
  const server = createServer(handler);
  servers.add(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; assert(data.length < 1048576); }
  return JSON.parse(data);
}

try {
  assert.notEqual(platform(), 'win32', 'POSIX process cleanup only; Windows is untested');
  const settingsFile = join(homedir(), '.gemini/antigravity-cli/settings.json');
  let settings = {};
  try { settings = JSON.parse(await readFile(settingsFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert(!settings.modelProvider, 'Refusing non-default provider; research requires account authentication');
  assert(!settings.useG1Credits, 'Disable paid overage credits before subscription research');
  const forbidden = Object.keys(process.env).filter(key => /^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GENAI_USE_.*|GOOGLE_GEMINI_BASE_URL|ANTHROPIC_API_KEY)$/.test(key) && process.env[key]);
  assert.equal(forbidden.length, 0, `Remove API/provider overrides first: ${forbidden.join(', ')}`);
  report.auth = 'default CLI account provider; no API/provider overrides';
  report.paidOverageCredits = false;
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(version.status, 0);
  report.cli = version.stdout.trim();

  if (mode === 'basic') {
    const token = `MEMORY_${randomUUID()}`;
    const first = await one('first', `Remember this token: ${token}. Reply with exactly READY. Do not use tools.`);
    success(first.result, 'READY');
    const resumed = await one('resume', 'Reply with exactly the token I asked you to remember. Do not use tools.', ['--conversation', first.result.conversation_id]);
    success(resumed.result, token);
    assert.equal(first.result.conversation_id, resumed.result.conversation_id);
    report.observations.push({ name: 'new-process-resume', passed: true });
    const run = await launch('persistent', ['--input-format', 'stream-json']);
    try {
      run.send(`Remember ${token}. Reply with exactly READY. Do not use tools.`);
      const a = await run.next(); success(a, 'READY');
      run.send('Reply with exactly the token I asked you to remember. Do not use tools.');
      const b = await run.next(); success(b, token);
      assert.equal(a.conversation_id, b.conversation_id);
      run.child.stdin.end();
      assert.equal((await bounded(run.closed)).code, 0);
      report.observations.push({ name: 'persistent-stdin', passed: true, firstUsage: a.usage, secondUsage: b.usage });
    } finally { await run.save(); }
    const results = await Promise.all(['LEFT', 'RIGHT'].map(async side => {
      const value = `${side}_${randomUUID()}`;
      const r = await one(side.toLowerCase(), `Reply with exactly ${value}. Do not use tools.`);
      success(r.result, value); return r.result.conversation_id;
    }));
    assert.notEqual(results[0], results[1]);
    report.observations.push({ name: 'concurrent-independent-conversations', passed: true });
  }

  if (mode === 'input') {
    const run = await launch('native-tool-result', ['--input-format', 'stream-json']);
    try {
      run.send([{ type: 'tool_result', tool_use_id: 'probe', content: 'receipt' }]);
      run.child.stdin.end();
      const exit = await bounded(run.closed);
      assert.notEqual(exit.code, 0);
      assert(run.results.some(result => result.error?.includes('"tool_result" is not supported')));
      report.observations.push({ name: 'native-tool-result-input', exit, results: run.results });
    } finally { await run.save(); }
  }

  if (mode === 'cancel') {
    const run = await launch('cancel', ['--input-format', 'stream-json']);
    try {
      run.send('Write a detailed 2000-word essay about binary search. Do not use tools.');
      await bounded((async () => {
        const deadline = Date.now() + 60000;
        while (!run.events.some(event => event.step_update?.text_delta)) {
          assert(Date.now() < deadline && run.child.exitCode === null, 'No text before exit/deadline');
          await delay(25);
        }
      })());
      const start = Date.now(); killGroup(run.child, 'SIGINT');
      const exit = await bounded(run.closed, 10000);
      assert.notEqual(exit.code, 0);
      report.observations.push({ name: 'process-group-cancellation', exit, elapsedMs: Date.now() - start, results: run.results });
    } finally { await run.save(); }
  }

  if (mode === 'tools') {
    const received = deferred(), externalResult = deferred();
    let callCount = 0;
    const rpcLog = [];
    const mcpUrl = await listen(async (req, res) => {
      try {
        if (req.method !== 'POST') return json(res, 405, {});
        const rpc = await body(req); rpcLog.push(rpc);
        if (!('id' in rpc)) { res.writeHead(202); res.end(); return; }
        let result;
        if (rpc.method === 'initialize') result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'meridian-research', version: '0.0.1' } };
        else if (rpc.method === 'tools/list') result = { tools: [{ name: 'lookup_receipt', description: 'Get the secret receipt from the external client. This is the only way to obtain it.', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }] };
        else if (rpc.method === 'tools/call') {
          callCount++;
          assert.equal(rpc.params.name, 'lookup_receipt');
          received.resolve(rpc.params);
          result = { content: [{ type: 'text', text: await bounded(externalResult.promise, 30000) }] };
        } else return json(res, 200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } });
        json(res, 200, { jsonrpc: '2.0', id: rpc.id, result });
      } catch (error) { json(res, 500, { error: error.message }); }
    });
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.agents'), { recursive: true });
    await writeFile(join(workspace, '.agents/mcp_config.json'), JSON.stringify({ mcpServers: { meridian_research: { serverUrl: mcpUrl } } }));
    // Hook is scoped to the disposable workspace. Only the fixture MCP call is allowed.
    const hook = join(root, 'hook.cjs');
    await writeFile(hook, `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const v=JSON.parse(s);require('node:fs').appendFileSync(${JSON.stringify(join(root, 'hooks.ndjson'))},JSON.stringify(v)+'\\n');const n=v.toolCall?.name||'';const allowed=n==='call_mcp_tool'&&v.toolCall.args.ServerName==='meridian_research'&&v.toolCall.args.ToolName==='lookup_receipt';console.log(JSON.stringify({decision:allowed?'allow':'deny',permissionOverrides:allowed?['mcp(meridian_research/lookup_receipt)']:[],reason:'Isolated Meridian research fixture'}));});`);
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(join(workspace, '.agents/hooks.json'), JSON.stringify({ research: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(hook)}`, timeout: 5 }] }] } }));
    const permissionArgs = process.env.AGY_RESEARCH_AUTO_APPROVE === '1' ? ['--dangerously-skip-permissions'] : [];
    report.autoApprove = permissionArgs.length > 0;
    const run = await launch('tool-bridge', [...permissionArgs, '--new-project', '--add-dir', workspace, '-p', 'Call the meridian_research MCP tool lookup_receipt exactly once with key="probe". Reply with exactly the returned receipt. Do not use any other tools, read files, or guess the receipt.'], workspace);
    const toolId = `toolu_${randomUUID()}`;
    let round = 0;
    const clientUrl = await listen(async (req, res) => {
      try {
        assert.equal(req.url, '/v1/messages');
        const request = await body(req);
        if (round++ === 0) {
          const call = await bounded(Promise.race([received.promise, run.closed.then(() => { throw new Error('agy exited before requesting the MCP tool; inspect tool-bridge.ndjson'); })]));
          return json(res, 200, { id: 'research_tool', type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id: toolId, name: call.name, input: call.arguments }], stop_reason: 'tool_use' });
        }
        const toolResult = request.messages.at(-1).content[0];
        assert.equal(toolResult.type, 'tool_result');
        assert.equal(toolResult.tool_use_id, toolId);
        externalResult.resolve(toolResult.content);
        const result = await run.next(); success(result);
        json(res, 200, { id: 'research_answer', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: result.response }], stop_reason: 'end_turn' });
      } catch (error) { json(res, 500, { error: error.message }); }
    });
    try {
      const request = data => bounded(fetch(`${clientUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }).then(async response => { const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data; }));
      const first = await request({ messages: [{ role: 'user', content: 'Get receipt' }] });
      assert.equal(first.stop_reason, 'tool_use');
      assert.deepEqual(first.content[0].input, { key: 'probe' });
      assert.equal(run.results.length, 0, 'agy must wait for the external client result');
      await delay(1500);
      const receipt = `EXTERNAL_${randomUUID()}`; // Created only after tool handoff.
      const second = await request({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: receipt }] }] });
      // Formatting is a separate observation: the harness can add timestamps.
      // The randomly created receipt must still survive exactly and only once.
      assert.deepEqual(second.content[0].text.match(/EXTERNAL_[a-f0-9-]+/g), [receipt]);
      assert.equal(callCount, 1);
      assert.equal((await bounded(run.closed)).code, 0);
      const toolDone = run.events.find(event => event.step_update?.step_type === 'tool' && event.step_update.state === 'DONE');
      assert.equal(toolDone?.step_update.tool_info.output, receipt);
      report.observations.push({ name: 'external-client-tool-roundtrip', passed: true, callCount, heldMs: 1500, receipt, exactFormatting: second.content[0].text.trim() === receipt, first, second, usage: run.results[0].usage });
      const resumed = await one('tool-resume', 'Without calling any tools, repeat the EXTERNAL_ receipt from our last tool result. Output only the receipt, without timestamps.', ['--conversation', run.results[0].conversation_id], workspace);
      success(resumed.result);
      assert.deepEqual(resumed.result.response.match(/EXTERNAL_[a-f0-9-]+/g), [receipt]);
      assert.equal(callCount, 1);
      report.observations.push({ name: 'completed-tool-history-resume', passed: true });
      const forbiddenValue = `FORBIDDEN_${randomUUID()}`;
      const forbiddenPath = join(workspace, 'guard.txt');
      await writeFile(forbiddenPath, forbiddenValue);
      const guard = await one('guard', `Use view_file to read ${forbiddenPath}. Do not use any other tool. If denied, stop immediately.`, [...permissionArgs, '--conversation', run.results[0].conversation_id], workspace);
      const reads = guard.events.filter(event => event.step_update?.tool_name === 'view_file');
      assert(reads.some(event => event.step_update.state === 'ERROR'), 'Expected denied builtin tool');
      assert(!reads.some(event => event.step_update.state === 'DONE'), 'Builtin tool executed');
      assert(!JSON.stringify(guard).includes(forbiddenValue), 'Denied file contents leaked');
      assert.equal(callCount, 1);
      report.observations.push({ name: 'builtin-denied-with-auto-approve', passed: true });
    } finally {
      await run.save();
      await writeFile(join(root, 'mcp.ndjson'), rpcLog.map(value => JSON.stringify(value)).join('\n') + '\n');
    }
  }
  report.cliAtEnd = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 }).stdout.trim();
  assert.equal(report.cliAtEnd, report.cli, 'CLI version changed during the probe');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  for (const child of children) killGroup(child, 'SIGTERM');
  if (children.size) await delay(500);
  for (const child of children) killGroup(child, 'SIGKILL');
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  for (const run of runs) {
    try { await bounded(run.closed, 2000); await run.save(); }
    catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
  }
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
