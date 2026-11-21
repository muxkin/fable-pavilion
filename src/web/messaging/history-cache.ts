import { openDB, type DBSchema } from 'idb';
import {
  openPrivate,
  privateId,
  sealPrivate,
  type AccountSecrets,
  type Ciphertext,
} from '../../shared/account-crypto';
import type { ChatHistory, ChatMessage } from '../../shared/messaging';
import { contentVersion } from '../../shared/sync';

interface HistoryEntry {
  key: string;
  digest: string;
  saved: number;
  ciphertext: Ciphertext;
}
interface HistoryDB extends DBSchema {
  latest: { key: string; value: HistoryEntry; indexes: { saved: number } };
}
export interface HistoryOwner {
  id: string;
  secrets: AccountSecrets;
}
const pageLimit = 64;
const defaultBudgetBytes = 4 * 1024 * 1024;
const memory = new WeakMap<AccountSecrets, Map<string, ChatHistory>>();
let database: ReturnType<typeof openDB<HistoryDB>> | undefined;
const historyDB = () =>
  (database ??= openDB<HistoryDB>('pocket-im-history', 1, {
    upgrade(db) {
      db.createObjectStore('latest', { keyPath: 'key' }).createIndex('saved', 'saved');
    },
  }));
const pageKey = (owner: HistoryOwner, id: string) => `im-history:${owner.id}:${id}`;

/**
 * Merge newly fetched/received messages into the locally cached history without
 * discarding older locally cached messages after 7-day cloud retention pruning.
 */
export function mergeHistoryPages(
  existing: ChatHistory | undefined,
  incoming: ChatHistory,
  budgetBytes = defaultBudgetBytes,
): ChatHistory {
  const byId = new Map<string, ChatMessage>();
  for (const message of existing?.messages ?? []) byId.set(message.id, message);
  for (const message of incoming.messages) {
    const prev = byId.get(message.id);
    if (!prev || message.revision >= prev.revision) byId.set(message.id, message);
  }
  const merged = [...byId.values()].sort(
    (a, b) => a.sequence - b.sequence || a.createdAt - b.createdAt,
  );
  let budget = budgetBytes;
  let first = merged.length;
  while (first > 0) {
    budget -= JSON.stringify(merged[first - 1]).length;
    if (budget < 0) break;
    first--;
  }
  if (first && first === merged.length) {
    return existing ?? incoming;
  }
  const messages = first ? merged.slice(first) : merged;
  const oldest = messages[0]?.sequence;
  let before: number | undefined;
  if (first) {
    before = oldest;
  } else {
    const candidates = [existing?.before, incoming.before].filter(
      (v): v is number => typeof v === 'number' && (oldest === undefined || v <= oldest),
    );
    before = candidates.length ? Math.min(...candidates) : undefined;
  }
  return { messages, ...(before !== undefined ? { before } : {}) };
}

function remember(owner: HistoryOwner, key: string, page: ChatHistory) {
  const pages = memory.get(owner.secrets) ?? new Map<string, ChatHistory>();
  pages.delete(key);
  pages.set(key, page);
  if (pages.size > pageLimit) pages.delete(pages.keys().next().value!);
  memory.set(owner.secrets, pages);
}

export function peekHistory(owner: HistoryOwner, id: string) {
  return memory.get(owner.secrets)?.get(pageKey(owner, id));
}

export async function cachedHistory(owner: HistoryOwner, id: string): Promise<ChatHistory | undefined> {
  const key = pageKey(owner, id);
  const cached = memory.get(owner.secrets)?.get(key);
  if (cached) return cached;
  try {
    const entry = await (await historyDB()).get('latest', key);
    if (!entry) return;
    const page = await openPrivate<ChatHistory>(owner.secrets, key, entry.ciphertext);
    const recent = peekHistory(owner, id);
    if (recent) return recent;
    remember(owner, key, page);
    return page;
  } catch {
    // A missing or unreadable cache does not block history from the server.
  }
}

export async function saveHistory(owner: HistoryOwner, id: string, page: ChatHistory) {
  const key = pageKey(owner, id);
  const saved = Date.now();
  const existing = peekHistory(owner, id) ?? (await cachedHistory(owner, id));
  const snapshot = mergeHistoryPages(existing, page);
  remember(owner, key, snapshot);
  try {
    const db = await historyDB();
    const digest = await privateId(owner.secrets, `${key}:${contentVersion(snapshot)}`);
    if ((await db.get('latest', key))?.digest === digest) return;
    const ciphertext = await sealPrivate(owner.secrets, key, snapshot);
    const tx = db.transaction('latest', 'readwrite');
    const previous = await tx.store.get(key);
    if (!previous || (previous.saved <= saved && previous.digest !== digest)) {
      await tx.store.put({ key, digest, saved, ciphertext });
      const keys = await tx.store.index('saved').getAllKeys();
      for (const old of keys.slice(0, Math.max(0, keys.length - pageLimit))) await tx.store.delete(old);
    }
    await tx.done;
  } catch {
    // The in-memory copy stays usable when persistent storage is unavailable.
  }
}

export async function forgetHistory(owner: HistoryOwner, id: string) {
  const key = pageKey(owner, id);
  memory.get(owner.secrets)?.delete(key);
  try {
    await (await historyDB()).delete('latest', key);
  } catch {
    // A storage failure cannot restore access in the current session.
  }
}
