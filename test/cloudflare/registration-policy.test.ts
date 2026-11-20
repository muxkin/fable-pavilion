import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { AccountClient } from '../../src/client/account.js';

let mf: Miniflare, origin: string;
beforeAll(async () => {
  const directory = '.implementation/cloudflare-registration-test';
  mkdirSync(`${directory}/assets`, { recursive: true });
  writeFileSync(`${directory}/assets/index.html`, 'isolated registration policy test');
  execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'deploy',
      '--dry-run',
      '--outdir',
      directory,
      '--assets',
      `${directory}/assets`,
    ],
    { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe' },
  );
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'registration-policy-test',
      modules: true,
      scriptPath: `${directory}/index.js`,
      compatibilityDate: '2026-11-04',
      compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
      host: '127.0.0.1',
      port,
      bindings: {
        POCKET_PUBLIC_ORIGIN: origin,
        POCKET_RELAY_ENROLLMENT: 'registration-policy-test-enrollment-32',
        POCKET_IM_REGISTRATION_ENABLED: 'false',
        POCKET_IM_REGISTRATION_CODE: 'still-not-allowed',
        POCKET_LOGIN_ARTWORK_BASE: 'https://static.example.com/login',
        POCKET_DEVICE_LOGIN_ONLY: '1',
      },
      durableObjects: {
        RELAY: { className: 'RelayHub', useSQLite: true },
        MESSAGING: { className: 'MessagingHub', useSQLite: true },
      },
      r2Buckets: ['IM_MEDIA'],
      images: { binding: 'IMAGES' },
      serviceBindings: { ASSETS: async () => new Response('isolated registration policy test') },
    }),
  );
  await mf.ready;
});
afterAll(async () => {
  await mf?.dispose();
});

it('enforces the Cloudflare registration flag in the shared account service', async () => {
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`${origin}/api/im${path}`, {
      method,
      headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = (await response.json()) as any;
    if (!response.ok) throw Object.assign(Error(value.error), { status: response.status });
    return value as T;
  };
  expect(await request('/status')).toEqual({
    registrationEnabled: false,
    registrationRequiresCode: true,
    deviceLoginOnly: true,
    loginArtworkBase: 'https://static.example.com/login/',
  });
  await expect(request('/crypto/register', 'POST', {})).rejects.toMatchObject({
    status: 403,
    message: '本站已关闭注册',
  });
  await expect(
    new AccountClient(request, true).register(
      'blocked',
      'Blocked',
      'strong-blocked-password',
      'still-not-allowed',
    ),
  ).rejects.toMatchObject({ status: 403, message: '本站已关闭注册' });
  expect(await request('/me')).toEqual({ user: null });
});
