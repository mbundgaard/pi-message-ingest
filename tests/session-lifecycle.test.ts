import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import extension from '../src/index.js';

async function freePort() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function call(session: AgentSession, name: string, args = {}) {
  const runner = session.extensionRunner;
  const tool = runner.getToolDefinition(name)!;
  const result = await tool.execute('fixture', args, new AbortController().signal, undefined, runner.createToolContext('fixture', undefined));
  const content = result.content.find(part => part.type === 'text');
  assert.ok(content?.type === 'text'); return JSON.parse(content.text);
}

test('real Pi runtime new, resume and fork release exact-session listeners without inheriting mappings', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ingest-session-'));
  const agentDir = path.join(root, 'agent'); await mkdir(agentDir);
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: path.join(agentDir, 'models'), refreshOnCreate: false });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const manager = SessionManager.create(root, path.join(root, 'sessions'));
  const userEntry = manager.appendMessage({ role: 'user', content: 'Synthetic lifecycle fixture; do not send to a model.', timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', api: 'fixture', provider: 'fixture', model: 'fixture', content: [], stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [extension] } });
    return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: [] }),
      services, diagnostics: services.diagnostics };
  }, { cwd: root, agentDir, sessionManager: manager });
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  const errors: string[] = [];
  runtime.setRebindSession(async session => { await session.bindExtensions({ mode: 'rpc', onError: e => errors.push(e.error) }); });
  await runtime.session.bindExtensions({ mode: 'rpc', onError: e => errors.push(e.error) });
  const originalPath = runtime.session.sessionFile!; assert.ok(originalPath);
  const originalId = manager.getSessionId();
  const port = await freePort();
  await call(runtime.session, 'message_ingest_configure', { port });
  await call(runtime.session, 'message_ingest_enable');
  const request = () => fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'no authentication' });
  assert.equal((await request()).status, 401);

  await runtime.newSession();
  const newStatus = await call(runtime.session, 'message_ingest_status');
  assert.notEqual(newStatus.sessionId, originalId);
  assert.equal(newStatus.configured, false);
  await assert.rejects(request());

  await runtime.switchSession(originalPath);
  const resumed = await call(runtime.session, 'message_ingest_status');
  assert.equal(resumed.sessionId, originalId);
  assert.equal(resumed.listener, 'ready');
  assert.equal((await request()).status, 401);

  await runtime.fork(userEntry, { position: 'at' });
  const forked = await call(runtime.session, 'message_ingest_status');
  assert.notEqual(forked.sessionId, originalId);
  assert.equal(forked.configured, false);
  await assert.rejects(request());
  assert.deepEqual(errors, []);
});
