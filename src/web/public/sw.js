/* Cache local public assets only. CDN assets use their immutable HTTP cache directly. */
const CACHE = 'pocket-static-v5';
const OFFLINE_SHELL =
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>子虚亭</title><p>当前处于离线状态，请联网后重新打开子虚亭。</p></html>';
self.addEventListener('install', (event) => {
  self.skipWaiting();
  if (!self.pocketVerifiedFrontend) {
    event.waitUntil(
      caches
        .open(CACHE)
        .then((cache) =>
          fetch('/')
            .then((response) => {
              if (response.ok && response.headers.get('Content-Type')?.includes('text/html'))
                return cache.put('/', response);
            })
            .catch(() => {}),
        )
        .catch(() => {}),
    );
  }
});
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('pocket-static-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener('fetch', (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (url.origin === self.location.origin && /^\/local-files\/[a-f0-9-]{36}$/.test(url.pathname)) {
    event.respondWith(localFile(event, url.pathname.split('/').at(-1)));
    return;
  }
  if (self.pocketVerifiedFrontend && url.origin === self.location.origin) {
    event.respondWith(self.pocketVerifiedFrontend(event, url));
    return;
  }
  if (
    url.origin === self.location.origin &&
    request.mode === 'navigate' &&
    !url.pathname.startsWith('/api/')
  ) {
    event.respondWith(
      caches
        .open(CACHE)
        .catch(() => undefined)
        .then(async (cache) => {
          try {
            const response = await fetch(request);
            if (response.ok && response.headers.get('Content-Type')?.includes('text/html'))
              event.waitUntil(cache?.put('/', response.clone()).catch(() => {}) ?? Promise.resolve());
            if (response.status >= 500) {
              const offline = await cache?.match('/').catch(() => undefined);
              if (offline) return offline;
            }
            return response;
          } catch {
            return (
              (await cache?.match('/').catch(() => undefined)) ??
              new Response(OFFLINE_SHELL, {
                status: 200,
                headers: { 'Content-Type': 'text/html; charset=utf-8' },
              })
            );
          }
        }),
    );
    return;
  }
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !['script', 'style', 'font'].includes(request.destination) ||
    !url.pathname.includes('/assets/')
  )
    return;
  event.respondWith(
    caches
      .open(CACHE)
      .catch(() => undefined)
      .then(async (cache) => {
        const hit = await cache?.match(request).catch(() => undefined);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok && response.type !== 'opaque')
          event.waitUntil(cache?.put(request, response.clone()).catch(() => {}) ?? Promise.resolve());
        return response;
      }),
  );
});

