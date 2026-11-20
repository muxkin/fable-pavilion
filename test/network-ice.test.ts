import { expect, it, vi } from 'vitest';
import { readIceRoute } from '../src/web/network-ice';

const local = { address: 'host-3.local', port: 45678, protocol: 'udp', candidateType: 'host' };
const remote = { address: '2001:db8::2', port: 45679, protocol: 'udp', candidateType: 'srflx' };
const unknownEndpoint = { address: null, port: null, protocol: null, candidateType: null };
const candidates = {
  local: { type: 'local-candidate', ...local, relatedAddress: '192.0.2.20' },
  remote: { type: 'remote-candidate', ...remote, relatedAddress: '192.0.2.21' },
};
const nominated = {
  type: 'candidate-pair',
  localCandidateId: 'local',
  remoteCandidateId: 'remote',
  nominated: true,
  state: 'succeeded',
};

function peer(getStats?: () => Promise<RTCStatsReport>, selectPair?: () => unknown) {
  return {
    getStats,
    sctp: selectPair ? { transport: { iceTransport: { getSelectedCandidatePair: selectPair } } } : null,
  } as unknown as RTCPeerConnection;
}

function stats(entries: Record<string, unknown>) {
  return vi.fn().mockResolvedValue(new Map(Object.entries(entries)));
}

it('reads the selected SCTP pair without consulting stats or exposing other candidate fields', async () => {
  const getStats = vi.fn();
  const { address, port, protocol, candidateType } = local;
  const selected = peer(getStats, () => ({
    local: { address, port, protocol, type: candidateType, relatedAddress: '192.0.2.20' },
    remote: { address: '', port: 0, protocol: 'unknown', type: 'unknown', candidate: 'raw SDP' },
  }));

  await expect(readIceRoute(selected)).resolves.toEqual({ local, remote: unknownEndpoint });
  expect(getStats).not.toHaveBeenCalled();
});

it('prefers the transport-selected stats pair over other nominated pairs', async () => {
  const getStats = stats({
    ...candidates,
    transport: { type: 'transport', selectedCandidatePairId: 'selected' },
    other: { ...nominated, remoteCandidateId: 'unselectedRemote' },
    unselectedRemote: { ...candidates.remote, address: '192.0.2.30' },
    selected: { ...nominated, nominated: false },
  });
  const connection = peer(getStats, () => {
    throw new Error('SCTP transport unavailable');
  });

  await expect(readIceRoute(connection)).resolves.toEqual({ local, remote });
});

it('falls back to the sole successful nominated pair and preserves redaction', async () => {
  const getStats = stats({
    ...candidates,
    local: { type: 'local-candidate', port: 70000, relatedAddress: '192.0.2.20' },
    transport: { type: 'transport' },
    viable: nominated,
    waiting: { ...nominated, state: 'in-progress' },
    notNominated: { ...nominated, nominated: false },
  });

  await expect(readIceRoute(peer(getStats))).resolves.toEqual({ local: unknownEndpoint, remote });
});

it.each([
  { another: { ...nominated } },
  { transport: { type: 'transport', selectedCandidatePairId: 'missing' } },
  { transport: { type: 'transport' }, anotherTransport: { type: 'transport' } },
])('declines to guess a route from ambiguous or stale stats %#', async (extraStats) => {
  const getStats = stats({ ...candidates, viable: nominated, ...extraStats });
  await expect(readIceRoute(peer(getStats))).resolves.toBeNull();
});

it('returns no route when the browser has no usable stats', async () => {
  await expect(readIceRoute(peer())).resolves.toBeNull();
  await expect(readIceRoute(peer(vi.fn().mockRejectedValue(new Error('closed'))))).resolves.toBeNull();
  await expect(readIceRoute(peer(stats({ viable: nominated })))).resolves.toBeNull();
});
