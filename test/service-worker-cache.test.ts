import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../src/web/public/sw.js', import.meta.url), 'utf8');
function fixture(userAgent = 'Mozilla/5.0') {
  const handlers: Record<string, (e: any) => void> = {},
    entries = new Map<string, Response>();
  let denied = false;
  const cache = {
    put: vi.fn(async (key: any, value: Response) => {
      if (denied) throw Error('quota');
      entries.set(typeof key === 'string' ? key : key.url, value);
    }),
    match: async (key: any) => entries.get(typeof key === 'string' ? key : key.url)?.clone(),
  };
  const fetch = vi.fn(
    async () => new Response('<html>current</html>', { headers: { 'Content-Type': 'text/html' } }),
  );
  runInNewContext(source, {
    self: {
      location: { origin: 'https://chat.test' },
      navigator: { userAgent },
      skipWaiting: vi.fn(),
      addEventListener: (key: string, handler: any) => {
        handlers[key] = handler;
      },
    },
    caches: { open: async () => cache },
    fetch,
    Response,
    URL,
    setTimeout,
    clearTimeout,
    MessageChannel,
  });
  return {
    entries,
    cache,
    fetch,
    deny: () => {
      denied = true;
    },
    async install() {
      const lifetime: Promise<unknown>[] = [];
      handlers.install?.({ waitUntil: (value: Promise<unknown>) => lifetime.push(value) });
      await Promise.all(lifetime);
    },
    request(path: string, destination = 'document') {
      let response: Promise<Response> | undefined;
      const lifetime: Promise<unknown>[] = [];
      handlers.fetch({
        request: {
          url: `https://chat.test${path}`,
          method: 'GET',
          mode: destination === 'document' ? 'navigate' : 'cors',
          destination,
        },
        respondWith: (value: Promise<Response>) => {
          response = value;
        },
        waitUntil: (value: Promise<unknown>) => lifetime.push(value),
      });
      return response?.then(async (value) => {
        await Promise.all(lifetime);
        return value;
      });
    },
  };
}
it('does not intercept private API navigations or cache media documents as the application shell', async () => {
  const f = fixture();
  expect(f.request('/api/im/me')).toBeUndefined();
  f.fetch.mockImplementation(async () => new Response('image', { headers: { 'Content-Type': 'image/png' } }));
  expect(await (await f.request('/support/wechat-reward.png'))!.text()).toBe('image');
  expect(f.cache.put).not.toHaveBeenCalled();
});
it('keeps online navigation working when cache writes fail and uses only the saved HTML shell offline', async () => {
  const f = fixture();
  await f.request('/?page=messages');
  expect(await f.entries.get('/')!.clone().text()).toContain('current');
  f.deny();
  expect(await (await f.request('/?page=contacts'))!.text()).toContain('current');
  f.fetch.mockRejectedValue(Error('offline'));
  expect(await (await f.request('/?page=messages'))!.text()).toContain('current');
});
it('returns cached public scripts without a second network request', async () => {
  const f = fixture();
  // Real same-origin fetch responses have type basic; default Response is also non-opaque.
  await f.request('/assets/app-123456.js', 'script');
  await f.request('/assets/app-123456.js', 'script');
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.request('/api/im/conversations/a/files/b/private.png', 'image')).toBeUndefined();
});
it('pre-caches the start shell on install and returns a 200 HTML fallback offline for PWA installability', async () => {
  const f = fixture();
  await f.install();
  expect(await f.entries.get('/')!.clone().text()).toContain('current');
  const cold = fixture();
  cold.fetch.mockRejectedValue(Error('offline'));
  const response = await cold.request('/');
  expect(response!.status).toBe(200);
  expect(response!.headers.get('Content-Type')).toContain('text/html');
  expect(await response!.text()).toContain('离线');
});
it('leaves top-level document navigations to the Android verified wrapper so reload activates new releases', async () => {
  const f = fixture('Mozilla/5.0 FablePavilionAndroid/13 FablePavilionAndroidUpdater');
  await f.install();
  expect(f.entries.size).toBe(0);
  expect(f.request('/')).toBeUndefined();
  expect(f.request('/?page=downloads')).toBeUndefined();
});
