import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const releaseSchema = 'fable-cloud-release-v1';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A caller supplies the independently approved commit. Never infer the target from HEAD. */
export function sourceRelease(expectedCommit, cwd = process.cwd()) {
  assert.match(expectedCommit ?? '', /^[a-f0-9]{40}$/, 'An explicit full expected source commit is required');
  assert.equal(
    git(cwd, 'rev-parse', 'HEAD'),
    expectedCommit,
    'This checkout is not the expected release source',
  );
  assert.equal(git(cwd, 'status', '--porcelain'), '', 'Release builds require committed, clean source');
  const source = {
    commit: expectedCommit,
    tree: git(cwd, 'rev-parse', 'HEAD^{tree}'),
    business: Object.fromEntries(
      ['src/server', 'src/cloudflare', 'src/shared', 'src/client'].map((path) => [
        path,
        git(cwd, 'rev-parse', `HEAD:${path}`),
      ]),
    ),
    frontend: git(cwd, 'rev-parse', 'HEAD:src/web'),
    lockfileSha256: sha256(readFileSync(join(cwd, 'package-lock.json'))),
  };
  const identity = { schema: releaseSchema, source };
  return { ...identity, releaseId: sha256(JSON.stringify(identity)) };
}

export function configuredRelease(cwd = process.cwd()) {
  return process.env.POCKET_RELEASE_COMMIT ? sourceRelease(process.env.POCKET_RELEASE_COMMIT, cwd) : null;
}

/** Sorted file receipts reject symlinks and include unexpected files as well as missing files. */
export function fileReceipt(root, directory = '') {
  assert(lstatSync(join(root, directory)).isDirectory(), 'Artifact root must be a real directory');
  return Object.fromEntries(
    readdirSync(join(root, directory))
      .sort()
      .flatMap((name) => {
        const relative = directory ? `${directory}/${name}` : name;
        const path = join(root, relative);
        const stat = lstatSync(path);
        assert(!stat.isSymbolicLink(), 'Release artifacts must not contain symlinks');
        if (stat.isDirectory()) return Object.entries(fileReceipt(root, relative));
        assert(stat.isFile(), 'Release artifacts must contain only ordinary files');
        return [[relative, sha256(readFileSync(path))]];
      }),
  );
}

export function verifyArtifacts(manifest, root) {
  assert.equal(manifest.schema, 'fable-cloud-artifacts-v1');
  for (const directory of ['node/web', 'node/server', 'cloudflare/web', 'cloudflare/worker']) {
    assert.deepEqual(
      fileReceipt(join(root, directory)),
      manifest.artifacts[directory],
      `Artifact drift: ${directory}`,
    );
  }
  assert.deepEqual(
    manifest.artifacts['node/web'],
    manifest.artifacts['cloudflare/web'],
    'Node and Worker frontends differ',
  );
  for (const directory of ['node/web', 'cloudflare/web']) {
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, directory, 'release.json'), 'utf8')),
      manifest.release,
      'Static release identity differs',
    );
    assert.equal(
      JSON.parse(readFileSync(join(root, directory, 'version.json'), 'utf8')).buildId,
      manifest.buildId,
      'Frontend build differs',
    );
  }
  for (const directory of ['node/server', 'cloudflare/worker']) {
    assert(
      Object.keys(manifest.artifacts[directory]).some(
        (file) =>
          file.endsWith('.js') &&
          readFileSync(join(root, directory, file), 'utf8').includes(manifest.release.releaseId),
      ),
      `Compiled runtime provenance is missing from ${directory}`,
    );
  }
}

export async function verifyLive(manifest, origins, fetcher = fetch) {
  assert(origins.length >= 2, 'Verify both deployment origins together');
  assert.equal(new Set(origins).size, origins.length, 'Deployment origins must be distinct');
  const results = [];
  for (const [index, origin] of origins.entries()) {
    const url = new URL(origin);
    assert.equal(url.origin, origin, 'Use an exact origin without a path or trailing slash');
    assert.equal(url.protocol, 'https:', 'Public verification requires HTTPS');
    const get = async (path) => {
      const response = await fetcher(origin + path, {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(response.status, 200, `${origin}${path} is unavailable`);
      return response;
    };
    // Static provenance alone cannot establish the running backend revision.
    const runtime = index === 0 ? 'node' : 'cloudflare';
    assert.deepEqual(
      await (await get('/api/release')).json(),
      { runtime, release: manifest.release },
      `${origin}: backend release drift`,
    );
    assert.deepEqual(
      await (await get('/release.json')).json(),
      manifest.release,
      `${origin}: frontend release drift`,
    );
    assert.equal(
      (await (await get('/version.json')).json()).buildId,
      manifest.buildId,
      `${origin}: frontend build drift`,
    );
    assert.equal(
      sha256(Buffer.from(await (await get('/')).arrayBuffer())),
      manifest.artifacts['node/web']['index.html'],
      `${origin}: HTML artifact drift`,
    );
    results.push({
      origin,
      runtime,
      releaseId: manifest.release.releaseId,
      commit: manifest.release.source.commit,
      buildId: manifest.buildId,
    });
  }
  return results;
}
