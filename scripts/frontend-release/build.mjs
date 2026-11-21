import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import './verify.js';

const here = dirname(fileURLToPath(import.meta.url));
const { validFile } = globalThis.frontendRelease;
const [input = 'dist/web', output = 'dist/frontend-pages'] = process.argv
  .slice(2)
  .map((path) => resolve(path));
const source = resolve(input);
const target = resolve(output);
if (
  target === source ||
  target.startsWith(source + sep) ||
  source.startsWith(target + sep) ||
  [resolve('.'), dirname(resolve('.'))].includes(target)
)
  throw Error('Use a separate frontend output directory');
const mode = process.env.POCKET_FRONTEND_VERIFY ?? '0';
if (!['0', '1'].includes(mode)) throw Error('POCKET_FRONTEND_VERIFY must be 0 or 1');

const uploadOrigins = (process.env.POCKET_FRONTEND_UPLOAD_ORIGINS ?? '')
  .split(',')
  .filter(Boolean)
  .map((value) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value) throw Error('Expected exact HTTPS upload origin');
    return value;
  });
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self'",
  ["connect-src 'self'", ...uploadOrigins].join(' '),
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const safeHeaders = `  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer`;
const routeMap = {
  version: 1,
  include: ['/api/*', '/connect', '/health', '/downloads/desktop/*'],
  exclude: [],
};
const buildHeaders = (checked) => `/*
${safeHeaders}
${
  checked
    ? `  Content-Security-Policy: ${csp}
  Cache-Control: no-cache
