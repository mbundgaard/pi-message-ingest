import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/import-tunnel-token.mjs', import.meta.url));
for (const scenario of ['success', 'insecure-source', 'different-destination'] as const) {
  test(`credential handoff utility: ${scenario}`, { skip: process.platform === 'win32' }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingest-credential-fixture-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourceDir = path.join(root, 'handoff'); await mkdir(sourceDir, { mode: 0o700 });
    const pi = path.join(root, '.pi'); await mkdir(pi, { mode: 0o700 });
    const source = path.join(sourceDir, 'token');
    const destination = path.join(pi, 'message-ingest', 'secrets', 'cloudflare-tunnel.token');
    const synthetic = 'synthetic-test-only-not-a-real-credential\n';
    await writeFile(source, synthetic, { mode: scenario === 'insecure-source' ? 0o644 : 0o600 });
    if (scenario === 'different-destination') {
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, 'different-synthetic-credential', { mode: 0o600 });
    }
    const child = spawnSync(process.execPath, [script, source, destination], { encoding: 'utf8' });
    assert.ok(!child.stdout.includes(synthetic.trim())); assert.equal(child.stderr, '');
    const outcome = JSON.parse(child.stdout);
    if (scenario === 'success') {
      assert.equal(child.status, 0); assert.equal(outcome.verified, true); assert.equal(outcome.handoffDeleted, true);
      assert.equal(await readFile(destination, 'utf8'), synthetic);
      assert.equal((await stat(destination)).mode & 0o777, 0o600);
      await assert.rejects(stat(source), { code: 'ENOENT' });
    } else {
      assert.equal(child.status, 1); assert.equal(outcome.handoffDeleted, false);
      assert.equal(await readFile(source, 'utf8'), synthetic);
    }
  });
}
