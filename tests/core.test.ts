import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, request } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { ConfigStore, configuredMapping } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { listen, MAX_BODY_BYTES } from '../src/transport.js';
import { startTunnel } from '../src/tunnel.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'message-ingest-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
function post(port: number, body: string | Buffer, token?: string, extra: Record<string, string> = {}, url = '/'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: url, method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject); req.end(body);
  });
}

test('unmapped sessions are no-op; configuration disables and status redacts token', async t => {
  const dir = await fixture(t);
  const runtime = new Runtime({ sessionId: () => 'exact', deliver() { throw new Error('unexpected'); } }, { projectDirectory: dir });
  t.after(() => runtime.close());
  assert.equal((await runtime.start()).configured, false);
  await assert.rejects(runtime.enable(), /No mapping/);
  const result = await runtime.configure({ port: await freePort() });
  assert.equal(result.token.length, 43);
  assert.equal(result.status.mapping?.enabled, false);
  assert.equal(result.status.listener, 'stopped');
  assert.ok(!JSON.stringify(runtime.status()).includes(result.token));
  const file = path.join(dir, '.pi/message-ingest/config.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  const rotated = await runtime.configure({ port: result.status.mapping!.port, rotateToken: true });
  assert.notEqual(rotated.token, result.token);
});

test('raw text including whitespace, BOM, JSON and duplicates passes unchanged', async t => {
  const dir = await fixture(t), port = await freePort(), delivered: string[] = [];
  const runtime = new Runtime({ sessionId: () => 'one', deliver: text => { delivered.push(text); } }, { projectDirectory: dir });
  t.after(() => runtime.close());
  const { token } = await runtime.configure({ port });
  assert.equal((await runtime.enable()).listener, 'ready');
  const body = '\uFEFF  {"sessionId":"other","text":"unchanged"}\r\n🙂\t';
  assert.equal(await post(port, body, token), 202);
  assert.equal(await post(port, body, token), 202);
  assert.equal(await post(port, '', token), 202);
  assert.deepEqual(delivered, [body, body, '']);
  await runtime.disable();
  await assert.rejects(post(port, body, token));
  await runtime.close(); await runtime.close();
});

test('auth, route, encoding and 64KiB bound are enforced without delivering failures', async t => {
  const port = await freePort(), token = configuredMapping({ port }).token, delivered: string[] = [];
  const listener = await listen({ host: '127.0.0.1', port, token, isCurrent: () => true, deliver: text => { delivered.push(text); } });
  t.after(() => listener.close());
  assert.equal(await post(port, 'secret'), 401);
  assert.equal(await post(port, 'secret', 'wrong'), 401);
  assert.equal(await post(port, 'secret', token, {}, '/other'), 404);
  assert.equal(await post(port, Buffer.from([0xc3, 0x28]), token), 400);
  assert.equal(await post(port, 'compressed', token, { 'content-encoding': 'gzip' }), 415);
  assert.equal(await post(port, 'a'.repeat(MAX_BODY_BYTES + 1), token), 413);
  assert.equal(await post(port, 'a'.repeat(MAX_BODY_BYTES), token), 202);
  assert.deepEqual(delivered, ['a'.repeat(MAX_BODY_BYTES)]);
});

test('exact session mismatch fences delivery even before lifecycle cleanup', async t => {
  const dir = await fixture(t), port = await freePort(); let session = 'one';
  const delivered: string[] = [];
  const runtime = new Runtime({ sessionId: () => session, deliver: text => { delivered.push(text); } }, { projectDirectory: dir });
  t.after(() => runtime.close());
  const { token } = await runtime.configure({ port }); await runtime.enable();
  session = 'two';
  assert.equal(await post(port, 'not for two', token), 503);
  assert.equal(runtime.status().configured, false);
  assert.equal((await runtime.start()).listener, 'stopped');
  assert.deepEqual(delivered, []);
  session = 'one'; assert.equal((await runtime.start()).listener, 'ready');
  assert.equal(await post(port, 'for one', token), 202);
});

test('occupied fixed port fails without fallback or exposing token', async t => {
  const dir = await fixture(t), port = await freePort();
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => occupied.close(() => resolve())));
  const runtime = new Runtime({ sessionId: () => 'one', deliver() {} }, { projectDirectory: dir });
  t.after(() => runtime.close());
  const { token } = await runtime.configure({ port });
  await assert.rejects(runtime.enable(), /already in use/);
  assert.notEqual(runtime.status().listener, 'ready');
  assert.ok(!JSON.stringify(runtime.status()).includes(token));
});

