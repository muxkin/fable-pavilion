// Standalone Admin Console Pages proxy: forwards /api/* and /health same-origin to the Worker backend.
const networkTypes =
  /^(?:application\/(?:json|octet-stream)|text\/plain|image\/(?:avif|gif|jpeg|png|webp))$/i;
const responseHeaders = ['cache-control', 'content-length', 'etag', 'last-modified', 'vary'];
const localError = (status) => Response.json({ error: '管理服务暂不可用' }, { status });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!(path.startsWith('/api/') || path === '/health')) return localError(404);
    if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return localError(403);
    const allowedOrigins = (env.POCKET_ADMIN_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    if (allowedOrigins.length && !allowedOrigins.includes(url.origin)) return localError(403);

    let upstream;
    try {
      if (env.BACKEND) upstream = await env.BACKEND.fetch(request);
      else return localError(503);
    } catch {
      return localError(502);
    }

    const headers = new Headers();
    for (const name of responseHeaders) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    for (const value of upstream.headers.getSetCookie()) {
      if (/^pocket_im_session=/.test(value) && !/;\s*domain\s*=/i.test(value)) {
        headers.append('Set-Cookie', value);
      }
    }
    const type = upstream.headers.get('Content-Type')?.split(';')[0].trim() ?? '';
    headers.set('Content-Type', networkTypes.test(type) ? type : 'application/octet-stream');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
