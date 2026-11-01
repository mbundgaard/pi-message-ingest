import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from '@earendil-works/pi-ai';
import extension from '../src/index.js';
import { EXTERNAL_START, MESSAGE_TYPE } from '../src/delivery.js';

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function until(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${description}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('real Pi SDK + loopback: unmapped, raw input, busy follow-up, reload and disable', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ingest-sdk-'));
  const agentDir = path.join(root, 'agent'); await mkdir(agentDir);
  const requests: Message[][] = [];
  const releases: Array<() => void> = [];
  let hold = false;
  const provider = (pi: ExtensionAPI) => pi.registerProvider('ingest-test', {
    api: 'ingest-test-api', baseUrl: 'http://127.0.0.1/never-used', apiKey: 'synthetic-test-key',
    models: [{ id: 'test', name: 'Local deterministic test', reasoning: false, input: ['text'],
      contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      requests.push(structuredClone(context.messages));
      const stream = createAssistantMessageEventStream();
      const complete = () => {
        const response: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [{ type: 'text', text: 'local synthetic response' }], timestamp: Date.now(), stopReason: 'stop',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: response });
        stream.push({ type: 'done', reason: 'stop', message: response }); stream.end();
      };
      if (hold) releases.push(complete); else queueMicrotask(complete);
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resources = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [provider, extension] });
  await resources.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: path.join(agentDir, 'models'), refreshOnCreate: false });
  const sessionManager = SessionManager.create(root, path.join(root, 'sessions'));
  const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: resources, modelRuntime,
    sessionManager, settingsManager, tools: [], thinkingLevel: 'off' });
  const errors: string[] = [];
  t.after(async () => {
    hold = false; for (const release of releases.splice(0)) release();
    await session.abort();
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose(); await rm(root, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error.error) });
  const model = modelRuntime.getModel('ingest-test', 'test'); assert.ok(model);
  await session.setModel(model, { persist: false });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const runner = session.extensionRunner;
    const tool = runner.getToolDefinition(name); assert.ok(tool, name);
    const result = await tool.execute('test-call', args, new AbortController().signal, undefined, runner.createToolContext('test-call', undefined));
    const text = result.content.find(part => part.type === 'text'); assert.ok(text?.type === 'text');
    return JSON.parse(text.text);
  };
  assert.equal((await call('message_ingest_status')).configured, false);
  await assert.rejects(call('message_ingest_enable'), /No mapping/);
  await assert.rejects(call('message_ingest_token'), /No mapping/);
  const port = await freePort();
  const configured = await call('message_ingest_configure', { port });
  const token = configured.token;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(configured.status.listener, 'stopped');
  assert.equal(configured.status.sessionId, sessionManager.getSessionId());
  assert.ok(!JSON.stringify(await call('message_ingest_status')).includes(token));
  assert.equal((await call('message_ingest_enable')).listener, 'ready');
  assert.equal((await call('message_ingest_token')).token, token);
  assert.equal((await call('message_ingest_status')).listener, 'ready', 'token retrieval must not restart or disable');
  const post = (body: string, auth = token) => fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { Authorization: `Bearer ${auth}` }, body });
  assert.equal((await post('blocked', 'wrong')).status, 401);
  const body = '  /not-a-command\r\n{"text":"not an envelope"}\nUnicode: æ 📨\n  ';
  assert.equal((await post(body)).status, 202);
  await until(() => session.messages.some(m => m.role === 'custom' && m.customType === MESSAGE_TYPE && m.content === body), 'custom message receipt');
  await until(() => !session.isStreaming && requests.length === 1, 'idle body run settled');
  assert.ok(requests[0]!.some(m => m.role === 'user' && JSON.stringify(m.content).includes('not an envelope')));
  assert.ok(requests[0]!.some(m => m.role === 'system' && m.content === EXTERNAL_START));
  const received = requests[0]!.find(m => m.role === 'user')!;
  assert.deepEqual(received.content, [{ type: 'text', text: body }]);

  hold = true;
  const consoleRun = session.prompt('Unrelated console work');
  await until(() => releases.length === 1, 'busy console run');
  const before = requests.length;
  assert.equal((await post('first external while busy')).status, 202);
  assert.equal((await post('second external while busy')).status, 202);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(requests.length, before, 'must not interrupt active work');
  assert.equal((await call('message_ingest_status')).delivery.waiting, 2);
  await call('message_ingest_enable');
  assert.equal((await call('message_ingest_status')).delivery.waiting, 2, 'repeated enable must not discard waiting bodies');
  hold = false; releases.shift()!(); await consoleRun;
  await until(() => requests.length === before + 2 && !session.isStreaming, 'two follow-up runs');
  const bodies = session.messages.filter(m => m.role === 'custom').map(m => m.content);
  assert.deepEqual(bodies, [body, 'first external while busy', 'second external while busy']);

  await session.reload();
  assert.equal((await call('message_ingest_status')).listener, 'ready');
  assert.equal((await post('after reload')).status, 202);
  await until(() => session.messages.some(m => m.role === 'custom' && m.content === 'after reload') && !session.isStreaming, 'reload receipt');
  hold = true;
  const busyAtDisable = session.prompt('Console work during disable');
  await until(() => releases.length === 1, 'busy run before disable');
  assert.equal((await post('discard this waiting body')).status, 202);
  const disabled = await call('message_ingest_disable');
  assert.equal(disabled.listener, 'stopped');
  assert.equal(disabled.discardedWaitingMessages, 1);
  hold = false; releases.shift()!(); await busyAtDisable;
  assert.ok(!session.messages.some(m => m.role === 'custom' && m.content === 'discard this waiting body'));
  await assert.rejects(post('after disable'));
  assert.deepEqual(errors, []);
});
