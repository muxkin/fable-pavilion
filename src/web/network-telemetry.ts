import { DeviceRequestTimeout, type DeviceLink } from '../shared/device-link';
import { readIceRoute, type IceRoute } from './network-ice';

const SAMPLE_MS = 2000;
const PROBE_TIMEOUT_MS = 2000;
const MAX_PROBES = 30;

export interface LinkTraffic {
  sentBytes: number;
  receivedBytes: number;
}

interface NetworkPaths {
  control?: Pick<DeviceLink, 'request'>;
  directPeer?: RTCPeerConnection;
  traffic?: LinkTraffic;
}

export interface NetworkDetails {
  rates: { sent: number; received: number } | null;
  probes: { timedOut: number; total: number } | null;
  route: IceRoute | null;
}

const emptyDetails: NetworkDetails = { rates: null, probes: null, route: null };

export function watchNetworkDetails(
  read: () => NetworkPaths,
  subscribe: (listener: () => void) => () => void,
  notify: (details: NetworkDetails) => void,
) {
  let details = emptyDetails;
  let current: Pick<NetworkPaths, 'control' | 'directPeer'> | undefined;
  let previous: { at: number; source: LinkTraffic; bytes: LinkTraffic } | undefined;
  let probing = false;
  let readingRoute = false;
  const outcomes: boolean[] = [];

  const publish = (update: Partial<NetworkDetails>) => {
    details = { ...details, ...update };
    notify(details);
  };
  const reset = () => {
    current = undefined;
    previous = undefined;
    probing = false;
    readingRoute = false;
    outcomes.length = 0;
    publish(emptyDetails);
  };
  const sync = (paths: NetworkPaths) => {
    const { control, directPeer } = paths;
    if (current && current.control === control && current.directPeer === directPeer) return current;
    reset();
    return (current = { control, directPeer });
  };
  const sample = (paths = read()) => {
    if (document.hidden) return;
    const target = sync(paths);
    const at = performance.now();
    const traffic = paths.traffic;
    if (traffic && previous?.source === traffic && at > previous.at) {
      const seconds = (at - previous.at) / 1000;
      publish({
        rates: {
          sent: (8 * (traffic.sentBytes - previous.bytes.sentBytes)) / seconds,
          received: (8 * (traffic.receivedBytes - previous.bytes.receivedBytes)) / seconds,
        },
      });
    }
    previous = traffic ? { at, source: traffic, bytes: { ...traffic } } : undefined;

    if (target.directPeer && !readingRoute) {
      readingRoute = true;
      void readIceRoute(target.directPeer).then((route) => {
        if (current !== target) return;
        readingRoute = false;
        publish({ route });
      });
    }

    if (target.control && !probing) {
      probing = true;
      const record = (timedOut: boolean) => {
        if (current !== target) return;
        outcomes.push(timedOut);
        if (outcomes.length > MAX_PROBES) outcomes.shift();
        publish({ probes: { timedOut: outcomes.filter(Boolean).length, total: outcomes.length } });
      };
      void target.control
        .request('ping', {}, undefined, PROBE_TIMEOUT_MS)
        .then(
          ({ value }) => {
            if (value?.ok === true) record(false);
          },
          (error: unknown) => {
            if (error instanceof DeviceRequestTimeout) record(true);
          },
        )
        .finally(() => {
          if (current === target) probing = false;
        });
    }
  };
  const syncConnection = () => {
    if (document.hidden) return;
    const paths = read();
    if (current?.control !== paths.control || current?.directPeer !== paths.directPeer) sample(paths);
  };
  const visibility = () => {
    reset();
    sample();
  };
  const unsubscribe = subscribe(syncConnection);
  const timer = setInterval(sample, SAMPLE_MS);
  document.addEventListener('visibilitychange', visibility);
  sample();
  return () => {
    current = undefined;
    clearInterval(timer);
    unsubscribe();
    document.removeEventListener('visibilitychange', visibility);
  };
}
