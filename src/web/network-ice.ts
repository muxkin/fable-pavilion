export interface IceEndpoint {
  address: string | null;
  port: number | null;
  protocol: string | null;
  candidateType: string | null;
}

export interface IceRoute {
  local: IceEndpoint;
  remote: IceEndpoint;
}

type CandidateFields = { address?: unknown; port?: unknown; protocol?: unknown; candidateType?: unknown };

function endpoint(candidate?: CandidateFields, candidateType = candidate?.candidateType): IceEndpoint {
  const { address, port, protocol } = candidate ?? {};
  return {
    address: typeof address === 'string' && address.trim() ? address.trim() : null,
    port: typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null,
    protocol: protocol === 'udp' || protocol === 'tcp' ? protocol : null,
    candidateType:
      candidateType === 'host' ||
      candidateType === 'srflx' ||
      candidateType === 'prflx' ||
      candidateType === 'relay'
        ? candidateType
        : null,
  };
}

function statsRoute(report: RTCStatsReport): IceRoute | null {
  let transports = 0;
  let selectedId: string | undefined;
  const nominatedPairs: RTCIceCandidatePairStats[] = [];
  report.forEach((stat: RTCStats | undefined) => {
    if (stat?.type === 'transport') {
      transports++;
      selectedId = (stat as RTCTransportStats).selectedCandidatePairId;
    }
    if (stat?.type === 'candidate-pair') {
      const pair = stat as RTCIceCandidatePairStats;
      if (pair.nominated === true && pair.state === 'succeeded') nominatedPairs.push(pair);
    }
  });
  if (transports > 1) return null;
  // A missing transport reference is common on older browsers. A single successful,
  // nominated pair is the only fallback with enough evidence to display a route.
  const pair: RTCIceCandidatePairStats | undefined =
    typeof selectedId === 'string' && selectedId
      ? report.get(selectedId)
      : nominatedPairs.length === 1
        ? nominatedPairs[0]
        : undefined;
  if (pair?.type !== 'candidate-pair' || (pair.state !== undefined && pair.state !== 'succeeded'))
    return null;
  const local = typeof pair.localCandidateId === 'string' ? report.get(pair.localCandidateId) : undefined;
  const remote = typeof pair.remoteCandidateId === 'string' ? report.get(pair.remoteCandidateId) : undefined;
  const localCandidate = local?.type === 'local-candidate' ? local : undefined;
  const remoteCandidate = remote?.type === 'remote-candidate' ? remote : undefined;
  if (!localCandidate && !remoteCandidate) return null;
  return { local: endpoint(localCandidate), remote: endpoint(remoteCandidate) };
}

export async function readIceRoute(pc: RTCPeerConnection): Promise<IceRoute | null> {
  if (pc.signalingState === 'closed') return null;
  try {
    const pair = pc.sctp?.transport?.iceTransport?.getSelectedCandidatePair?.();
    if (pair?.local || pair?.remote)
      return {
        local: endpoint(pair.local, pair.local?.type),
        remote: endpoint(pair.remote, pair.remote?.type),
      };
  } catch {
    // Some implementations expose the method before the SCTP transport can use it.
  }
  try {
    const report = await pc.getStats?.();
    return report ? statsRoute(report) : null;
  } catch {
    return null;
  }
}
