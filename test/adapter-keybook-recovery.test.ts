import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountClient } from '../src/client/account.js';
import { createSecrets } from '../src/shared/account-crypto.js';
import type { ChatUser } from '../src/shared/messaging.js';

// Only the browser's storage adapter is substituted; encryption and account state are real.
vi.mock('../src/web/device-session', () => ({ deviceSession: {} }));
import {
  pendingAdapterRecovery,
  rememberRecoveryForAdapter,
  persistAdapterRecovery,
} from '../src/web/adapter-security-backup.js';

const values = new Map<string, string>();
const key = 'pavilion-keybook-recovery';
const recoveryCode = Buffer.alloc(32, 63).toString('base64');
const user = (id = '10000001'): ChatUser => ({
  id,
  address: `${id}@keybook.test`,
  username: `fixture_${id}`,
  displayName: 'Synthetic keybook owner',
  kind: 'human',
  encrypted: true,
  createdAt: 0,
});
beforeEach(() => {
  values.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function account() {
  const client = new AccountClient(async () => {
    throw Error('Keybook handoff must not call the server');
  });
  client.activate(user(), await createSecrets(), undefined, 7);
  return client;
}

it('keeps the saved recovery code encrypted across a page reload and returns it only to the same unlocked account', async () => {
  const owner = await account();
  await rememberRecoveryForAdapter(owner, recoveryCode);
  const encoded = values.get(key)!;
  expect(encoded.includes(recoveryCode)).toBe(false);
  expect(JSON.parse(encoded)).toMatchObject({
    accountId: owner.user!.id,
    revision: 7,
    ciphertext: { iv: expect.any(String), data: expect.any(String) },
  });
  expect(await pendingAdapterRecovery(owner)).toBe(recoveryCode);
  const restored = await account();
  restored.activate(owner.user!, owner.secrets!, undefined, owner.revision);
  expect(await pendingAdapterRecovery(restored)).toBe(recoveryCode);
  restored.lock();
  expect(await pendingAdapterRecovery(restored)).toBeUndefined();
});

it('removes expired handoffs and rejects altered expiry metadata', async () => {
  const owner = await account();
  await rememberRecoveryForAdapter(owner, recoveryCode);
  const pending = JSON.parse(values.get(key)!);
  values.set(key, JSON.stringify({ ...pending, expiresAt: pending.expiresAt + 60_000 }));
  expect(await pendingAdapterRecovery(owner)).toBeUndefined();
  values.set(key, JSON.stringify(pending));
  vi.spyOn(Date, 'now').mockReturnValue(pending.expiresAt);
  expect(await pendingAdapterRecovery(owner)).toBeUndefined();
  expect(values.has(key)).toBe(false);
});

it('rejects another UID, revision or root even when the outer metadata is rewritten', async () => {
  const owner = await account();
  await rememberRecoveryForAdapter(owner, recoveryCode);
  const original = values.get(key)!;
  const pending = JSON.parse(original);
  const other = await account();
  other.activate(user('10000002'), owner.secrets!, undefined, 7);
  expect(await pendingAdapterRecovery(other)).toBeUndefined();
  values.set(key, JSON.stringify({ ...pending, accountId: other.user!.id }));
  expect(await pendingAdapterRecovery(other)).toBeUndefined();
  other.activate(owner.user!, owner.secrets!, undefined, 8);
  values.set(key, JSON.stringify({ ...pending, revision: 8 }));
  expect(await pendingAdapterRecovery(other)).toBeUndefined();
  other.activate(owner.user!, await createSecrets(), undefined, 7);
  values.set(key, original);
  expect(await pendingAdapterRecovery(other)).toBeUndefined();
  expect(await pendingAdapterRecovery(owner)).toBe(recoveryCode);
});

it('rejects corrupted ciphertext and malformed storage instead of returning raw material', async () => {
  const owner = await account();
  await rememberRecoveryForAdapter(owner, recoveryCode);
  const pending = JSON.parse(values.get(key)!);
  const bytes = Buffer.from(pending.ciphertext.data, 'base64');
  bytes[0] ^= 1;
  values.set(
    key,
    JSON.stringify({ ...pending, ciphertext: { ...pending.ciphertext, data: bytes.toString('base64') } }),
  );
  expect(await pendingAdapterRecovery(owner)).toBeUndefined();
  for (const malformed of ['{}', 'null', 'not-json']) {
    values.set(key, malformed);
    expect(await pendingAdapterRecovery(owner)).toBeUndefined();
  }
});

it('abandons async encryption or decryption when the unlocked account changes', async () => {
  const owner = await account();
  const writing = rememberRecoveryForAdapter(owner, recoveryCode);
  owner.lock();
  await writing;
  expect(values.has(key)).toBe(false);
  const current = await account();
  await rememberRecoveryForAdapter(current, recoveryCode);
  const reading = pendingAdapterRecovery(current);
  current.lock();
  expect(await reading).toBeUndefined();
});

it('restores the original recovery code from the E2EE account vault after the local handoff expires or is removed', async () => {
  const items = new Map<string, { id: string; ciphertext: unknown; revision: number }>();
  const requests: unknown[] = [];
  const request: AccountClient['request'] = async <T>(path: string, method = 'GET', body?: unknown) => {
    if (path.startsWith('/crypto/items') && method === 'GET') return { items: [...items.values()] } as T;
    if (path.startsWith('/crypto/items/') && method === 'PUT') {
      requests.push(body);
      const { ciphertext } = body as { ciphertext: unknown };
      const id = path.split('/').at(-1)!;
      items.set(id, { id, ciphertext, revision: 1 });
      return { revision: 1 } as T;
    }
    throw Error('Unexpected synthetic vault operation');
  };
  const owner = new AccountClient(request);
  owner.activate(user(), await createSecrets(), undefined, 7);
  await persistAdapterRecovery(owner, recoveryCode);
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests).includes(recoveryCode)).toBe(false);
  values.clear();
  const restored = new AccountClient(request);
  restored.activate(owner.user!, owner.secrets!, undefined, 7);
  await restored.refreshItems();
  expect(await pendingAdapterRecovery(restored)).toBe(recoveryCode);
  restored.revision = 8;
  expect(await pendingAdapterRecovery(restored)).toBeUndefined();
  restored.activate(owner.user!, await createSecrets(), undefined, 7);
  await restored.refreshItems();
  expect(await pendingAdapterRecovery(restored)).toBeUndefined();
});

