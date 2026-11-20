import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const officialProducts = Object.freeze(['codex', 'dsh', 'antigravity']);
const documents = ['LICENSE', 'THIRD-PARTY-NOTICES.txt'];

async function entries(directory, expected, directories = []) {
  const actual = (await readdir(directory)).sort();
  assert.deepEqual(actual, [...expected].sort(), `Unexpected native package contents in ${directory}`);
  for (const name of actual) {
    const metadata = await lstat(join(directory, name));
    assert(!metadata.isSymbolicLink(), `Native package symlink: ${name}`);
    assert(directories.includes(name) ? metadata.isDirectory() : metadata.isFile(), `Unexpected native package entry type: ${name}`);
  }
}

function nativeBinary(bytes, platform, path) {
  const magic = bytes.subarray(0, 4).toString('hex');
  const supported = platform === 'win32'
    ? bytes.subarray(0, 2).toString() === 'MZ'
    : platform === 'darwin'
      ? ['cffaedfe', 'feedfacf'].includes(magic)
      : magic === '7f454c46';
  assert(supported, `Expected a native ${platform} executable: ${path}`);
}

export async function validateNativePlugin(directory, { platform, version, product }) {
  assert(officialProducts.includes(product), 'Unknown official native plugin');
  const entry = `agent-space-adapter-${product}${platform === 'win32' ? '.exe' : ''}`;
  await entries(directory, ['adapter.json', entry, ...documents]);
  const manifest = JSON.parse(await readFile(join(directory, 'adapter.json'), 'utf8'));
  assert.equal(manifest.sdk, 1);
  assert.equal(manifest.name, `@agent-remote/adapter-${product}`);
  assert.equal(manifest.product, product);
  assert.equal(manifest.version, version);
  assert.equal(manifest.entry, entry);
  assert(Number.isInteger(manifest.stateVersion) && manifest.stateVersion > 0);
  const binary = await readFile(join(directory, entry));
  nativeBinary(binary, platform, entry);
  assert.equal(createHash('sha256').update(binary).digest('hex'), manifest.sha256, `Plugin hash mismatch: ${product}`);
}

/** This allowlist rejects bundled Node/Python, JS entry points and old gateway
 * payloads before either portable archiving or installer creation. */
export async function validateNativeBundle(directory, { platform, version }) {
  const program = `agent-space-native${platform === 'win32' ? '.exe' : ''}`;
  await entries(directory, [program, 'README.txt', 'official-plugins', ...documents], ['official-plugins']);
  nativeBinary(await readFile(join(directory, program)), platform, program);
  const plugins = join(directory, 'official-plugins');
  await entries(plugins, officialProducts, officialProducts);
  for (const product of officialProducts)
    await validateNativePlugin(join(plugins, product), { platform, version, product });
}
