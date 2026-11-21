// Served from the independently published Pages project. The raw release is untrusted.
const releaseStore = 'pocket-verified-frontend-v1';
const manifestPath = '/_release/manifest.json';
const installedPath = '/_release/installed.json';
const releaseVerifier = self.frontendRelease;
const contentTypes = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
};
const clientReleases = new Map();
let current;
let checking;

async function checkRelease() {
  const cache = await caches.open(releaseStore);
  const stored = await cache.match(installedPath);
  let previous;
  if (stored) {
    const record = await stored.json();
    try {
      previous = await releaseVerifier.verifyRelease(record.document, self.POCKET_FRONTEND_PUBLIC_KEY, 0);
    } catch {}
  }
  try {
    const response = await fetch(manifestPath, { cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw Error('Release unavailable');
    const document = await response.json();
    const next = await releaseVerifier.verifyRelease(document, self.POCKET_FRONTEND_PUBLIC_KEY);
    if (
      previous &&
      (next.version < previous.version || (next.version === previous.version && next.id !== previous.id))
    )
      throw Error('Release rollback');
    await readFile(next, '/index.html', cache);
    if (Object.hasOwn(next.files, '/manifest.webmanifest'))
      await readFile(next, '/manifest.webmanifest', cache).catch(() => {});
    await cache.put(installedPath, Response.json({ document }));
    return next;
  } catch (error) {
    if (previous && previous.expires > Date.now()) return previous;
    throw error;
  }
}

function installedRelease(refresh = false) {
  if (!refresh && current && current.expires > Date.now()) return Promise.resolve(current);
  checking ??= checkRelease()
    .then((release) => (current = release))
    .finally(() => (checking = undefined));
  return checking;
}

async function readFile(release, path, cache = null) {
  cache ??= await caches.open(releaseStore);
  const expected = release.files[path];
  if (!expected) throw Error('Release file is missing');
  const location = '/_release/assets/' + expected + '.bin';
  const response =
    (await cache.match(location)) ?? (await fetch(location, { cache: 'no-store', redirect: 'error' }));
  if (!response.ok) throw Error('Release file is unavailable');
  const data = await response.arrayBuffer();
  if ((await releaseVerifier.digest(data)) !== expected) throw Error('Release file was modified');
  const safe = new Response(data, {
    headers: {
      'Content-Type': contentTypes[path.split('.').at(-1)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    },
  });
  await cache.put(location, safe.clone()).catch(() => {});
  return safe;
}

function verificationFailed() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>子虚亭</title><p>前端发布验签失败。请稍后重新打开。</p>',
    {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );
}

self.pocketVerifiedFrontend = async (event, url) => {
  const request = event.request;
  const data =
    url.pathname.startsWith('/api/') ||
    url.pathname === '/health' ||
    url.pathname.startsWith('/downloads/desktop/');
  // Data routes may be used by the app but cannot load as same-origin executable resources.
  if (
    data &&
    ![
      'script',
      'style',
      'worker',
      'sharedworker',
      'serviceworker',
      'iframe',
      'frame',
      'object',
      'embed',
    ].includes(request.destination) &&
    (request.mode !== 'navigate' || url.pathname.startsWith('/downloads/desktop/'))
  )
    return fetch(request);
  try {
    const navigation = request.mode === 'navigate';
    const release =
      (!navigation && event.clientId && clientReleases.get(event.clientId)) ||
      (await installedRelease(navigation));
    if (release.expires <= Date.now()) throw Error('Frontend release has expired');
    const path = navigation && !data ? '/index.html' : url.pathname;
    const response = await readFile(release, path);
    if (navigation) {
      if (event.resultingClientId) {
        for (const id of clientReleases.keys()) if (!(await self.clients.get(id))) clientReleases.delete(id);
        clientReleases.set(event.resultingClientId, release);
      }
      response.headers.set('Content-Security-Policy', self.POCKET_FRONTEND_CSP);
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('Referrer-Policy', 'no-referrer');
    }
    return response;
  } catch {
    return verificationFailed();
  }
};
