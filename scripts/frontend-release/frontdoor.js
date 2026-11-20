import bridge from './proxy.js';

// Only the independently deployed Pages project supplies frontend bytes. The
// business Worker is reached exclusively on the bridge's non-executable data routes.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origins = env.POCKET_FRONTEND_ORIGINS.split(',').map((origin) => origin.trim());
    if (!origins.includes(url.origin)) return new Response('Unknown frontend', { status: 404 });
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname === '/connect' ||
      url.pathname === '/health' ||
      url.pathname.startsWith('/downloads/desktop/')
    )
      return bridge.fetch(request, env);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const pages = new URL(env.POCKET_VERIFIED_PAGES);
    if (pages.protocol !== 'https:' || pages.origin !== env.POCKET_VERIFIED_PAGES)
      return new Response('Invalid frontend host', { status: 503 });
    pages.pathname = url.pathname;
    pages.search = url.search;
    const headers = new Headers();
    for (const name of ['If-Modified-Since', 'If-None-Match', 'Range']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    try {
      const response = await fetch(pages, { method: request.method, headers, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        const redirect = new URL(response.headers.get('Location') ?? '/', pages);
        if (redirect.origin !== pages.origin) throw Error('Unexpected frontend redirect');
        return Response.redirect(url.origin + redirect.pathname + redirect.search, response.status);
      }
      return response;
    } catch {
      return new Response('已验签的前端入口暂不可用', { status: 502 });
    }
  },
};
