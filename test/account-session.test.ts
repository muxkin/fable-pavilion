import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountClient } from '../src/client/account.js';
import { createSecrets } from '../src/shared/account-crypto.js';
import type { ChatUser } from '../src/shared/messaging.js';
const fixture = vi.hoisted(() => {
  const records = new Map<string, any>(),
    keys = new Map<string, CryptoKey>(),
    hosts = new Map<string, any[]>();
  const faults = { accountKey: false, pending: false, localHosts: false, cloudWrite: false };
  const cache = {
    scope: '',
    onHostChange: undefined as ((id: string, host?: any) => Promise<void>) | undefined,
    hosts: async (scope?: string) => {
      if (faults.localHosts) throw new DOMException('Storage denied', 'SecurityError');
      return hosts.get(scope ?? cache.scope) ?? [];
    },
    replaceHosts: async (value: any[], scope?: string) => {
      hosts.set(scope ?? cache.scope, value);
    },
    identity: async () => ({ peerId: 'test-phone', privateKey: new Uint8Array([1, 2]) }),
    restoreCloudHosts: vi.fn(async (value: any[], scope: string, persist: boolean, claimed: any[] = []) => {
      if (!persist || faults.cloudWrite) return false;
      hosts.set(scope, value);
      if (claimed.length)
        hosts.set(
          '',
          (hosts.get('') ?? []).filter((host) => !claimed.includes(host)),
        );
      return true;
    }),
  };
  const store = (name: string) => {
    const map = name === 'device-keys' ? keys : records;
    return {
      get: async (key: string) => structuredClone(map.get(key)),
      put: async (value: any, key: string) => {
        if (name === 'device-keys' && faults.accountKey)
          throw new DOMException('Could not persist device key', 'DataCloneError');
        map.set(key, structuredClone(value));
      },
      delete: async (key: string) => {
        map.delete(key);
      },
    };
  };
  const database = {
    get: async (name: string, key: string) => store(name).get(key),
    put: async (name: string, value: any, key: string) => store(name).put(value, key),
    getAllKeys: async () => {
      if (faults.pending) throw new DOMException('Cannot read pairing queue', 'SecurityError');
      return [...records.keys()];
    },
    transaction: (name: string | string[]) => ({
      store: typeof name === 'string' ? store(name) : undefined,
      objectStore: store,
      done: Promise.resolve(),
    }),
  };
  const session = {
    cache,
    host: undefined,
    resetAccount: (scope: string) => {
      cache.scope = scope;
    },
    init: async () => {},
    select: async () => {},
  };
  return { records, keys, hosts, database, session, faults };
});
vi.mock('idb', () => ({ openDB: async () => fixture.database }));
vi.mock('../src/web/device-session', () => ({ deviceSession: fixture.session }));
import { activateAccount, syncAccountHosts, accountSyncError } from '../src/web/account-session.js';
const user = (id: string): ChatUser => ({
  id,
  username: `user${id}`,
  address: `${id}@test`,
  displayName: 'Test',
  kind: 'human',
  encrypted: true,
  createdAt: 0,
});
const host = {
  hostId: 'test-host',
  name: 'My Codex',
  deviceId: 'device',
  ticket: 'private-ticket-marker',
  phoneId: 'test-phone',
  identity: { peerId: 'test-phone', privateKey: new Uint8Array([1, 2]) },
};
beforeEach(() => {
  vi.stubGlobal('location', { origin: 'https://account-session.test' });
  fixture.records.clear();
  fixture.keys.clear();
  fixture.hosts.clear();
  for (const key of Object.keys(fixture.faults) as (keyof typeof fixture.faults)[])
    fixture.faults[key] = false;
  fixture.session.cache.restoreCloudHosts.mockClear();
});
afterEach(() => vi.unstubAllGlobals());
function server() {
  let uid = '10000000',
    offline = false;
  const rows = new Map<string, Map<string, any>>();
  const account = new AccountClient(async <T>(path: string, _method?: string, body?: any): Promise<T> => {
    if (offline) throw Error('Offline');
    const items = rows.get(uid) ?? new Map<string, any>();
    rows.set(uid, items);
    if (path.startsWith('/crypto/items?')) return { items: [...items.values()] } as T;
    if (body.accountId !== uid) throw Error('Wrong account');
    const id = path.split('/').at(-1)!;
    items.set(id, { id, revision: body.revision + 1, ciphertext: body.ciphertext });
    return { revision: body.revision + 1 } as T;
  });
  return {
    account,
    rows,
    setUser: (id: string) => {
      uid = id;
    },
    offline: (value: boolean) => {
      offline = value;
    },
  };
}
it('retains encrypted pending pairings when initial sync is offline, then restores them on reconnect', async () => {
  const cloud = server(),
    secrets = await createSecrets(),
    owner = user('10000000');
  await activateAccount(cloud.account, null);
  cloud.account.activate(owner, secrets);
  cloud.offline(true);
  await activateAccount(cloud.account, owner);
  expect(fixture.session.cache.onHostChange).toBeDefined();
  await fixture.session.cache.onHostChange!('test-host', host);
  expect(accountSyncError).toContain('联网');
  const pending = [...fixture.records.entries()].filter(([key]) => key.startsWith('pending:'));
  expect(pending).toHaveLength(1);
  expect(JSON.stringify(pending)).not.toContain(host.ticket);
  cloud.offline(false);
  await syncAccountHosts(cloud.account);
  expect(await cloud.account.readItem('host:test-host')).toMatchObject({
    kind: 'host',
    host: { ticket: host.ticket },
  });
  expect([...fixture.records.keys()].filter((key) => key.startsWith('pending:'))).toHaveLength(0);
});
it('a pairing finishing after account switch stays encrypted for its original owner', async () => {
  const cloud = server(),
    a = user('10000000'),
    b = user('10000001'),
    aKeys = await createSecrets(),
    bKeys = await createSecrets();
  await activateAccount(cloud.account, null);
  cloud.account.activate(a, aKeys);
  await activateAccount(cloud.account, a);
  const finishing = fixture.session.cache.onHostChange!;
  cloud.setUser(b.id);
  cloud.account.activate(b, bKeys);
  await activateAccount(cloud.account, b);
  await finishing(host.hostId, host);
  expect(cloud.rows.get(b.id)?.size ?? 0).toBe(0);
  cloud.setUser(a.id);
  cloud.account.activate(a, aKeys);
  await activateAccount(cloud.account, a);
  expect(await cloud.account.readItem('host:test-host')).toMatchObject({ host: { ticket: host.ticket } });
});