test('configure stops intake and preserves credentials unless explicitly rotated', async t => {
  const dir = await fixture(t), port = await freePort();
  const runtime = new Runtime({ sessionId: () => 'one', deliver() {} }, { projectDirectory: dir });
  t.after(() => runtime.close());
  const first = await runtime.configure({ port }); await runtime.enable();
  const second = await runtime.configure({ port });
  assert.equal(first.token, second.token); assert.equal(second.status.mapping?.enabled, false);
  await assert.rejects(post(port, 'closed', first.token));
});

test('store serializes concurrent updates across instances and rejects unsafe file', async t => {
  const dir = await fixture(t), a = new ConfigStore(dir), b = new ConfigStore(dir);
  await Promise.all([a.update(c => { c.sessions.one = configuredMapping({ port: 12345 }); }), b.update(c => { c.sessions.two = configuredMapping({ port: 12346 }); })]);
  assert.deepEqual(Object.keys((await a.read()).sessions).sort(), ['one', 'two']);
  const original = await readFile(a.file, 'utf8');
  await rm(a.file); const other = path.join(dir, 'other'); await writeFile(other, original, { mode: 0o600 }); await symlink(other, a.file);
  await assert.rejects(a.read(), /protected/);
  await assert.rejects(a.update(() => {}), /update/);
});

test('tunnel runs only after listener readiness and only when explicitly enabled', async t => {
  const dir = await fixture(t), order: string[] = [];
  const runtime = new Runtime({ sessionId: () => 'one', deliver() {} }, { projectDirectory: dir,
    listen: async options => { order.push('listen'); return { host: options.host, port: options.port, close: async () => { order.push('listener-close'); } }; },
    startTunnel: async () => { order.push('tunnel'); return { status: () => ({ state: 'spawned', publicReachabilityVerified: false }), close: async () => { order.push('tunnel-close'); } }; },
  });
  t.after(() => runtime.close());
  await runtime.configure({ port: 12345, tunnel: { configFile: '/tmp/existing.yml', enabled: false } });
  await runtime.enable(); assert.deepEqual(order, ['listen']);
  await runtime.configure({ port: 12345, tunnel: { configFile: '/tmp/existing.yml', enabled: true } });
  order.length = 0; await runtime.enable(); assert.deepEqual(order, ['listen', 'tunnel']);
  assert.deepEqual(runtime.status().tunnel, { state: 'spawned', publicReachabilityVerified: false });
  await runtime.close(); assert.ok(order.includes('tunnel-close'));
});

test('generation fence closes a late listener and never starts its tunnel', async t => {
  const dir = await fixture(t); let release!: () => void, started!: () => void, closed = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const runtime = new Runtime({ sessionId: () => 'one', deliver() {} }, { projectDirectory: dir,
    listen: async options => { started(); await wait; return { host: options.host, port: options.port, close: async () => { closed++; } }; },
    startTunnel: async () => { throw new Error('must not start'); },
  });
  await runtime.configure({ port: 12345, tunnel: { configFile: '/tmp/fake.yml', enabled: true } });
  const enabling = runtime.enable(); const rejected = assert.rejects(enabling, /lifecycle/);
  await ready; const closing = runtime.close(); release(); await rejected; await closing;
  assert.equal(closed, 1); assert.equal(runtime.status().listener, 'stopped');
});

test('cloudflared uses fixed executable and existing config; spawned differs from registered', async t => {
  const dir = await fixture(t), file = path.join(dir, 'tunnel.yml'); await writeFile(file, 'test');
  const fake = new EventEmitter() as ChildProcess;
  const stderr = new PassThrough(); Object.assign(fake, { stderr, kill: (signal: string) => { assert.equal(signal, 'SIGTERM'); queueMicrotask(() => fake.emit('close', 0)); return true; } });
  const tunnel = await startTunnel({ configFile: file, enabled: true }, (command, args) => {
    assert.equal(command, 'cloudflared'); assert.deepEqual(args, ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0', '--loglevel', 'info', '--config', file, 'run']);
    queueMicrotask(() => fake.emit('spawn')); return fake;
  });
  assert.equal(tunnel.status().state, 'spawned');
  stderr.write('Registered tunnel connection connIndex=0 secret-not-published\n');
  assert.deepEqual(tunnel.status(), { state: 'connection-ready', publicReachabilityVerified: false });
  await tunnel.close(); await tunnel.close(); assert.equal(tunnel.status().state, 'stopped');
});
