import { DurableObject } from 'cloudflare:workers';
import { callIceConfig } from '../server/messaging/calls.js';
import { translationProvider } from '../server/messaging/translation.js';
import { pushConfig } from '../server/messaging/notifications.js';
import { WorkerMessagingHttp } from './http.js';
import { ChatError, MESSAGE_RETENTION_MS, MessagingStore } from '../server/messaging/store-core.js';
import { parseAdminUserIds, registerMessaging } from '../server/messaging/service-core.js';
import { DurableDatabase } from './database.js';
import { R2MessagingObjects, avatar } from './media.js';
import { identityAuthorityFor, originFor, originsFor } from './security.js';
import type { Env } from './env.js';
import { resourceProvider } from '../server/resources/lago.js';
import { ResourceService, ResourceError } from '../server/resources/service.js';
import type { RelayHub } from './relay.js';
import type { RelayAccount } from '../shared/resources.js';

export class MessagingHub extends DurableObject<Env> {
  private store: MessagingStore;
  private app = new WorkerMessagingHttp();
  private ready: Promise<void>;
  private objects: R2MessagingObjects;
  private origins: ReadonlySet<string>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = new DurableDatabase(ctx.storage);
    this.origins = originsFor(env);
    this.store = new MessagingStore(db, identityAuthorityFor(env));
    const provider = resourceProvider(env);
    if (provider) this.store.resources = new ResourceService(this.store, provider);
    this.objects = new R2MessagingObjects(this.store, env.IM_MEDIA);
    db.exec(
      'CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)',
    );
    const relay = () => env.RELAY.get(env.RELAY.idFromName('relay-v2')) as DurableObjectStub<RelayHub>;
    this.ready = registerMessaging(this.app, {
      store: this.store,
      origin: originFor(env),
      registrationEnabled: env.POCKET_IM_REGISTRATION_ENABLED !== 'false',
      registrationCode: env.POCKET_IM_REGISTRATION_CODE,
      loginArtworkBase: env.POCKET_LOGIN_ARTWORK_BASE,
      totpKey: env.POCKET_IM_TOTP_KEY,
      deviceLoginOnly: env.POCKET_DEVICE_LOGIN_ONLY === '1',
      desktops: {
        approve: (...args) => relay().approveDesktop(...args),
        list: (...args) => relay().listDesktops(...args),
        ready: (...args) => relay().desktopReady(...args),
        revoke: (...args) => relay().revokeDesktop(...args),
        rename: (...args) => relay().renameDesktop(...args),
        listAll: () => relay().listAllDesktops(),
        revokeAny: (hostId) => relay().revokeAnyDesktop(hostId),
        migrateAccount: (fromId, toId) => relay().migrateDesktopAccount(fromId, toId),
      },
      runtime: 'cloudflare',
      humanContacts: env.POCKET_IM_HUMAN_CONTACTS === 'true',
      adminUserIds: parseAdminUserIds(env.POCKET_ADMIN_UIDS),
      translate: translationProvider(env),
      push: pushConfig(env),
      callIce: callIceConfig({
        POCKET_IM_CALL_STUN_URLS: env.POCKET_IM_CALL_STUN_URLS,
        POCKET_IM_CALL_TURN_URLS: env.POCKET_IM_CALL_TURN_URLS,
        POCKET_IM_CALL_TURN_SECRET: env.POCKET_IM_CALL_TURN_SECRET,
      }),
      storage: true,
      externalUploads: true,
      maintenance: false,
      maxHashing: 1,
      objects: this.objects,
      avatar: (bytes) => avatar(env.IMAGES, bytes),
      take: (key, max) => {
        const now = Date.now();
        db.prepare('DELETE FROM rate_limits WHERE expires<=?').run(now);
        const old = db.prepare('SELECT count FROM rate_limits WHERE key=?').get(key);
        if (
          Number(old?.count ?? 0) >= max ||
          (!old && Number(db.prepare('SELECT count(*) AS n FROM rate_limits').get()!.n) >= 20000)
        )
          throw new ChatError(429, '操作过于频繁，请稍后再试');
        db.prepare('INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(
          key,
          now + 60000,
        );
      },
    }).then(() => {});
  }
  private maintain() {
    this.store.expireStreams();
    this.store.expireInteractions();
    this.store.maybePruneExpired();
    this.store.calls?.expire();
  }
  private async schedule() {
    const db = this.store.db;
    const streamRow = db
      .prepare("SELECT min(updated_at)+120001 AS deadline FROM im_messages WHERE state='streaming'")
      .get();
    const messageRow = db
      .prepare('SELECT min(created_at)+? AS deadline FROM im_messages')
      .get(MESSAGE_RETENTION_MS + 1);
    const fileRow = db
      .prepare('SELECT min(created_at)+? AS deadline FROM im_files')
      .get(MESSAGE_RETENTION_MS + 1);
    const orphanFileRow = db
      .prepare('SELECT min(created_at)+86400001 AS deadline FROM im_files WHERE message_id IS NULL')
      .get();
    const gcRow = db.prepare('SELECT min(not_before) AS deadline FROM im_object_gc').get();
    const orphanMediaRow = db
      .prepare(
        `SELECT ? AS deadline WHERE EXISTS(SELECT 1 FROM im_media_objects m WHERE
        (kind='file' AND NOT EXISTS(SELECT 1 FROM im_files f WHERE f.id=m.id AND f.removed=0)) OR
        (kind='sticker' AND NOT EXISTS(SELECT 1 FROM im_stickers s WHERE s.id=m.id)) OR
        (kind='avatar' AND NOT EXISTS(SELECT 1 FROM im_avatars a WHERE a.id=m.id)))`,
      )
      .get(Date.now() + 60000);
    const featureRow = db
      .prepare("SELECT min(expires_at) AS deadline FROM im_message_features WHERE status='pending'")
      .get();
    const deadlines = [
      streamRow?.deadline,
      messageRow?.deadline,
      fileRow?.deadline,
      orphanFileRow?.deadline,
      gcRow?.deadline,
      orphanMediaRow?.deadline,
      featureRow?.deadline,
      this.store.calls?.nextDeadline(),
      this.store.push?.nextDeadline(),
    ]
      .filter((v) => v !== null && v !== undefined)
      .map(Number);
    if (deadlines.length)
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(...deadlines)));
    else await this.ctx.storage.deleteAlarm();
  }
  async fetch(request: Request) {
    if (!this.origins.has(new URL(request.url).origin) || !request.headers.get('CF-Connecting-IP'))
      return new Response('Forbidden', { status: 403 });
    await this.ready;
    this.maintain();
    try {
      return await this.app.fetch(request);
    } finally {
      await this.schedule();
    }
  }
  async alarm() {
    await this.ready;
    this.store.pruneExpiredCloudData();
    this.maintain();
    await this.store.push?.run().catch(() => {});
    await this.objects.collectGarbage().catch(() => {
      // Avoid an alarm hot loop while R2 is unavailable.
      this.store.db
        .prepare('UPDATE im_object_gc SET not_before=? WHERE not_before<?')
        .run(Date.now() + 60000, Date.now());
    });
    await this.schedule();
  }
  async redeemRelay(token: string, host: string, route: string, lane: string) {
    await this.ready;
    if (!this.store.resources) throw Error('Resource policy not configured');
    return this.store.resources.redeemRelay(token, host, route, lane);
  }
  async consumeRelay(account: RelayAccount, bytes: number) {
    await this.ready;
    try {
      if (!this.store.resources) throw Error('Resource policy not configured');
      await this.store.resources.consumeRelay(account, bytes);
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        reason: error instanceof ResourceError ? error.message : '资源服务暂不可用',
      };
    }
  }
}
