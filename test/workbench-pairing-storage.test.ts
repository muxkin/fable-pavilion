import { beforeEach, expect, it, vi } from 'vitest';
import { SyncStore, type PairedHost } from '../src/web/sync-store.js';

const storage = vi.hoisted(() => {
  const records = new Map<string, unknown>();
  const faults = { open: false, write: false };
  const store = {
    get: async (key: string) => structuredClone(records.get(key)),
    put: async (value: unknown, key: string) => {
      if (faults.write) throw new DOMException('Storage is read-only', 'ReadOnlyError');
      records.set(key, structuredClone(value));
    },
  };
  return {
    records,
    faults,
    open() {
      if (faults.open) throw new DOMException('Storage denied', 'SecurityError');
      return Promise.resolve({
        get: async (_store: string, key: string) => store.get(key),
        transaction: () => ({ store, done: Promise.resolve() }),
      });
    },
  };
});
vi.mock('idb', () => ({ openDB: storage.open }));

const paired = (hostId: string): PairedHost => ({
  hostId,
  name: hostId,
  deviceId: `${hostId}-device`,
  ticket: `${hostId}-ticket`,
  phoneId: 'phone',
  identity: { peerId: 'phone', privateKey: new Uint8Array([1, 2]) },
});

beforeEach(() => {
  storage.records.clear();
  storage.faults.open = storage.faults.write = false;
});

it('opens verified cloud pairings in memory when IndexedDB rejects the request', async () => {
  const cache = new SyncStore(),
    hosts = [paired('Workstation'), paired('Other')];
  cache.scope = 'owner';
  storage.faults.open = true;
  await expect(cache.hosts()).rejects.toMatchObject({ name: 'SecurityError' });
  await expect(cache.restoreCloudHosts(hosts, 'owner', true)).resolves.toBe(false);
  await expect(cache.hosts()).resolves.toEqual(hosts);
  await expect(cache.active()).resolves.toEqual(hosts[0]);
  await expect(cache.get('nonessential-workbench-cache')).resolves.toBeUndefined();
  cache.scope = 'other-owner';
  await expect(cache.hosts()).rejects.toMatchObject({ name: 'SecurityError' });
  cache.scope = 'owner';
  await expect(cache.hosts()).rejects.toMatchObject({ name: 'SecurityError' });
});

it('combines cloud and readable local pairings while IndexedDB writes are blocked', async () => {
  const cache = new SyncStore(),
    local = paired('local'),
    cloud = paired('cloud');
  cache.scope = 'owner';
  storage.records.set('account:owner:hosts', [local]);
  storage.records.set('account:owner:active', local.hostId);
  storage.faults.write = true;
  await expect(cache.restoreCloudHosts([cloud], 'owner', true)).resolves.toBe(false);
  await expect(cache.hosts()).resolves.toEqual([cloud, local]);
  await expect(cache.active()).resolves.toEqual(local);
  expect(storage.records.get('account:owner:hosts')).toEqual([local]);
});

it('removes only the anonymous records included in the completed cloud migration', async () => {
  const cache = new SyncStore(),
    claimed = paired('claimed'),
    newlyPaired = paired('new');
  cache.scope = 'owner';
  storage.records.set('hosts', [claimed, newlyPaired]);
  await expect(cache.restoreCloudHosts([claimed], 'owner', true, [claimed])).resolves.toBe(true);
  await expect(cache.hosts()).resolves.toEqual([claimed]);
  await expect(cache.hosts('')).resolves.toEqual([newlyPaired]);
});
