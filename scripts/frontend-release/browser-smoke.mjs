import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const scratch = await mkdtemp(join(tmpdir(), 'verified-web-'));
const source = join(scratch, 'source');
let deployed;
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  // Match Pages headers for the raw download area, including application/octet-stream.
  const root = deployed;
  try {
    const name = path === '/' ? '/index.html' : path;
    const body = await readFile(join(root, name));
    let type = 'application/octet-stream';
    if (!name.startsWith('/_release/')) {
      if (name.endsWith('.html')) type = 'text/html; charset=utf-8';
      if (name.endsWith('.js')) type = 'text/javascript';
    }
    response.writeHead(200, {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const signed = (release, label, env = {}) => {
  const target = join(scratch, label);
  execFileSync(process.execPath, ['scripts/frontend-release/build.mjs', source, target], {
    env: {
      ...process.env,
      POCKET_FRONTEND_VERIFY: '1',
      POCKET_FRONTEND_RELEASE_VERSION: String(release),
      POCKET_FRONTEND_RELEASE_EXPIRES: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      POCKET_FRONTEND_SIGNING_KEY_FILE: join(scratch, 'signing.pem'),
      POCKET_FRONTEND_PUBLIC_KEY_FILE: join(scratch, 'verification.pem'),
      ...env,
    },
  });
  return target;
};

let browser;
try {
  await mkdir(join(source, 'assets'), { recursive: true });
  await mkdir(join(source, 'app-icons'), { recursive: true });
  await writeFile(join(scratch, 'signing.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  await writeFile(join(scratch, 'verification.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(join(source, 'asset-origin.json'), '{"base":"/"}');
  await copyFile(resolve('src/web/public/sw.js'), join(source, 'sw.js'));
  await copyFile(resolve('src/web/public/manifest.webmanifest'), join(source, 'manifest.webmanifest'));
  await copyFile(resolve('src/web/public/app-icons/wuyou-192.png'), join(source, 'app-icons/wuyou-192.png'));
  await writeFile(
    join(source, 'index.html'),
    '<meta charset="utf-8"><script type="module" src="/assets/main.js"></script><p>application</p>',
  );
  await writeFile(
    join(source, 'assets/main.js'),
    'const { label } = await import("./dependency.js"); document.body.dataset.verified = label;',
  );
  await writeFile(join(source, 'assets/dependency.js'), 'export const label = "old";');
  const old = signed(20, 'valid');
  assert.equal(JSON.parse(await readFile(join(old, 'manifest.webmanifest'), 'utf8')).start_url, '/');
  assert.ok((await readFile(join(old, 'app-icons/wuyou-192.png'))).length > 1000);
  assert.match(await readFile(join(old, 'index.html'), 'utf8'), /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(await readFile(join(old, '_headers'), 'utf8'), /\/manifest\.webmanifest\n\s+Content-Type: application\/manifest\+json/);
  await writeFile(join(source, 'assets/dependency.js'), 'export const label = "new";');
  const newer = signed(21, 'new');
  const tampered = signed(22, 'tampered');
  const manifestPath = join(tampered, '_release/manifest.json');
  const document = JSON.parse(await readFile(manifestPath, 'utf8'));
  const manifest = JSON.parse(Buffer.from(document.manifest, 'base64'));
  await writeFile(
    join(tampered, '_release/assets', manifest.files['/assets/dependency.js'] + '.bin'),
    'document.body.dataset.verified = "unsigned";',
  );
  const invalid = signed(23, 'invalid');
  const invalidPath = join(invalid, '_release/manifest.json');
  const bad = JSON.parse(await readFile(invalidPath, 'utf8'));
  const signature = Buffer.from(bad.signature, 'base64');
  signature[0] ^= 1;
  bad.signature = signature.toString('base64');
  await writeFile(invalidPath, JSON.stringify(bad));
  const off = signed(0, 'off', {
    POCKET_FRONTEND_VERIFY: '0',
    POCKET_FRONTEND_PUBLIC_KEY_FILE: '',
    POCKET_FRONTEND_SIGNING_KEY_FILE: '',
  });
  assert.match(await readFile(join(off, 'index.html'), 'utf8'), /assets\/main\.js/);

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: process.env.POCKET_TEST_CHROMIUM, headless: true });
  const page = await browser.newPage();
  deployed = old;
  await page.goto(origin + '/?page=login-security');
  await page.waitForFunction(() => document.body.dataset.verified === 'old');
  assert.equal(new URL(page.url()).searchParams.get('page'), 'login-security');
  deployed = newer;
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.verified === 'new');
  deployed = old;
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.verified === 'new');
  deployed = invalid;
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.verified === 'new');

  const unsignedManifest = await browser.newPage();
  await unsignedManifest.goto(origin);
  await unsignedManifest.getByText('前端发布验签失败。').waitFor();
  const changedModule = await browser.newPage();
  deployed = tampered;
  const refused = changedModule.waitForResponse(
    (r) => r.url().endsWith('/assets/dependency.js') && r.status() === 503,
  );
  await changedModule.goto(origin);
  await refused;
  assert.equal(await changedModule.locator('body').getAttribute('data-verified'), null);
  console.log(
    'Verified frontend browser smoke passed: signatures, tampered dynamic import, rollback, and off mode.',
  );
} finally {
  await browser?.close();
  server.close();
  await rm(scratch, { recursive: true, force: true });
}
