import type { AppPage } from './shell/routes';

const codes = [
  'page-resource-failed',
  'page-resource-recovered',
  'page-runtime-failed',
  'page-load-slow',
  'control-unavailable',
  'control-probe-timeout',
  'control-high-latency',
  'direct-negotiation-failed',
  'workbench-history-slow',
  'workbench-subscription-failed',
  'im-history-failed',
  'im-avatar-load-failed',
  'im-media-load-failed',
  'im-send-failed',
  'adapter-backup-failed',
] as const;
const stages = [
  'websocket',
  'relay-ticket',
  'relay-join',
  'encrypted-handshake',
  'device-auth',
  'ice',
] as const;
const signals = [
  'adapter-offline',
  'host-reconnecting',
  'relay-rejected',
  'relay-busy',
  'authentication-timeout',
  'device-connection-limit',
] as const;
const transports = ['direct', 'relay'] as const;
const clients = ['android-webview', 'android-browser', 'web'] as const;
export type DiagnosticSignal = (typeof signals)[number];

interface Diagnostic {
  code: (typeof codes)[number];
  page?: AppPage;
  asset?: string;
  stage?: (typeof stages)[number];
  signal?: DiagnosticSignal;
  transport?: (typeof transports)[number];
  status?: number;
  closeCode?: number;
  elapsedMs?: number;
}

const key = 'pocket-diagnostics-v1';
const retention = 7 * 24 * 60 * 60 * 1000;
const limit = 64;
const maxStoredLength = 24 * 1024;
const repeatInterval = 2 * 60 * 1000;
const build = typeof __POCKET_WEB_BUILD_ID__ === 'string' ? __POCKET_WEB_BUILD_ID__ : 'dev';
const allowedPages =
  /^(messages|contacts|workbench|me|settings|appearance|devices|integrations|profile|login-security|trusted-devices|login-devices|authenticators|account-recovery|account-credentials|resources|admin|donation|downloads|about|add-computer|account-login|pair|login-invite|desktop-authorization)$/;

type Entry = Diagnostic & { at: number; build: string; online?: boolean; client: (typeof clients)[number] };
let memory: Entry[] = [];
let memoryOnly = false;

function oneOf<T extends string>(choices: readonly T[], input: unknown): T | undefined {
  return choices.includes(input as T) ? (input as T) : undefined;
}

function numberBetween(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function fields(input: Partial<Diagnostic>): Diagnostic | undefined {
  const code = oneOf(codes, input.code);
  if (!code) return;
  return {
    code,
    page: typeof input.page === 'string' && allowedPages.test(input.page) ? input.page : undefined,
    asset:
      typeof input.asset === 'string' && /^[a-z\d_-]{1,96}-[a-z\d_-]{8}\.(?:css|js)$/i.test(input.asset)
        ? input.asset
        : undefined,
    stage: oneOf(stages, input.stage),
    signal: oneOf(signals, input.signal),
    transport: oneOf(transports, input.transport),
    status: numberBetween(input.status, 400, 599),
    closeCode: numberBetween(input.closeCode, 1000, 4999),
    elapsedMs: numberBetween(input.elapsedMs, 0, 300_000),
  };
}

function entries(now: number): Entry[] {
  const recentMemory = () => memory.filter(({ at }) => at > now - retention && at <= now);
  if (memoryOnly) return recentMemory();
  try {
    const saved = localStorage.getItem(key);
    if (!saved || saved.length > maxStoredLength) return recentMemory();
    const rows: unknown = JSON.parse(saved);
    if (!Array.isArray(rows)) return recentMemory();
    return rows.slice(-limit).flatMap((row: Partial<Entry> | null) => {
      if (!row || typeof row.at !== 'number' || row.at <= now - retention || row.at > now) return [];
      const event = fields(row);
      const client = oneOf(clients, row.client);
      if (!event || !client || typeof row.online !== 'boolean' || typeof row.build !== 'string') return [];
      if (!/^(dev|[a-f\d]{7,64})$/i.test(row.build)) return [];
      return [{ ...event, client, online: row.online, build: row.build, at: row.at }];
    });
  } catch {
    return recentMemory();
  }
}

function clientType(): Entry['client'] {
  const ua = navigator.userAgent;
  return /FablePavilionAndroid\/|Android[^)]*\bwv\b/i.test(ua)
    ? 'android-webview'
    : /Android/i.test(ua)
      ? 'android-browser'
      : 'web';
}

export function recordDiagnostic(input: Diagnostic) {
  const event = fields(input);
  if (!event || document.visibilityState === 'hidden') return;
  const now = Date.now();
  const previous = entries(now);
  const online = navigator.onLine;
  if (
    previous.some(
      (row) =>
        row.at > now - repeatInterval &&
        row.build === build &&
        row.code === event.code &&
        row.page === event.page &&
        row.asset === event.asset &&
        row.stage === event.stage &&
        row.signal === event.signal &&
        row.transport === event.transport &&
        row.online === online &&
        row.status === event.status &&
        row.closeCode === event.closeCode,
    )
  )
    return;
  memory = [...previous, { ...event, online, client: clientType(), build, at: now }].slice(-limit);
  try {
    localStorage.setItem(key, JSON.stringify(memory));
  } catch {
    // Diagnostics remain downloadable in memory when persistent storage is unavailable.
    memoryOnly = true;
  }
}

export function diagnosticStatus(error: unknown) {
  const status: unknown = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  return numberBetween(status, 400, 599);
}

export function downloadDiagnostics() {
  const now = Date.now();
  const events = entries(now);
  // Previous versions stored one page failure in the current tab only.
  try {
    const old = JSON.parse(sessionStorage.getItem('pocket-page-failure') ?? 'null');
    const at = typeof old?.at === 'string' ? Date.parse(old.at) : NaN;
    if (
      at > now - retention &&
      at <= now &&
      typeof old.build === 'string' &&
      /^[a-f\d]{7,64}$/i.test(old.build) &&
      (old.kind === 'resource' || old.kind === 'runtime')
    ) {
      const event = fields({
        code: old.kind === 'resource' ? 'page-resource-failed' : 'page-runtime-failed',
        page: old.page,
        asset: old.resource,
      });
      if (event) events.push({ ...event, at, build: old.build, client: clientType() });
    }
  } catch {
    /* The legacy record is optional. */
  }
  const report = JSON.stringify(
    {
      format: 'fable-pavilion-diagnostics-v1',
      exportedAt: new Date(now).toISOString(),
      build,
      events: events
        .sort((a, b) => a.at - b.at)
        .slice(-limit)
        .map(({ at, ...event }) => ({ at: new Date(at).toISOString(), ...event })),
    },
    null,
    2,
  );
  const url = URL.createObjectURL(new Blob([report + '\n'], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `fable-pavilion-diagnostics-${new Date(now).toISOString().slice(0, 10)}.log`;
  document.body.append(link);
  link.click();
  link.remove();
  // Android's WebView obtains the Blob asynchronously through its download handler.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
