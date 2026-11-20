import { buildPushPayload, type PushSubscription, type VapidKeys } from '@block65/webcrypto-web-push';
import { createCipheriv, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { NotificationEvent, NotificationKind } from '../../shared/notifications.js';
import { ChatError, digest, type MessagingStore } from './store-core.js';

export interface NotificationEnvironment {
  POCKET_IM_PUSH_WEB_PUBLIC_KEY?: string;
  POCKET_IM_PUSH_WEB_PRIVATE_KEY?: string;
  POCKET_IM_PUSH_WEB_SUBJECT?: string;
  POCKET_IM_PUSH_ANDROID_ORIGINS?: string;
}
export interface PushConfig {
  web?: VapidKeys;
  androidOrigins: ReadonlySet<string>;
}
const publicKey = /^B[A-Za-z0-9_-]{86}$/;
const secretKey = /^[A-Za-z0-9_-]{43}$/;
export function pushConfig(env: NotificationEnvironment): PushConfig | undefined {
  const pub = env.POCKET_IM_PUSH_WEB_PUBLIC_KEY,
    priv = env.POCKET_IM_PUSH_WEB_PRIVATE_KEY,
    subject = env.POCKET_IM_PUSH_WEB_SUBJECT;
  const web =
    pub || priv || subject
      ? {
          subject: z
            .string()
            .regex(/^(mailto:|https:\/\/)\S+$/)
            .parse(subject),
          publicKey: z.string().regex(publicKey).parse(pub),
          privateKey: z.string().regex(secretKey).parse(priv),
        }
      : undefined;
  const androidOrigins = new Set(
    (env.POCKET_IM_PUSH_ANDROID_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const url = new URL(value);
        if (url.origin !== value || url.protocol !== 'https:')
          throw Error('POCKET_IM_PUSH_ANDROID_ORIGINS requires exact HTTPS origins');
        return url.origin;
      }),
  );
  return web || androidOrigins.size ? { web, androidOrigins } : undefined;
}

const webSubscription = z
  .object({
    kind: z.literal('web'),
    endpoint: z.string().max(2048),
    expirationTime: z.number().finite().nullable().optional(),
    keys: z
      .object({ p256dh: z.string().regex(publicKey), auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/) })
      .strict(),
  })
  .strict();
export const notificationSubscription = z.discriminatedUnion('kind', [
  webSubscription,
  z
    .object({ kind: z.literal('android'), endpoint: z.string().max(2048), key: z.string().regex(secretKey) })
    .strict(),
]);
type Subscription = z.infer<typeof notificationSubscription>;

