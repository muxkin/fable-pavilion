import { expect, it, vi } from 'vitest';
vi.mock('../src/web/sync-store', () => ({
  SyncStore: class {
    get = vi.fn().mockResolvedValue(undefined);
    put = vi.fn();
  },
}));
import { DeviceSession } from '../src/web/device-session';
import { DEFAULT_BACKEND, conversationKey } from '../src/shared/backends';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function snapshot(id: string) {
  return {
    type: 'sync',
    threadId: id,
    updates: [
      {
        kind: 'manifest',
        epoch: 'epoch',
        thread: { id, revision: 1 },
        order: ['message'],
        changed: [{ id: 'message', role: 'assistant', text: 'History for ' + id }],
      },
    ],
  };
}

it('releases inactive chat snapshots while keeping their persistent cache', async () => {
  const session = new DeviceSession();
  for (let index = 0; index < 40; index++) {
    const id = `chat-${index}`;
    const unsubscribe = session.subscribe(id, vi.fn());
    await (session as any).receive(snapshot(id));
    unsubscribe();
  }
  expect((session as any).views.size).toBe(0);
  expect(session.cache.put).toHaveBeenCalledTimes(40);
});

it('ignores late snapshots for chats that are no longer watched', async () => {
  const session = new DeviceSession();
  await (session as any).receive(snapshot('old-chat'));
  expect(session.cache.get).not.toHaveBeenCalled();
  expect(session.cache.put).not.toHaveBeenCalled();
  expect((session as any).views.size).toBe(0);
});

it('discards a snapshot if the subscription changes while its cache read is pending', async () => {
  const session = new DeviceSession();
  const read = deferred<undefined>();
  vi.mocked(session.cache.get).mockReturnValueOnce(read.promise);
  const key = conversationKey(DEFAULT_BACKEND, 'chat');
  const previous = vi.fn(),
    current = vi.fn();
  (session as any).watchers.set(key, new Set([previous]));
  const receiving = (session as any).receive(snapshot('chat'));
  (session as any).watchers.set(key, new Set([current]));
  read.resolve(undefined);
  await receiving;
  expect(previous).not.toHaveBeenCalled();
  expect(current).not.toHaveBeenCalled();
  expect(session.cache.put).not.toHaveBeenCalled();
  expect((session as any).views.size).toBe(0);
});

it('does not restore an old host snapshot after disconnecting during a cache read', async () => {
  const session = new DeviceSession();
  const read = deferred<any>();
  vi.mocked(session.cache.get).mockReturnValueOnce(read.promise);
  const listener = vi.fn();
  session.subscribe('chat', listener);
  session.disconnect();
  read.resolve({ epoch: 'old-host', view: { id: 'chat', messages: [], revision: 1 } });
  await read.promise;
  expect(listener).not.toHaveBeenCalled();
  expect((session as any).views.size).toBe(0);
});

it('keeps the new subscription when an old host subscription is cleaned up late', async () => {
  const session = new DeviceSession();
  const oldUnsubscribe = session.subscribe('chat', vi.fn());
  session.disconnect();
  const current = vi.fn();
  const unsubscribe = session.subscribe('chat', current);
  oldUnsubscribe();
  await (session as any).receive(snapshot('chat'));
  expect(current).toHaveBeenCalledWith({ type: 'thread', thread: expect.objectContaining({ id: 'chat' }) });
  unsubscribe();
});

it('uses the live relay when a closed direct link is awaiting cleanup', async () => {
  const session = new DeviceSession();
  const request = vi.fn().mockResolvedValue({ value: { ok: true } });
  (session as any).links.set('direct:control', { closed: true });
  (session as any).links.set('relay:control', { closed: false, request });
  expect(session.online).toBe(true);
  await expect(session.request('ping', {})).resolves.toEqual({ value: { ok: true } });
  expect(request).toHaveBeenCalledOnce();
});

