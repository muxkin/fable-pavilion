import { openDB, type DBSchema } from 'idb';
import type { AttachmentResource } from '../AttachmentAccess';
import type { EncryptedDownloadMetadata, EncryptedFileCache } from '../../client/encrypted-messaging';
interface MediaDB extends DBSchema {
  blobs: {
    key: string;
    value: { key: string; account: string; blob: Blob; used: number; encrypted?: string; cacheKey?: string };
    indexes: { account: string; used: number };
  };
}
const database = Promise.resolve()
  .then(() =>
    typeof indexedDB === 'undefined'
      ? undefined
      : openDB<MediaDB>('pocket-im-media', 1, {
          upgrade(db) {
            const store = db.createObjectStore('blobs', { keyPath: 'key' });
            store.createIndex('account', 'account');
            store.createIndex('used', 'used');
          },
        }),
  )
  .catch(() => undefined);
const metadata = new Map<string, { until: number; promise: Promise<MediaResource> }>();
const memory = new Map<string, { url: string; size: number; blob?: Blob }>();
const inflight = new Map<string, Promise<string>>();
const decrypted = new Map<string, { name: string; mime: string; size: number }>();
const decrypting = new Map<string, Promise<void>>();
const previews = new Map<string, { resource: MediaResource; blobKey: string }>();
let folders = new Set<string>();
let account = '',
  epoch = 0,
  controller = new AbortController();
interface MediaResource extends AttachmentResource {
  encrypted?: string;
  cacheKey: string;
  width?: number;
  height?: number;
  downloadUrl: string;
}
let encryptedDownload:
  | ((
      path: string,
      signal?: AbortSignal,
      cache?: EncryptedFileCache,
      metadata?: EncryptedDownloadMetadata,
    ) => Promise<{ data: Uint8Array<ArrayBuffer>; name: string; mime: string; size: number }>)
  | undefined;
export function setEncryptedDownload(loader: NonNullable<typeof encryptedDownload>) {
  encryptedDownload = loader;
}
export function setMediaAccount(next: string | null) {
  if (account === (next ?? '')) return;
  const previous = account;
  account = next ?? '';
  epoch++;
  controller.abort();
  controller = new AbortController();
  metadata.clear();
  previews.clear();
  folders = new Set();
  inflight.clear();
  decrypted.clear();
  decrypting.clear();
  for (const value of memory.values()) URL.revokeObjectURL(value.url);
  memory.clear();
  if (previous)
    void database
      .then(async (db) => {
        if (!db) return;
        const keys = await db.getAllKeysFromIndex('blobs', 'account', previous);
        const tx = db.transaction('blobs', 'readwrite');
        for (const key of keys) void tx.store.delete(key);
        await tx.done;
      })
      .catch(() => {});
}
export function invalidateMediaConversations(ids: Set<string>) {
  folders = ids;
  for (const key of metadata.keys()) {
    const cid = /\/conversations\/([^/]+)\/files\//.exec(key)?.[1];
    if (cid && !ids.has(cid)) metadata.delete(key);
  }
  for (const key of previews.keys()) {
    if (!ids.has(conversationId(key) ?? '')) previews.delete(key);
  }
}
const conversationId = (path: string) => /\/conversations\/([^/]+)\/files\//.exec(path)?.[1];
const previewKey = (owner: string, path: string) => `${owner}:preview:v2:${path}`;

export function peekMessagingMedia(owner: string, path: string): MediaResource | undefined {
  if (!owner || owner !== account) return;
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin || !folders.has(conversationId(url.pathname) ?? '')) return;
  const cached = previews.get(previewKey(owner, url.pathname));
  const value = cached && memory.get(cached.blobKey);
  if (cached && value) return { ...cached.resource, blob: value.blob };
}

async function readBlobEntry(key: string) {
  try {
    const db = await database;
    if (!db) return;
    const tx = db.transaction('blobs', 'readwrite');
    const row = await tx.store.get(key);
    if (row && Date.now() - row.used > 60_000) await tx.store.put({ ...row, used: Date.now() });
    await tx.done;
    return row;
  } catch {
    return undefined;
  }
}
const readBlob = async (key: string) => (await readBlobEntry(key))?.blob;

