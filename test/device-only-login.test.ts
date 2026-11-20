import { expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { HTTPMethods } from 'fastify';
import { AccountClient } from '../src/client/account.js';
import { buildRelay } from '../src/server/relay.js';
import { unlockAccount } from '../src/shared/account-crypto.js';
import {
  createTrustedLoginKey,
  deviceLoginMatchCode,
  sealTrustedLoginRoot,
  signDeviceLoginApproval,
  type TrustedDevicePublicKey,
} from '../src/shared/trusted-device-crypto.js';

it('keeps device approval and recovery usable without a server seed or password-wrapped root', async () => {
  const origin = 'https://frontend.example.test';
  const server = await buildRelay({
    origin,
    upstreamOrigin: 'https://data.example.test',
    webRoot: resolve('src/web/public'),
    enrollmentSecret: 'device-only-test-enrollment-enough-characters',
    assetOrigin: null,
    uploadOrigins: [],
    messaging: { deviceLoginOnly: true },
  });
  const client = () => {
    let cookie = '';
    return new AccountClient(async <T>(url: string, method = 'GET', body?: unknown) => {
      const response = await server.app.inject({
        method: method as HTTPMethods,
        url: '/api/im' + url,
        headers: { host: 'data.example.test', origin, cookie },
        payload: body as object,
      });
      if (response.cookies.length)
        cookie = response.cookies.map(({ name, value }) => name + '=' + value).join('; ');
      if (response.statusCode >= 400)
        throw Object.assign(Error(response.json().error), { status: response.statusCode });
      return response.json() as T;
    });
  };
  try {
    const original = client(),
      recipient = client();
    const password = 'test-device-only-password';
    const { user, vault } = await original.register('keeps-secrets', 'Owner', password, undefined, true);
    const originalRoot = original.secrets!.root;
    const recovery = original.recoveryCode;
    expect(vault.password).toBeUndefined();
    await expect(unlockAccount(vault, password)).rejects.toThrow('扫码解锁');
    await expect(recipient.login(user.username, password)).rejects.toMatchObject({ status: 403 });
    await expect(original.request('/crypto/totp/display', 'POST', {})).rejects.toMatchObject({ status: 503 });
    await original.writeItem('existing', { value: 'private data' });

    const handle = await recipient.startQrLogin(user.username, 'Recipient');
    const request = await original.request<{
      id: string;
      expiresAt: number;
      publicKey: TrustedDevicePublicKey;
      deviceBound: boolean;
    }>('/crypto/qr/' + handle.id);
    expect(request.deviceBound).toBe(true);
    expect(await deviceLoginMatchCode(handle.id, handle.key.publicKey)).toBe(
      await deviceLoginMatchCode(request.id, request.publicKey),
    );
    const other = await createTrustedLoginKey();
    expect(await deviceLoginMatchCode(handle.id, other.publicKey)).not.toBe(
      await deviceLoginMatchCode(request.id, request.publicKey),
    );
    const { id, expiresAt, publicKey } = request;
    const envelope = await sealTrustedLoginRoot(original.secrets!, {
      origin,
      requestId: id,
      accountId: user.id,
      recipientPublicKey: publicKey,
    });
    const approval = {
      origin,
      accountId: user.id,
      revision: original.revision,
      requestId: id,
      expiresAt,
      recipientPublicKey: publicKey,
      envelope,
    };
    expect(await recipient.checkQrLogin(handle, origin)).toEqual({ pending: true });
    await expect(original.request('/crypto/qr/approve', 'POST', { id, envelope })).rejects.toMatchObject({
      status: 403,
    });
    const wrong = await signDeviceLoginApproval(original.secrets!.signing, {
      ...approval,
      expiresAt: expiresAt + 1,
    });
    await expect(
      original.request('/crypto/qr/approve', 'POST', { id, envelope, signature: wrong }),
    ).rejects.toMatchObject({ status: 403 });
    const signature = await signDeviceLoginApproval(original.secrets!.signing, approval);
    await original.request('/crypto/qr/approve', 'POST', { id, envelope, signature });
    await recipient.checkQrLogin(handle, origin);
    expect(recipient.secrets?.root).toBe(originalRoot);
    expect(await recipient.readItem('existing')).toEqual({ value: 'private data' });

    const restored = client();
    await restored.login(user.username, recovery, true);
    await restored.changePassword(recovery, 'new-device-only-password', true);
    expect(restored.secrets?.root).toBe(originalRoot);
    expect(restored.vault?.password).toBeUndefined();
    expect(await restored.readItem('existing')).toEqual({ value: 'private data' });
  } finally {
    await server.app.close();
  }
});

it('a frontend with device login pinned never uploads a password-wrapped key', async () => {
  let requests = 0;
  const account = new AccountClient(async <T>(path: string, _method?: string, payload?: unknown) => {
    requests++;
    expect(path).toBe('/crypto/register');
    const { vault } = payload as { vault: { password?: unknown } };
    expect(vault.password).toBeUndefined();
    return { user: { id: '10000000' }, vault } as T;
  }, true);
  await account.register('pinned', 'Owner', 'test-pinned-password');
  await expect(account.login('pinned', 'test-pinned-password')).rejects.toThrow('扫码登录');
  expect(requests).toBe(1);
});

it('migrates an existing account immediately while keeping the recovery code, active session and ciphertext', async () => {
  const root = await mkdtemp(join(tmpdir(), 'device-migration-'));
  const database = join(root, 'im.sqlite');
  const origin = 'https://frontend.example.test';
  const config = {
    origin,
    webRoot: resolve('src/web/public'),
    enrollmentSecret: 'device-migration-test-enrollment-enough-characters',
    assetOrigin: null,
    uploadOrigins: [],
  };
  let server = await buildRelay({
    ...config,
    messaging: { database, totpKey: Buffer.alloc(32, 42).toString('base64url') },
  });
  let cookie = '';
  const client = (inheritCookie: boolean) => {
    let local = inheritCookie ? cookie : '';
    return new AccountClient(async <T>(path: string, method = 'GET', payload?: unknown) => {
      const response = await server.app.inject({
        method: method as HTTPMethods,
        url: '/api/im' + path,
        headers: { host: 'frontend.example.test', origin, cookie: local },
        payload: payload as object,
      });
      if (response.cookies.length) {
        local = response.cookies.map(({ name, value }) => name + '=' + value).join('; ');
        if (inheritCookie && !cookie) cookie = local;
      }
      if (response.statusCode >= 400)
        throw Object.assign(Error(response.json().error), { status: response.statusCode });
      return response.json() as T;
    });
  };
  try {
    const existing = client(true);
    const { user, vault } = await existing.register('migration', 'Owner', 'original-password-for-migration');
    const code = existing.recoveryCode;
    const rootKey = existing.secrets!.root;
    await existing.writeItem('existing', { value: 'retained' });
    expect(vault.password).toBeDefined();
    await server.app.close();
    server = await buildRelay({ ...config, messaging: { database, deviceLoginOnly: true } });

    const live = await client(true).request<{ vault: typeof vault; revision: number }>('/crypto/account');
    expect(live.revision).toBe(1);
    expect(live.vault).toEqual({ ...vault, password: undefined });
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS count FROM im_account_totp').get()?.count).toBe(0);
    } finally {
      db.close();
    }
    const recovery = client(false);
    await recovery.login(user.username, code, true);
    expect(recovery.secrets?.root).toBe(rootKey);
    expect(await recovery.readItem('existing')).toEqual({ value: 'retained' });
  } finally {
    await server.app.close();
    await rm(root, { recursive: true, force: true });
  }
});