it('always reads model catalogs live and never restores a persistent catalog after a failed reconnect', async () => {
  const session = new DeviceSession();
  const host = {
    hostId: 'fixture-host',
    deviceId: 'fixture-device',
    phoneId: 'fixture-phone',
    ticket: 'fixture-ticket',
    name: 'Fixture',
  };
  session.host = host;
  (session as any).identity = { peerId: 'fixture-phone' };
  (session as any).init = vi.fn().mockResolvedValue(undefined);
  const request = vi
    .fn()
    .mockResolvedValueOnce({ value: { models: [{ id: 'before-upgrade' }] } })
    .mockResolvedValueOnce({ value: { models: [{ id: 'after-upgrade' }] } });
  (session as any).links.set('relay:control', { closed: false, request });
  vi.mocked(session.cache.get).mockResolvedValue({
    hash: 'old-models',
    value: { models: [{ id: 'stale-persistent' }] },
  });
  await expect(session.api('/api/models')).resolves.toEqual({ models: [{ id: 'before-upgrade' }] });
  await expect(session.api('/api/models')).resolves.toEqual({ models: [{ id: 'after-upgrade' }] });
  expect(session.cache.get).not.toHaveBeenCalled();
  expect(session.cache.put).not.toHaveBeenCalled();
  expect(request.mock.calls.every((args) => args[1].knownHash === undefined)).toBe(true);
  (session as any).links.clear();
  (session as any).connect = vi.fn().mockRejectedValue(Error('Synthetic reconnect failed'));
  await expect(session.api('/api/models')).rejects.toThrow('Synthetic reconnect failed');
  expect(session.cache.get).not.toHaveBeenCalled();
});

it('loads the selected backend creation capability before opening any conversation', async () => {
  const session = new DeviceSession();
  session.host = {
    hostId: 'fixture-host',
    deviceId: 'fixture-device',
    phoneId: 'fixture-phone',
    ticket: 'fixture-ticket',
    name: 'Fixture',
  };
  (session as any).init = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(session, 'online', 'get').mockReturnValue(true);
  const backend = 'antigravity-fixture';
  const status = { connected: true, writesEnabled: true, capabilities: { newThread: true } };
  const request = vi.spyOn(session, 'request').mockResolvedValue({ value: status });
  session.selectBackend(backend);

  await expect(session.api('/session', undefined, backend)).resolves.toMatchObject({ status: undefined });
  await expect(session.api('/status', undefined, backend)).resolves.toEqual(status);
  expect(request).toHaveBeenCalledExactlyOnceWith('rpc', {
    call: expect.objectContaining({ method: 'status.read', backendId: backend }),
    knownHash: undefined,
  });
  expect(session.backendStatus(backend)).toEqual(status);
  expect(session.backendStatus(DEFAULT_BACKEND)).toBeUndefined();
  await expect(session.api('/session', undefined, backend)).resolves.toMatchObject({ status });
  expect((session as any).watchers.size).toBe(0);
});

