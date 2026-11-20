/** Add only the lockfile-pinned musl codecs beside the host's glibc test dependencies. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

assert(process.platform === 'linux' && process.arch === 'x64', 'Musl test dependencies require Linux x64');
const run = promisify(execFile);
const modules = resolve('node_modules');
await mkdir(modules, { recursive: true });
assert.equal(await realpath(modules), modules, 'Use the actual workspace node_modules directory');
const scope = join(modules, '@img');
await mkdir(scope, { recursive: true });
assert.equal(await realpath(scope), scope, 'Musl test dependency scope must remain in the workspace');
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'native-musl-test-deps-'));
try {
  for (const name of ['@img/sharp-linuxmusl-x64', '@img/sharp-libvips-linuxmusl-x64']) {
    const pinned = lock.packages[`node_modules/${name}`];
    assert(pinned?.version && pinned.resolved?.startsWith('https://'));
    assert.match(pinned.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
    const packed = await run('npm', [
      'pack', '--ignore-scripts', '--json', '--pack-destination', temporary, pinned.resolved,
    ], { maxBuffer: 2 * 1024 * 1024 });
    const artifacts = JSON.parse(packed.stdout);
    assert(Array.isArray(artifacts) && artifacts.length === 1, 'npm pack did not return one JSON artifact');
    const [artifact] = artifacts;
    assert(artifact?.filename && basename(artifact.filename) === artifact.filename);
    const archive = join(temporary, artifact.filename);
    assert.equal(
      'sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64'),
      pinned.integrity,
      `Musl codec archive differs from package-lock.json: ${name}`,
    );
    const extracted = join(temporary, basename(name));
    await mkdir(extracted);
    await run('tar', ['-xzf', archive, '--strip-components=1', '-C', extracted]);
    const manifest = JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8'));
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, pinned.version);
    assert(manifest.libc?.includes('musl') && manifest.cpu?.includes('x64'));
    const destination = join(modules, name);
    const existing = await lstat(destination).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    assert(!existing?.isSymbolicLink(), 'Musl test dependency must be a workspace directory');
    await rm(destination, { recursive: true, force: true });
    await cp(extracted, destination, { recursive: true });
    console.log(`Prepared locked test dependency ${name}@${pinned.version}`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
