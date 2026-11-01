import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import extension from '../src/index.js';
import type { Runtime } from '../src/runtime.js';
import { drainRetired, retire } from '../src/ownership.js';

function harness(persistent = true) {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, { execute: Function }>();
  extension({ on: (name: string, handler: Function) => { handlers.set(name, handler); },
    registerTool: (tool: { name: string; execute: Function }) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
  const ctx = { sessionManager: { getSessionId: () => 'synthetic', getSessionFile: () => persistent ? '/not-opened/synthetic.jsonl' : undefined },
    cwd: '/not-opened', ui: { notify() {} } } as unknown as ExtensionContext;
  return { handlers, tools, ctx };
}
test('uncertain retired resource fence survives a fresh extension factory and blocks startup', async () => {
  let closed = false;
  const runtime = { close: async () => { if (!closed) throw new Error('synthetic uncertain close'); } } as unknown as Runtime;
  try {
    await assert.rejects(retire(runtime), /uncertain/);
    const fresh = harness();
    await assert.rejects(fresh.handlers.get('session_start')!({}, fresh.ctx), /uncertain/);
    // Another factory (the behavior of reload) must not bypass process-owned cleanup.
    const reloaded = harness();
    await assert.rejects(reloaded.handlers.get('session_start')!({}, reloaded.ctx), /uncertain/);
  } finally { closed = true; await drainRetired(); }
});
test('in-memory sessions remain unmapped and cannot configure or enable exposure', async () => {
  const f = harness(false);
  await f.handlers.get('session_start')!({}, f.ctx);
  const call = (name: string, args = {}) => f.tools.get(name)!.execute('fixture', args, undefined, undefined, f.ctx);
  const status = await call('message_ingest_status');
  assert.equal(JSON.parse(status.content[0].text).configured, false);
  await assert.rejects(call('message_ingest_configure', { port: 43000 }), /persistent/);
  await assert.rejects(call('message_ingest_enable'), /persistent/);
  await f.handlers.get('session_shutdown')!();
});
