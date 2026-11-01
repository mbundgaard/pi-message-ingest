import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigStore, configuredMapping } from '../src/config.js';
import { Runtime } from '../src/runtime.js';

test('store respects an existing writer lock and then commits atomically', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ingest-lock-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ConfigStore(dir);
  await store.update(c => { c.sessions.a = configuredMapping({ port: 10001 }); });
  const lockFile = path.join(store.directory, 'config.lock');
  const lock = await open(lockFile, 'wx', 0o600);
  let committed = false;
  const pending = store.update(c => { c.sessions.b = configuredMapping({ port: 10002 }); }).then(() => { committed = true; });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(committed, false);
  assert.deepEqual(Object.keys((await store.read()).sessions), ['a']);
  await lock.close(); await unlink(lockFile); await pending;
  assert.deepEqual(Object.keys((await store.read()).sessions), ['a', 'b']);
});

test('close during tunnel spawn fences intake and closes the late owned tunnel', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ingest-tunnel-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let began!: () => void, release!: () => void, tunnelCloses = 0, listenerCloses = 0;
  const beganPromise = new Promise<void>(resolve => { began = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let isCurrent!: () => boolean;
  const runtime = new Runtime({ sessionId: () => 'a', deliver() {} }, {
    projectDirectory: dir,
    listen: async o => { isCurrent = o.isCurrent; return { host: o.host, port: o.port, close: async () => { listenerCloses++; } }; },
    startTunnel: async () => { began(); await gate; return { status: () => ({ state: 'spawned', publicReachabilityVerified: false }), close: async () => { tunnelCloses++; } }; },
  });
  await runtime.configure({ port: 10001, tunnel: { enabled: true, configFile: '/tmp/fake.yml' } });
  const enabling = assert.rejects(runtime.enable(), /lifecycle/);
  await beganPromise;
  const closing = runtime.close(); assert.equal(isCurrent(), false);
  release(); await enabling; await closing;
  assert.equal(tunnelCloses, 1); assert.equal(listenerCloses, 1);
});

test('uncertain tunnel cleanup retains ownership and blocks replacements', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ingest-uncertain-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let starts = 0;
  const runtime = new Runtime({ sessionId: () => 'a', deliver() {} }, {
    projectDirectory: dir,
    listen: async o => { starts++; return { host: o.host, port: o.port, close: async () => {} }; },
    startTunnel: async () => ({ status: () => ({ state: 'failed', publicReachabilityVerified: false }), close: async () => { throw new Error('Tunnel termination was not confirmed'); } }),
  });
  await runtime.configure({ port: 10001, tunnel: { enabled: true, configFile: '/tmp/fake.yml' } });
  await runtime.enable();
  await assert.rejects(runtime.close(), /not confirmed/);
  await assert.rejects(runtime.start(), /not confirmed/);
  assert.equal(starts, 1);
});
