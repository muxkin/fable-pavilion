import { openDB, type IDBPDatabase } from 'idb';
import type { AccountClient } from '../client/account';
import {
  openPrivate,
  sealPrivate,
  privateId,
  type Ciphertext,
  type AccountSecrets,
  type AccountVault,
} from '../shared/account-crypto';
import type { ChatUser } from '../shared/messaging';
import type { DeviceSession } from './device-session';
import type { PairedHost } from './sync-store';

let opening: Promise<IDBPDatabase> | undefined;
function accountDatabase() {
  return (opening ??= Promise.resolve()
    .then(() =>
      openDB('pocket-account-v1', 2, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('unlocked')) db.createObjectStore('unlocked');
          if (!db.objectStoreNames.contains('device-keys')) db.createObjectStore('device-keys');
        },
      }),
    )
    .catch((error) => {
      opening = undefined;
      throw error;
    }));
}
type SavedAccount = {
  sealed: { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };
  vault?: AccountVault;
  revision: number;
};
type LegacyAccount = { secrets: AccountSecrets; vault?: AccountVault; revision: number };
const encoding = new TextEncoder();
const keyContext = (userId: string, revision: number) =>
  encoding.encode(JSON.stringify(['pocket-device-session-v1', location.origin, userId, revision]));

async function deviceKey(userId: string) {
  const database = await accountDatabase();
  const current = (await database.get('device-keys', userId)) as CryptoKey | undefined;
  if (current) return current;
  const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const transaction = database.transaction('device-keys', 'readwrite');
  void transaction.done.catch(() => {});
  const existing = (await transaction.store.get(userId)) as CryptoKey | undefined;
  if (!existing) await transaction.store.put(generated, userId);
  await transaction.done;
  return existing ?? generated;
}

async function sealLocal(
  userId: string,
  secrets: AccountSecrets,
  vault: AccountVault | undefined,
  revision: number,
): Promise<SavedAccount> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: keyContext(userId, revision) },
    await deviceKey(userId),
    encoding.encode(JSON.stringify(secrets)),
  );
  return { sealed: { iv, data }, vault, revision };
}

async function restoreLocal(userId: string) {
  const database = await accountDatabase();
  const saved = (await database.get('unlocked', userId)) as LegacyAccount | SavedAccount | undefined;
  if (!saved) return;
  if ('secrets' in saved) {
    try {
      const protectedValue = await sealLocal(userId, saved.secrets, saved.vault, saved.revision);
      const transaction = database.transaction('unlocked', 'readwrite');
      void transaction.done.catch(() => {});
      const current = (await transaction.store.get(userId)) as LegacyAccount | SavedAccount | undefined;
      if (current && 'secrets' in current && JSON.stringify(current) === JSON.stringify(saved))
        await transaction.store.put(protectedValue, userId);
      await transaction.done;
    } catch {
      // Keep the existing unlock usable and retry sealing when the browser allows it.
    }
    return saved;
  }
  const key = (await database.get('device-keys', userId)) as CryptoKey | undefined;
  if (!key) return;
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: saved.sealed.iv, additionalData: keyContext(userId, saved.revision) },
    key,
    saved.sealed.data,
  );
  return {
    secrets: JSON.parse(new TextDecoder().decode(plaintext)) as AccountSecrets,
    vault: saved.vault,
    revision: saved.revision,
  };
}

let current = '',
  generation = 0;
