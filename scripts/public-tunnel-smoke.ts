// Explicitly authorized integration test. Secret values remain in private files/process memory.
// Exercises listener-only, loopback + public tunnel, busy delivery, and disable/re-enable.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import extension from '../src/index.js';
import { MESSAGE_TYPE, EXTERNAL_START } from '../src/delivery.js';

if (process.argv[2] !== '--run-public-test') throw new Error('Explicit --run-public-test is required');
const project = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const hostname = process.env.INGEST_TEST_HOSTNAME ?? '';
const port = Number(process.env.INGEST_TEST_PORT ?? '43180');
const tokenFile = process.env.INGEST_TEST_TOKEN_FILE ?? '';
if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(hostname)
    || !Number.isInteger(port) || port < 1 || port > 65535 || !path.isAbsolute(tokenFile)) {
  throw new Error('Set INGEST_TEST_HOSTNAME, an absolute INGEST_TEST_TOKEN_FILE path, and an optional valid INGEST_TEST_PORT. Never put token contents in these variables.');
}
const endpoints = { local: `http://127.0.0.1:${port}/`, tunnel: `https://${hostname}/` };
const reportFile = path.join(project, '.pi/local-tunnel-test-result.json');
const report: Record<string, unknown> = { hostname, port, startedAt: new Date().toISOString(), synthetic: true, hostedModelUsed: false };
const checks: Array<Record<string, unknown>> = [];
report.checks = checks;
let phase = 'preflight', session: AgentSession | undefined, completed = false, token = '';
let holdModel = false, releaseModel: (() => void) | undefined;
let requests = 0, extensionErrors = 0;
const seenAtModel = new Set<string>(), expectedBodies: string[] = [];
const probe = randomUUID(); report.probe = probe;
const log = (event: string, details: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...details }));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function check(condition: unknown) { if (!condition) throw new Error('Verification failed'); }
async function waitFor(predicate: () => boolean | Promise<boolean>, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error('Test deadline'); await delay(100); }
}
async function call(name: string, args = {}) {
  const runner = session!.extensionRunner, tool = runner.getToolDefinition(name);
  if (!tool) throw new Error('Tool unavailable');
  const result = await tool.execute('smoke-control', args, new AbortController().signal, undefined, runner.createToolContext('smoke-control', undefined));
  const text = result.content.find(part => part.type === 'text');
  if (text?.type !== 'text') throw new Error('Invalid tool result');
  return JSON.parse(text.text);
}
async function post(route: keyof typeof endpoints, body: string | Uint8Array, auth: 'valid' | 'missing' | 'wrong' = 'valid') {
  const headers: Record<string, string> = {};
  if (auth !== 'missing') headers.Authorization = `Bearer ${auth === 'valid' ? token : 'synthetic-invalid-key'}`;
  const response = await fetch(endpoints[route], { method: 'POST', body: body as BodyInit, headers,
    redirect: 'error', signal: AbortSignal.timeout(15000) });
  const status = response.status; await response.body?.cancel(); return status;
}
function receivedBodies(): string[] {
  return (session?.messages ?? []).flatMap(m => m.role === 'custom' && m.customType === MESSAGE_TYPE ? [m.content as string] : []);
}
async function verifyReceipt(body: string) {
  await waitFor(() => receivedBodies().includes(body) && seenAtModel.has(body) && !session!.isStreaming);
  check(extensionErrors === 0);
  const messages = session!.messages.filter(m => m.role === 'custom' && m.customType === MESSAGE_TYPE && m.content === body);
  check(messages.length === 1);
  check(messages.every(m => m.role === 'custom' && (m.details as { sessionId?: string })?.sessionId === report.sessionId));
}
async function deliver(route: keyof typeof endpoints, label: string) {
  // Includes BOM, CRLF, Unicode, JSON-looking content and leading/trailing whitespace.
  const body = `\uFEFF  Synthetic ${label}\r\nProbe: ${probe}\n{"text":"raw, not an envelope"}\nUnicode: æ 📨\n  `;
  expectedBodies.push(body);
  check(await post(route, body) === 202); // Intentionally never retry an authorized POST.
  await verifyReceipt(body);
  checks.push({ test: label, route, status: 202, exactBodyAtPi: true, exactBodyAtModelBoundary: true });
}
async function rejectInvalid(route: keyof typeof endpoints) {
  const before = requests;
  const missing = await post(route, 'unauthenticated synthetic probe', 'missing');
  const wrong = await post(route, 'invalid-auth synthetic probe', 'wrong');
  const oversized = await post(route, 'x'.repeat(65537));
  const malformed = await post(route, new Uint8Array([0xc3, 0x28]));
  check(missing === 401 && wrong === 401 && oversized === 413 && malformed === 400 && requests === before);
  checks.push({ test: 'rejection', route, missingToken: missing, wrongToken: wrong, oversized, invalidUtf8: malformed, modelRequestsCreated: 0 });
}
async function connected() {
  await waitFor(async () => {
    const status = await call('message_ingest_status');
    if (status.tunnel.state === 'failed') throw new Error('Tunnel failed');
    return status.tunnel.state === 'connection-ready';
  }, 90000);
  // Only unauthenticated readiness probes repeat; they cannot enter the agent.
  const deadline = Date.now() + 60000;
  while (true) {
    try { if (await post('tunnel', 'unauthenticated readiness probe', 'missing') === 401) return; } catch { /* bounded readiness only */ }
    if (Date.now() >= deadline) throw new Error('Public route not ready');
    await delay(1000);
  }
}
async function busyStart() {
  holdModel = true;
  const run = session!.prompt('Synthetic unrelated console work held open for ingress testing.');
  // Attach a rejection handler immediately; the original promise is awaited below.
  void run.catch(() => {});
  await waitFor(() => !!releaseModel);
  return { finish: async () => { holdModel = false; releaseModel!(); releaseModel = undefined; await run; } };
}
try {
  // The operator must provision the named tunnel and its ingress route before opting in.
  await mkdir(path.join(project, '.pi'), { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(project, '.pi/local-tunnel-smoke-'));
  const agentDir = path.join(root, 'agent'); await mkdir(agentDir, { mode: 0o700 }); report.testDirectory = root;
  const provider = (pi: ExtensionAPI) => pi.registerProvider('ingest-public-smoke', {
    api: 'ingest-public-smoke', baseUrl: 'http://127.0.0.1/never-used', apiKey: 'synthetic-local-model-key',
    models: [{ id: 'synthetic', name: 'Local deterministic smoke test', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      requests++;
      const trust = context.messages.some(m => m.role === 'system' && m.content === EXTERNAL_START);
      for (const m of context.messages) {
        if (m.role !== 'user') continue;
        const text = typeof m.content === 'string' ? m.content : m.content.length === 1 && m.content[0]?.type === 'text' ? m.content[0].text : undefined;
        if (text && expectedBodies.includes(text) && trust) seenAtModel.add(text);
      }
      const stream = createAssistantMessageEventStream();
      const finish = () => {
        const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Synthetic request completed.' }], api: model.api, provider: model.provider,
          model: model.id, timestamp: Date.now(), stopReason: 'stop',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      };
      if (holdModel) releaseModel = finish; else queueMicrotask(finish);
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [provider, extension] });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: path.join(agentDir, 'models'), refreshOnCreate: false });
  const sessionManager = SessionManager.create(root, path.join(root, 'sessions'));
  ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, resourceLoader, settingsManager, sessionManager, tools: [], thinkingLevel: 'off' }));
  await session.bindExtensions({ mode: 'rpc', onError: () => { extensionErrors++; } });
  const model = modelRuntime.getModel('ingest-public-smoke', 'synthetic'); check(model);
  await session.setModel(model!, { persist: false }); report.sessionId = sessionManager.getSessionId();

  phase = 'listener-only';
  const initial = await call('message_ingest_configure', { port, host: '127.0.0.1' }); token = initial.token;
  const local = await call('message_ingest_enable'); check(local.listener === 'ready' && local.tunnel.state === 'not-configured');
  check((await call('message_ingest_token')).token === token);
  check(!JSON.stringify(await call('message_ingest_status')).includes(token));
  await rejectInvalid('local'); await deliver('local', 'listener-only');
  checks.push({ test: 'listener-only-mode', noTunnelStarted: true, explicitTokenRetrieval: true, statusRedacted: true });
  log('listener-only-passed');

  phase = 'tunnel-start';
  const configured = await call('message_ingest_configure', { port, host: '127.0.0.1', tunnel: { enabled: true, tokenFile } });
  check(configured.token === token && configured.status.listener === 'stopped');
  await call('message_ingest_enable'); await connected();
  phase = 'both-access-paths';
  await rejectInvalid('local'); await rejectInvalid('tunnel');
  await deliver('local', 'local-with-tunnel-active'); await deliver('tunnel', 'public-tunnel');
  log('both-paths-passed');

  phase = 'busy-delivery';
  const busy = await busyStart(); const before = requests;
  const localBusy = `  Local busy probe ${probe}\r\n`, tunnelBusy = `  Tunnel busy probe ${probe}\r\n`;
  expectedBodies.push(localBusy, tunnelBusy);
  check(await post('local', localBusy) === 202); check(await post('tunnel', tunnelBusy) === 202);
  await delay(250);
  check(requests === before && (await call('message_ingest_status')).delivery.waiting === 2);
  await call('message_ingest_enable');
  check((await call('message_ingest_status')).delivery.waiting === 2);
  await busy.finish(); await verifyReceipt(localBusy); await verifyReceipt(tunnelBusy);
  const received = receivedBodies(); check(received.indexOf(localBusy) < received.indexOf(tunnelBusy));
  checks.push({ test: 'busy-cross-transport', bothAccepted: true, noSteering: true, deliveredInOrder: true, repeatedEnablePreservedQueue: true });
  log('busy-delivery-passed');

  phase = 'disable';
  const busyDisable = await busyStart();
  const discardLocal = `discard-local-${probe}`, discardTunnel = `discard-tunnel-${probe}`;
  check(await post('local', discardLocal) === 202); check(await post('tunnel', discardTunnel) === 202);
  const disabled = await call('message_ingest_disable');
  check(disabled.listener === 'stopped' && disabled.discardedWaitingMessages === 2 && disabled.piSubmittedWorkCancelled === false);
  let localClosed = false;
  try { await post('local', 'unauthenticated disabled probe', 'missing'); } catch { localClosed = true; }
  check(localClosed);
  let publicDisabledStatus = 0;
  try { publicDisabledStatus = await post('tunnel', 'unauthenticated disabled probe', 'missing'); } catch { /* transport failure also expected */ }
  check(publicDisabledStatus === 0 || publicDisabledStatus >= 500);
  await busyDisable.finish(); await delay(150);
  check(!receivedBodies().includes(discardLocal) && !receivedBodies().includes(discardTunnel));
  checks.push({ test: 'disable', listenerClosed: true, publicDisabledStatus, discardedWaiting: 2, unrelatedRunNotAborted: true });
  log('disable-passed', { publicDisabledStatus });

  phase = 're-enable';
  await call('message_ingest_enable'); await connected();
  check((await call('message_ingest_token')).token === token);
  await deliver('local', 'local-after-reenable'); await deliver('tunnel', 'tunnel-after-reenable');
  check(receivedBodies().length === expectedBodies.length && expectedBodies.every(body => seenAtModel.has(body)) && extensionErrors === 0);
  checks.push({ test: 're-enable', sameToken: true, localAndPublicDelivery: true });
  report.acceptedBodiesVerified = expectedBodies.length; report.modelRequests = requests; report.extensionErrors = extensionErrors;
  completed = true; log('combined-test-passed', { bodies: expectedBodies.length, modelRequests: requests });
} catch {
  report.failedPhase = phase; process.exitCode = 1; log('test-failed', { phase });
} finally {
  token = ''; holdModel = false;
  if (releaseModel) { releaseModel(); releaseModel = undefined; }
  let cleanup = true;
  if (session) {
    try { await call('message_ingest_disable'); } catch { cleanup = false; }
    try { await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); } catch { cleanup = false; }
    try { session.dispose(); } catch { cleanup = false; }
  }
  report.ownedResourcesStopped = cleanup; report.finishedAt = new Date().toISOString();
  report.outcome = completed && cleanup ? 'passed' : 'failed'; if (!cleanup) process.exitCode = 1;
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  log('test-finished', { outcome: report.outcome, ownedResourcesStopped: cleanup, reportFile });
}