// Private media never enters CacheStorage or the cloud HTTP route. The owning
// page authorizes each local capability and supplies one decrypted block at a time.
async function localFile(event, id) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const ask = (client, body) =>
    new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(Error('File unavailable'));
      }, 30000);
      channel.port1.onmessage = ({ data }) => {
        clearTimeout(timer);
        channel.port1.close();
        data.error ? reject(Error('File unavailable')) : resolve(data);
      };
      client.postMessage({ type: 'local-file', id, ...body }, [channel.port2]);
    });
  let owner, meta;
  for (const client of clients) {
    try {
      meta = await ask(client, { metadata: true });
      owner = client;
      break;
    } catch {}
  }
  if (!owner) return new Response('附件页面已关闭，请在会话中重新打开', { status: 410 });
  const range = event.request.headers.get('Range');
  let start = 0,
    end = meta.size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${meta.size}` } });
    start = match[1] ? Number(match[1]) : Math.max(0, meta.size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    if (start > end || start >= meta.size)
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${meta.size}` } });
  }
  const headers = {
    'Content-Type': meta.mime,
    'Content-Length': String(Math.max(0, end - start + 1)),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
  const inline = /^(image\/|audio\/|video\/|text\/plain(?:;|$)|application\/(?:pdf|json)(?:;|$))/.test(
    meta.mime,
  );
  const disposition =
    !inline || new URL(event.request.url).searchParams.has('download') ? 'attachment' : 'inline';
  headers['Content-Disposition'] =
    `${disposition}; filename*=UTF-8''${encodeURIComponent(meta.name).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase())}`;
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${meta.size}`;
  const stream = new ReadableStream({
    async pull(controller) {
      if (start > end) {
        controller.close();
        return;
      }
      const stop = Math.min(end, (Math.floor(start / 1048576) + 1) * 1048576 - 1);
      try {
        const { data } = await ask(owner, { start, end: stop });
        controller.enqueue(data);
        start = stop + 1;
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(event.request.method === 'HEAD' ? null : stream, {
    status: range ? 206 : 200,
    headers,
  });
}

const pushBindingCache = 'fable-push-binding-v1';
const pushBindingKey = '/_local/fable-push-binding';
const clearedCallsKey = '/_local/fable-cleared-calls';
const noticeId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
self.addEventListener('message', (event) => {
  if (
    event.data?.type !== 'fable-push-binding' ||
    !event.source?.url ||
    new URL(event.source.url).origin !== self.location.origin
  )
    return;
  const id = event.data.id;
  if (id !== null && (typeof id !== 'string' || !noticeId.test(id))) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(pushBindingCache);
      if (id) await cache.put(pushBindingKey, new Response(id));
      else {
        await cache.delete(pushBindingKey);
        await cache.delete(clearedCallsKey);
        for (const notification of await self.registration.getNotifications()) notification.close();
      }
    })(),
  );
});

let notifyQueue = Promise.resolve();
self.addEventListener('push', (event) => {
  notifyQueue = notifyQueue
    .catch(() => {})
    .then(async () => {
      let notice;
      try {
        notice = event.data?.json();
      } catch {
        return;
      }
      const now = Date.now();
      if (
        !notice ||
        !noticeId.test(notice.id) ||
        !noticeId.test(notice.conversation) ||
        !Number.isSafeInteger(notice.expiresAt) ||
        notice.expiresAt <= now ||
        notice.expiresAt - now > 16 * 60_000
      )
        return;
      const cache = await caches.open(pushBindingCache);
      const binding = await (await cache.match(pushBindingKey))?.text();
      if (!binding || binding !== notice.binding) return;
      const cleared = (await (await cache.match(clearedCallsKey))?.json()) ?? {};
      if (notice.kind === 'call-cleared') {
        const active = Object.entries(cleared).filter(([, expiresAt]) => expiresAt > now);
        await cache.put(
          clearedCallsKey,
          new Response(
            JSON.stringify({
              ...Object.fromEntries(active),
              [notice.id]: notice.expiresAt,
            }),
          ),
        );
        for (const n of await self.registration.getNotifications({ tag: 'fable-call:' + notice.id }))
          n.close();
        return;
      }
      const call = notice.kind === 'audio-call' || notice.kind === 'video-call';
      if (!call && notice.kind !== 'message') return;
      if (call && cleared[notice.id] > now) return;
      await self.registration.showNotification('子虚亭', {
        body: call ? (notice.kind === 'video-call' ? '有视频来电' : '有语音来电') : '助手发来新消息',
        icon: '/app-icons/wuyou-192.png',
        tag: call ? 'fable-call:' + notice.id : 'fable-message:' + notice.conversation,
        data: { conversation: notice.conversation, expiresAt: notice.expiresAt, call },
      });
    });
  event.waitUntil(notifyQueue);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { conversation, expiresAt, call } = event.notification.data ?? {};
  if (!noticeId.test(conversation) || (call && expiresAt <= Date.now())) return;
  event.waitUntil(
    (async () => {
      const url = '/?page=messages&conversation=' + conversation;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
      const client = windows.find(({ visibilityState }) => visibilityState === 'visible') ?? windows[0];
      if (client) {
        client.postMessage({ type: 'fable-open-notification', conversation });
        await client.focus();
      } else await self.clients.openWindow(url);
    })(),
  );
});
