import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { resolve } from 'node:path';
import { configuredRelease } from './lib/cloud-release.mjs';

// Build the same application for the Worker runtime, using this deployment's explicit configuration.
// Never auto-load this machine's Gateway configuration or overwrite its Node web output.
const env = { ...process.env, POCKET_ENV_FILE: process.env.POCKET_CF_ENV_FILE || devNull };
delete env.POCKET_ASSET_BASE;
if (process.env.POCKET_CF_ASSET_BASE) env.POCKET_ASSET_BASE = process.env.POCKET_CF_ASSET_BASE;
const [mode, ...args] = process.argv.slice(2);
const run = (file, argv) => {
  const child = spawnSync(process.execPath, [file, ...argv], { env, stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
};
if (!['build', 'deploy', 'dev'].includes(mode)) throw Error('Expected build, deploy or dev');
if (mode === 'deploy' && !process.env.POCKET_RELEASE_COMMIT)
  throw Error(
    'Production deployment requires POCKET_RELEASE_COMMIT; prepare and verify a unified cloud release first',
  );
const release = configuredRelease();
const webRoot = resolve(process.env.POCKET_CF_WEB_OUTDIR || 'dist/cloudflare-web');
const workerRoot = process.env.POCKET_CF_WORKER_OUTDIR || '.implementation/cloudflare';
run('node_modules/vite/bin/vite.js', ['build', '--outDir', webRoot]);
if (process.env.POCKET_CF_WEB_OUTDIR) args.push('--assets', webRoot);
if (release) args.push('--define', `__POCKET_CLOUD_RELEASE__:${JSON.stringify(release)}`);
run(
  'node_modules/wrangler/bin/wrangler.js',
  mode === 'build' ? ['deploy', '--dry-run', '--outdir', workerRoot, ...args] : [mode, ...args],
);