function androidPayload(payload: string, key: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), nonce);
  cipher.setAAD(Buffer.from('fable-push-v1'));
  return (
    'fable1.' +
    Buffer.concat([nonce, cipher.update(payload, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString(
      'base64url',
    )
  );
}

function endpointFor(config: PushConfig, value: Subscription) {
  let url: URL;
  try {
    url = new URL(value.endpoint);
  } catch {
    throw new ChatError(400, '通知地址无效');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.pathname === '/')
    throw new ChatError(400, '通知地址无效');
  if (value.kind === 'android') {
    if (config.androidOrigins.has(url.origin)) return url;
    throw new ChatError(400, '当前站点未配置此 Android 推送服务');
  }
  const host = url.hostname;
  if (
    config.web &&
    !url.port &&
    ((host === 'fcm.googleapis.com' && /^\/(?:fcm\/send|wp)\/.+/.test(url.pathname)) ||
      (host === 'updates.push.services.mozilla.com' && url.pathname.startsWith('/wpush/')) ||
      host.endsWith('.push.apple.com') ||
      host.endsWith('.notify.windows.com'))
  )
    return url;
  throw new ChatError(400, '当前站点不支持此浏览器的推送服务');
}

export class PushNotifications {
  private active?: Promise<void>;
  private closed = false;

  constructor(
    private readonly store: MessagingStore,
    private readonly config: PushConfig,
    private readonly send: typeof fetch = fetch,
  ) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS im_push_devices(id TEXT PRIMARY KEY, endpoint_hash TEXT NOT NULL UNIQUE, session_hash TEXT NOT NULL REFERENCES im_sessions(hash) ON DELETE CASCADE, details TEXT NOT NULL, focus TEXT, focus_until INTEGER NOT NULL DEFAULT 0);',
    );
    store.db.exec('CREATE INDEX IF NOT EXISTS im_push_sessions ON im_push_devices(session_hash)');
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS im_push_queue(job INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT NOT NULL REFERENCES im_push_devices(id) ON DELETE CASCADE, kind TEXT NOT NULL, event_id TEXT NOT NULL, conversation TEXT NOT NULL, expires INTEGER NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, UNIQUE(device, kind, event_id));',
    );
    store.db.exec('CREATE INDEX IF NOT EXISTS im_push_due ON im_push_queue(due)');
  }
  settings(session: string, id: string | undefined) {
    return {
      webKey: this.config.web?.publicKey ?? null,
      android: this.config.androidOrigins.size > 0,
      registered:
        !!id &&
        !!this.store.db
          .prepare('SELECT 1 FROM im_push_devices WHERE id=? AND session_hash=?')
          .get(id, digest(session)),
    };
  }
  subscribe(session: string, id: string, subscription: Subscription) {
    const endpoint = endpointFor(this.config, subscription).href;
    const fingerprint = digest(endpoint);
    const hash = digest(session);
    this.store.transaction(() => {
      const previous = this.store.db
        .prepare('SELECT id,session_hash FROM im_push_devices WHERE endpoint_hash=?')
        .get(fingerprint);
      if (previous && previous.id !== id)
        this.store.db.prepare('DELETE FROM im_push_devices WHERE id=?').run(previous.id);
      const result = this.store.db
        .prepare(
          'INSERT INTO im_push_devices(id,endpoint_hash,session_hash,details) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET endpoint_hash=excluded.endpoint_hash,session_hash=excluded.session_hash,details=excluded.details WHERE im_push_devices.session_hash=excluded.session_hash',
        )
        .run(id, fingerprint, hash, JSON.stringify({ ...subscription, endpoint }));
      if (!result.changes) throw new ChatError(409, '请在当前设备重新启用通知');
    });
  }
  unsubscribe(session: string, id: string) {
    this.store.db
      .prepare('DELETE FROM im_push_devices WHERE id=? AND session_hash=?')
      .run(id, digest(session));
  }
  focus(session: string, id: string, conversation: string | null) {
    this.store.db
      .prepare('UPDATE im_push_devices SET focus=?, focus_until=? WHERE id=? AND session_hash=?')
      .run(conversation, conversation ? Date.now() + 25_000 : 0, id, digest(session));
  }
  enqueue(user: string, kind: NotificationKind, id: string, conversation: string, expiresAt: number) {
    const now = Date.now();
    // The session join also prevents sending to an expired login before garbage collection.
    this.store.db
      .prepare(
        'INSERT OR IGNORE INTO im_push_queue(device,kind,event_id,conversation,expires,due) SELECT d.id,?,?,?,?,? FROM im_push_devices d JOIN im_sessions s ON d.session_hash=s.hash WHERE s.user_id=? AND s.expires_at>? AND (?<>? OR d.focus IS NULL OR d.focus<>? OR d.focus_until<=?)',
      )
      .run(kind, id, conversation, expiresAt, now, user, now, kind, 'message', conversation, now);
  }
  nextDeadline() {
    const due = this.store.db.prepare('SELECT min(due) AS due FROM im_push_queue').get()?.due;
    return due === null || due === undefined ? undefined : Number(due);
  }
  run() {
    if (this.closed) return Promise.resolve();
    return (this.active ??= this.deliver().finally(() => (this.active = undefined)));
  }
  async close() {
    this.closed = true;
    await this.active;
  }
  private async deliver() {
    const db = this.store.db;
    const now = Date.now();
    db.prepare(
      'DELETE FROM im_push_devices WHERE NOT EXISTS(SELECT 1 FROM im_sessions s WHERE s.hash=im_push_devices.session_hash AND s.expires_at>?)',
    ).run(now);
    db.prepare('DELETE FROM im_push_queue WHERE expires<=?').run(now);
    const batch = db
      .prepare(
        'SELECT q.*,d.details,s.user_id AS user,d.focus,d.focus_until FROM im_push_queue q JOIN im_push_devices d ON q.device=d.id JOIN im_sessions s ON s.hash=d.session_hash WHERE q.due<=? ORDER BY q.kind=? DESC,q.job LIMIT 12',
      )
      .all(now, 'call-cleared');
    await Promise.all(
      batch.map(async (row) => {
        const event: NotificationEvent = {
          kind: String(row.kind) as NotificationKind,
          id: String(row.event_id),
          conversation: String(row.conversation),
          expiresAt: Number(row.expires),
        };
        const done = () => db.prepare('DELETE FROM im_push_queue WHERE job=?').run(row.job);
        if (
          !db
            .prepare('SELECT 1 FROM im_members WHERE user_id=? AND conversation_id=?')
            .get(row.user, row.conversation)
        )
          return done();
        if (event.kind === 'message') {
          if (row.focus === row.conversation && Number(row.focus_until) > Date.now()) return done();
          const message = db
            .prepare(
              'SELECT 1 FROM im_messages m JOIN im_members d ON d.conversation_id=m.conversation_id WHERE m.id=? AND d.user_id=? AND m.sequence>d.read_sequence',
            )
            .get(row.event_id, row.user);
          if (!message) return done();
        } else if (
          event.kind !== 'call-cleared' &&
          !db.prepare("SELECT 1 FROM im_calls WHERE id=? AND state='ringing'").get(row.event_id)
        )
          return done();

        try {
          const details = notificationSubscription.parse(JSON.parse(String(row.details)));
          const endpoint = endpointFor(this.config, details);
          const payload = JSON.stringify({ ...event, binding: String(row.device) });
          const ttl = Math.max(0, Math.ceil((event.expiresAt - Date.now()) / 1000));
          const urgent = event.kind !== 'message';
          const request =
            details.kind === 'web'
              ? await buildPushPayload(
                  { data: payload, options: { ttl, urgency: urgent ? 'high' : 'normal' } },
                  { ...details, expirationTime: details.expirationTime ?? null } as PushSubscription,
                  this.config.web!,
                )
              : {
                  method: 'POST',
                  body: androidPayload(payload, details.key),
                  headers: {
                    'Content-Type': 'application/octet-stream',
                    TTL: String(ttl),
                    ...(endpoint.hostname === 'ntfy.sh' && { 'X-UnifiedPush': '1', 'X-Cache': 'no' }),
                  },
                };
          const response = await this.send(endpoint, {
            ...request,
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
          });
          await response.body?.cancel().catch(() => {});
          if (response.status === 404 || response.status === 410) {
            db.prepare('DELETE FROM im_push_devices WHERE id=?').run(row.device);
            return;
          }
          if (response.ok || (response.status < 500 && response.status !== 429)) return done();
        } catch {
          // The outbox retries temporary failures without logging endpoints or credentials.
        }
        const attempts = Number(row.attempts) + 1;
        const next = Date.now() + 1000 * 2 ** attempts;
        if (next >= event.expiresAt || attempts >= 5) return done();
        db.prepare('UPDATE im_push_queue SET due=?,attempts=? WHERE job=?').run(next, attempts, row.job);
      }),
    );
  }
}