async function saveBlob(
  key: string,
  account: string,
  blob: Blob,
  ticketEpoch: number,
  descriptor?: { encrypted: string; cacheKey: string },
) {
  try {
    const db = await database;
    if (!db || ticketEpoch !== epoch) return;
    const tx = db.transaction('blobs', 'readwrite');
    await tx.store.put({ key, account, blob, used: Date.now(), ...descriptor });
    const rows = await tx.store.index('used').getAll();
    let total = rows.reduce((n, r) => n + r.blob.size, 0);
    for (const row of rows) {
      if (total <= 64 * 1024 * 1024) break;
      await tx.store.delete(row.key);
      total -= row.blob.size;
    }
    await tx.done;
  } catch {
    /* Storage denied/full: memory cache remains usable. */
  }
}

function keepDecrypted(
  blobKey: string,
  file: { data: Uint8Array<ArrayBuffer>; name: string; mime: string; size: number },
) {
  const previous = memory.get(blobKey);
  if (previous) return;
  const blob = new Blob([file.data], { type: file.mime });
  memory.set(blobKey, { url: URL.createObjectURL(blob), size: file.size, blob });
  decrypted.set(blobKey, { name: file.name, mime: file.mime, size: file.size });
  let total = [...memory.values()].reduce((sum, v) => sum + v.size, 0);
  for (const [old, value] of memory) {
    if (total <= 64 * 1024 * 1024) break;
    if (old === blobKey) continue;
    total -= value.size;
    URL.revokeObjectURL(value.url);
    memory.delete(old);
    decrypted.delete(old);
  }
}

function authorizedPreview(key: string, blobKey: string, resource: MediaResource): MediaResource {
  const { url, blob } = memory.get(blobKey)!;
  const local = { ...resource, ...decrypted.get(blobKey)!, url, downloadUrl: url, expiresAt: 0 };
  previews.set(key, { resource: local, blobKey });
  if (previews.size > 256) previews.delete(previews.keys().next().value!);
  return { ...local, blob };
}

