import { browserId } from './browser-id';
import { watchNetworkDetails, type NetworkDetails, type LinkTraffic } from './network-telemetry';
import { DEFAULT_BACKEND, conversationKey, type BackendInfo, type ModelChoice } from '../shared/backends';
import { CipherWire, SecureChannel, type Identity, type Lane } from '../shared/secure-channel';
import { DeviceLink, type DeviceAuth } from '../shared/device-link';
import { apiCall, RpcError, type RpcCall } from '../shared/rpc';
import {
  desktopAuthorizationSchema,
  type DesktopAuthorization,
} from '../shared/desktop-authorization';
import { keybookSyncChallengeSchema, type KeybookSyncChallenge } from '../shared/keybook-sync';
import { applySync, checkpoint, contentVersion, type CachedThread } from '../shared/sync';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { SyncStore, type PairedHost } from './sync-store';
import type { GatewayStatus, ServerEvent, ThreadSummary, ThreadView } from '../shared/types';
import type { AgentUsage } from '../../packages/adapter-sdk/src/usage';
import type { UsageSnapshot } from '../shared/usage';
import type { CodexVoiceEvent, CodexVoiceMode } from '../shared/codex-voice';
import { diagnosticStatus, recordDiagnostic, type DiagnosticSignal } from './diagnostics';

export interface DeviceOverview {
  online: boolean | null;
  toolsChecked: boolean;
  backends: BackendInfo[];
  recent: (ThreadSummary & { backendId: string })[];
}

export interface DeviceNetworkStatus {
  control: 'direct' | 'relay' | null;
  latencyMs: number | null;
  highLatency: boolean;
  directBulk: boolean;
}

type ModelCatalog = { models: ModelChoice[]; source?: string };
type WarmHostSession = {
  key: string;
  host: PairedHost;
  identity: Identity;
  sessionId: string;
  links: Map<string, DeviceLink>;
  pc?: RTCPeerConnection;
  candidates: (RTCIceCandidateInit | null)[];
  statuses: Map<string, GatewayStatus>;
  networkTraffic: LinkTraffic;
  cleanup: () => void;
};

const WORKBENCH_RECENT_LIMIT = 24;
const WARM_HOST_LIMIT = 3;
const RELAY_STAGE_TIMEOUT = 10_000;
const DIRECT_NEGOTIATION_TIMEOUT = 25_000;
const DIRECT_DISCONNECTED_GRACE = 10_000;
const DIRECT_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 45_000, 60_000];
const HIGH_LATENCY_MS = 500;
const CONTROL_UNAVAILABLE_MS = 8000;
const relaySignals = new Map<string, DiagnosticSignal>([
  ['Host offline', 'adapter-offline'],
  ['Host reconnecting', 'host-reconnecting'],
  ['Connection rejected', 'relay-rejected'],
  ['Relay backpressure', 'relay-busy'],
  ['Authentication timeout', 'authentication-timeout'],
  ['Device connection limit', 'device-connection-limit'],
]);

class RelayUpgradeError extends RpcError {
  constructor() {
    super('电脑暂未连接', 0);
  }
}

