import { expect, it } from 'vitest';

type ContentRequest = (path: string, init?: RequestInit) => Promise<Response>;
const id = 'c88e61c9-30f6-4c4d-aaf1-b0e9263143db';

/** Keep the private-content boundary identical on the Node and Worker HTTP adapters. */
export function anonymousAccessContract(request: ContentRequest) {
  it('rejects anonymous and forged sessions across private content while retaining login bootstrap', async () => {
    for (const [method, path, body] of [
      ['GET', '/bootstrap'],
      ['GET', '/contacts'],
      ['GET', '/agents'],
      ['GET', '/conversations'],
      ['GET', '/sync'],
      ['GET', '/resources'],
      ['GET', '/resources/files'],
      ['GET', '/stickers'],
      ['GET', '/calls'],
      ['GET', '/calls/ice'],
      ['GET', '/crypto/account'],
      ['GET', '/crypto/items?accountId=1'],
      ['GET', '/crypto/keys/1'],
      ['GET', `/users/1/avatar/${id}`],
      ['HEAD', `/users/1/avatar/${id}`],
      ['GET', `/conversations/${id}`],
      ['GET', `/conversations/${id}/messages`],
      ['GET', `/conversations/${id}/files/${id}/private.txt`],
      ['GET', `/stickers/${id}/file`],
      ['GET', '/notifications'],
      ['GET', '/translation'],
      ['GET', '/login-devices'],
      ['GET', '/desktop-devices'],
      ['POST', '/groups', { name: 'Group', userIds: ['1'] }],
      ['POST', '/agent-invitations', {}],
      ['POST', '/me/avatar', {}],
      ['POST', '/crypto/password', {}],
      ['POST', '/crypto/recovery/rotate', {}],
      ['POST', '/translation', {}],
      ['PATCH', '/me', { displayName: 'Anonymous' }],
      ['DELETE', '/me/avatar'],
    ] as const) {
      const response = await request(path, {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      if (method !== 'HEAD') expect(await response.json()).toEqual({ error: '请先登录' });
    }
    for (const headers of [
      new Headers({ Authorization: 'Bearer forged-session' }),
      new Headers({ Cookie: 'pocket_im_session=forged-session' }),
    ]) {
      const response = await request('/bootstrap', { headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: '请先登录' });
    }
    const status = await request('/status');
    expect(status.status).toBe(200);
    expect(await status.json()).toHaveProperty('registrationEnabled');
    const me = await request('/me');
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ user: null });
    const parameters = await request('/crypto/parameters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'login-user' }),
    });
    expect(parameters.status).toBe(200);
    expect(await parameters.json()).toHaveProperty('salt');
  });
}
