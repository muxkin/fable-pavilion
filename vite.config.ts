import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';
import { defineConfig } from 'vite';
import './scripts/env.mjs';
import { assetSettings } from './src/shared/assets';
import { configuredRelease } from './scripts/lib/cloud-release.mjs';

function parseLoginRedirectOrigins(raw?: string): string[] {
  if (!raw?.trim()) return [];
  const origins = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const url = new URL(trimmed);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error(`Invalid POCKET_LOGIN_REDIRECT_ORIGINS entry: ${trimmed}`);
    }
    origins.add(url.origin);
  }
  return Array.from(origins).sort();
}

function loadSupportDeployment(env: NodeJS.ProcessEnv): {
  json: string;
  qr?: { fileName: string; source: Buffer };
} {
  const configPath = env.POCKET_SUPPORT_CONFIG?.trim();
  const qrPath = env.POCKET_SUPPORT_QR_FILE?.trim();
  if (!configPath) return { json: '{}\n' };
  const raw = readFileSync(resolve(configPath), 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('POCKET_SUPPORT_CONFIG must be a JSON object');
  }
  let qr: { fileName: string; source: Buffer } | undefined;
  if (qrPath) {
    const target = typeof parsed.wechat?.qr === 'string' ? parsed.wechat.qr.trim() : '/support/wechat-reward.png';
    if (!/^\/support\/[A-Za-z0-9._-]+$/.test(target)) {
      throw new Error(`Invalid support wechat.qr path: ${target}`);
    }
    qr = { fileName: target.slice(1), source: readFileSync(resolve(qrPath)) };
  }
  return { json: `${JSON.stringify(parsed, null, 2)}\n`, qr };
}

function loadAndroidDownloads(dir?: string): Array<{ fileName: string; source: Buffer }> {
  const root = dir?.trim();
  if (!root) return [];
  const resolved = resolve(root);
  const files: Array<{ fileName: string; source: Buffer }> = [];
  for (const entry of readdirSync(resolved, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile()) continue;
    if (entry.name === 'latest.json' || /^fable-pavilion-android-[0-9]+\.[0-9]+\.[0-9]+\.apk$/.test(entry.name)) {
      files.push({
        fileName: `downloads/android/${basename(entry.name)}`,
        source: readFileSync(join(resolved, entry.name)),
      });
    }
  }
  return files;
}

export default defineConfig(() => {
  const env = process.env;
  const release = configuredRelease();
  const deviceLoginOnly = env.POCKET_DEVICE_LOGIN_ONLY === '1';
  const loginRedirectOrigins = parseLoginRedirectOrigins(env.POCKET_LOGIN_REDIRECT_ORIGINS);
  const support = loadSupportDeployment(env);
  const androidDownloads = loadAndroidDownloads(env.POCKET_ANDROID_DOWNLOADS_DIR);
  const updatePubPath = env.POCKET_DESKTOP_UPDATE_PUB_FILE?.trim();
  const desktopUpdatePub = readFileSync(
    updatePubPath ? resolve(updatePubPath) : 'desktop/native/update-release.pub',
    'utf8',
  );
  const rawReleaseRepo = env.POCKET_RELEASE_REPO?.trim();
  const releaseRepo =
    rawReleaseRepo === 'none'
      ? ''
      : rawReleaseRepo
        ? (() => {
            const url = new URL(rawReleaseRepo);
            if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
              throw new Error(`Invalid POCKET_RELEASE_REPO: ${rawReleaseRepo}`);
            return url.href.replace(/\/+$/, '');
          })()
        : 'https://github.com/muxkin/fable-pavilion';
  const assets = assetSettings(env.POCKET_ASSET_BASE);
  const hash = createHash('sha256')
    .update(assets.base)
    .update(deviceLoginOnly ? 'device-login-only' : '')
    .update(JSON.stringify(loginRedirectOrigins))
    .update(releaseRepo)
    .update(support.json);
  if (support.qr) hash.update(support.qr.fileName).update(support.qr.source);
  for (const asset of androidDownloads) hash.update(asset.fileName).update(asset.source);
  const addFiles = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) addFiles(path);
      else hash.update(path).update(readFileSync(path));
    }
  };
  addFiles('src/web');
  addFiles('src/client');
  addFiles('src/shared');
  addFiles('packages/adapter-sdk/src');
  hash.update(readFileSync('package-lock.json')).update(readFileSync('vite.config.ts'));
  const nativeVersion = readFileSync('desktop/native/Cargo.toml', 'utf8').match(
    /^version = "([0-9.]+)"$/m,
  )?.[1];
  if (!nativeVersion) throw new Error('Missing native adapter version');
  hash.update(nativeVersion).update(desktopUpdatePub);
  const buildId = hash.digest('hex').slice(0, 16);
  return {
    define: {
      __POCKET_WEB_BUILD_ID__: JSON.stringify(buildId),
      __POCKET_NATIVE_VERSION__: JSON.stringify(nativeVersion),
      __POCKET_DEVICE_LOGIN_ONLY__: JSON.stringify(deviceLoginOnly),
      __POCKET_LOGIN_REDIRECT_ORIGINS__: JSON.stringify(loginRedirectOrigins),
      __POCKET_DESKTOP_UPDATE_PUB__: JSON.stringify(desktopUpdatePub),
      __POCKET_RELEASE_REPO__: JSON.stringify(releaseRepo),
    },
    root: 'src/web',
    base: assets.base,
    build: {
      outDir: '../../dist/web',
      emptyOutDir: true,
      // Small math fonts must remain files: the app's font CSP intentionally excludes data: URLs.
      assetsInlineLimit: (path) => (/\.(?:woff2?|ttf|otf)$/i.test(path) ? false : undefined),
      rollupOptions: {
        output: {
          manualChunks(id) {
            // Stable foundations keep their cache across application-only releases.
            if (/\/node_modules\/(?:@vue\/|vue\/)/.test(id)) return 'vue-vendor';
            if (id.includes('/node_modules/@material/material-color-utilities/')) return 'theme-vendor';
          },
        },
      },
    },
    plugins: [
      vue(),
      vueJsx(),
      {
        name: 'asset-origin',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === '/support.json') {
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(support.json);
              return;
            }
            if (support.qr && req.url === `/${support.qr.fileName}`) {
              res.end(support.qr.source);
              return;
            }
            next();
          });
        },
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'version.json',
            source: JSON.stringify({ buildId, ...(deviceLoginOnly && { deviceLoginOnly: true }) }),
          });
          if (release)
            this.emitFile({ type: 'asset', fileName: 'release.json', source: JSON.stringify(release) });
          this.emitFile({ type: 'asset', fileName: 'asset-origin.json', source: JSON.stringify(assets) });
          this.emitFile({ type: 'asset', fileName: 'support.json', source: support.json });
          if (support.qr)
            this.emitFile({ type: 'asset', fileName: support.qr.fileName, source: support.qr.source });
          for (const asset of androidDownloads)
            this.emitFile({ type: 'asset', fileName: asset.fileName, source: asset.source });
        },
      },
    ],
  };
});
