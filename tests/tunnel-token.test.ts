import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { startTunnel } from '../src/tunnel.js';
import { configuredMapping } from '../src/config.js';

test('remotely managed tunnel passes only protected token file path, not its contents', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ingest-tokenfile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'connector.token');
  const synthetic = 'synthetic-token-never-in-argv';
  await writeFile(file, synthetic, { mode: 0o600 });
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stderr: new PassThrough(), kill: () => { queueMicrotask(() => child.emit('close', 0)); return true; } });
  const config = { enabled: true, tokenFile: file };
  const tunnel = await startTunnel(config, (executable, args) => {
    assert.equal(executable, 'cloudflared');
    assert.deepEqual(args, ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0', '--loglevel', 'info', '--config', devNull, 'run', '--token-file', file]);
    assert.ok(!args.join(' ').includes(synthetic));
    queueMicrotask(() => child.emit('spawn')); return child;
  });
  assert.equal(tunnel.status().state, 'spawned'); await tunnel.close();
  assert.equal(configuredMapping({ port: 43180, tunnel: config }).tunnel?.tokenFile, file);
  assert.throws(() => configuredMapping({ port: 43180, tunnel: { ...config, configFile: '/tmp/other.yml' } }), /Invalid tunnel/);
  if (process.platform !== 'win32') {
    await chmod(file, 0o644);
    await assert.rejects(startTunnel(config, () => { throw new Error('must not spawn'); }), /protected token file/);
  }
});
