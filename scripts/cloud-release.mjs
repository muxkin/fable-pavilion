#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileReceipt, sha256, sourceRelease, verifyArtifacts, verifyLive } from './lib/cloud-release.mjs';

const [mode, ...argv] = process.argv.slice(2);
const options = {};
for (let index = 0; index < argv.length; index += 2) {
  assert(
    argv[index]?.startsWith('--') && argv[index + 1] && !argv[index + 1].startsWith('--'),
    'Expected --name value pairs',
  );
  assert(!Object.hasOwn(options, argv[index]), 'Repeated option');
  options[argv[index]] = argv[index + 1];
}
const requireOption = (name) => {
  assert(options[name], `Missing ${name}`);
  return options[name];
};
const source = sourceRelease(requireOption('--expected-commit'));

if (mode === 'prepare') {
  for (const key of Object.keys(options))
    assert(
      ['--expected-commit', '--out', '--cf-config', '--previous-manifest'].includes(key),
      `Unknown option ${key}`,
    );
  const output = resolve(requireOption('--out'));
  assert(!existsSync(output), 'Use a new staging directory; existing artifacts must not be reused');
  const config = resolve(requireOption('--cf-config'));
  assert(existsSync(config), 'Cloudflare configuration is missing');
  mkdirSync('.implementation', { recursive: true });
  const lockPath = '.implementation/cloud-release-build.lock';
  const lock = openSync(lockPath, 'wx', 0o600);
  try {
    mkdirSync(output, { recursive: true });
    const env = {
      ...process.env,
      POCKET_ENV_FILE: devNull,
      POCKET_CF_ENV_FILE: devNull,
      POCKET_RELEASE_COMMIT: source.source.commit,
      POCKET_ASSET_BASE: '',
      POCKET_CF_ASSET_BASE: '',
      POCKET_SERVER_BUILD_ROOT: join(output, 'node'),
      POCKET_CF_WEB_OUTDIR: join(output, 'cloudflare/web'),
      POCKET_CF_WORKER_OUTDIR: join(output, 'cloudflare/worker'),
      WRANGLER_SEND_METRICS: 'false',
    };
    const run = (file, args) => {
      const result = spawnSync(process.execPath, [file, ...args], { env, stdio: 'inherit' });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, 'Release build command failed');
    };
    // Run each real build entry point under the same pinned source, using fresh output directories.
    run('scripts/build-server.mjs', []);
    run('node_modules/vite/bin/vite.js', ['build', '--outDir', join(output, 'node/web')]);
    run('scripts/cloudflare.mjs', ['build', '--config', config]);
    assert.deepEqual(sourceRelease(source.source.commit), source, 'Source changed during the builds');
    const retainedAssets = [];
    if (options['--previous-manifest']) {
      const previousPath = resolve(options['--previous-manifest']);
      const previous = JSON.parse(readFileSync(previousPath, 'utf8'));
      const keepOut = new Set(previous.retainedAssets ?? []);
      const node = join(output, 'node/web');
      const cloudflare = join(output, 'cloudflare/web');
      for (const [name, hash] of Object.entries(previous.artifacts['node/web'])) {
        const android = /^downloads\/android\/(?:latest\.json|fable-pavilion-android-[0-9.]+\.apk)$/.test(
          name,
        );
        if (!android && !/^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(name)) continue;
        if ((!android && keepOut.has(name)) || existsSync(join(node, name))) continue;
        const oldAsset = join(dirname(previousPath), 'node/web', name);
        assert.equal(sha256(readFileSync(oldAsset)), hash, `Previous asset differs: ${name}`);
        assert(!existsSync(join(cloudflare, name)), `Frontend builds differ at ${name}`);
        mkdirSync(dirname(join(node, name)), { recursive: true });
        mkdirSync(dirname(join(cloudflare, name)), { recursive: true });
        copyFileSync(oldAsset, join(node, name));
        copyFileSync(oldAsset, join(cloudflare, name));
        if (!android) retainedAssets.push(name);
      }
    }
    const directories = ['node/web', 'node/server', 'cloudflare/web', 'cloudflare/worker'];
    const manifest = {
      schema: 'fable-cloud-artifacts-v1',
      release: source,
      buildId: JSON.parse(readFileSync(join(output, 'node/web/version.json'), 'utf8')).buildId,
      retainedAssets,
      artifacts: Object.fromEntries(
        directories.map((directory) => [directory, fileReceipt(join(output, directory))]),
      ),
    };
    assert(manifest.artifacts['node/server']['relay-main.js'], 'Node relay runtime artifact is missing');
    assert(
      Object.keys(manifest.artifacts['cloudflare/worker']).some((file) => file.endsWith('.js')),
      'Worker runtime artifact is missing',
    );
    for (const directory of ['node/server', 'cloudflare/worker']) {
      assert(
        Object.keys(manifest.artifacts[directory]).some(
          (file) =>
            file.endsWith('.js') &&
            readFileSync(join(output, directory, file), 'utf8').includes(source.releaseId),
        ),
        `Compiled runtime provenance is missing from ${directory}`,
      );
    }
    verifyArtifacts(manifest, output);
    writeFileSync(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(
      JSON.stringify({
        releaseId: source.releaseId,
        commit: source.source.commit,
        buildId: manifest.buildId,
        frontendFiles: Object.keys(manifest.artifacts['node/web']).length,
      }),
    );
  } finally {
    closeSync(lock);
    rmSync(lockPath);
  }
} else if (mode === 'verify' || mode === 'verify-live') {
  for (const key of Object.keys(options))
    assert(['--expected-commit', '--manifest', '--root', '--origins'].includes(key), `Unknown option ${key}`);
  const manifestPath = resolve(requireOption('--manifest'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(manifest.release, source, 'The artifact manifest is from a different source release');
  if (mode === 'verify') {
    verifyArtifacts(manifest, resolve(requireOption('--root')));
    console.log(
      JSON.stringify({
        verified: true,
        releaseId: source.releaseId,
        commit: source.source.commit,
        buildId: manifest.buildId,
      }),
    );
  } else {
    const origins = requireOption('--origins').split(',');
    console.log(JSON.stringify(await verifyLive(manifest, origins)));
  }
} else {
  throw Error('Use prepare, verify, or verify-live');
}
