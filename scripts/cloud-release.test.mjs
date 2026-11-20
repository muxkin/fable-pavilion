import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fileReceipt, sha256, sourceRelease, verifyArtifacts, verifyLive } from './lib/cloud-release.mjs';

const root = mkdtempSync(join(tmpdir(), 'fable-release-guard-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
git('init', '-q');
git('config', 'user.email', 'release-fixture@example.invalid');
git('config', 'user.name', 'Release fixture');
writeFileSync(join(root, 'package-lock.json'), '{}');
for (const directory of ['server', 'cloudflare', 'shared', 'client', 'web']) {
  mkdirSync(join(root, 'src', directory), { recursive: true });
  writeFileSync(join(root, 'src', directory, 'index.ts'), `// ${directory}\n`);
}
git('add', '.');
git('commit', '-qm', 'first source');
const old = git('rev-parse', 'HEAD');
writeFileSync(join(root, 'src/server/index.ts'), '// trusted login enabled\n');
git('add', '.');
git('commit', '-qm', 'new backend source');
const current = git('rev-parse', 'HEAD');
const release = sourceRelease(current, root);

test('the ordinary production deploy entry rejects an unstamped release before building', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cloudflare.mjs', import.meta.url)), 'deploy'],
    {
      cwd: root,
      env: { ...process.env, POCKET_RELEASE_COMMIT: '' },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Production deployment requires POCKET_RELEASE_COMMIT/);
});

test('a successful old-branch build cannot satisfy the independently pinned new source', () => {
  assert.throws(() => sourceRelease(old, root), /expected release source/);
  assert.throws(() => sourceRelease('HEAD', root), /explicit full expected/);
  writeFileSync(join(root, 'src/shared/uncommitted.ts'), '// invisible to old frontend parity');
  assert.throws(() => sourceRelease(current, root), /committed, clean/);
  rmSync(join(root, 'src/shared/uncommitted.ts'));
});

test('backend changes affect the release even when frontend source is unchanged', () => {
  git('checkout', '--detach', '-q', old);
  const prior = sourceRelease(old, root);
  git('checkout', '--detach', '-q', current);
  assert.equal(prior.source.frontend, release.source.frontend);
  assert.notEqual(prior.source.business['src/server'], release.source.business['src/server']);
  assert.notEqual(prior.releaseId, release.releaseId);
});

function fixture() {
  const stage = mkdtempSync(join(tmpdir(), 'fable-release-artifact-test-'));
  const artifacts = {};
  for (const directory of ['node/web', 'node/server', 'cloudflare/web', 'cloudflare/worker']) {
    const path = join(stage, directory);
    mkdirSync(path, { recursive: true });
    if (directory.endsWith('/web')) {
      writeFileSync(join(path, 'release.json'), JSON.stringify(release));
      writeFileSync(join(path, 'version.json'), JSON.stringify({ buildId: '1234567890abcdef' }));
      writeFileSync(join(path, 'index.html'), '<html>new frontend</html>');
    } else writeFileSync(join(path, 'index.js'), JSON.stringify(release));
    artifacts[directory] = fileReceipt(path);
  }
  return {
    stage,
    manifest: { schema: 'fable-cloud-artifacts-v1', release, buildId: '1234567890abcdef', artifacts },
  };
}

test('a mixed or tampered server is rejected despite equal frontend artifacts', () => {
  const { stage, manifest } = fixture();
  try {
    verifyArtifacts(manifest, stage);
    writeFileSync(join(stage, 'cloudflare/worker/index.js'), '// old backend');
    assert.throws(() => verifyArtifacts(manifest, stage), /Artifact drift/);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test('live checks require both deployments and inspect backend as well as static provenance', async () => {
  const { stage, manifest } = fixture();
  try {
    const get = (stale) => async (url) => {
      if (url.endsWith('/api/release'))
        return Response.json({
          runtime: url.startsWith('https://node.example') ? 'node' : 'cloudflare',
          release: stale && url.startsWith('https://cf.example') ? { ...release, releaseId: 'old' } : release,
        });
      if (url.endsWith('/release.json')) return Response.json(release);
      if (url.endsWith('/version.json')) return Response.json({ buildId: manifest.buildId });
      return new Response(readFileSync(join(stage, 'node/web/index.html')));
    };
    const origins = ['https://node.example', 'https://cf.example'];
    assert.equal((await verifyLive(manifest, origins, get(false))).length, 2);
    await assert.rejects(verifyLive(manifest, [origins[0]], get(false)), /both deployment origins/);
    await assert.rejects(
      verifyLive(manifest, [origins[1], 'https://cf-alias.example'], get(false)),
      /backend release drift/,
    );
    await assert.rejects(verifyLive(manifest, origins, get(true)), /backend release drift/);
    assert.equal(
      sha256(readFileSync(join(stage, 'node/web/index.html'))),
      manifest.artifacts['node/web']['index.html'],
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
