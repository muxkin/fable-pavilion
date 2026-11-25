import { expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { HTTPMethods } from 'fastify';
import { AccountClient } from '../src/client/account.js';
import { createHash, randomUUID } from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { desktopAuthorizationProof } from '../src/shared/desktop-authorization.js';
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

    // In deviceLoginOnly mode without passkeys: usage-reset, desktop-backup, recovery rotate,
    // and first passkey enrollment must work cleanly without demanding a disabled password or TOTP.
    const hostKey = await generateKeyPair('Ed25519');
    const hostId = peerIdFromPrivateKey(hostKey).toString();
    const ticket = createHash('sha256').update('device-only-claim-code').digest('hex');
    const issuedAt = Date.now();
    const baseAuth = { hostId, name: 'Linux Box', ticket, issuedAt };
    const authorization = {
      ...baseAuth,
      signature: Buffer.from(await hostKey.sign(desktopAuthorizationProof(origin, baseAuth))).toString(
        'base64',
      ),
    };
    await recovery.request('/desktop-devices/approve', 'POST', { accountId: user.id, authorization });
    const deviceId = randomUUID();
    const prepared = await recovery.request<{
      ticket: string;
      document: { account: { id: string }; totpSecret?: string };
    }>('/crypto/desktop-backup/prepare', 'POST', { hostId, deviceId, authorization });
    expect(prepared.document.account.id).toBe(user.id);
    expect(prepared.document.totpSecret).toBeUndefined();
    const serialized = JSON.stringify(prepared.document);
    const payloadHash = createHash('sha256').update(serialized).digest('hex');
    const sealed = await recovery.request<{ proof: string }>('/crypto/desktop-backup/seal', 'POST', {
      ticket: prepared.ticket,
      payloadHash,
    });
    const redeemedBackup = await client(false).request<{ accountId: string }>(
      '/crypto/desktop-backup/redeem',
      'POST',
      { proof: sealed.proof, hostId, deviceId, payloadHash, totpHash: '' },
    );
    expect(redeemedBackup.accountId).toBe(user.id);

    const resetScope = { hostId, deviceId, backendId: 'codex-local', requestId: randomUUID() };
    const { proof } = await recovery.confirmUsageReset(user, { sessionConfirm: true }, resetScope);
    const redeemRes = await server.app.inject({
      method: 'POST',
      url: '/api/im/crypto/usage-reset/redeem',
      headers: { host: 'frontend.example.test', origin },
      payload: { ...resetScope, proof },
    });
    expect(redeemRes.statusCode).toBe(204);

    const enrollOpts = await recovery.request<{ id: string; options: { challenge: string } }>(
      '/crypto/trusted/enroll/options',
      'POST',
      { name: 'Current Browser' },
    );
    expect(enrollOpts.options.challenge).toBeTruthy();

    await recovery.rotateRecovery({ sessionConfirm: true });
    expect(recovery.revision).toBe(2);
  } finally {
    await server.app.close();
    await rm(root, { recursive: true, force: true });
  }
});