export class DeviceSession {
  readonly cache = new SyncStore();
  backendId = DEFAULT_BACKEND;
  private statuses = new Map<string, GatewayStatus>();
  backendStatus(id: string) {
    return this.statuses.get(id);
  }
  private receiveStatus(id: string, status: GatewayStatus) {
    if (JSON.stringify(this.backendStatus(id)) === JSON.stringify(status)) return;
    this.statuses.set(id, status);
    if (id === this.backendId) this.status = status;
    this.changed();
  }
  selectBackend(id: string) {
    this.backendId = id;
    this.status = this.statuses.get(id);
    this.changed();
  }
  host?: PairedHost;
  status?: GatewayStatus;
  private identity?: Identity;
  private sessionId = browserId();
  private links = new Map<string, DeviceLink>();
  private linkUnsubscribes = new Map<string, () => void>();
  private warm = new Map<string, WarmHostSession>();
  private linkTraffic = new WeakMap<DeviceLink, { totals?: LinkTraffic }>();
  private networkTraffic: LinkTraffic = { sentBytes: 0, receivedBytes: 0 };
  private opening = new Map<string, Promise<DeviceLink>>();
  private linkLifetime = new AbortController();
  private connecting?: Promise<void>;
  private offlineSince?: number;
  private catalogRequests = new Map<string, Promise<ModelCatalog>>();
  private retry?: ReturnType<typeof setTimeout>;
  private peerRetry?: ReturnType<typeof setTimeout>;
  private peerDisconnectTimer?: ReturnType<typeof setTimeout>;
  private peerFailures = 0;
  private watchRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private waking = false;
  private attempt = 0;
  private pc?: RTCPeerConnection;
  private candidates: (RTCIceCandidateInit | null)[] = [];
  private watchers = new Map<string, Set<(event: ServerEvent) => void>>();
  private terminalListeners = new Set<(event: Record<string, any>, bytes?: Uint8Array) => void>();
  private usageWatchers = new Map<string, (snapshot: UsageSnapshot) => void>();
  private usageVersion = 0;
  private views = new Map<string, CachedThread>();
  private events = new EventTarget();
  private networkState: Readonly<DeviceNetworkStatus> = {
    control: null,
    latencyMs: null,
    highLatency: false,
    directBulk: false,
  };
  private networkLink?: DeviceLink;
  private networkProbe?: symbol;
  private networkConfirmation?: ReturnType<typeof setTimeout>;
  private slowSamples = 0;
  private missedSamples = 0;
  private running = false;
  private generation = 0;
  private listening = false;
  private processing = Promise.resolve();
  metrics = { relayBytes: 0, directBytes: 0, resyncs: 0, directAttempts: 0, directMillis: 0, fallback: '' };
  get direct() {
    return !!this.links.get('direct:control') && !this.links.get('direct:control')!.closed;
  }
  get directBulk() {
    const link = this.links.get('direct:bulk');
    return !!link && !link.closed;
  }
  get online() {
    return this.direct || (!!this.links.get('relay:control') && !this.links.get('relay:control')!.closed);
  }
  get establishingDirect() {
    return !!this.pc && !this.directBulk;
  }
  onChange(fn: () => void) {
    this.events.addEventListener('change', fn);
    return () => this.events.removeEventListener('change', fn);
  }
  get networkStatus() {
    return this.networkState;
  }
  onNetworkChange(fn: () => void) {
    this.events.addEventListener('network', fn);
    return () => this.events.removeEventListener('network', fn);
  }
  watchNetworkDetails(notify: (details: NetworkDetails) => void) {
    return watchNetworkDetails(
      () => ({
        control: this.networkLink,
        directPeer: this.direct || this.directBulk ? this.pc : undefined,
        traffic: this.online || this.directBulk ? this.networkTraffic : undefined,
      }),
      (notify) => this.onChange(notify),
      notify,
    );
  }
  private changed() {
    this.updateNetwork();
    this.events.dispatchEvent(new Event('change'));
  }
  private updateNetwork(latencyMs = this.networkState.latencyMs) {
    const control = this.direct ? 'direct' : this.online ? 'relay' : null;
    if (control) this.offlineSince = undefined;
    const link = control ? this.links.get(`${control}:control`) : undefined;
    const changedLink = this.networkLink !== link;
    if (changedLink) {
      this.networkLink = link;
      this.networkProbe = undefined;
      clearTimeout(this.networkConfirmation);
      this.slowSamples = 0;
      this.missedSamples = 0;
      latencyMs = null;
    }
    const directBulk = this.directBulk;
    const highLatency = this.slowSamples >= 2;
    if (
      this.networkState.control !== control ||
      this.networkState.latencyMs !== latencyMs ||
      this.networkState.highLatency !== highLatency ||
      this.networkState.directBulk !== directBulk
    ) {
      this.networkState = { control, latencyMs, highLatency, directBulk };
      this.events.dispatchEvent(new Event('network'));
    }
    if (changedLink && link) void this.measureNetwork();
  }
  private async measureNetwork() {
    const link = this.networkLink;
    if (!link || link.closed || this.networkProbe) return;
    const probe = (this.networkProbe = Symbol());
    const startedAt = performance.now();
    let confirm = false;
    try {
      await link.request('ping', {}, undefined, 10000);
      if (this.networkProbe !== probe || link.closed) return;
      const latency = Math.round(performance.now() - startedAt);
      this.missedSamples = 0;
      if (this.slowSamples === 1 && latency >= HIGH_LATENCY_MS)
        recordDiagnostic({
          code: 'control-high-latency',
          transport: this.networkState.control ?? undefined,
          elapsedMs: latency,
        });
      this.slowSamples = latency >= HIGH_LATENCY_MS ? Math.min(2, this.slowSamples + 1) : 0;
      confirm = this.slowSamples === 1;
      this.updateNetwork(latency);
    } catch {
      if (this.networkProbe === probe && !link.closed) {
        if (++this.missedSamples >= 2) {
          recordDiagnostic({
            code: 'control-probe-timeout',
            transport: this.networkState.control ?? undefined,
          });
          link.close();
        } else confirm = true;
      }
    } finally {
      if (this.networkProbe === probe) {
        this.networkProbe = undefined;
        clearTimeout(this.networkConfirmation);
        if (confirm) this.networkConfirmation = setTimeout(() => void this.measureNetwork(), 1000);
      }
    }
  }
  private key(suffix: string, backendId = this.backendId, host = this.host, phoneId = this.identity?.peerId) {
    return `${phoneId}:${host?.hostId}:${backendId === DEFAULT_BACKEND ? '' : `backend:${backendId}:`}${suffix}`;
  }
  contentKey(suffix: string, backendId = this.backendId) {
    return this.key(suffix, backendId);
  }
  modelCatalogKey(backendId = this.backendId) {
    if (this.identity && this.host) return `models:${this.cache.scope}:${this.key('catalog', backendId)}`;
  }
  refreshModelCatalog(backendId = this.backendId): Promise<ModelCatalog> {
    const key = this.modelCatalogKey(backendId);
    if (!key || !this.online) return Promise.reject(Error('电脑尚未连接'));
    const pending = this.catalogRequests.get(key);
    if (pending) return pending;
    const request = this.api<ModelCatalog>('/models', undefined, backendId)
      .then(async (catalog) => {
        if (this.catalogRequests.get(key) !== request || this.modelCatalogKey(backendId) !== key)
          throw Error('电脑已切换');
        if (!Array.isArray(catalog.models) || catalog.source === 'unavailable')
          throw Error('暂时无法读取原实例模型目录');
        const snapshot = { models: catalog.models, source: catalog.source };
        const saved = await this.cache.get<ModelCatalog>(key).catch(() => undefined);
        if (
          this.catalogRequests.get(key) === request &&
          this.modelCatalogKey(backendId) === key &&
          (this.cache.writeFailed || !saved || contentVersion(saved) !== contentVersion(snapshot))
        )
          this.cache.put(key, snapshot);
        return snapshot;
      })
      .finally(() => {
        if (this.catalogRequests.get(key) === request) this.catalogRequests.delete(key);
      });
    this.catalogRequests.set(key, request);
    return request;
  }
  async init() {
    const generation = this.generation;
    const host = this.host ?? (await this.cache.active());
    if (generation !== this.generation) return;
    this.host = host;
    if (host && !this.running) {
      const identity = this.identity ?? host.identity ?? (await this.cache.identity());
      if (generation !== this.generation) return;
      this.identity = identity;
      this.running = true;
      void this.connect();
    }
    if (!this.listening) {
      this.listening = true;
      window.addEventListener('online', this.wake);
      document.addEventListener('visibilitychange', this.wake);
      window.addEventListener('pageshow', this.wake);
      setInterval(() => void this.measureNetwork(), 20000);
    }
    return this.host;
  }
  private wake = () => {
    if (document.visibilityState === 'hidden' || this.waking) return;
    this.waking = true;
    void (async () => {
      await this.connect();
      void this.measureNetwork();
      // A surviving socket does not imply the phone received every foreground/background update.
      await this.resume();
      this.peerFailures = 0;
      if (!this.direct) this.schedulePeer();
    })()
      .catch(() => {})
      .finally(() => {
        this.waking = false;
      });
  };
  async pair(
    hostId: string,
    code: string,
    name: string,
    hostName?: string,
    options?: { signal?: AbortSignal; retryUntil?: number },
  ) {
    const { signal, retryUntil } = options ?? {};
    if (retryUntil !== undefined && retryUntil <= Date.now())
      throw new DOMException('Authorization expired', 'TimeoutError');
    const deadlineSignal =
      retryUntil === undefined
        ? signal
        : AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(Math.max(0, retryUntil - Date.now())),
          ]);
    signal?.throwIfAborted();
    this.disconnect();
    const generation = this.generation;
    const identity = this.identity ?? (await this.cache.identity());
    const checkPairing = () => {
      deadlineSignal?.throwIfAborted();
      if (retryUntil !== undefined && retryUntil <= Date.now())
        throw new DOMException('Authorization expired', 'TimeoutError');
      if (generation !== this.generation) throw Error('账号或电脑已切换，请重新配对');
    };
    checkPairing();
    this.identity = identity;
    const ticket = bytesToHex(sha256(new TextEncoder().encode(code)));
    const open = () =>
      this.openRelay(
        hostId,
        ticket,
        'control',
        { type: 'pair', protocol: 2, sessionId: this.sessionId, code, name },
        identity,
        deadlineSignal,
      );
    let link: DeviceLink;
    for (let attempt = 0; ; attempt++) {
      try {
        link = await open();
        break;
      } catch (error) {
        // An unopened WebSocket could not have sent a join or used the pairing code.
        if (!(error instanceof RelayUpgradeError) || (retryUntil === undefined && attempt > 0)) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 4000)));
        checkPairing();
      }
    }
    const ready = await link.ready;
    try {
      checkPairing();
    } catch (error) {
      link.close();
      throw error;
    }
    this.host = {
      hostId,
      name: hostName ?? ready.hostName,
      deviceId: ready.device.id,
      ticket: ready.ticket,
      phoneId: this.identity.peerId,
      identity: this.identity,
    };
    await this.cache.saveHost(this.host);
    if (generation !== this.generation) {
      link.close();
      throw Error('账号或电脑已切换');
    }
    this.running = true;
    this.attach(link, 'relay', 'control');
    this.schedulePeer();
    this.changed();
    void navigator.storage?.persist?.().catch(() => false);
    return this.host;
  }
  private hostSessionKey(host: Pick<PairedHost, 'hostId' | 'ticket' | 'phoneId'>) {
    return `${host.hostId}:${host.ticket}:${host.phoneId}`;
  }
  private closeWarmHost(entry: WarmHostSession) {
    entry.cleanup();
    entry.pc?.close();
    for (const link of entry.links.values()) link.close();
    entry.links.clear();
  }
  private clearWarmHosts() {
    for (const entry of this.warm.values()) this.closeWarmHost(entry);
    this.warm.clear();
  }
  private parkActiveHost() {
    if (!this.running || !this.host || !this.identity) return;
    const liveLinks = new Map<string, DeviceLink>();
    for (const [key, link] of this.links) {
      if (!link.closed) liveLinks.set(key, link);
    }
    if (!liveLinks.size) return;
    const control = liveLinks.get('direct:control') ?? liveLinks.get('relay:control');
    if (control && !control.closed) {
      for (const watchKey of this.watchers.keys()) {
        const [backendId, threadId] = JSON.parse(watchKey) as [string, string];
        void control.request('unwatch', { threadId, backendId }).catch(() => {});
      }
    }
    for (const unsubscribe of this.linkUnsubscribes.values()) unsubscribe();
    this.linkUnsubscribes.clear();
    const key = this.hostSessionKey(this.host);
    const existing = this.warm.get(key);
    if (existing) this.closeWarmHost(existing);
    const unsubscribes: (() => void)[] = [];
    const parkedPc =
      this.pc &&
      liveLinks.has('direct:control') &&
      this.pc.connectionState !== 'failed' &&
      this.pc.connectionState !== 'closed'
        ? this.pc
        : undefined;
    if (this.pc && !parkedPc) {
      this.pc.close();
    }
    const entry: WarmHostSession = {
      key,
      host: this.host,
      identity: this.identity,
      sessionId: this.sessionId,
      links: liveLinks,
      pc: parkedPc,
      candidates: parkedPc ? this.candidates : [],
      statuses: new Map(this.statuses),
      networkTraffic: this.networkTraffic,
      cleanup: () => {
        for (const fn of unsubscribes.splice(0)) fn();
      },
    };
    if (parkedPc) {
      const prevHandler = parkedPc.onconnectionstatechange;
      const onParkedState = () => {
        if (parkedPc.connectionState === 'failed' || parkedPc.connectionState === 'closed') {
          if (entry.pc === parkedPc) {
            entry.pc = undefined;
            entry.candidates = [];
            try {
              parkedPc.close();
            } catch {}
          }
        }
      };
      parkedPc.onconnectionstatechange = onParkedState;
      unsubscribes.push(() => {
        if (parkedPc.onconnectionstatechange === onParkedState) {
          parkedPc.onconnectionstatechange = prevHandler;
        }
      });
    }
    for (const [laneKey, link] of liveLinks) {
      const traffic = this.linkTraffic.get(link);
      if (traffic) traffic.totals = undefined;
      unsubscribes.push(
        link.onClose(() => {
          entry.links.delete(laneKey);
          if (laneKey === 'direct:control' && entry.pc) {
            const stalePc = entry.pc;
            entry.pc = undefined;
            entry.candidates = [];
            try {
              stalePc.close();
            } catch {}
          }
          if (
            (laneKey === 'relay:control' || laneKey === 'direct:control') &&
            !entry.links.has('relay:control') &&
            !entry.links.has('direct:control')
          ) {
            if (this.warm.get(key) === entry) {
              this.warm.delete(key);
              this.closeWarmHost(entry);
            }
          }
        }),
      );
    }
    this.warm.set(key, entry);
    while (this.warm.size > WARM_HOST_LIMIT) {
      const oldest = this.warm.values().next().value;
      if (!oldest) break;
      this.warm.delete(oldest.key);
      this.closeWarmHost(oldest);
    }
    // Detach parked transport references so resetActiveState does not close them.
    this.links = new Map();
    this.pc = undefined;
    this.candidates = [];
    this.networkTraffic = { sentBytes: 0, receivedBytes: 0 };
  }
  private resetActiveState() {
    this.running = false;
    this.generation++;
    this.linkLifetime.abort();
    this.linkLifetime = new AbortController();
    this.connecting = undefined;
    this.offlineSince = undefined;
    this.catalogRequests.clear();
    this.networkTraffic = { sentBytes: 0, receivedBytes: 0 };
    this.opening.clear();
    for (const timer of this.watchRetries.values()) clearTimeout(timer);
    this.watchRetries.clear();
    clearTimeout(this.retry);
    clearTimeout(this.peerRetry);
    clearTimeout(this.peerDisconnectTimer);
    this.peerFailures = 0;
    for (const unsubscribe of this.linkUnsubscribes.values()) unsubscribe();
    this.linkUnsubscribes.clear();
    this.closePeer();
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.watchers.clear();
    this.usageWatchers.clear();
    this.views.clear();
    this.status = undefined;
    this.statuses.clear();
    this.sessionId = browserId();
  }
  async select(host: PairedHost, persist = true) {
    if (
      this.running &&
      this.host?.hostId === host.hostId &&
      this.host.ticket === host.ticket &&
      this.host.phoneId === host.phoneId
    ) {
      this.host = host;
      if (persist) await this.cache.saveHost(host, false);
      this.changed();
      if (!this.online) await this.connect();
      return;
    }
    this.parkActiveHost();
    this.resetActiveState();
    const generation = this.generation;
    const identity = host.identity ?? (await this.cache.identity());
    if (generation !== this.generation) return;
    const warmKey = this.hostSessionKey(host);
    const warm = this.warm.get(warmKey);
    if (warm) this.warm.delete(warmKey);
    this.host = host;
    this.identity = warm?.identity ?? identity;
    if (persist) await this.cache.saveHost(host, false);
    if (generation !== this.generation) {
      if (warm) this.closeWarmHost(warm);
      return;
    }
    this.running = true;
    if (warm) {
      warm.cleanup();
      this.sessionId = warm.sessionId;
      if (warm.pc && warm.pc.connectionState !== 'failed' && warm.pc.connectionState !== 'closed') {
        this.pc = warm.pc;
        this.candidates = warm.candidates;
      } else {
        try {
          warm.pc?.close();
        } catch {}
        this.pc = undefined;
        this.candidates = [];
      }
      this.statuses = warm.statuses;
      this.status = this.statuses.get(this.backendId);
      this.networkTraffic = warm.networkTraffic;
      for (const [laneKey, link] of warm.links) {
        if (link.closed) continue;
        const [path, lane] = laneKey.split(':') as ['relay' | 'direct', Lane];
        this.attach(link, path, lane);
      }
      this.changed();
      if (!this.online) {
        await this.connect();
      } else {
        if (!this.direct && !this.pc) this.schedulePeer();
        void this.measureNetwork();
      }
      return;
    }
    this.changed();
    await this.connect();
  }
  async renameHost(host: PairedHost, name: string) {
    const renamed = await this.cache.renameHost(host.hostId, name);
    if (renamed && this.host?.hostId === host.hostId && this.host.ticket === renamed.ticket) {
      this.host = renamed;
      this.changed();
    }
  }

  async overview(host: PairedHost, signal: AbortSignal, publish: (result: DeviceOverview) => void) {
    const scope = this.cache.scope;
    const current = () => !signal.aborted && scope === this.cache.scope;
    const identity = host.identity ?? (await this.cache.identity(scope));
    const cached = async <T>(path: string, backendId: string) =>
      (
        await this.cache.get<{ hash: string; value: T }>(
          this.key(`rpc:${contentVersion(apiCall(path))}`, backendId, host, identity.peerId),
        )
      )?.value;
    let online: boolean | null = null;
    let toolsChecked = false;
    let backends = (await cached<{ backends: BackendInfo[] }>('/backends', DEFAULT_BACKEND))?.backends ?? [];
    const recent = new Map<string, ThreadSummary[]>();
    const emit = () => {
      if (current())
        publish({
          online,
          toolsChecked,
          backends,
          recent: [...recent]
            .flatMap(([backendId, threads]) => threads.map((thread) => ({ ...thread, backendId })))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, WORKBENCH_RECENT_LIMIT),
        });
    };
    await Promise.all(
      backends.map(async (backend) => {
        const result = await cached<{ threads: ThreadSummary[] }>('/threads', backend.id);
        if (result) recent.set(backend.id, result.threads);
      }),
    );
    emit();
    if (!current()) return;
    const active = this.host?.hostId === host.hostId && this.host.ticket === host.ticket && this.running;
    const warmEntry = !active ? this.warm.get(this.hostSessionKey(host)) : undefined;
    const warmLink = warmEntry
      ? (warmEntry.links.get('direct:control') ?? warmEntry.links.get('relay:control'))
      : undefined;
    const reuseWarm = !!warmLink && !warmLink.closed;
    let link: DeviceLink | undefined;
    const closeProbe = () => {
      if (!active && !reuseWarm) link?.close();
    };
    try {
      if (active && !this.online) await this.connect();
      if (!current()) return;
      link = active
        ? this.link()
        : reuseWarm
          ? warmLink
          : await this.openRelay(
              host.hostId,
              host.ticket,
              'control',
              { type: 'authenticate', protocol: 2, sessionId: browserId() },
              identity,
              signal,
            );
      if (!current()) return;
      signal.addEventListener('abort', closeProbe, { once: true });
      online = true;
      const read = async <T>(path: string, backendId: string): Promise<T> => {
        const call = apiCall(path);
        const key = this.key(`rpc:${contentVersion(call)}`, backendId, host, identity.peerId);
        const { value } = await link!.request('rpc', { call: { ...call, backendId } }, undefined, 6000);
        if (current()) this.cache.put(key, { hash: contentVersion(value), value });
        return value;
      };
      backends = (await read<{ backends: BackendInfo[] }>('/backends', DEFAULT_BACKEND)).backends;
      toolsChecked = true;
      for (const id of recent.keys()) if (!backends.some((backend) => backend.id === id)) recent.delete(id);
      emit();
      await Promise.allSettled(
        backends.map(async (backend) => {
          if (backend.capabilities?.history.state === 'unsupported') return;
          const { threads } = await read<{ threads: ThreadSummary[] }>('/threads', backend.id);
          recent.set(backend.id, threads);
          emit();
        }),
      );
    } catch {
      online ??= false;
      emit();
    } finally {
      signal.removeEventListener('abort', closeProbe);
      closeProbe();
    }
  }
  resetAccount(scope: string) {
    this.disconnect();
    this.host = undefined;
    this.identity = undefined;
    this.status = undefined;
    this.statuses.clear();
    this.views.clear();
    this.watchers.clear();
    this.cache.scope = scope;
    void import('./file-client').then((module) => module.clearFileProviders());
    this.changed();
  }
  private auth(): DeviceAuth {
    return { type: 'authenticate', protocol: 2, sessionId: this.sessionId };
  }
  connect() {
    if (this.connecting) return this.connecting;
    if (!this.running || !this.host || this.links.get('relay:control')?.closed === false)
      return Promise.resolve();
    const attempt = this.connectControl().finally(() => {
      if (this.connecting === attempt) this.connecting = undefined;
    });
    this.connecting = attempt;
    return attempt;
  }
  private async connectControl() {
    const generation = this.generation;
    try {
      await this.relay('control');
      if (generation !== this.generation) return;
      this.offlineSince = undefined;
      this.attempt = 0;
      this.schedulePeer();
    } catch (error) {
      if (generation === this.generation)
        this.metrics.fallback = error instanceof Error ? error.message : '电脑离线或中继暂不可用';
    } finally {
      if (generation === this.generation) {
        clearTimeout(this.retry);
        if (this.running && !this.links.get('relay:control'))
          this.retry = setTimeout(
            () => void this.connect(),
            Math.min(15000, 500 * 2 ** this.attempt++ * (1 + Math.random() * 0.2)),
          );
        this.changed();
      }
    }
  }
  private async openRelay(
    hostId: string,
    ticket: string,
    lane: Lane,
    auth: DeviceAuth,
    identity = this.identity!,
    signal?: AbortSignal,
    observeControl = false,
  ): Promise<DeviceLink> {
    signal?.throwIfAborted();
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/connect`);
    const generation = this.generation;
    if (observeControl && !this.online) this.offlineSince ??= performance.now();
    let stage: 'websocket' | 'relay-ticket' | 'relay-join' | 'encrypted-handshake' | 'device-auth' =
      'websocket';
    let closeCode: number | undefined;
    let closeSignal: DiagnosticSignal | undefined;
    const abort = () => ws.close();
    signal?.addEventListener('abort', abort, { once: true });
    ws.binaryType = 'arraybuffer';
    const traffic: { totals?: LinkTraffic } = {};
    const wire = new CipherWire(
      async (bytes) => {
        const deadline = Date.now() + 10000;
        while (ws.bufferedAmount > 256 * 1024 && ws.readyState === WebSocket.OPEN && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 10));
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256 * 1024)
          throw Error('Relay unavailable');
        ws.send(bytes as Uint8Array<ArrayBuffer>);
        if (traffic.totals) traffic.totals.sentBytes += bytes.byteLength;
      },
      () => ws.close(),
    );
    let timer: ReturnType<typeof setTimeout>;
    try {
      await new Promise<void>((resolve, reject) => {
        let upgraded = false;
        const timeout = (error: RpcError) =>
          setTimeout(() => {
            reject(error);
            ws.close();
          }, RELAY_STAGE_TIMEOUT);
        timer = timeout(new RelayUpgradeError());
        ws.onopen = () => {
          upgraded = true;
          stage = 'relay-join';
          clearTimeout(timer);
          timer = timeout(new RpcError('连接未完成，请重试', 0));
        };
        ws.onmessage = (e) => {
          if (e.data instanceof ArrayBuffer) {
            if (traffic.totals) traffic.totals.receivedBytes += e.data.byteLength;
            wire.onData(new Uint8Array(e.data));
            return;
          }
          const msg = JSON.parse(e.data);
          if (msg.type === 'challenge') {
            void (async () => {
              let resourceToken: string | undefined;
              if (msg.resources) {
                stage = 'relay-ticket';
                const response = await fetch('/api/im/resources/relay-ticket', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ hostId, lane, ticket }),
                  signal,
                });
                const result = await response.json();
                if (!response.ok) throw new RpcError(result.error ?? '请先登录后使用中转', response.status);
                resourceToken = result.token;
              }
              stage = 'relay-join';
              if (ws.readyState === WebSocket.OPEN)
                ws.send(
                  JSON.stringify({
                    type: 'join',
                    hostId,
                    lane,
                    ticket,
                    ...(resourceToken ? { resourceToken } : {}),
                  }),
                );
            })().catch((error) => {
              clearTimeout(timer);
              reject(error);
              ws.close();
            });
          }
          if (msg.type === 'joined') {
            clearTimeout(timer);
            resolve();
          }
        };
        ws.onclose = (event) => {
          closeCode = event.code;
          closeSignal = relaySignals.get(event.reason);
          clearTimeout(timer);
          wire.onTransportClosed();
          reject(
            signal?.aborted
              ? signal.reason
              : upgraded
                ? new RpcError(event.reason || '电脑离线或配对失效', 0)
                : new RelayUpgradeError(),
          );
        };
        ws.onerror = () => ws.close();
      });
      stage = 'encrypted-handshake';
      const channel = await SecureChannel.open(wire, identity, true, lane, hostId);
      stage = 'device-auth';
      const link = await DeviceLink.authenticate(channel, auth);
      this.linkTraffic.set(link, traffic);
      return link;
    } catch (error) {
      if (
        observeControl &&
        generation === this.generation &&
        !this.online &&
        this.offlineSince !== undefined
      ) {
        const elapsedMs = Math.round(performance.now() - this.offlineSince);
        if (elapsedMs >= CONTROL_UNAVAILABLE_MS || closeSignal === 'device-connection-limit')
          recordDiagnostic({
            code: 'control-unavailable',
            stage,
            closeCode,
            signal: closeSignal,
            status: diagnosticStatus(error),
            elapsedMs,
            transport: 'relay',
          });
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  private async relay(lane: Lane) {
    const key = `relay:${lane}`,
      old = this.links.get(key);
    if (old && !old.closed) return old;
    if (this.opening.has(key)) return this.opening.get(key)!;
    const generation = this.generation;
    const promise = this.openRelay(
      this.host!.hostId,
      this.host!.ticket,
      lane,
      this.auth(),
      this.identity!,
      this.linkLifetime.signal,
      lane === 'control',
    ).then((link) => {
      if (generation !== this.generation || !this.running) {
        link.close();
        throw Error('Device switched');
      }
      this.attach(link, 'relay', lane);
      return link;
    });
    this.opening.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.opening.get(key) === promise) this.opening.delete(key);
    }
  }
  private attach(link: DeviceLink, path: 'relay' | 'direct', lane: Lane) {
    const generation = this.generation;
    const key = `${path}:${lane}`;
    const previous = this.links.get(key);
    this.linkUnsubscribes.get(key)?.();
    this.linkUnsubscribes.delete(key);
    if (previous && previous !== link) previous.close();
    this.links.set(key, link);
    if (path === 'direct' && lane === 'control') this.peerFailures = 0;
    const traffic = this.linkTraffic.get(link);
    if (traffic) traffic.totals = this.networkTraffic;
    void link.ready.then((ready) => {
      if (generation !== this.generation || this.links.get(key) !== link || link.closed) return;
      this.statuses.set(DEFAULT_BACKEND, ready.status);
      if (this.backendId === DEFAULT_BACKEND) this.status = ready.status;
      this.changed();
    });
    const unsubClose = link.onClose(() => {
      if (traffic) traffic.totals = undefined;
      if (generation !== this.generation || this.links.get(key) !== link) return;
      this.links.delete(key);
      this.linkUnsubscribes.delete(key);
      this.changed();
      if (lane === 'control') {
        void this.resume();
        if (path === 'direct') {
          this.closePeer();
          this.schedulePeer(this.nextPeerRetryDelay());
        } else void this.connect();
      }
    });
    const unsubEvent = link.onEvent((event, bytes) => {
      if (generation !== this.generation || this.links.get(key) !== link) return;
      if (event.type === 'terminal-output' || event.type === 'terminal-exit') {
        for (const listener of this.terminalListeners) listener(event, bytes);
        return;
      }
      if (event.type === 'usage') {
        if (generation === this.generation && this.online && this.link() === link)
          this.usageWatchers.get(event.backendId)?.(event.snapshot);
        return;
      }
      const watchKey =
        event.type === 'sync'
          ? conversationKey(event.backendId ?? DEFAULT_BACKEND, event.threadId)
          : undefined;
      const listeners = watchKey ? this.watchers.get(watchKey) : undefined;
      // Do not queue large snapshots for chats that were already left.
      if (watchKey && !listeners) return;
      this.processing = this.processing
        .then(() => {
          if (generation !== this.generation || this.links.get(key) !== link) return;
          if (watchKey && this.watchers.get(watchKey) !== listeners) return;
          return this.receive(event);
        })
        .catch(() => {
          this.metrics.resyncs++;
          void this.resume();
        });
    });
    this.linkUnsubscribes.set(key, () => {
      unsubClose();
      unsubEvent();
    });
    if (lane === 'control') void this.resume();
    this.changed();
  }
  private link(lane: Lane = 'control') {
    for (const path of ['direct', 'relay']) {
      const link = this.links.get(`${path}:${lane}`);
      if (link && !link.closed) return link;
    }
    throw new RpcError('电脑未连接，当前显示缓存内容', 0);
  }
  onTerminalEvent(listener: (event: Record<string, any>, bytes?: Uint8Array) => void) {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }
  async terminalRequest(
    type: 'terminal-attach' | 'terminal-detach' | 'terminal-input' | 'terminal-resize',
    data: Record<string, unknown>,
    bytes?: Uint8Array,
    timeout = 15000,
  ) {
    if (!this.online) await this.connect();
    return this.link('control').request(type, data, bytes, timeout);
  }
  async rpcBinary<T = any>(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    bytes?: Uint8Array,
    backendId = this.backendId,
    timeout = 30000,
  ): Promise<{ value: T; bytes?: Uint8Array }> {
    if (!this.online) await this.connect();
    const call = { ...apiCall(path, method, body), backendId };
    return this.link('control').request('rpc', { call }, bytes, timeout);
  }
  async requestOnHost<T>(
    host: PairedHost,
    path: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const call = apiCall(path, method, body);
    if (this.host?.hostId === host.hostId && this.host.ticket === host.ticket && this.running) {
      if (!this.online) await this.connect();
      return this.link('control').rpc<T>(call);
    }
    const warmEntry = this.warm.get(this.hostSessionKey(host));
    const warmLink = warmEntry
      ? (warmEntry.links.get('direct:control') ?? warmEntry.links.get('relay:control'))
      : undefined;
    if (warmLink && !warmLink.closed) return warmLink.rpc<T>(call);
    const identity = host.identity ?? (await this.cache.identity(this.cache.scope));
    const link = await this.openRelay(
      host.hostId,
      host.ticket,
      'control',
      { type: 'authenticate', protocol: 2, sessionId: browserId() },
      identity,
      signal,
    );
    try {
      return await link.rpc<T>(call);
    } finally {
      link.close();
    }
  }
  voice(
    hostId: string,
    backendId: string,
    threadId: string,
    mode: CodexVoiceMode,
    onEvent: (event: CodexVoiceEvent) => void,
  ) {
    if (this.host?.hostId !== hostId) throw new RpcError('电脑已切换，请重新打开语音', 409);
    // Keep signaling on the authenticated control link that owns this call.
    const link = this.link();
    const sessionId = crypto.randomUUID();
    const scope = { backendId, threadId, sessionId };
    const unsubscribe = link.onEvent((message) => {
      if (
        message.type === 'voice-event' &&
        message.sessionId === sessionId &&
        message.backendId === backendId &&
        message.threadId === threadId
      )
        onEvent(message.event);
    });
    const unsubscribeClose = link.onClose(() => onEvent({ type: 'error', message: '电脑连接已中断' }));
    return {
      start: (sdp: string) => link.request('voice-start', { ...scope, mode, sdp }, undefined, 12000),
      stop: () => link.request('voice-stop', scope, undefined, 5000),
      heartbeat: () => link.request('voice-keepalive', scope, undefined, 8000),
      dispose: () => {
        unsubscribe();
        unsubscribeClose();
      },
    };
  }
  private async receive(event: Record<string, any>) {
    if (event.type === 'candidate') {
      const candidate = event.candidate ?? null;
      if (this.pc?.remoteDescription) {
        try {
          await this.pc.addIceCandidate(candidate);
        } catch {}
      } else {
        this.candidates.push(candidate);
      }
    } else if (event.type === 'direct-closed') {
      this.closePeer();
      this.schedulePeer();
    } else if (event.type === 'sync') {
      const backendId = event.backendId ?? DEFAULT_BACKEND,
        key = conversationKey(backendId, event.threadId);
      const listeners = this.watchers.get(key),
        generation = this.generation;
      if (!listeners) return;
      const cacheKey = this.key(`thread:${event.threadId}`, backendId);
      const old = this.views.get(key) ?? (await this.cache.get<CachedThread>(cacheKey));
      if (generation !== this.generation || this.watchers.get(key) !== listeners) return;
      let next = old ?? null;
      for (const update of event.updates) {
        next = applySync(next, update);
        if (!next) break;
      }
      if (!next) {
        this.views.delete(key);
        this.metrics.resyncs++;
        await this.watchRemote(key, false);
        return;
      }
      this.views.set(key, next);
      this.cache.put(cacheKey, next);
      for (const fn of listeners) fn({ type: 'thread', thread: next.view });
    } else if (event.type === 'event') {
      const backendId = event.backendId ?? DEFAULT_BACKEND;
      if (event.event.type === 'status') {
        this.receiveStatus(backendId, event.event.status);
      }
      for (const [key, listeners] of this.watchers) {
        const [watchedBackend, watchedThread] = JSON.parse(key);
        if (watchedBackend === backendId && (!event.threadId || event.threadId === watchedThread))
          for (const fn of listeners) fn(event.event);
      }
    }
  }
  subscribe(threadId: string, fn: (event: ServerEvent) => void, backendId = this.backendId) {
    const key = conversationKey(backendId, threadId);
    const generation = this.generation;
    const listeners = this.watchers.get(key) ?? new Set();
    listeners.add(fn);
    this.watchers.set(key, listeners);
    void (async () => {
      const cached =
        this.views.get(key) ??
        (await this.cache.get<CachedThread>(this.key(`thread:${threadId}`, backendId)));
      if (generation !== this.generation || this.watchers.get(key) !== listeners || !listeners.has(fn))
        return;
      if (cached) {
        this.views.set(key, cached);
        fn({
          type: 'thread',
          thread: {
            ...cached.view,
            synchronized: false,
            boundedQuestionAvailable: false,
            canResumeForSend: false,
            textOnlySend: false,
            canSendFileReferences: false,
            canSend: false,
            canInterrupt: false,
            reason: null,
          },
        });
      }
      await this.watchRemote(key);
    })().catch(() => {});
    return () => {
      listeners.delete(fn);
      if (!listeners.size && this.watchers.get(key) === listeners) {
        this.watchers.delete(key);
        // SyncStore retains the history on disk and has its own bounded memory cache.
        this.views.delete(key);
        clearTimeout(this.watchRetries.get(key));
        this.watchRetries.delete(key);
        if (this.online)
          void this.link()
            .request('unwatch', { threadId, backendId })
            .catch(() => {});
      }
    };
  }
  private async watchRemote(key: string, useCache = true) {
    const [backendId, threadId] = JSON.parse(key) as [string, string];
    if (!this.online || !this.watchers.has(key)) return;
    clearTimeout(this.watchRetries.get(key));
    this.watchRetries.delete(key);
    const generation = this.generation;
    try {
      await this.link().request('watch', {
        threadId,
        backendId,
        known: useCache ? checkpoint(this.views.get(key) ?? null) : undefined,
      });
    } catch (error) {
      if (generation !== this.generation || !this.watchers.has(key)) return;
      if (this.online)
        recordDiagnostic({
          code: 'workbench-subscription-failed',
          page: 'workbench',
          status: diagnosticStatus(error),
          transport: this.networkState.control ?? undefined,
        });
      if (error instanceof RpcError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        for (const fn of this.watchers.get(key) ?? []) fn({ type: 'error', message: error.message });
        return;
      }
      // Retry subscription confirmation even when the transport itself stays connected.
      this.watchRetries.set(
        key,
        setTimeout(() => {
          this.watchRetries.delete(key);
          void this.watchRemote(key, useCache);
        }, 1500),
      );
    }
  }
  private async resume() {
    for (const id of this.watchers.keys()) await this.watchRemote(id).catch(() => {});
  }
  watchUsage(backendId: string, notify: (snapshot: UsageSnapshot) => void) {
    const generation = this.generation;
    let selected: DeviceLink | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const current = (link: DeviceLink) => !disposed && generation === this.generation && selected === link;
    const update = (link: DeviceLink, watching: boolean) =>
      link.request('usage-watch', { backendId, watching, version: ++this.usageVersion }, undefined, 5000);
    const stopWatching = (link?: DeviceLink) => {
      if (!link || link.closed) return;
      void update(link, false).catch(() => {});
    };
    const receive = (snapshot: UsageSnapshot) => {
      if (!disposed && selected && generation === this.generation) notify(snapshot);
    };
    const legacy = async (link: DeviceLink) => {
      try {
        const value = await link.rpc<AgentUsage>({ ...apiCall('/usage'), backendId });
        if (current(link)) notify({ state: value.available ? 'current' : 'unavailable', value });
      } catch {
        if (current(link)) notify({ state: 'stale' });
      } finally {
        if (current(link)) timer = setTimeout(() => void legacy(link), 60_000);
      }
    };
    const subscribe = (link: DeviceLink) => {
      void update(link, true).catch((error) => {
        if (!current(link)) return;
        if (error instanceof RpcError && [400, 404].includes(error.status)) void legacy(link);
        else {
          notify({ state: 'stale' });
          timer = setTimeout(() => subscribe(link), 5000);
        }
      });
    };
    const sync = () => {
      const next =
        generation === this.generation && this.online && document.visibilityState !== 'hidden'
          ? this.link()
          : undefined;
      if (next === selected) return;
      clearTimeout(timer);
      const previous = selected;
      selected = next;
      if (next) subscribe(next);
      else {
        stopWatching(previous);
        notify({ state: 'stale' });
      }
    };
    this.usageWatchers.set(backendId, receive);
    const unsubscribe = this.onChange(sync);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (this.usageWatchers.get(backendId) === receive) {
        this.usageWatchers.delete(backendId);
        if (generation === this.generation && this.online) stopWatching(this.link());
      }
      unsubscribe();
      document.removeEventListener('visibilitychange', sync);
    };
  }
  private schedulePeer(delay = 300) {
    clearTimeout(this.peerRetry);
    if (!this.running || this.direct || this.pc || !this.online) return;
    this.peerRetry = setTimeout(() => void this.startPeer(), delay);
  }
  private nextPeerRetryDelay() {
    const index = Math.min(this.peerFailures, DIRECT_RETRY_DELAYS_MS.length - 1);
    this.peerFailures++;
    return DIRECT_RETRY_DELAYS_MS[index];
  }
  private closePeer() {
    clearTimeout(this.peerDisconnectTimer);
    this.peerDisconnectTimer = undefined;
    this.pc?.close();
    this.pc = undefined;
    this.candidates = [];
    this.links.get('direct:control')?.close();
    this.links.get('direct:bulk')?.close();
  }
  private async startPeer() {
    const relay = this.links.get('relay:control');
    const host = this.host;
    const identity = this.identity;
    if (!relay || this.pc || !host || !identity) return;
    const auth = this.auth();
    const ready = await relay.ready;
    if (this.host !== host || this.pc || !ready.p2p.enabled || !globalThis.RTCPeerConnection) return;
    const start = performance.now();
    this.metrics.directAttempts++;
    let pc: RTCPeerConnection;
    try {
      pc = this.pc = new RTCPeerConnection({
        iceServers: ready.p2p.stunUrls.length ? [{ urls: ready.p2p.stunUrls }] : [],
        iceCandidatePoolSize: 2,
      });
    } catch {
      this.metrics.fallback = '当前浏览器无法建立直连';
      return;
    }
    let offered = false;
    const pending: (RTCIceCandidateInit | null)[] = [];
    const sendCandidate = (candidate: RTCIceCandidateInit | null) =>
      relay.request('candidate', { candidate }).catch(() => {});
    const recordIceFailure = () =>
      recordDiagnostic({
        code: 'direct-negotiation-failed',
        stage: 'ice',
        elapsedMs: Math.round(performance.now() - start),
      });
    const timer = setTimeout(() => {
      if (!this.direct && this.pc === pc) {
        recordIceFailure();
        this.closePeer();
        this.metrics.fallback = '直连超时，使用加密中继';
        this.schedulePeer(this.nextPeerRetryDelay());
      }
    }, DIRECT_NEGOTIATION_TIMEOUT);
    pc.onicecandidate = (e) => {
      const candidate = e.candidate ? e.candidate.toJSON() : null;
      if (offered) void sendCandidate(candidate);
      else pending.push(candidate);
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === 'connected') {
        clearTimeout(this.peerDisconnectTimer);
        this.peerDisconnectTimer = undefined;
      } else if (pc.connectionState === 'disconnected') {
        clearTimeout(this.peerDisconnectTimer);
        this.peerDisconnectTimer = setTimeout(() => {
          if (this.pc === pc && pc.connectionState !== 'connected') {
            clearTimeout(timer);
            this.closePeer();
            this.schedulePeer(this.nextPeerRetryDelay());
          }
        }, DIRECT_DISCONNECTED_GRACE);
      } else if (pc.connectionState === 'failed') {
        clearTimeout(timer);
        recordIceFailure();
        this.closePeer();
        this.schedulePeer(this.nextPeerRetryDelay());
      }
    };
    for (const lane of ['control', 'bulk'] as const) {
      const dc = pc.createDataChannel(`pocket-${lane}-v2`, { ordered: true });
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = 64 * 1024;
      const traffic: { totals?: LinkTraffic } = {};
      const wire = new CipherWire(
        async (bytes) => {
          if (dc.bufferedAmount > 256 * 1024)
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(() => {
                dc.removeEventListener('bufferedamountlow', done);
                reject(Error('Direct backpressure'));
              }, 10000);
              const done = () => {
                clearTimeout(t);
                resolve();
              };
              dc.addEventListener('bufferedamountlow', done, { once: true });
            });
          dc.send(bytes as Uint8Array<ArrayBuffer>);
          if (traffic.totals) traffic.totals.sentBytes += bytes.byteLength;
        },
        () => dc.close(),
      );
      dc.onmessage = (e) => {
        if (traffic.totals) traffic.totals.receivedBytes += e.data.byteLength;
        wire.onData(new Uint8Array(e.data));
      };
      dc.onclose = () => wire.onTransportClosed();
      dc.onopen = () => {
        void (async () => {
          const channel = await SecureChannel.open(wire, identity, true, lane, host.hostId);
          const link = await DeviceLink.authenticate(channel, auth);
          if (this.pc !== pc || this.host !== host) {
            link.close();
            return;
          }
          this.linkTraffic.set(link, traffic);
          this.attach(link, 'direct', lane);
          if (lane === 'control') {
            this.metrics.directMillis = performance.now() - start;
            clearTimeout(timer);
          }
        })().catch(() => dc.close());
      };
    }
    try {
      await pc.setLocalDescription(await pc.createOffer());
      const { value } = await relay.request('offer', { sdp: pc.localDescription!.sdp });
      if (this.pc !== pc) return;
      offered = true;
      await pc.setRemoteDescription({ type: 'answer', sdp: value.sdp });
      const remoteQueued = this.candidates.splice(0);
      const localQueued = pending.splice(0);
      void Promise.allSettled(localQueued.map((candidate) => sendCandidate(candidate)));
      for (const candidate of remoteQueued) {
        try {
          await pc.addIceCandidate(candidate);
        } catch {}
      }
    } catch {
      clearTimeout(timer);
      if (this.pc === pc) {
        this.closePeer();
        this.schedulePeer(this.nextPeerRetryDelay());
      }
    }
  }
  async request(
    type: string,
    data: Record<string, unknown>,
    bytes?: Uint8Array,
    bulk = false,
    backendId = this.backendId,
  ) {
    const generation = this.generation;
    if (type === 'file') data = { backendId, ...data };
    if (!this.online) await this.connect();
    if (generation !== this.generation) throw new RpcError('电脑已切换，请重试', 0);
    if (bulk && !this.links.get('direct:bulk')) await this.relay('bulk');
    if (generation !== this.generation) throw new RpcError('电脑已切换，请重试', 0);
    const link = this.link(bulk ? 'bulk' : 'control');
    const extended =
      bulk || (type === 'file' && (data.action === 'storage-plan' || data.action === 'storage-import'));
    const result = await link.request(type, data, bytes, extended ? 120000 : 30000);
    this.metrics[
      link === this.links.get(`direct:${bulk ? 'bulk' : 'control'}`) ? 'directBytes' : 'relayBytes'
    ] += (bytes?.length ?? 0) + (result.bytes?.length ?? 0) + JSON.stringify(result.value ?? null).length;
    return result;
  }
  async cachedThread(threadId: string, backendId = this.backendId): Promise<ThreadView | undefined> {
    await this.init();
    return (
      this.views.get(conversationKey(backendId, threadId)) ??
      (await this.cache.get<CachedThread>(this.key(`thread:${threadId}`, backendId)))
    )?.view;
  }
  /** Credentials use the paired Noise channel without entering the history/RPC cache or changing hosts. */
  async securityBackup<T>(
    host: PairedHost,
    body?: { proof: string; document: string },
    signal?: AbortSignal,
  ): Promise<T> {
    const query = body
      ? ''
      : `?accountId=${encodeURIComponent(this.cache.scope)}&origin=${encodeURIComponent(location.origin)}`;
    return this.securityRequest(
      host,
      apiCall(`/security/backup${query}`, body ? 'POST' : 'GET', body),
      signal,
    );
  }
  async claimDesktop(host: PairedHost, signal?: AbortSignal): Promise<DesktopAuthorization> {
    const value = await this.securityRequest<{ authorization: unknown }>(
      host,
      apiCall('/desktop/claim', 'POST', {}),
      signal,
    );
    return desktopAuthorizationSchema.parse(value?.authorization);
  }
  async securityBackupChallenge(
    host: PairedHost,
    accountId: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<KeybookSyncChallenge> {
    const value = await this.securityRequest(
      host,
      apiCall('/security/backup/challenge', 'POST', {
        origin: location.origin,
        accountId,
        revision,
      }),
      signal,
    );
    return keybookSyncChallengeSchema.parse(value);
  }
  private async securityRequest<T>(host: PairedHost, call: RpcCall, signal?: AbortSignal): Promise<T> {
    const generation = this.generation,
      scope = this.cache.scope;
    const identity = host.identity ?? (await this.cache.identity(scope));
    const current = () => {
      signal?.throwIfAborted();
      if (generation !== this.generation || scope !== this.cache.scope)
        throw new RpcError('账号或电脑已切换，请重试', 0);
    };
    current();
    const link = await this.openRelay(
      host.hostId,
      host.ticket,
      'control',
      { type: 'authenticate', protocol: 2, sessionId: browserId() },
      identity,
      signal,
    );
    const close = () => link.close();
    signal?.addEventListener('abort', close, { once: true });
    try {
      current();
      const { value } = await link.request('rpc', { call }, undefined, 10000);
      current();
      return value as T;
    } finally {
      signal?.removeEventListener('abort', close);
      close();
    }
  }
  async cached<T>(path: string, backendId = this.backendId): Promise<T | undefined> {
    await this.init();
    const entry = await this.cache.get<{ value: T }>(
      this.key(`rpc:${contentVersion(apiCall(path))}`, backendId),
    );
    return entry?.value;
  }
  async api<T>(path: string, init?: RequestInit, backendId = this.backendId): Promise<T> {
    const generation = this.generation;
    await this.init();
    if (generation !== this.generation) throw new RpcError('电脑已切换，请重试', 0);
    if (!this.host) throw new RpcError('请先扫码配对', 401);
    const call = apiCall(
      path,
      init?.method,
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    );
    if (call.method === 'session.read')
      return {
        device: { id: this.host.deviceId },
        status: this.backendStatus(backendId),
      } as T;
    const cacheable =
      (init?.method ?? 'GET') === 'GET' &&
      ![
        'operation.read',
        'operations.list',
        'status.read',
        'models.list',
        'usage.read',
        'backends.appearance.read',
      ].includes(call.method);
    const key = this.key(`rpc:${contentVersion(call)}`, backendId),
      old = cacheable ? await this.cache.get<{ hash: string; value: T }>(key) : undefined;
    if (generation !== this.generation) throw new RpcError('电脑已切换，请重试', 0);
    if (!this.online) {
      if (old) return old.value;
      await this.connect();
    }
    if (generation !== this.generation) throw new RpcError('电脑已切换，请重试', 0);
    const { value } = await this.request('rpc', { call: { ...call, backendId }, knownHash: old?.hash });
    if (generation !== this.generation) throw new RpcError('电脑已切换，请重试', 0);
    if (call.method === 'status.read' && value) this.receiveStatus(backendId, value as GatewayStatus);
    if (value?.cacheHit && old) {
      if (this.cache.writeFailed) this.cache.put(key, old);
      return old.value;
    }
    if (cacheable) {
      const hash = contentVersion(value);
      if (hash !== old?.hash || this.cache.writeFailed) this.cache.put(key, { hash, value });
    }
    return value;
  }
  async forget() {
    if (!this.host) return;
    await this.forgetHost(this.host);
  }
  async forgetHost(host: PairedHost) {
    const scope = this.cache.scope;
    if (this.host?.hostId === host.hostId) await this.api('/logout', { method: 'POST', body: '{}' });
    else {
      const identity = host.identity ?? (await this.cache.identity(scope));
      const link = await this.openRelay(
        host.hostId,
        host.ticket,
        'control',
        { type: 'authenticate', protocol: 2, sessionId: browserId() },
        identity,
      );
      try {
        if (scope !== this.cache.scope) return;
        await link.rpc(apiCall('/logout', 'POST', {}));
      } finally {
        link.close();
      }
    }
    if (scope !== this.cache.scope) return;
    const { hostId, deviceId } = host;
    const warmKey = this.hostSessionKey(host);
    const warm = this.warm.get(warmKey);
    if (warm) {
      this.warm.delete(warmKey);
      this.closeWarmHost(warm);
    }
    if (this.host?.hostId === hostId) {
      this.disconnect();
      this.host = undefined;
      this.identity = undefined;
    }
    await this.cache.forget(hostId);
    for (const storage of [localStorage, sessionStorage])
      for (const key of Object.keys(storage))
        if (
          ['pocket-pending:', 'pocket-drafts:'].some(
            (prefix) => key === `${prefix}${deviceId}` || key.startsWith(`${prefix}${deviceId}:`),
          )
        )
          storage.removeItem(key);
    (await import('./file-client')).clearFileProviders();
    this.changed();
  }
  disconnect() {
    this.clearWarmHosts();
    this.resetActiveState();
    this.changed();
  }
}
export const deviceSession = new DeviceSession();
/** Compatibility bridge for existing UI components; all requests still use the fixed RPC contract. */
export async function remoteFetch(
  path: string,
  init?: RequestInit,
  backendId = deviceSession.backendId,
): Promise<Response> {
  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  try {
    const match = /^\/api\/threads\/([^/]+)\/media$/.exec(path);
    const data =
      match && typeof init?.body === 'string'
        ? await (
            await import('./file-client')
          ).mediaContent(decodeURIComponent(match[1]), JSON.parse(init.body).path, backendId)
        : await deviceSession.api(path, init, backendId);
    return Response.json(data);
  } catch (error) {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return Response.json(
      { error: error instanceof Error ? error.message : '请求失败' },
      { status: error instanceof RpcError && error.status >= 400 ? error.status : 503 },
    );
  }
}