it('measures the control path without treating a direct file channel as a direct control connection', async () => {
  const session = new DeviceSession();
  const response = deferred<{ value: { ok: true } }>();
  const request = vi.fn(() => response.promise);
  const changed = vi.fn();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  const unsubscribe = session.onNetworkChange(changed);
  try {
    (session as any).links.set('relay:control', { closed: false, request });
    (session as any).links.set('direct:bulk', { closed: false });
    (session as any).changed();
    expect(session.networkStatus).toEqual({
      control: 'relay',
      directBulk: true,
      latencyMs: null,
      highLatency: false,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith('ping', {}, undefined, 10000);

    clock.mockReturnValue(744);
    response.resolve({ value: { ok: true } });
    await response.promise;
    expect(session.networkStatus).toEqual({
      control: 'relay',
      directBulk: true,
      latencyMs: 644,
      highLatency: false,
    });
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    clock.mockRestore();
  }
});

it('ignores the old control path measurement after switching to a direct path', async () => {
  const session = new DeviceSession();
  const relay = deferred<{ value: { ok: true } }>();
  const direct = deferred<{ value: { ok: true } }>();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
  try {
    const links = (session as any).links;
    links.set('relay:control', { closed: false, request: () => relay.promise, close: vi.fn() });
    (session as any).changed();
    clock.mockReturnValue(20);
    links.set('direct:control', { closed: false, request: () => direct.promise, close: vi.fn() });
    (session as any).changed();

    relay.resolve({ value: { ok: true } });
    await relay.promise;
    expect(session.networkStatus).toEqual({
      control: 'direct',
      directBulk: false,
      latencyMs: null,
      highLatency: false,
    });

    clock.mockReturnValue(45);
    direct.resolve({ value: { ok: true } });
    await direct.promise;
    expect(session.networkStatus).toEqual({
      control: 'direct',
      directBulk: false,
      latencyMs: 25,
      highLatency: false,
    });

    session.disconnect();
    expect(session.networkStatus).toEqual({
      control: null,
      directBulk: false,
      latencyMs: null,
      highLatency: false,
    });
  } finally {
    clock.mockRestore();
  }
});

it('notifies connection subscribers when the session is explicitly disconnected', () => {
  const session = new DeviceSession();
  (session as any).links.set('relay:control', { closed: false, close: vi.fn() });
  const online: boolean[] = [];
  session.onChange(() => online.push(session.online));
  expect(session.online).toBe(true);
  session.disconnect();
  expect(online).toEqual([false]);
});

it('reconnects unopened pairing sockets during authorization and stops on cancellation', async () => {
  const sockets: TestSocket[] = [];
  class TestSocket {
    onopen?: () => void;
    onclose?: (event: { reason: string }) => void;
    send = vi.fn();
    close = vi.fn(() => this.onclose?.({ reason: '' }));
    constructor() {
      sockets.push(this);
    }
  }

  vi.useFakeTimers();
  vi.stubGlobal('location', { protocol: 'https:', host: 'app.example.test' });
  vi.stubGlobal('WebSocket', TestSocket);
  try {
    const session = new DeviceSession();
    Object.assign(session, { identity: { peerId: 'fixture' } });
    const first = expect(session.pair('desktop', 'code', 'Browser')).rejects.toThrow('连接未完成');
    await vi.advanceTimersByTimeAsync(10_500);
    expect(sockets).toHaveLength(2);
    expect(sockets[0].close).toHaveBeenCalledOnce();
    expect(sockets[0].send).not.toHaveBeenCalled();
    sockets[1].onopen?.();
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    expect(sockets).toHaveLength(2);

    const controller = new AbortController();
    const canceled = expect(
      session.pair('desktop', 'code', 'Browser', undefined, {
        signal: controller.signal,
        retryUntil: Date.now() + 60_000,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(21_500);
    expect(sockets).toHaveLength(5);
    expect(sockets[2].send).not.toHaveBeenCalled();
    expect(sockets[3].send).not.toHaveBeenCalled();
    controller.abort();
    await canceled;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(5);
    expect(sockets[4].close).toHaveBeenCalledOnce();

    const expired = expect(
      session.pair('desktop', 'code', 'Browser', undefined, { retryUntil: Date.now() + 10_400 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(10_500);
    await expired;
    expect(sockets).toHaveLength(6);
    expect(sockets[5].send).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it('scopes history errors to the requested chat instead of every chat on the backend', async () => {
  const session = new DeviceSession();
  const current = vi.fn(),
    other = vi.fn();
  (session as any).watchers.set(JSON.stringify(['codex', 'current']), new Set([current]));
  (session as any).watchers.set(JSON.stringify(['codex', 'other']), new Set([other]));
  await (session as any).receive({
    type: 'event',
    backendId: 'codex',
    threadId: 'other',
    event: { type: 'error', message: 'Unavailable' },
  });
  expect(current).not.toHaveBeenCalled();
  expect(other).toHaveBeenCalledWith({ type: 'error', message: 'Unavailable' });
});
