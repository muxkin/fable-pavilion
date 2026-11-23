import { afterEach, beforeAll, expect, it } from 'vitest';
import { AccountClient, TrustedLoginRequired } from '../src/client/account.js';
import { MessagingError } from '../src/client/messaging.js';
import { protectAccount } from '../src/shared/account-crypto.js';
import type { ChatUser } from '../src/shared/messaging.js';
import { buildRelay } from '../src/server/relay.js';
import { TEST_TOTP_KEY } from './secure-login-fixture.js';

const password = 'synthetic-local-unlock-password';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function serverFixture() {
  const relay = await buildRelay({
    origin: 'https://unlock.test',
    webRoot: '/missing',
    assetOrigin: null,
    uploadOrigins: [],
    enrollmentSecret: 'synthetic-session-unlock-enrollment-key',
    messaging: { totpKey: TEST_TOTP_KEY },
  });
  cleanups.push(() => relay.app.close());
  const device = () => {
    let cookie = '';
    const calls: { path: string; method: string; setCookies: string[] }[] = [];
    const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      const response = await relay.app.inject({
        method: method as 'GET',
        url: `/api/im${path}`,
        headers: { host: 'unlock.test', origin: 'https://unlock.test', cookie },
        payload: body as object,
      });
      const setCookies = response.cookies.map(({ name, value }) => `${name}=${value}`);
      calls.push({ path, method, setCookies });
      if (setCookies.length) cookie = setCookies.join('; ');
      if (response.statusCode >= 400) throw new MessagingError(response.statusCode, response.json().error);
      return response.json() as T;
    };
    return { account: new AccountClient(request), request, calls, cookie: () => cookie };
  };
  return { device };
}

it('restores local keys using the existing complete session and its token', async () => {
  const { device } = await serverFixture();
  const owner = device();
  await owner.account.register('unlock-owner', 'Owner', password);
  const user = owner.account.user!,
    root = owner.account.secrets!.root,
    cookie = owner.cookie();
  owner.account.lock();
  owner.account.user = user;
  const start = owner.calls.length;
  const result = await owner.account.unlockSession(user, password);
  expect(result.user.id).toBe(user.id);
  expect(owner.account.secrets!.root).toBe(root);
  expect(owner.cookie()).toBe(cookie);
  // GET /me refreshes the browser cookie lifetime using the same session token.
  expect(owner.calls.slice(start)).toEqual([
    { path: '/me', method: 'GET', setCookies: [cookie] },
    { path: '/crypto/account', method: 'GET', setCookies: [] },
    { path: '/crypto/account', method: 'GET', setCookies: [] },
    { path: '/me', method: 'GET', setCookies: [cookie] },
  ]);
  expect((await owner.request<{ code: string }>('/crypto/totp/display', 'POST', {})).code).toMatch(/^\d{6}$/);
});

it('keeps the complete session valid on a wrong local password and permits a successful retry', async () => {
  const { device } = await serverFixture();
  const owner = device();
  await owner.account.register('wrong-local-password', 'Owner', password);
  const user = owner.account.user!,
    cookie = owner.cookie();
  owner.account.lock();
  owner.account.user = user;
  const start = owner.calls.length;
  await expect(owner.account.unlockSession(user, 'incorrect-local-password')).rejects.toThrow('解锁失败');
  expect(owner.account.user).toBe(user);
  expect(owner.account.secrets).toBeUndefined();
  expect(owner.cookie()).toBe(cookie);
  expect(owner.calls.slice(start)).toEqual([
    { path: '/me', method: 'GET', setCookies: [cookie] },
    { path: '/crypto/account', method: 'GET', setCookies: [] },
  ]);
  expect((await owner.request<{ user: ChatUser }>('/me')).user.id).toBe(user.id);
  await expect(owner.account.unlockSession(user, password)).resolves.toMatchObject({ user: { id: user.id } });
});