let desktopSession: DeviceSession | undefined;
let syncing: { epoch: number; promise: Promise<boolean | undefined> } | undefined;
let changed: (() => void) | undefined;
export let accountSyncError = '';
async function flushPending(account: AccountClient, epoch = generation) {
  const user = account.user,
    secrets = account.secrets;
  if (!user || !secrets) return false;
  const active = () => epoch === generation && account.user === user && account.secrets === secrets;
  const database = await accountDatabase().catch(() => undefined);
  const keys = await database?.getAllKeys('unlocked').catch(() => undefined);
  if (!database || !keys) return false;
  const prefix = `pending:${user.id}:`;
  for (const key of keys) {
    if (!active()) return false;
    if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
    const pending = await database
      .get('unlocked', key)
      .then((value) => value as { id: string; ciphertext: Ciphertext | null } | undefined)
      .catch(() => null);
    if (pending === null) return false;
    if (!pending || !active()) continue;
    const currentItems = await account.refreshItems();
    if (!active()) return false;
    await account.writeCiphertext(
      pending.id,
      pending.ciphertext,
      currentItems.find((i) => i.id === pending.id)?.revision ?? 0,
    );
    if (!active()) return false;
    // Do not clear a newer change queued while this upload was in flight.
    try {
      const tx = database.transaction('unlocked', 'readwrite');
      void tx.done.catch(() => {});
      if (JSON.stringify(await tx.store.get(key)) === JSON.stringify(pending)) await tx.store.delete(key);
      await tx.done;
    } catch {
      return false;
    }
  }
  if (active()) accountSyncError = '';
  return active();
}
export function onAccountSessionChange(fn: () => void) {
  changed = fn;
  return () => {
    if (changed === fn) changed = undefined;
  };
}
export async function rememberAccount(account: AccountClient) {
  const user = account.user,
    secrets = account.secrets,
    vault = account.vault,
    revision = account.revision;
  if (!user || !secrets) return;
  const entry = await sealLocal(user.id, secrets, vault, revision);
  if (account.user !== user || account.secrets !== secrets || account.revision !== revision) return;
  const transaction = (await accountDatabase()).transaction(['unlocked', 'device-keys'], 'readwrite');
  void transaction.done.catch(() => {});
  const saved = (await transaction.objectStore('unlocked').get(user.id)) as
    LegacyAccount | SavedAccount | undefined;
  if (
    account.user === user &&
    account.secrets === secrets &&
    account.revision === revision &&
    (!saved || saved.revision <= revision) &&
    (await transaction.objectStore('device-keys').get(user.id))
  )
    await transaction.objectStore('unlocked').put(entry, user.id);
  await transaction.done;
}
export async function activateAccount(account: AccountClient, user: ChatUser | null) {
  const epoch = ++generation;
  if (desktopSession) desktopSession.cache.onHostChange = undefined;
  accountSyncError = '';
  if (!user) {
    const previous = current;
    current = '';
    account.lock();
    desktopSession?.resetAccount('');
    if (previous) {
      const transaction = (await accountDatabase()).transaction(['unlocked', 'device-keys'], 'readwrite');
      void transaction.done.catch(() => {});
      await transaction.objectStore('unlocked').delete(previous);
      await transaction.objectStore('device-keys').delete(previous);
      await transaction.done;
    }
    return;
  }
  const deviceSession = desktopSession ?? (await import('./device-session')).deviceSession;
  if (epoch !== generation) return;
  desktopSession = deviceSession;
  if (account.user?.id !== user.id || !account.secrets) {
    const saved = await restoreLocal(user.id).catch(() => undefined);
    if (epoch !== generation) return;
    if (saved) account.activate(user, saved.secrets, saved.vault, saved.revision);
    else {
      account.lock();
      account.user = user;
    }
  }
  const switching = current !== user.id;
  current = user.id;
  if (switching) deviceSession.resetAccount(user.id);
  if (!account.secrets) return;
  const owner = account.user!,
    secrets = account.secrets;
  deviceSession.cache.onHostChange = async (id, host) => {
    const itemId = await privateId(secrets, `host:${id}`);
    const value = host
      ? {
          kind: 'host',
          host: {
            ...host,
            identity: host.identity
              ? { ...host.identity, privateKey: Array.from(host.identity.privateKey) }
              : undefined,
          },
        }
      : null;
    const ciphertext = value ? await sealPrivate(secrets, `vault:${owner.id}:${itemId}`, value) : null;
    await (
      await accountDatabase()
    ).put('unlocked', { id: itemId, ciphertext }, `pending:${owner.id}:${itemId}`);
    if (epoch !== generation) return;
    try {
      if (!(await flushPending(account, epoch)) && epoch === generation)
        accountSyncError = '电脑已保存在本机，浏览器暂时无法读取待同步的配对记录';
    } catch {
      if (epoch === generation) accountSyncError = '电脑已保存在本机，账号同步将在联网后重试';
    }
    changed?.();
  };
  // Retain the session and restore devices with the key already opened by this login.
  await rememberAccount(account).catch(() => {});
  if (epoch !== generation) return;
  try {
    const unclaimed = await deviceSession.cache.hosts('').catch(() => undefined);
    const localIdentity = unclaimed?.some((host) => !host.identity)
      ? await deviceSession.cache.identity('').catch(() => undefined)
      : undefined;
    if (epoch !== generation) return;
    const canClaim = unclaimed?.every((host) => host.identity || localIdentity);
    if (canClaim && unclaimed?.length) {
      await account.refreshItems();
      for (const host of unclaimed) {
        if (epoch !== generation) return;
        const identity = host.identity ?? localIdentity!;
        if (!(await account.readItem(`host:${host.hostId}`)))
          await account.writeItem(`host:${host.hostId}`, {
            kind: 'host',
            host: { ...host, identity: { ...identity, privateKey: Array.from(identity.privateKey) } },
          });
      }
      if (epoch !== generation) return;
    }
    await syncAccountHosts(account, canClaim ? { claimed: unclaimed } : { preserveLocal: true });
  } catch (error) {
    if ((error as { status?: number }).status === 401) throw error;
    if (epoch === generation) accountSyncError = '账号同步暂不可用，联网后会重试';
  }
  if (epoch !== generation) return;
  await deviceSession.init().catch(() => {});
}
export async function syncAccountHosts(
  account: AccountClient,
  { preserveLocal = false, claimed }: { preserveLocal?: boolean; claimed?: PairedHost[] } = {},
) {
  const deviceSession = desktopSession;
  if (!deviceSession || !account.secrets || account.user?.id !== current) return;
  if (syncing?.epoch === generation) return syncing.promise;
  const epoch = generation,
    user = account.user.id,
    secrets = account.secrets;
  const promise = (async () => {
    const pendingFlushed = await flushPending(account, epoch);
    if (epoch !== generation) return;
    const items = await account.refreshItems();
    const hosts: PairedHost[] = [];
    for (const item of items) {
      if (!item.ciphertext) continue;
      const value = await openPrivate<any>(secrets, `vault:${user}:${item.id}`, item.ciphertext);
      if (value?.kind === 'host' && value.host?.hostId && value.host.identity?.privateKey) {
        hosts.push({
          ...value.host,
          identity: { ...value.host.identity, privateKey: new Uint8Array(value.host.identity.privateKey) },
        });
      }
    }
    if (epoch !== generation) return;
    const active = deviceSession.host?.hostId;
    const stored = await deviceSession.cache.restoreCloudHosts(
      hosts,
      user,
      pendingFlushed && !preserveLocal,
      claimed?.filter(({ hostId }) => hosts.some((host) => host.hostId === hostId)),
    );
    if (epoch !== generation) return;
    if (stored && active && !hosts.some((h) => h.hostId === active)) deviceSession.resetAccount(user);
    const updated = hosts.find((h) => h.hostId === active);
    if (
      updated &&
      deviceSession.host &&
      (updated.phoneId !== deviceSession.host.phoneId || updated.ticket !== deviceSession.host.ticket)
    )
      await deviceSession.select(updated, stored);
    if (!deviceSession.host && hosts.length) await deviceSession.init().catch(() => {});
    changed?.();
    return stored;
  })().finally(() => {
    if (syncing?.epoch === epoch) syncing = undefined;
  });
  syncing = { epoch, promise };
  return promise;
}
