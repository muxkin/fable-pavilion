import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DeviceRequestTimeout } from '../src/shared/device-link';
import { RpcError } from '../src/shared/rpc';
import { readIceRoute, type IceRoute } from '../src/web/network-ice';
import { watchNetworkDetails, type NetworkDetails } from '../src/web/network-telemetry';

vi.mock('../src/web/network-ice', () => ({ readIceRoute: vi.fn() }));

const empty = { rates: null, probes: null, route: null };
const ok = { value: { ok: true } };
let doc: EventTarget & { hidden: boolean };
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('document', doc);
  vi.mocked(readIceRoute).mockReset();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function watch(read: Parameters<typeof watchNetworkDetails>[0]) {
  let details: NetworkDetails;
  const source = new EventTarget();
  stop = watchNetworkDetails(
    read,
    (listener) => {
      source.addEventListener('change', listener);
      return () => source.removeEventListener('change', listener);
    },
    (next) => {
      details = next;
    },
  );
  return { details: () => details, changed: () => source.dispatchEvent(new Event('change')) };
}

it('computes per-window bit rates from the full session counters and rebaselines when the route changes', async () => {
  const control = { request: vi.fn().mockResolvedValue(ok) };
  const traffic = { sentBytes: 25, receivedBytes: 190 };
  const paths = { control, traffic };
  const watchDetails = watch(() => paths);
  expect(watchDetails.details().rates).toBeNull();

  traffic.sentBytes += 250;
  traffic.receivedBytes += 500;
  await vi.advanceTimersByTimeAsync(2000);
  expect(watchDetails.details().rates).toEqual({ sent: 1000, received: 2000 });

  // Includes a bulk transport that opened, transferred, and closed inside this window.
  traffic.sentBytes += 1000;
  traffic.receivedBytes += 2500;
  await vi.advanceTimersByTimeAsync(2000);
  expect(watchDetails.details().rates).toEqual({ sent: 4000, received: 10000 });

  paths.control = { request: vi.fn().mockResolvedValue(ok) };
  paths.traffic = { sentBytes: 5, receivedBytes: 10 };
  watchDetails.changed();
  expect(watchDetails.details().rates).toBeNull();
  await vi.advanceTimersByTimeAsync(2000);
  expect(watchDetails.details().rates).toEqual({ sent: 0, received: 0 });
});

it('counts completed probes and timeouts, excluding failed sends and inactive tabs', async () => {
  const control = {
    request: vi
      .fn()
      .mockResolvedValueOnce(ok)
      .mockRejectedValueOnce(new DeviceRequestTimeout())
      .mockRejectedValueOnce(new RpcError('连接中断', 0)),
  };
  const watchDetails = watch(() => ({ control }));
  await vi.advanceTimersByTimeAsync(0);
  expect(watchDetails.details().probes).toEqual({ timedOut: 0, total: 1 });
  await vi.advanceTimersByTimeAsync(4000);
  expect(watchDetails.details().probes).toEqual({ timedOut: 1, total: 2 });

  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(6000);
  expect(control.request).toHaveBeenCalledTimes(3);
  expect(watchDetails.details()).toEqual(empty);
});

it('clears route and probe measurements when the link changes and ignores late old-route results', async () => {
  let resolveRoute!: (route: IceRoute) => void;
  vi.mocked(readIceRoute).mockReturnValue(
    new Promise((resolve) => {
      resolveRoute = resolve;
    }),
  );
  const endpoint = { address: '192.0.2.1', port: 3478, protocol: 'udp', candidateType: 'host' };
  const direct = { request: vi.fn().mockRejectedValue(new DeviceRequestTimeout()) };
  const relay = { request: vi.fn().mockResolvedValue(ok) };
  const paths: ReturnType<Parameters<typeof watchNetworkDetails>[0]> = {
    control: direct,
    directPeer: {} as RTCPeerConnection,
  };
  const watchDetails = watch(() => paths);
  await vi.advanceTimersByTimeAsync(0);
  expect(watchDetails.details().probes).toEqual({ timedOut: 1, total: 1 });

  paths.directPeer = undefined;
  paths.control = relay;
  watchDetails.changed();
  expect(watchDetails.details()).toEqual(empty);
  resolveRoute({ local: endpoint, remote: endpoint });
  await vi.advanceTimersByTimeAsync(0);
  expect(watchDetails.details()).toEqual({ ...empty, probes: { timedOut: 0, total: 1 } });

  stop?.();
  await vi.advanceTimersByTimeAsync(6000);
  expect(relay.request).toHaveBeenCalledOnce();
});
