import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

test('Pi file loader loads the distributable TypeScript entry and all five tools', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ingest-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root,
    settingsManager: SettingsManager.inMemory(), noExtensions: true, noContextFiles: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [entry] });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const tools = loaded.extensions.flatMap(extension => [...extension.tools.keys()]);
  assert.deepEqual(tools.sort(), ['message_ingest_configure', 'message_ingest_disable', 'message_ingest_enable',
    'message_ingest_status', 'message_ingest_token'].sort());
});