it('never lets a stale unlocked tab overwrite a newer recovery revision or a conflicting code at the same revision', async () => {
  const items = new Map<string, { id: string; ciphertext: unknown; revision: number }>();
  let writes = 0;
  const request: AccountClient['request'] = async <T>(path: string, method = 'GET', body?: unknown) => {
    if (path.startsWith('/crypto/items') && method === 'GET') return { items: [...items.values()] } as T;
    if (path.startsWith('/crypto/items/') && method === 'PUT') {
      writes++;
      const { ciphertext } = body as { ciphertext: unknown };
      const id = path.split('/').at(-1)!;
      const revision = (items.get(id)?.revision ?? 0) + 1;
      items.set(id, { id, ciphertext, revision });
      return { revision } as T;
    }
    throw Error('Unexpected synthetic vault operation');
  };
  const current = new AccountClient(request),
    stale = new AccountClient(request);
  const secrets = await createSecrets();
  current.activate(user(), secrets, undefined, 8);
  stale.activate(user(), secrets, undefined, 7);
  const latest = Buffer.alloc(32, 72).toString('base64');
  await persistAdapterRecovery(current, latest);
  await stale.refreshItems();
  await expect(persistAdapterRecovery(stale, recoveryCode)).rejects.toThrow('恢复码已变化');
  expect(writes).toBe(1);
  expect(JSON.parse(values.get(key)!).revision).toBe(8);
  expect(await pendingAdapterRecovery(current)).toBe(latest);
  stale.revision = 8;
  await expect(persistAdapterRecovery(stale, recoveryCode)).rejects.toThrow('恢复码已变化');
  expect(writes).toBe(1);
  values.clear();
  await current.refreshItems();
  expect(await pendingAdapterRecovery(current)).toBe(latest);
});