it('refuses anonymous and password-pending clients even when they know the account password', async () => {
  const { device } = await serverFixture();
  const owner = device(),
    anonymous = device(),
    pending = device();
  await owner.account.register('pending-cannot-unlock', 'Owner', password);
  const user = owner.account.user!;
  await expect(pending.account.login(user.id, password, false, { trusted: true })).rejects.toBeInstanceOf(
    TrustedLoginRequired,
  );
  for (const client of [anonymous, pending]) {
    client.account.user = user;
    const start = client.calls.length;
    await expect(client.account.unlockSession(user, password)).rejects.toMatchObject({ status: 401 });
    expect(client.account.secrets).toBeUndefined();
    expect(client.cookie()).toBe('');
    expect(client.calls.slice(start)).toEqual([{ path: '/me', method: 'GET', setCookies: [] }]);
  }
});

let protectedA: Awaited<ReturnType<typeof protectAccount>>;
let protectedB: Awaited<ReturnType<typeof protectAccount>>;
beforeAll(async () => {
  [protectedA, protectedB] = await Promise.all([protectAccount(password), protectAccount(password)]);
});
const userA: ChatUser = {
  id: '10000001',
  address: '10000001@unlock.test',
  username: 'a-user',
  displayName: 'A',
  kind: 'human',
  encrypted: true,
  createdAt: 0,
};
const userB: ChatUser = { ...userA, id: '10000002', address: '10000002@unlock.test', username: 'b-user' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(['switch', 'logout', 'same-account-replaced'] as const)(
  'does not overwrite a newer local account state during %s',
  async (action) => {
    const entered = deferred<void>(),
      release = deferred<void>();
    const client = new AccountClient(async <T>(path: string): Promise<T> => {
      if (path === '/me') return { user: userA } as T;
      entered.resolve();
      await release.promise;
      return { vault: protectedA.vault, revision: 1 } as T;
    });
    client.user = userA;
    const unlocking = client.unlockSession(userA, password);
    await entered.promise;
    if (action === 'switch') client.activate(userB, protectedB.secrets, protectedB.vault, 4);
    else if (action === 'logout') client.lock();
    else {
      client.activate(userB, protectedB.secrets, protectedB.vault, 4);
      client.activate(userA, protectedA.secrets, protectedA.vault, 5);
    }
    const latest = {
      user: client.user,
      secrets: client.secrets,
      vault: client.vault,
      revision: client.revision,
    };
    release.resolve();
    await expect(unlocking).rejects.toThrow('账号已切换');
    expect(client.user).toBe(latest.user);
    expect(client.secrets).toBe(latest.secrets);
    expect(client.vault).toBe(latest.vault);
    expect(client.revision).toBe(latest.revision);
  },
);

it.each(['revision', 'vault', 'server-user', 'expired'] as const)(
  'does not activate stale decrypted keys after a server %s change',
  async (action) => {
    let identityReads = 0,
      vaultReads = 0;
    const calls: string[] = [];
    const client = new AccountClient(async <T>(path: string): Promise<T> => {
      calls.push(path);
      if (path === '/me') {
        identityReads++;
        const user =
          identityReads === 1
            ? userA
            : action === 'server-user'
              ? userB
              : action === 'expired'
                ? null
                : userA;
        return { user } as T;
      }
      vaultReads++;
      return {
        vault: vaultReads > 1 && action === 'vault' ? protectedB.vault : protectedA.vault,
        revision: vaultReads > 1 && action === 'revision' ? 2 : 1,
      } as T;
    });
    client.user = userA;
    await expect(client.unlockSession(userA, password)).rejects.toThrow();
    expect(client.user).toBe(userA);
    expect(client.secrets).toBeUndefined();
    expect(calls.every((path) => path === '/me' || path === '/crypto/account')).toBe(true);
  },
);

it('passes through an actual 401 without logging out or altering client state', async () => {
  const calls: string[] = [];
  const client = new AccountClient(async <T>(path: string): Promise<T> => {
    calls.push(path);
    throw new MessagingError(401, 'Session revoked');
  });
  client.user = userA;
  await expect(client.unlockSession(userA, password)).rejects.toMatchObject({ status: 401 });
  expect(calls).toEqual(['/me']);
  expect(client.user).toBe(userA);
  expect(client.secrets).toBeUndefined();
});
