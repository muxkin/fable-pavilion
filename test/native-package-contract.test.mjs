import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it as test } from 'vitest';
import { officialProducts, validateNativeBundle } from '../scripts/desktop/native-package-contract.mjs';

const version = '1.2.3';
async function fixture(t, platform = 'linux') {
  const root = await mkdtemp(join(tmpdir(), 'native-package-contract-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const suffix = platform === 'win32' ? '.exe' : '';
  const bytes = Buffer.alloc(64);
  Buffer.from(platform === 'win32' ? '4d5a' : platform === 'darwin' ? 'cffaedfe' : '7f454c46', 'hex').copy(bytes);
  await writeFile(join(root, 'agent-space-native' + suffix), bytes);
  for (const name of ['README.txt', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']) await writeFile(join(root, name), 'fixture');
  for (const product of officialProducts) {
    const directory = join(root, 'official-plugins', product);
    await mkdir(directory, { recursive: true });
    const entry = `agent-space-adapter-${product}${suffix}`;
    await writeFile(join(directory, entry), bytes);
    for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.txt']) await writeFile(join(directory, name), 'fixture');
    await writeFile(join(directory, 'adapter.json'), JSON.stringify({
      sdk: 1, name: `@agent-remote/adapter-${product}`, product, version, stateVersion: 1, entry,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }));
  }
  return root;
}

test('requires exactly three independently packaged native plugins on every platform', async (t) => {
  assert.deepEqual(officialProducts, ['codex', 'dsh', 'antigravity']);
  for (const platform of ['linux', 'win32', 'darwin']) {
    const root = await fixture(t, platform);
    await validateNativeBundle(root, { platform, version });
  }
});

test('rejects bundles missing Antigravity', async (t) => {
  const root = await fixture(t);
  await rm(join(root, 'official-plugins', 'antigravity'), { recursive: true });
  await assert.rejects(validateNativeBundle(root, { platform: 'linux', version }));
});

test('rejects old desktop runtime payloads and extra executable entry points', async (t) => {
  for (const extra of ['gateway', 'runtime', 'python', 'node', 'main.js']) {
    const root = await fixture(t);
    await writeFile(join(root, extra), 'retired runtime');
    await assert.rejects(validateNativeBundle(root, { platform: 'linux', version }));
  }
  const root = await fixture(t);
  await writeFile(join(root, 'official-plugins', 'codex', 'peer-bridge.py'), 'retired runtime');
  await assert.rejects(validateNativeBundle(root, { platform: 'linux', version }));
  const nested = await fixture(t);
  await rm(join(nested, 'LICENSE'));
  await mkdir(join(nested, 'LICENSE'));
  await writeFile(join(nested, 'LICENSE', 'node'), 'hidden runtime');
  await assert.rejects(validateNativeBundle(nested, { platform: 'linux', version }), /entry type/);
});

test('rejects modified plugin binaries and disguised script entries', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'official-plugins', 'antigravity', 'agent-space-adapter-antigravity'), '#!/usr/bin/env node');
  await assert.rejects(validateNativeBundle(root, { platform: 'linux', version }), /native linux executable/);
  const other = await fixture(t);
  const path = join(other, 'official-plugins', 'antigravity', 'agent-space-adapter-antigravity');
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('modified')]));
  await assert.rejects(validateNativeBundle(other, { platform: 'linux', version }), /hash mismatch/);
});

test.skipIf(process.platform === 'win32')('rejects binary symlinks outside the package', async (t) => {
  const root = await fixture(t);
  const binary = join(root, 'official-plugins', 'antigravity', 'agent-space-adapter-antigravity');
  await rm(binary);
  await symlink(join(root, 'agent-space-native'), binary);
  await assert.rejects(validateNativeBundle(root, { platform: 'linux', version }), /symlink/);
});