it('migrates an existing saved session to a non-exportable device key and restores it after reload', async () => {
  const cloud = server();
  const owner = user('10000000');
  await activateAccount(cloud.account, null);
  const secrets = await createSecrets();
  fixture.records.set(owner.id, { secrets, revision: 3 });
  await activateAccount(cloud.account, owner);
  expect(cloud.account.secrets?.root).toBe(secrets.root);
  const saved = fixture.records.get(owner.id);
  expect(saved.secrets).toBeUndefined();
  expect(saved.sealed.iv.byteLength).toBe(12);
  expect(fixture.keys.get(owner.id)?.extractable).toBe(false);
  cloud.account.lock();
  await activateAccount(cloud.account, owner);
  expect(cloud.account.secrets?.root).toBe(secrets.root);
  expect(cloud.account.revision).toBe(3);
  await activateAccount(cloud.account, null);
  expect(fixture.records.has(owner.id)).toBe(false);
  expect(fixture.keys.has(owner.id)).toBe(false);
});

it('pulls account pairings when browser storage rejects the unlocked key and pairing reads', async () => {
  const cloud = server();
  const owner = user('10000000');
  await activateAccount(cloud.account, null);
  cloud.account.activate(owner, await createSecrets());
  await cloud.account.writeItem(`host:${host.hostId}`, {
    kind: 'host',
    host: { ...host, identity: { ...host.identity, privateKey: [...host.identity.privateKey] } },
  });
  fixture.faults.accountKey = fixture.faults.pending = fixture.faults.localHosts = true;
  await activateAccount(cloud.account, owner);
  expect(fixture.session.cache.restoreCloudHosts).toHaveBeenCalledWith([host], owner.id, false, undefined);
  expect(cloud.account.secrets).toBeTruthy();
});

it('retains anonymous pairings when their cloud copy cannot be mirrored locally', async () => {
  const cloud = server();
  const owner = user('10000000');
  await activateAccount(cloud.account, null);
  cloud.account.activate(owner, await createSecrets());
  fixture.hosts.set('', [host]);
  fixture.faults.cloudWrite = true;
  await activateAccount(cloud.account, owner);
  expect(await cloud.account.readItem(`host:${host.hostId}`)).toMatchObject({
    host: { ticket: host.ticket },
  });
  expect(fixture.hosts.get('')).toEqual([host]);
  expect(fixture.hosts.get(owner.id)).toBeUndefined();
});