/** Inline previews can reuse ciphertext from an authenticated conversation. Explicit downloads still authorize online. */
export async function loadMessagingMedia(
  accountId: string,
  path: string,
  signal?: AbortSignal,
  fullSize = false,
): Promise<MediaResource> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!accountId) throw Error('请先登录');
  // Provider sets the active account before any profile/media request.
  if (account !== accountId) throw new DOMException('Account changed', 'AbortError');
  const ticketEpoch = epoch,
    url = new URL(path, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/im/')) throw Error('附件地址无效');
  const cid = conversationId(url.pathname);
  const canPreviewLocally = !fullSize && !!cid && folders.has(cid);
  const localKey = previewKey(accountId, url.pathname);
  if (canPreviewLocally) {
    const quick = peekMessagingMedia(accountId, path);
    if (quick) return quick;
    const local = await readBlobEntry(localKey);
    if (
      local?.encrypted &&
      local.cacheKey &&
      encryptedDownload &&
      ticketEpoch === epoch &&
      folders.has(cid)
    ) {
      const blobKey = `${accountId}:encrypted:${local.cacheKey}`;
      try {
        const file = await encryptedDownload(
          path,
          controller.signal,
          {
            get: async () => new Uint8Array(await local.blob.arrayBuffer()),
            put: async () => {},
            remove: async () => {
              await (await database)?.delete('blobs', localKey);
            },
          },
          { name: '', mime: '', encrypted: local.encrypted, cacheKey: local.cacheKey },
        );
        if (ticketEpoch !== epoch || signal?.aborted || !folders.has(cid))
          throw new DOMException('Aborted', 'AbortError');
        keepDecrypted(blobKey, file);
        return authorizedPreview(localKey, blobKey, {
          name: file.name,
          mime: file.mime,
          size: file.size,
          url: '',
          downloadUrl: '',
          cacheKey: local.cacheKey,
          expiresAt: 0,
        });
      } catch {
        // Reauthorize on the network if the local material cannot be decrypted.
      }
    }
    if (ticketEpoch !== epoch || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
  const key = `${accountId}:${url.pathname}:${fullSize ? 'full' : 'preview'}`;
  let entry = metadata.get(key);
  if (!entry || entry.until <= Date.now()) {
    const request = fetch(`${url.pathname}?meta=1${fullSize ? '&full=1' : ''}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw Error('附件不可用或你已离开此会话');
      return (await response.json()) as MediaResource;
    });
    entry = { until: Date.now() + 20000, promise: request };
    metadata.set(key, entry);
    void request.catch(() => {
      if (metadata.get(key)?.promise === request) metadata.delete(key);
    });
  }
  const resource = await entry.promise;
  if (ticketEpoch !== epoch || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (resource.encrypted) {
    const blobKey = `${accountId}:encrypted:${resource.cacheKey}`;
    if (!encryptedDownload) throw Error('请先解锁账号');
    if (!memory.has(blobKey)) {
      let pending = decrypting.get(blobKey);
      if (!pending) {
        const loader = encryptedDownload;
        pending = (async () => {
          const prefix = `${accountId}:cipher:v1:`;
          const descriptor = { encrypted: resource.encrypted!, cacheKey: resource.cacheKey };
          let previousBlob: Blob | undefined;
          let readPreviewBlob = false;
          const file = await loader(
            path,
            controller.signal,
            {
              get: async (key) => {
                if (ticketEpoch !== epoch) return;
                // The online metadata already authorized this exact ciphertext. The
                // conversation list may still be loading when history starts rendering.
                const page = cid ? await readBlobEntry(localKey) : undefined;
                const preview = page?.cacheKey === key ? page.blob : undefined;
                const blob = preview ?? (await readBlob(prefix + key));
                if (ticketEpoch !== epoch) return;
                readPreviewBlob = !!preview;
                if (blob && canPreviewLocally && !preview) previousBlob = blob;
                return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
              },
              put: async (key, bytes) => {
                const blob = new Blob([bytes]);
                if (canPreviewLocally) await saveBlob(localKey, accountId, blob, ticketEpoch, descriptor);
                else await saveBlob(prefix + key, accountId, blob, ticketEpoch);
              },
              remove: async (key) => {
                previousBlob = undefined;
                await (await database)?.delete('blobs', prefix + key);
                if (canPreviewLocally || readPreviewBlob) await (await database)?.delete('blobs', localKey);
              },
            },
            resource,
          );
          if (ticketEpoch !== epoch) throw new DOMException('Aborted', 'AbortError');
          if (previousBlob) await saveBlob(localKey, accountId, previousBlob, ticketEpoch, descriptor);
          keepDecrypted(blobKey, file);
        })();
        decrypting.set(blobKey, pending);
        void pending
          .finally(() => {
            if (decrypting.get(blobKey) === pending) decrypting.delete(blobKey);
          })
          .catch(() => {});
      }
      await pending;
    }
    if (ticketEpoch !== epoch || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (canPreviewLocally && folders.has(cid)) return authorizedPreview(localKey, blobKey, resource);
    const { url, blob } = memory.get(blobKey)!;
    return { ...resource, ...decrypted.get(blobKey)!, url, blob, downloadUrl: url, expiresAt: 0 };
  }
  if (!resource.mime.startsWith('image/')) return resource;
  const blobKey = `${accountId}:${resource.cacheKey}`;
  let cached = memory.get(blobKey)?.url;
  if (!cached) {
    let pending = inflight.get(blobKey);
    if (!pending) {
      const currentController = controller;
      pending = (async () => {
        let blob = await readBlob(blobKey);
        if (!blob) {
          const response = await fetch(resource.url, {
            credentials: resource.url.startsWith('/') ? 'same-origin' : 'omit',
            cache: 'default',
            signal: AbortSignal.any([currentController.signal, AbortSignal.timeout(45000)]),
          });
          if (!response.ok) throw Error('图片加载失败，请重试');
          blob = await response.blob();
          if (ticketEpoch !== epoch) throw new DOMException('Aborted', 'AbortError');
          await saveBlob(blobKey, accountId, blob, ticketEpoch);
        }
        if (ticketEpoch !== epoch) throw new DOMException('Aborted', 'AbortError');
        const objectURL = URL.createObjectURL(blob);
        memory.set(blobKey, { url: objectURL, size: blob.size });
        let total = [...memory.values()].reduce((n, v) => n + v.size, 0);
        for (const [old, value] of memory) {
          if (total <= 64 * 1024 * 1024) break;
          if (old === blobKey) continue;
          URL.revokeObjectURL(value.url);
          memory.delete(old);
          total -= value.size;
        }
        return objectURL;
      })();
      inflight.set(blobKey, pending);
      void pending
        .finally(() => {
          if (inflight.get(blobKey) === pending) inflight.delete(blobKey);
        })
        .catch(() => {});
    }
    cached = await pending;
  } else {
    const value = memory.get(blobKey)!;
    memory.delete(blobKey);
    memory.set(blobKey, value);
  }
  if (ticketEpoch !== epoch || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return { ...resource, url: cached, expiresAt: 0 };
}
