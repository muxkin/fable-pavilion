// Pages owns this data bridge. Only the publisher can change which paths it exposes.
const networkTypes =
  /^(?:application\/(?:json|octet-stream|pdf)|text\/(?:plain|event-stream)|image\/(?:avif|gif|jpeg|png|webp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;
const responseHeaders = [
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-length',
  'content-range',
  'etag',
  'last-modified',
  'vary',
];
const localError = (status) => Response.json({ error: '业务服务暂不可用' }, { status });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const socket =
      path === '/connect' && !url.search && request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    const downloads = path.startsWith('/downloads/desktop/');
    if (!(path.startsWith('/api/') || path === '/health' || downloads || socket)) return localError(404);
    if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return localError(403);
    if (socket && request.headers.get('Origin') !== url.origin) return localError(403);
    const frontendOrigins = (env.POCKET_FRONTEND_ORIGINS ?? env.POCKET_FRONTEND_ORIGIN ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    if (frontendOrigins.length && !frontendOrigins.includes(url.origin)) return localError(403);

    let upstream;
    try {
      if (env.BACKEND) upstream = await env.BACKEND.fetch(request);
      else if (env.POCKET_BACKEND_ORIGIN && frontendOrigins.length) {
        const backend = new URL(env.POCKET_BACKEND_ORIGIN);
        if (
          backend.origin !== env.POCKET_BACKEND_ORIGIN ||
          backend.protocol !== 'https:' ||
          backend.origin === url.origin
        )
          return localError(503);
        // Assign pathname/query separately so even a path beginning with // cannot select a host.
        backend.pathname = path;
        backend.search = url.search;
        upstream = await fetch(new Request(backend, request), { redirect: 'manual' });
      } else return localError(503);
    } catch {
      return localError(502);
    }
    if (socket && upstream.status === 101 && upstream.webSocket) return upstream;
    if (upstream.status === 101) return localError(502);

    const headers = new Headers();
    for (const name of responseHeaders) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    for (const value of upstream.headers.getSetCookie())
      if (/^pocket_(?:im_session|session)=/.test(value) && !/;\s*domain\s*=/i.test(value))
        headers.append('Set-Cookie', value);
    const type = upstream.headers.get('Content-Type')?.split(';')[0].trim() ?? '';
    headers.set('Content-Type', networkTypes.test(type) ? type : 'application/octet-stream');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');

    if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
      // External object/download redirects leave the verified frontend origin.
      const location = upstream.headers.get('Location');
      let target;
      try {
        target = new URL(location ?? '');
      } catch {
        return localError(502);
      }
      if (target.protocol !== 'https:' || target.origin === url.origin || target.username || target.password)
        return localError(502);
      headers.set('Location', target.href);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
