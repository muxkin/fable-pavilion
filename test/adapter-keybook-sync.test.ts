import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountClient } from '../src/client/account.js';
import { createSecrets } from '../src/shared/account-crypto.js';
import type { ChatUser } from '../src/shared/messaging.js';

const fixture = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  host: { hostId: 'selected-host', deviceId: 'device', ticket: 'ticket', phoneId: 'phone', name: 'Selected' },
  device: {
    host: undefined as unknown,
    online: true,
    cache: { scope: 'fixture', hosts: vi.fn() },
    onChange: vi.fn(),
  },
  backup: vi.fn(),
  recovery: vi.fn(),
  persist: vi.fn(),
}));
vi.mock('../src/web/device-session', () => ({ deviceSession: fixture.device }));
vi.mock('../src/web/adapter-security-backup', () => ({
  backupAdapter: fixture.backup,
  pendingAdapterRecovery: fixture.recovery,
  persistAdapterRecovery: fixture.persist,
}));
import { startAdapterKeybookSync } from '../src/web/adapter-keybook-sync.js';

let stop: (() => void) | undefined;
const user = (id = 'fixture'): ChatUser => ({
  id,
  username: id,
  displayName: 'Synthetic',
  kind: 'human',
  encrypted: true,
  address: `${id}@fixture.test`,
  createdAt: 0,
});
beforeEach(() => {
  vi.useFakeTimers();
  fixture.listeners.clear();
  fixture.device.host = fixture.host;
  fixture.device.online = true;
  fixture.device.cache.scope = 'fixture';
  fixture.device.cache.hosts
    .mockReset()
    .mockResolvedValue([
      fixture.host,
      ...Array.from({ length: 100 }, (_, i) => ({ ...fixture.host, hostId: `unselected-${i}` })),
    ]);
  fixture.device.onChange.mockImplementation((fn: () => void) => {
    fixture.listeners.add(fn);
    return () => fixture.listeners.delete(fn);
  });
  fixture.backup.mockReset().mockResolvedValue({ state: 'saved', hasRecovery: true });
  fixture.recovery.mockReset().mockResolvedValue(undefined);
  fixture.persist.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function account() {
  const account = new AccountClient(async () => {
    throw Error('Unexpected transport');
  });
  account.activate(user(), await createSecrets(), undefined, 7);
  return account;
}
const emit = () => fixture.listeners.forEach((fn) => fn());

it('syncs a restored full session to only the selected known host, deduplicates events and rechecks after reconnect', async () => {
  const owner = await account();
  stop = startAdapterKeybookSync(owner, owner.request);
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.backup).toHaveBeenCalledTimes(1);
  expect(fixture.backup.mock.calls[0][2]).toBe(fixture.host);
  for (let i = 0; i < 20; i++) emit();
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.backup).toHaveBeenCalledTimes(1);
  fixture.device.online = false;
  emit();
  await vi.advanceTimersByTimeAsync(500);
  fixture.device.online = true;
  emit();
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.backup).toHaveBeenCalledTimes(2);
});

it('aborts in-flight synchronization on account switch and cannot commit a stale successful attempt', async () => {
  const owner = await account();
  let finish!: (value: unknown) => void;
  fixture.backup.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  stop = startAdapterKeybookSync(owner, owner.request);
  await vi.advanceTimersByTimeAsync(500);
  const signal = fixture.backup.mock.calls[0][3].signal as AbortSignal;
  owner.activate(user('different-account'), await createSecrets(), undefined, 8);
  expect(signal.aborted).toBe(true);
  finish({ state: 'saved', hasRecovery: true });
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.backup).toHaveBeenCalledTimes(1);
});

it('abandons an old selected computer when the selection changes while the host cache is loading', async () => {
  const owner = await account();
  const nextHost = {
    ...fixture.host,
    hostId: 'next-selected',
    deviceId: 'next-device',
    ticket: 'next-ticket',
  };
  let release!: (hosts: (typeof fixture.host)[]) => void;
  fixture.device.cache.hosts
    .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    .mockResolvedValue([fixture.host, nextHost]);
  stop = startAdapterKeybookSync(owner, owner.request);
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.device.cache.hosts).toHaveBeenCalledTimes(1);
  fixture.device.host = nextHost;
  emit();
  release([fixture.host, nextHost]);
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.backup).toHaveBeenCalledTimes(1);
  expect(fixture.backup.mock.calls[0][2]).toEqual(nextHost);
});

it('aborts an active backup when the selected computer credentials or connectivity change', async () => {
  const owner = await account();
  let finish!: (value: unknown) => void;
  fixture.backup.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  stop = startAdapterKeybookSync(owner, owner.request);
  await vi.advanceTimersByTimeAsync(500);
  const signal = fixture.backup.mock.calls[0][3].signal as AbortSignal;
  fixture.device.host = { ...fixture.host, ticket: 'rotated-ticket' };
  emit();
  expect(signal.aborted).toBe(true);
  finish({ state: 'saved', hasRecovery: true });
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.backup).toHaveBeenCalledTimes(1);
});

it('bounds failed retries and only wakes them again on a real reconnect or explicit browser wake', async () => {
  const owner = await account();
  fixture.backup.mockRejectedValue(Error('Synthetic unreachable computer'));
  stop = startAdapterKeybookSync(owner, owner.request);
  await vi.advanceTimersByTimeAsync(180000);
  expect(fixture.backup).toHaveBeenCalledTimes(5);
  emit();
  await vi.advanceTimersByTimeAsync(10000);
  expect(fixture.backup).toHaveBeenCalledTimes(5);
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.backup).toHaveBeenCalledTimes(6);
});

it('never contacts an unknown selected computer or a locked account', async () => {
  const owner = await account();
  fixture.device.cache.hosts.mockResolvedValue([]);
  stop = startAdapterKeybookSync(owner, owner.request);
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.backup).not.toHaveBeenCalled();
  owner.lock();
  fixture.device.cache.hosts.mockResolvedValue([fixture.host]);
  emit();
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.backup).not.toHaveBeenCalled();
});

it('adds recovery after a slow real account-items refresh even when a seed-only import already succeeded', async () => {
  let release!: () => void;
  let loaded = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = new AccountClient(async <T>() => {
    await gate;
    loaded = true;
    return { items: [] } as T;
  });
  owner.activate(user(), await createSecrets(), undefined, 7);
  const loading = owner.refreshItems();
  fixture.recovery.mockImplementation(async () => (loaded ? 'synthetic-original-recovery' : undefined));
  fixture.backup
    .mockResolvedValueOnce({ state: 'saved', hasRecovery: false })
    .mockResolvedValue({ state: 'saved', hasRecovery: true });
  stop = startAdapterKeybookSync(owner, owner.request);
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.backup).toHaveBeenCalledTimes(1);
  expect(fixture.backup.mock.calls[0][3].recoveryCode).toBeUndefined();
  release();
  await loading;
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.backup).toHaveBeenCalledTimes(2);
  expect(fixture.backup.mock.calls[1][3].recoveryCode).toBe('synthetic-original-recovery');
});