/_release/*
  Content-Type: application/octet-stream
  Content-Disposition: attachment
  Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'
  Cache-Control: no-cache
/_release/assets/*.bin
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/downloads/android/*.apk
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/manifest.webmanifest
  Content-Type: application/manifest+json; charset=utf-8
  Cache-Control: no-cache
/app-icons/*.webmanifest
  Content-Type: application/manifest+json; charset=utf-8
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
`
    : ''
}`;
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function fileList(directory, parent = '') {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = parent + '/' + entry.name;
    if (!validFile(path) || /^\/(?:_headers|_redirects|_worker\.js|_routes\.json)$/.test(path))
      throw Error('Reserved or invalid frontend path ' + path);
    if (entry.isDirectory()) result.push(...(await fileList(join(directory, entry.name), path)));
    else if (entry.isFile()) result.push(path);
    else throw Error('Frontend releases must contain only ordinary files and directories');
  }
  return result;
}

async function signedRelease(directory) {
  const { base } = JSON.parse(await readFile(join(source, 'asset-origin.json'), 'utf8'));
  if (base !== '/')
    throw Error('Build the verified frontend with same-origin assets (POCKET_ASSET_BASE empty)');
  const version = Number(process.env.POCKET_FRONTEND_RELEASE_VERSION);
  const expires = Date.parse(process.env.POCKET_FRONTEND_RELEASE_EXPIRES ?? '');
  if (
    !Number.isSafeInteger(version) ||
    version <= 0 ||
    !Number.isSafeInteger(expires) ||
    expires <= Date.now()
  )
    throw Error(
      'Set a positive POCKET_FRONTEND_RELEASE_VERSION and a future POCKET_FRONTEND_RELEASE_EXPIRES',
    );
  const publicKey = createPublicKey(await readFile(process.env.POCKET_FRONTEND_PUBLIC_KEY_FILE ?? ''));
  if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails.modulusLength < 3072)
    throw Error('Use a dedicated RSA signing key of at least 3072 bits');
  const verifyKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const signer = createPrivateKey(await readFile(process.env.POCKET_FRONTEND_SIGNING_KEY_FILE ?? ''));
  if (!publicKey.equals(createPublicKey(signer)))
    throw Error('The release signing key does not match the pinned public key');

  const paths = await fileList(source);
  const assets = join(directory, '_release/assets');
  await mkdir(assets, { recursive: true });
  const files = {};
  const written = new Set();
  for (const path of paths) {
    const bytes = await readFile(join(source, path));
    if (bytes.length > 25 * 1024 * 1024) throw Error('Asset exceeds the Pages file size limit: ' + path);
    const checksum = sha(bytes);
    files[path] = checksum;
    if (written.has(checksum)) continue;
    // Raw files are inert and do not trigger Pages' canonical .html redirects.
    await writeFile(join(assets, checksum + '.bin'), bytes);
    written.add(checksum);
  }
  const manifest = Buffer.from(JSON.stringify({ schema: 1, version, expires, uploadOrigins, files }));
  const signature = sign('sha256', manifest, signer);
  if (!verify('sha256', manifest, publicKey, signature))
    throw Error('Self-check of the release signature failed');
  const id = sha(manifest);
  await writeFile(
    join(directory, '_release/manifest.json'),
    JSON.stringify({
      manifest: manifest.toString('base64'),
      signature: signature.toString('base64'),
    }),
  );

  const original = await readFile(join(source, 'sw.js'), 'utf8');
  const integration = 'if (self.pocketVerifiedFrontend && url.origin === self.location.origin)';
  if (!original.includes(integration))
    throw Error('Missing verified frontend integration in the service worker');
  await writeFile(
    join(directory, 'sw.js'),
    [
      'self.POCKET_FRONTEND_PUBLIC_KEY = ' + JSON.stringify(verifyKey) + ';',
      'self.POCKET_FRONTEND_CSP = ' + JSON.stringify(csp) + ';',
      await readFile(join(here, 'verify.js'), 'utf8'),
      await readFile(join(here, 'worker.js'), 'utf8'),
      original,
    ].join('\n'),
  );
  await cp(join(here, 'start.js'), join(directory, 'verified-start.js'));
  await writeFile(
    join(directory, 'index.html'),
    `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fffcf5">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="子虚亭">
<link rel="icon" type="image/png" sizes="32x32" href="/app-icons/wuyou-32.png">
<link rel="apple-touch-icon" sizes="192x192" href="/app-icons/wuyou-192.png">
<link rel="manifest" href="/manifest.webmanifest">
<title>子虚亭 · Fable Pavilion</title>
<style>
  html,body{margin:0;height:100%;background:#fffcf5;color:#24343a;font:14px/1.6 system-ui,-apple-system,sans-serif}
  @media (prefers-color-scheme:dark){:root:not([data-color-mode='light']),:root:not([data-color-mode='light']) body{background:#172329;color:#f6f2ea}}
  :root[data-color-mode='dark'],:root[data-color-mode='dark'] body{background:#172329;color:#f6f2ea}
  body{display:grid;place-items:center}
  p{margin:0;opacity:0;color:#627579;animation:fp-fade .25s ease .75s forwards}
  @media (prefers-color-scheme:dark){:root:not([data-color-mode='light']) p{color:#9ab0b3}}
  :root[data-color-mode='dark'] p{color:#9ab0b3}
  p[data-error='true']{opacity:1;animation:none}
  @keyframes fp-fade{to{opacity:.85}}
</style>
<p role="status">正在验证子虚亭前端…</p>
<script src="/verified-start.js" defer></script></html>\n`,
  );
  // Copy inert PWA metadata and icon files so browser-level installability checks
  // (e.g. manifest/icon fetches outside a controlling service worker) get JSON/PNG rather than HTML.
  if (paths.includes('/manifest.webmanifest')) {
    await cp(join(source, 'manifest.webmanifest'), join(directory, 'manifest.webmanifest'));
  }
  const iconAssets = paths.filter(
    (path) => path.startsWith('/app-icons/') && (path.endsWith('.webmanifest') || path.endsWith('.png')),
  );
  if (iconAssets.length) {
    await mkdir(join(directory, 'app-icons'), { recursive: true });
    for (const path of iconAssets) {
      const relative = path.slice(1);
      await cp(join(source, relative), join(directory, relative));
    }
  }
  // Copy download links that have to work outside a controlled browser (e.g. the APK installer).
  // Downloaded files remain subject to their own package signature verification.
  if (paths.some((path) => path.startsWith('/downloads/android/'))) {
    await mkdir(join(directory, 'downloads'), { recursive: true });
    await cp(join(source, 'downloads/android'), join(directory, 'downloads/android'), { recursive: true });
  }
  console.log(`Signed frontend release ${version} (${id.slice(0, 12)}, ${paths.length} files)`);
}

const stage = target + '.staging-' + process.pid;
try {
  if (mode === '1') {
    await mkdir(stage, { recursive: true });
    await signedRelease(stage);
  } else {
    await fileList(source);
    await cp(source, stage, { recursive: true, errorOnExist: true });
  }
  await writeFile(join(stage, '_headers'), buildHeaders(mode === '1'));
  await writeFile(join(stage, '_routes.json'), JSON.stringify(routeMap));
  await cp(join(here, 'proxy.js'), join(stage, '_worker.js'));
  // The previous build stays available if signing or staging fails.
  await rm(target, { recursive: true, force: true });
  await rename(stage, target);
  console.log(`Pages bundle ready at ${target} (verification ${mode === '1' ? 'required' : 'off'})`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
