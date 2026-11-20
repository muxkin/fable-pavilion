import { openDB, type IDBPDatabase } from 'idb';
import type { Identity } from '../shared/secure-channel';
import { createIdentity } from '../shared/secure-channel';

export interface PairedHost {
  hostId: string;
  name: string;
  deviceId: string;
  ticket: string;
  phoneId: string;
  identity?: Identity;
}
interface Entry {
  key: string;
  value: any;
  size: number;
  touched: number;
  kind: 'text' | 'attachment';
  opfs?: boolean;
}
/** Persistent content has no application budget or automatic eviction. */
export class SyncStore {
  private accountScope = '';
  private scopeVersion = 0;
  private cloudFallback?: { scope: string; hosts: PairedHost[] };
  get scope() {
    return this.accountScope;
  }
  set scope(value: string) {
    if (value !== this.accountScope) {
      this.scopeVersion++;
      this.cloudFallback = undefined;
    }
    this.accountScope = value;
  }
  onHostChange?: (hostId: string, host?: PairedHost) => Promise<void>;
  private privateKey(key: string, scope = this.scope) {
    return scope ? `account:${scope}:${key}` : key;
  }
  private opening?: Promise<IDBPDatabase>;
  private database() {
    return (this.opening ??= Promise.resolve()
      .then(() =>
        openDB('pocket-device-v2', 1, {
          upgrade(db) {
            db.createObjectStore('private');
            db.createObjectStore('content', { keyPath: 'key' });
          },
        }),
      )
      .catch((error) => {
        this.opening = undefined;
        throw error;
      }));
  }
  private memory = new Map<string, Entry>();
  private pending = new Map<string, Entry>();
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<unknown> = Promise.resolve();
  private generation = 0;
  writeFailed = false;
  metrics = { hitBytes: 0 };
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work);
    this.writes = result.catch(() => {});
    return result;
  }
  private remember(entry: Entry) {
    this.memory.delete(entry.key);
    this.memory.set(entry.key, entry);
    if (this.memory.size > 32) this.memory.delete(this.memory.keys().next().value!);
  }
  async identity(scope = this.scope): Promise<Identity> {
    const key = this.privateKey('identity', scope);
    const db = await this.database();
    const old = await db.get('private', key);
    if (old) return old;
    const identity = await createIdentity();
    const tx = db.transaction('private', 'readwrite');
    const raced = await tx.store.get(key);
    if (!raced) await tx.store.put(identity, key);
    await tx.done;
    return raced ?? identity;
  }
  private async persistedHosts(scope: string): Promise<PairedHost[]> {
    return (await (await this.database()).get('private', this.privateKey('hosts', scope))) ?? [];
  }
  private fallbackHosts(scope: string) {
    return this.cloudFallback?.scope === scope ? this.cloudFallback.hosts : [];
  }
  async hosts(scope = this.scope): Promise<PairedHost[]> {
    try {
      const local = await this.persistedHosts(scope);
      const cloud = this.fallbackHosts(scope);
      if (!cloud.length) return local;
      const ids = new Set(cloud.map(({ hostId }) => hostId));
      return [...cloud, ...local.filter(({ hostId }) => !ids.has(hostId))];
    } catch (error) {
      const cloud = this.fallbackHosts(scope);
      if (cloud.length) return cloud;
      throw error;
    }
  }
  async saveHost(host: PairedHost, sync = true) {
    const scope = this.scope,
      changed = this.onHostChange;
    const hosts = await this.persistedHosts(scope);
    host.identity ??= await this.identity(scope);
    await (
      await this.database()
    ).put(
      'private',
      [...hosts.filter((h) => h.hostId !== host.hostId), host],
      this.privateKey('hosts', scope),
    );
    await (await this.database()).put('private', host.hostId, this.privateKey('active', scope));
    if (sync) await changed?.(host.hostId, host);
  }
  async active() {
    const scope = this.scope;
    const hosts = await this.hosts(scope);
    if (hosts.length < 2) return hosts[0];
    try {
      const id = await (await this.database()).get('private', this.privateKey('active', scope));
      return hosts.find((h) => h.hostId === id) ?? hosts[0];
    } catch {
      return hosts[0];
    }
  }
  async renameHost(hostId: string, name: string) {
    const scope = this.scope;
    const changed = this.onHostChange;
    const key = this.privateKey('hosts', scope);
    const tx = (await this.database()).transaction('private', 'readwrite');
    const hosts: PairedHost[] = (await tx.store.get(key)) ?? [];
    const host = hosts.find((entry) => entry.hostId === hostId);
    if (host) {
      host.name = name;
      await tx.store.put(hosts, key);
    }
    await tx.done;
    if (host && scope === this.scope) await changed?.(hostId, host);
    return host;
  }
  async forget(hostId: string, sync = true) {
    const scope = this.scope;
    if (sync) await this.onHostChange?.(hostId);
    await (
      await this.database()
    ).put(
      'private',
      (await this.persistedHosts(scope)).filter((h) => h.hostId !== hostId),
      this.privateKey('hosts', scope),
    );
    await this.clear(`:${hostId}:`);
  }
  async replaceHosts(hosts: PairedHost[], scope = this.scope) {
    await (await this.database()).put('private', hosts, this.privateKey('hosts', scope));
  }
  async restoreCloudHosts(hosts: PairedHost[], scope: string, persist: boolean, claimed: PairedHost[] = []) {
    if (!scope || scope !== this.scope) return false;
    const version = this.scopeVersion;
    const current = () => version === this.scopeVersion;
    if (persist) {
      try {
        const db = await this.database();
        if (!current()) return false;
        const tx = db.transaction('private', 'readwrite');
        void tx.done.catch(() => {});
        const key = this.privateKey('hosts', scope);
        // Read before overwriting. An unreadable record may still exist.
        await tx.store.get(key);
        const anonymous: PairedHost[] | undefined = claimed.length ? await tx.store.get('hosts') : undefined;
        if (!current()) return false;
        await tx.store.put(hosts, key);
        if (anonymous) {
          const claimedTickets = new Map(claimed.map(({ hostId, ticket }) => [hostId, ticket]));
          await tx.store.put(
            anonymous.filter(({ hostId, ticket }) => claimedTickets.get(hostId) !== ticket),
            'hosts',
          );
        }
        await tx.done;
        if (current()) this.cloudFallback = undefined;
        return true;
      } catch {
        if (!current()) return false;
      }
    }
    this.cloudFallback = { scope, hosts };
    return false;
  }
  async get<T>(key: string): Promise<T | undefined> {
    const generation = this.generation;
    const entry: Entry | undefined =
      this.pending.get(key) ??
      this.memory.get(key) ??
      (await this.database()
        .then((db) => db.get('content', key))
        .catch(() => undefined));
    if (!entry || generation !== this.generation) return;
    if (entry.opfs) {
      try {
        const root = await navigator.storage.getDirectory();
        const bytes = new Uint8Array(await (await (await root.getFileHandle(key)).getFile()).arrayBuffer());
        if (generation !== this.generation) return;
        this.metrics.hitBytes += bytes.byteLength;
        return bytes as T;
      } catch {
        if (generation === this.generation) await this.remove(entry);
        return;
      }
    }
    this.metrics.hitBytes += entry.size;
    this.remember(entry);
    return entry.value;
  }
  peek<T>(key: string): T | undefined {
    return (this.pending.get(key) ?? this.memory.get(key))?.value as T | undefined;
  }
  put(key: string, value: any, kind: Entry['kind'] = 'text') {
    const size =
      value instanceof Uint8Array ? value.byteLength : new TextEncoder().encode(JSON.stringify(value)).length;
    this.pending.set(key, { key, value, size, touched: Date.now(), kind });
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 500);
  }
  async block(key: string, bytes: Uint8Array) {
    return this.serialize(async () => {
      try {
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle(key, { create: true });
        const writable = await file.createWritable();
        await writable.write(bytes as Uint8Array<ArrayBuffer>);
        await writable.close();
        await (
          await this.database()
        ).put('content', {
          key,
          size: bytes.length,
          touched: Date.now(),
          kind: 'attachment',
          opfs: true,
        });
        this.writeFailed = false;
      } catch {
        // A failed persistent write must not stop the live download or remove older content.
        const entry: Entry = {
          key,
          value: bytes,
          size: bytes.length,
          touched: Date.now(),
          kind: 'attachment',
        };
        this.remember(entry);
        try {
          await (await this.database()).put('content', entry);
          this.writeFailed = false;
        } catch {
          this.writeFailed = true;
        }
      }
    });
  }
  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) this.remember(entry);
    return this.serialize(async () => {
      if (!entries.length) return;
      try {
        const tx = (await this.database()).transaction('content', 'readwrite');
        const done = tx.done.catch(() => {});
        try {
          for (const entry of entries) await tx.store.put(entry);
          await tx.done;
          this.writeFailed = false;
        } finally {
          await done;
        }
      } catch {
        this.writeFailed = true;
      }
    });
  }
  async usage() {
    await this.flush();
    let bytes = 0;
    let cursor = await (await this.database()).transaction('content').store.openCursor();
    while (cursor) {
      bytes += cursor.value.size;
      cursor = await cursor.continue();
    }
    return { bytes };
  }
  private async remove(entry: Entry) {
    this.memory.delete(entry.key);
    this.pending.delete(entry.key);
    await (await this.database()).delete('content', entry.key);
    if (entry.opfs)
      await navigator.storage
        .getDirectory()
        .then((d) => d.removeEntry(entry.key))
        .catch(() => {});
  }
  async clear(fragment = '') {
    // Retain upload resume journals while clearing ordinary cache. Unpair removes them too.
    const matches = (key: string) => key.includes(fragment) && (!!fragment || !key.includes(':upload:'));
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const key of this.pending.keys()) if (matches(key)) this.pending.delete(key);
    for (const key of this.memory.keys()) if (matches(key)) this.memory.delete(key);
    return this.serialize(async () => {
      const db = await this.database();
      const tx = db.transaction('content', 'readwrite');
      const files: string[] = [];
      let cursor = await tx.store.openCursor();
      while (cursor) {
        if (matches(cursor.key as string)) {
          if (cursor.value.opfs) files.push(cursor.key as string);
          await cursor.delete();
        }
        cursor = await cursor.continue();
      }
      await tx.done;
      try {
        const root = await navigator.storage.getDirectory();
        for (const name of files) await root.removeEntry(name).catch(() => {});
      } catch {
        /* OPFS is optional. IndexedDB content is already cleared. */
      }
      this.writeFailed = false;
    });
  }
}
