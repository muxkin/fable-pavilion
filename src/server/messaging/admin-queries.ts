import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type {
  AdminAuditEntry,
  AdminConversationSummary,
  AdminDailyActivity,
  AdminOverview,
  AdminSessionEntry,
  AdminStorageConsumer,
  AdminStorageDetail,
  AdminUserSummary,
} from '../../shared/messaging.js';
import type { MessagingDatabase } from './database.js';
import { ChatError, digest, MESSAGE_RETENTION_DAYS, MESSAGE_RETENTION_MS } from './store-core.js';

const DAY = 86_400_000;
const ADMIN_AUTH_TTL_MS = 3 * 60_000;

export function ensureAdminAuditSchema(db: MessagingDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS im_admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS im_admin_audit_created ON im_admin_audit(created_at DESC);
    CREATE TABLE IF NOT EXISTS im_admin_auth_requests (
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      code TEXT NOT NULL,
      origin TEXT NOT NULL,
      device_name TEXT NOT NULL,
      user_id TEXT,
      approved_at INTEGER,
      expires_at INTEGER NOT NULL
    );
  `);
}

export function createAdminAuthRequest(
  db: MessagingDatabase,
  origin: string,
  deviceName: string,
  now = Date.now(),
) {
  db.prepare('DELETE FROM im_admin_auth_requests WHERE expires_at<=?').run(now);
  const id = randomUUID();
  const secret = randomBytes(24).toString('base64url');
  const code = String(randomInt(100000, 1000000));
  const expiresAt = now + ADMIN_AUTH_TTL_MS;
  db.prepare(
    'INSERT INTO im_admin_auth_requests(id,secret_hash,code,origin,device_name,expires_at) VALUES (?,?,?,?,?,?)',
  ).run(id, digest(secret), code, origin, deviceName.slice(0, 80) || '管理台浏览器', expiresAt);
  return { id, secret, code, expiresAt };
}

export function inspectAdminAuthRequest(db: MessagingDatabase, id: string, now = Date.now()) {
  db.prepare('DELETE FROM im_admin_auth_requests WHERE expires_at<=?').run(now);
  const row = db
    .prepare(
      'SELECT id, code, origin, device_name AS deviceName, approved_at AS approvedAt, expires_at AS expiresAt FROM im_admin_auth_requests WHERE id=? AND expires_at>?',
    )
    .get(id, now);
  if (!row) throw new ChatError(404, '授权请求不存在或已过期');
  return {
    id: String(row.id),
    code: String(row.code),
    origin: String(row.origin),
    deviceName: String(row.deviceName),
    approved: row.approvedAt != null,
    expiresAt: Number(row.expiresAt),
  };
}

export function approveAdminAuthRequest(
  db: MessagingDatabase,
  id: string,
  code: string,
  adminUserId: string,
  now = Date.now(),
) {
  db.prepare('DELETE FROM im_admin_auth_requests WHERE expires_at<=?').run(now);
  const row = db
    .prepare('SELECT code, origin, approved_at FROM im_admin_auth_requests WHERE id=? AND expires_at>?')
    .get(id, now);
  if (!row) throw new ChatError(404, '授权请求不存在或已过期');
  if (row.approved_at != null) throw new ChatError(409, '此授权请求已确认');
  if (String(row.code) !== code.trim()) throw new ChatError(400, '核对码不匹配');
  db.prepare('UPDATE im_admin_auth_requests SET user_id=?, approved_at=? WHERE id=? AND approved_at IS NULL').run(
    adminUserId,
    now,
    id,
  );
  return { origin: String(row.origin) };
}

export function consumeAdminAuthRequest(
  db: MessagingDatabase,
  id: string,
  secret: string,
  origin: string,
  now = Date.now(),
): { pending: true } | { pending: false; userId: string } {
  db.prepare('DELETE FROM im_admin_auth_requests WHERE expires_at<=?').run(now);
  const row = db
    .prepare(
      'SELECT secret_hash, origin, user_id, approved_at FROM im_admin_auth_requests WHERE id=? AND expires_at>?',
    )
    .get(id, now);
  if (!row || String(row.secret_hash) !== digest(secret) || String(row.origin) !== origin) {
    throw new ChatError(404, '授权请求已失效，请重新生成');
  }
  if (!row.user_id || row.approved_at == null) {
    return { pending: true };
  }
  const removed = db.prepare('DELETE FROM im_admin_auth_requests WHERE id=?').run(id);
  if (!removed.changes) throw new ChatError(409, '此授权已被使用');
  return { pending: false, userId: String(row.user_id) };
}

function dayKeyUtc(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mapUserSummary(row: Record<string, unknown>, authority: string): AdminUserSummary {
  const id = String(row.id);
  const avatarId = row.avatarId ? String(row.avatarId) : undefined;
  return {
    id,
    address: `${id}@${authority}`,
    kind: String(row.kind) as 'human' | 'agent',
    ownerId: row.ownerId == null ? null : String(row.ownerId),
    username: String(row.username),
    displayName: String(row.displayName),
    ...(avatarId ? { avatarUrl: `/api/im/users/${id}/avatar/${avatarId}` } : {}),
    createdAt: Number(row.createdAt),
    encrypted: Boolean(row.encrypted),
    activeSessions: Number(row.activeSessions ?? 0),
    lastActiveAt: row.lastActiveAt == null ? null : Number(row.lastActiveAt),
    messageCount: Number(row.messageCount ?? 0),
    fileCount: Number(row.fileCount ?? 0),
    fileBytes: Number(row.fileBytes ?? 0),
    stickerCount: Number(row.stickerCount ?? 0),
    stickerBytes: Number(row.stickerBytes ?? 0),
    hasAvatar: Boolean(avatarId),
  };
}

const USER_SUMMARY_SELECT = `
  SELECT u.id, u.kind, u.owner_id AS ownerId, u.username, u.display_name AS displayName, u.created_at AS createdAt,
         (SELECT a.id FROM im_avatars a WHERE a.user_id=u.id LIMIT 1) AS avatarId,
         EXISTS(SELECT 1 FROM im_account_crypto c WHERE c.user_id=u.id) AS encrypted,
         (SELECT COUNT(*) FROM im_sessions s WHERE s.user_id=u.id AND s.expires_at>?) AS activeSessions,
         (SELECT MAX(d.last_active_at) FROM im_sessions s JOIN im_login_devices d ON d.session_hash=s.hash WHERE s.user_id=u.id AND s.expires_at>?) AS lastActiveAt,
         (SELECT COUNT(*) FROM im_messages m WHERE m.sender_id=u.id) AS messageCount,
         (SELECT COUNT(*) FROM im_files f WHERE f.user_id=u.id AND f.removed=0) AS fileCount,
         (SELECT COALESCE(SUM(f.size),0) FROM im_files f WHERE f.user_id=u.id AND f.removed=0) AS fileBytes,
         (SELECT COUNT(*) FROM im_stickers st WHERE st.user_id=u.id) AS stickerCount,
         (SELECT COALESCE(SUM(st.size),0) FROM im_stickers st WHERE st.user_id=u.id) AS stickerBytes
  FROM im_users u
`;

export function queryAdminOverview(
  db: MessagingDatabase,
  authority: string,
  now = Date.now(),
): AdminOverview {
  const cutoff = now - MESSAGE_RETENTION_MS;
  const orphanCutoff = now - DAY;
  const dayAgo = now - DAY;
  const users = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN kind='human' THEN 1 ELSE 0 END) AS humans,
              SUM(CASE WHEN kind='agent' THEN 1 ELSE 0 END) AS agents,
              SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) AS new24h,
              SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) AS new7d
       FROM im_users`,
    )
    .get(dayAgo, cutoff)!;
  const sessions = db
    .prepare(
      `SELECT COUNT(*) AS active,
              SUM(CASE WHEN d.last_active_at>=? THEN 1 ELSE 0 END) AS active24h
       FROM im_sessions s LEFT JOIN im_login_devices d ON d.session_hash=s.hash
       WHERE s.expires_at>?`,
    )
    .get(dayAgo, now)!;
  const convos = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN kind='direct' THEN 1 ELSE 0 END) AS direct,
              SUM(CASE WHEN kind='group' THEN 1 ELSE 0 END) AS grp,
              SUM(CASE WHEN kind='group' AND closed=1 THEN 1 ELSE 0 END) AS closedGroups
       FROM im_conversations`,
    )
    .get()!;
  const messages = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) AS last24h,
              SUM(CASE WHEN created_at<=? THEN 1 ELSE 0 END) AS expiredPending,
              SUM(CASE WHEN state='streaming' THEN 1 ELSE 0 END) AS streaming,
              MIN(created_at) AS oldestAt
       FROM im_messages`,
    )
    .get(dayAgo, cutoff)!;
  const pendingInteractions = db
    .prepare("SELECT COUNT(*) AS n FROM im_message_features WHERE status='pending'")
    .get()!;
  const files = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(size),0) AS bytes,
              SUM(CASE WHEN created_at<=? THEN 1 ELSE 0 END) AS expiredPending,
              SUM(CASE WHEN message_id IS NULL AND created_at<=? THEN 1 ELSE 0 END) AS orphanPending,
              MIN(created_at) AS oldestAt
       FROM im_files WHERE removed=0`,
    )
    .get(cutoff, orphanCutoff)!;
  const stickers = db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(size),0) AS bytes FROM im_stickers')
    .get()!;
  const avatars = db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(size),0) AS bytes FROM im_avatars')
    .get()!;
  const gcQueue = db.prepare('SELECT COUNT(*) AS pending FROM im_object_gc').get()!;
  const orphanMedia = db
    .prepare(
      `SELECT COUNT(*) AS n FROM im_media_objects m WHERE
       (kind='file' AND NOT EXISTS(SELECT 1 FROM im_files f WHERE f.id=m.id AND f.removed=0)) OR
       (kind='sticker' AND NOT EXISTS(SELECT 1 FROM im_stickers s WHERE s.id=m.id)) OR
       (kind='avatar' AND NOT EXISTS(SELECT 1 FROM im_avatars a WHERE a.id=m.id))`,
    )
    .get()!;

  // Build 7-day UTC daily activity trend using simple indexed range scans.
  const startOfTodayUtc = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  const windowStart = startOfTodayUtc - 6 * DAY;
  const buckets = new Map<string, AdminDailyActivity>();
  for (let i = 0; i < 7; i++) {
    const key = dayKeyUtc(windowStart + i * DAY);
    buckets.set(key, { day: key, messages: 0, files: 0, fileBytes: 0, newUsers: 0 });
  }
  for (const row of db
    .prepare('SELECT created_at FROM im_messages WHERE created_at>=?')
    .all(windowStart)) {
    const bucket = buckets.get(dayKeyUtc(Number(row.created_at)));
    if (bucket) bucket.messages++;
  }
  for (const row of db
    .prepare('SELECT created_at, size FROM im_files WHERE removed=0 AND created_at>=?')
    .all(windowStart)) {
    const bucket = buckets.get(dayKeyUtc(Number(row.created_at)));
    if (bucket) {
      bucket.files++;
      bucket.fileBytes += Number(row.size ?? 0);
    }
  }
  for (const row of db
    .prepare('SELECT created_at FROM im_users WHERE created_at>=?')
    .all(windowStart)) {
    const bucket = buckets.get(dayKeyUtc(Number(row.created_at)));
    if (bucket) bucket.newUsers++;
  }

  return {
    authority,
    retentionDays: MESSAGE_RETENTION_DAYS,
    generatedAt: now,
    users: {
      total: Number(users.total ?? 0),
      humans: Number(users.humans ?? 0),
      agents: Number(users.agents ?? 0),
      new24h: Number(users.new24h ?? 0),
      new7d: Number(users.new7d ?? 0),
    },
    sessions: {
      active: Number(sessions.active ?? 0),
      active24h: Number(sessions.active24h ?? 0),
    },
    conversations: {
      total: Number(convos.total ?? 0),
      direct: Number(convos.direct ?? 0),
      group: Number(convos.grp ?? 0),
      closedGroups: Number(convos.closedGroups ?? 0),
    },
    messages: {
      total: Number(messages.total ?? 0),
      last24h: Number(messages.last24h ?? 0),
      expiredPending: Number(messages.expiredPending ?? 0),
      streaming: Number(messages.streaming ?? 0),
      pendingInteractions: Number(pendingInteractions.n ?? 0),
      oldestAt: messages.oldestAt == null ? null : Number(messages.oldestAt),
    },
    files: {
      total: Number(files.total ?? 0),
      bytes: Number(files.bytes ?? 0),
      expiredPending: Number(files.expiredPending ?? 0),
      orphanPending: Number(files.orphanPending ?? 0),
      oldestAt: files.oldestAt == null ? null : Number(files.oldestAt),
    },
    stickers: {
      total: Number(stickers.total ?? 0),
      bytes: Number(stickers.bytes ?? 0),
    },
    avatars: {
      total: Number(avatars.total ?? 0),
      bytes: Number(avatars.bytes ?? 0),
    },
    gcQueue: {
      pending: Number(gcQueue.pending ?? 0),
      orphanMedia: Number(orphanMedia.n ?? 0),
    },
    dailyActivity: [...buckets.values()],
  };
}

export function queryAdminUsers(
  db: MessagingDatabase,
  authority: string,
  options: { query?: string; kind?: 'all' | 'human' | 'agent'; sort?: string; limit?: number } = {},
): AdminUserSummary[] {
  const now = Date.now();
  const cleaned = (options.query ?? '').trim().toLowerCase();
  const capped = Math.max(1, Math.min(200, Math.floor(options.limit ?? 100)));
  const where: string[] = [];
  const params: (string | number)[] = [now, now];
  if (options.kind === 'human' || options.kind === 'agent') {
    where.push('u.kind=?');
    params.push(options.kind);
  }
  if (cleaned) {
    where.push(
      '(instr(lower(u.id),?)>0 OR instr(lower(u.username),?)>0 OR instr(lower(u.display_name),?)>0)',
    );
    params.push(cleaned, cleaned, cleaned);
  }
  const orderBy =
    options.sort === 'active'
      ? 'COALESCE(lastActiveAt, 0) DESC, u.created_at ASC'
      : options.sort === 'messages'
        ? 'messageCount DESC, u.created_at ASC'
        : options.sort === 'storage'
          ? '(fileBytes + stickerBytes) DESC, u.created_at ASC'
          : 'u.created_at ASC';
  const sql = `${USER_SUMMARY_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy} LIMIT ?`;
  params.push(capped);
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => mapUserSummary(row, authority));
}

export function queryAdminUserById(
  db: MessagingDatabase,
  authority: string,
  userId: string,
): AdminUserSummary | null {
  const now = Date.now();
  const row = db.prepare(`${USER_SUMMARY_SELECT} WHERE u.id=?`).get(now, now, userId);
  return row ? mapUserSummary(row, authority) : null;
}

export function queryAdminOwnedAgents(
  db: MessagingDatabase,
  authority: string,
  ownerId: string,
): AdminUserSummary[] {
  const now = Date.now();
  return db
    .prepare(`${USER_SUMMARY_SELECT} WHERE u.owner_id=? ORDER BY u.created_at ASC`)
    .all(now, now, ownerId)
    .map((row) => mapUserSummary(row, authority));
}

export function queryAdminSessions(
  db: MessagingDatabase,
  currentSessionHash: string,
  options: { userId?: string; query?: string; limit?: number } = {},
): AdminSessionEntry[] {
  const now = Date.now();
  // Ensure every active session has a login_devices row with an addressable deviceId.
  const missing = db
    .prepare(
      `SELECT s.hash FROM im_sessions s LEFT JOIN im_login_devices d ON s.hash=d.session_hash
       WHERE s.expires_at>? AND d.session_hash IS NULL`,
    )
    .all(now);
  for (const row of missing) {
    db.prepare('INSERT OR IGNORE INTO im_login_devices(session_hash,id) VALUES (?,?)').run(
      row.hash!,
      randomUUID(),
    );
  }

  const where: string[] = ['s.expires_at>?'];
  const params: (string | number)[] = [currentSessionHash, now];
  if (options.userId) {
    where.push('s.user_id=?');
    params.push(options.userId);
  }
  const cleaned = (options.query ?? '').trim().toLowerCase();
  if (cleaned) {
    where.push(
      `(instr(lower(u.id),?)>0 OR instr(lower(u.username),?)>0 OR instr(lower(u.display_name),?)>0
        OR instr(lower(COALESCE(d.name,'')),?)>0 OR instr(lower(COALESCE(d.custom_name,'')),?)>0
        OR instr(lower(COALESCE(d.ip,'')),?)>0 OR instr(lower(COALESCE(d.origin,'')),?)>0)`,
    );
    params.push(cleaned, cleaned, cleaned, cleaned, cleaned, cleaned, cleaned);
  }
  const capped = Math.max(1, Math.min(200, Math.floor(options.limit ?? 100)));
  params.push(capped);

  return db
    .prepare(
      `SELECT d.id AS deviceId,
              s.user_id AS userId,
              u.username AS username,
              u.display_name AS displayName,
              u.kind AS userKind,
              COALESCE(d.name, CASE WHEN u.kind='agent' THEN 'Agent 凭据' ELSE '浏览器' END) AS name,
              d.custom_name AS customName,
              d.platform AS platform,
              d.os AS os,
              d.browser AS browser,
              d.ip AS ip,
              d.location AS location,
              d.origin AS origin,
              d.created_at AS createdAt,
              d.last_active_at AS lastActiveAt,
              d.verified_at AS verifiedAt,
              s.expires_at AS expiresAt,
              s.hash=? AS current
       FROM im_sessions s
       JOIN im_users u ON u.id=s.user_id
       JOIN im_login_devices d ON d.session_hash=s.hash
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(d.last_active_at, d.created_at, 0) DESC
       LIMIT ?`,
    )
    .all(...params)
    .map((row) => ({
      deviceId: String(row.deviceId),
      userId: String(row.userId),
      username: String(row.username),
      displayName: String(row.displayName),
      userKind: String(row.userKind) as 'human' | 'agent',
      name: String(row.name),
      customName: row.customName == null ? null : String(row.customName),
      platform: row.platform == null ? null : String(row.platform),
      os: row.os == null ? null : String(row.os),
      browser: row.browser == null ? null : String(row.browser),
      ip: row.ip == null ? null : String(row.ip),
      location: row.location == null ? null : String(row.location),
      origin: row.origin == null ? null : String(row.origin),
      createdAt: row.createdAt == null ? null : Number(row.createdAt),
      lastActiveAt: row.lastActiveAt == null ? null : Number(row.lastActiveAt),
      verifiedAt: row.verifiedAt == null ? null : Number(row.verifiedAt),
      expiresAt: Number(row.expiresAt),
      current: Boolean(row.current),
    }));
}

export function revokeAdminSessionByDeviceId(
  db: MessagingDatabase,
  deviceId: string,
  currentSessionHash: string,
): { userId: string } {
  const row = db
    .prepare(
      `SELECT s.hash, s.user_id AS userId
       FROM im_login_devices d JOIN im_sessions s ON s.hash=d.session_hash
       WHERE d.id=?`,
    )
    .get(deviceId);
  if (!row) throw new ChatError(404, '登录会话不存在或已失效');
  if (String(row.hash) === currentSessionHash) throw new ChatError(400, '不能直接吊销当前管理员会话');
  db.prepare('DELETE FROM im_sessions WHERE hash=?').run(row.hash!);
  return { userId: String(row.userId) };
}

export function queryAdminConversations(
  db: MessagingDatabase,
  limit = 100,
): AdminConversationSummary[] {
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT c.id, c.kind, c.name, c.owner_id AS ownerId, c.closed,
              (SELECT COUNT(*) FROM im_members mb WHERE mb.conversation_id=c.id) AS memberCount,
              (SELECT COUNT(*) FROM im_messages m WHERE m.conversation_id=c.id) AS messageCount,
              (SELECT COUNT(*) FROM im_files f WHERE f.conversation_id=c.id AND f.removed=0) AS fileCount,
              (SELECT COALESCE(SUM(f.size),0) FROM im_files f WHERE f.conversation_id=c.id AND f.removed=0) AS fileBytes,
              (SELECT MAX(m.created_at) FROM im_messages m WHERE m.conversation_id=c.id) AS lastMessageAt
       FROM im_conversations c
       ORDER BY COALESCE(lastMessageAt, 0) DESC, c.id ASC
       LIMIT ?`,
    )
    .all(capped);

  return rows.map((row) => {
    const kind = String(row.kind) as 'direct' | 'group';
    let name = String(row.name || '');
    if (kind === 'direct' && !name) {
      const participants = db
        .prepare(
          `SELECT u.display_name AS displayName, u.username FROM im_members mb
           JOIN im_users u ON u.id=mb.user_id WHERE mb.conversation_id=? ORDER BY u.id ASC`,
        )
        .all(row.id!);
      name = participants.map((p) => String(p.displayName || p.username)).join(' ↔ ') || '私聊会话';
    }
    return {
      id: String(row.id),
      kind,
      name: name || '未命名群聊',
      ownerId: row.ownerId == null ? null : String(row.ownerId),
      closed: Boolean(row.closed),
      memberCount: Number(row.memberCount ?? 0),
      messageCount: Number(row.messageCount ?? 0),
      fileCount: Number(row.fileCount ?? 0),
      fileBytes: Number(row.fileBytes ?? 0),
      lastMessageAt: row.lastMessageAt == null ? null : Number(row.lastMessageAt),
    };
  });
}

export function queryAdminStorageDetail(db: MessagingDatabase, now = Date.now()): AdminStorageDetail {
  const cutoff = now - MESSAGE_RETENTION_MS;
  const orphanCutoff = now - DAY;
  const files = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(size),0) AS bytes,
              SUM(CASE WHEN created_at<=? THEN 1 ELSE 0 END) AS expiredPending,
              SUM(CASE WHEN message_id IS NULL AND created_at<=? THEN 1 ELSE 0 END) AS orphanPending
       FROM im_files WHERE removed=0`,
    )
    .get(cutoff, orphanCutoff)!;
  const stickers = db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(size),0) AS bytes FROM im_stickers')
    .get()!;
  const avatars = db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(size),0) AS bytes FROM im_avatars')
    .get()!;
  const gcQueue = db
    .prepare('SELECT key, not_before AS notBefore FROM im_object_gc ORDER BY not_before ASC LIMIT 50')
    .all()
    .map((row) => ({ key: String(row.key), notBefore: Number(row.notBefore) }));
  const orphanMedia = db
    .prepare(
      `SELECT COUNT(*) AS n FROM im_media_objects m WHERE
       (kind='file' AND NOT EXISTS(SELECT 1 FROM im_files f WHERE f.id=m.id AND f.removed=0)) OR
       (kind='sticker' AND NOT EXISTS(SELECT 1 FROM im_stickers s WHERE s.id=m.id)) OR
       (kind='avatar' AND NOT EXISTS(SELECT 1 FROM im_avatars a WHERE a.id=m.id))`,
    )
    .get()!;

  const consumers = db
    .prepare(
      `SELECT u.id AS userId, u.username, u.display_name AS displayName, u.kind,
              (SELECT COALESCE(SUM(f.size),0) FROM im_files f WHERE f.user_id=u.id AND f.removed=0) AS fileBytes,
              (SELECT COUNT(*) FROM im_files f WHERE f.user_id=u.id AND f.removed=0) AS fileCount,
              (SELECT COALESCE(SUM(s.size),0) FROM im_stickers s WHERE s.user_id=u.id) AS stickerBytes,
              (SELECT COUNT(*) FROM im_stickers s WHERE s.user_id=u.id) AS stickerCount,
              (SELECT COALESCE(SUM(a.size),0) FROM im_avatars a WHERE a.user_id=u.id) AS avatarBytes
       FROM im_users u`,
    )
    .all()
    .map((row): AdminStorageConsumer => {
      const fileBytes = Number(row.fileBytes ?? 0);
      const stickerBytes = Number(row.stickerBytes ?? 0);
      const avatarBytes = Number(row.avatarBytes ?? 0);
      return {
        userId: String(row.userId),
        username: String(row.username),
        displayName: String(row.displayName),
        kind: String(row.kind) as 'human' | 'agent',
        fileBytes,
        stickerBytes,
        avatarBytes,
        totalBytes: fileBytes + stickerBytes + avatarBytes,
        fileCount: Number(row.fileCount ?? 0),
        stickerCount: Number(row.stickerCount ?? 0),
      };
    })
    .filter((c) => c.totalBytes > 0)
    .sort((a, b) => b.totalBytes - a.totalBytes)
    .slice(0, 20);

  return {
    retentionDays: MESSAGE_RETENTION_DAYS,
    files: {
      total: Number(files.total ?? 0),
      bytes: Number(files.bytes ?? 0),
      expiredPending: Number(files.expiredPending ?? 0),
      orphanPending: Number(files.orphanPending ?? 0),
    },
    stickers: {
      total: Number(stickers.total ?? 0),
      bytes: Number(stickers.bytes ?? 0),
    },
    avatars: {
      total: Number(avatars.total ?? 0),
      bytes: Number(avatars.bytes ?? 0),
    },
    gcQueue,
    orphanMediaCount: Number(orphanMedia.n ?? 0),
    topConsumers: consumers,
  };
}

export function insertAdminAudit(
  db: MessagingDatabase,
  actorId: string,
  action: string,
  target: string | null,
  detail: string,
) {
  db.prepare('INSERT INTO im_admin_audit(created_at,actor_id,action,target,detail) VALUES (?,?,?,?,?)').run(
    Date.now(),
    actorId,
    action,
    target,
    detail,
  );
  // Retain the latest 500 audit records so the table stays bounded.
  db.prepare(
    'DELETE FROM im_admin_audit WHERE id NOT IN (SELECT id FROM im_admin_audit ORDER BY id DESC LIMIT 500)',
  ).run();
}

export function queryAdminAudit(db: MessagingDatabase, limit = 100): AdminAuditEntry[] {
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  return db
    .prepare(
      `SELECT a.id, a.created_at AS createdAt, a.actor_id AS actorId,
              u.username AS actorUsername, u.display_name AS actorDisplayName,
              a.action, a.target, a.detail
       FROM im_admin_audit a LEFT JOIN im_users u ON u.id=a.actor_id
       ORDER BY a.id DESC LIMIT ?`,
    )
    .all(capped)
    .map((row) => ({
      id: Number(row.id),
      createdAt: Number(row.createdAt),
      actorId: String(row.actorId),
      actorUsername: row.actorUsername == null ? null : String(row.actorUsername),
      actorDisplayName: row.actorDisplayName == null ? null : String(row.actorDisplayName),
      action: String(row.action),
      target: row.target == null ? null : String(row.target),
      detail: String(row.detail),
    }));
}

function tableExists(db: MessagingDatabase, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

/** Permanently remove a non-admin account and all owned data in foreign-key-safe order. */
export function deleteAdminUser(db: MessagingDatabase, targetId: string) {
  const user = db.prepare('SELECT id, username, display_name AS displayName, kind FROM im_users WHERE id=?').get(targetId);
  if (!user) throw new ChatError(404, '用户不存在');
  if (db.prepare('SELECT 1 FROM im_users WHERE owner_id=? LIMIT 1').get(targetId)) {
    throw new ChatError(409, '请先删除该账号名下的所有 Agent');
  }
  const run = () => {
    const directConvoIds = db
      .prepare("SELECT id FROM im_conversations WHERE low_id=? OR high_id=?")
      .all(targetId, targetId)
      .map((r) => String(r.id));
    for (const cid of directConvoIds) {
      db.prepare('DELETE FROM im_message_features WHERE message_id IN (SELECT id FROM im_messages WHERE conversation_id=?)').run(cid);
      db.prepare('DELETE FROM im_files WHERE conversation_id=?').run(cid);
      db.prepare('DELETE FROM im_events WHERE conversation_id=?').run(cid);
      db.prepare('DELETE FROM im_messages WHERE conversation_id=?').run(cid);
      db.prepare('DELETE FROM im_members WHERE conversation_id=?').run(cid);
      db.prepare('DELETE FROM im_conversations WHERE id=?').run(cid);
    }
    db.prepare('DELETE FROM im_message_features WHERE message_id IN (SELECT id FROM im_messages WHERE sender_id=?)').run(targetId);
    db.prepare('DELETE FROM im_files WHERE user_id=? OR message_id IN (SELECT id FROM im_messages WHERE sender_id=?)').run(targetId, targetId);
    db.prepare('DELETE FROM im_events WHERE user_id=? OR message_id IN (SELECT id FROM im_messages WHERE sender_id=?)').run(targetId, targetId);
    db.prepare('DELETE FROM im_messages WHERE sender_id=?').run(targetId);
    db.prepare('DELETE FROM im_members WHERE user_id=?').run(targetId);
    db.prepare('UPDATE im_conversations SET owner_id=NULL WHERE owner_id=?').run(targetId);
    db.prepare('DELETE FROM im_contacts WHERE user_id=? OR contact_id=?').run(targetId, targetId);
    db.prepare('DELETE FROM im_stickers WHERE user_id=?').run(targetId);
    db.prepare('DELETE FROM im_avatars WHERE user_id=?').run(targetId);
    db.prepare('DELETE FROM im_invites WHERE owner_id=?').run(targetId);
    db.prepare('DELETE FROM im_vault_items WHERE user_id=?').run(targetId);
    db.prepare('DELETE FROM im_account_crypto WHERE user_id=?').run(targetId);
    db.prepare('DELETE FROM im_sessions WHERE user_id=?').run(targetId);

    const optionalUserTables: [string, string][] = [
      ['im_trusted_credentials', 'user_id'],
      ['im_trusted_logins', 'user_id'],
      ['im_trusted_qr_invites', 'user_id'],
      ['im_trusted_ceremonies', 'user_id'],
      ['im_trusted_enroll_grants', 'user_id'],
      ['im_trusted_action_grants', 'user_id'],
      ['im_trusted_totp_grants', 'user_id'],
      ['im_trusted_events', 'user_id'],
      ['im_authenticator_setups', 'user_id'],
      ['im_external_setup_grants', 'user_id'],
      ['im_account_totp', 'user_id'],
      ['im_external_totp', 'user_id'],
      ['im_desktop_backup_grants', 'user_id'],
      ['im_usage_reset_proofs', 'account_id'],
      ['im_call_presence', 'agent_id'],
      ['im_calls', 'caller_id'],
      ['im_calls', 'agent_id'],
      ['im_call_signals', 'sender_id'],
      ['resource_policies', 'owner_id'],
      ['resource_usage', 'owner_id'],
      ['resource_relay_tickets', 'owner_id'],
    ];
    for (const [table, col] of optionalUserTables) {
      if (tableExists(db, table)) {
        db.prepare(`DELETE FROM ${table} WHERE ${col}=?`).run(targetId);
      }
    }
    db.prepare('DELETE FROM im_users WHERE id=?').run(targetId);
    return {
      id: targetId,
      username: String(user.username),
      displayName: String(user.displayName),
      kind: String(user.kind),
    };
  };
  return db.isTransaction ? run() : db.transaction(run);
}

/**
 * Atomically migrate an account to a vacant target UID while preserving all active sessions,
 * profile, avatar, stickers, vault, and references under SQLite foreign-key enforcement.
 */
export function migrateAdminUserId(
  db: MessagingDatabase,
  fromId: string,
  toId: string,
  resetAllocator = false,
) {
  if (fromId === toId) throw new ChatError(400, '目标 UID 与当前 UID 相同');
  const source = db
    .prepare('SELECT id, kind, username, display_name, password_hash, owner_id, created_at FROM im_users WHERE id=?')
    .get(fromId);
  if (!source) throw new ChatError(404, '源账号不存在');
  if (db.prepare('SELECT 1 FROM im_users WHERE id=?').get(toId)) {
    throw new ChatError(409, `目标 UID ${toId} 已被占用，请先清理或选择其他 UID`);
  }
  const run = () => {
    const tempUsername = `__migrating_${fromId}_${Date.now()}`;
    db.prepare('UPDATE im_users SET username=? WHERE id=?').run(tempUsername, fromId);
    db.prepare(
      'INSERT INTO im_users(id,kind,username,display_name,password_hash,owner_id,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(
      toId,
      source.kind!,
      source.username!,
      source.display_name!,
      source.password_hash ?? null,
      source.owner_id ?? null,
      source.created_at!,
    );

    db.prepare('UPDATE im_users SET owner_id=? WHERE owner_id=?').run(toId, fromId);
    db.prepare('UPDATE im_sessions SET user_id=? WHERE user_id=?').run(toId, fromId);
    db.prepare('UPDATE im_account_crypto SET user_id=? WHERE user_id=?').run(toId, fromId);
    db.prepare('UPDATE im_vault_items SET user_id=? WHERE user_id=?').run(toId, fromId);
    db.prepare('UPDATE im_invites SET owner_id=? WHERE owner_id=?').run(toId, fromId);
    db.prepare('UPDATE im_contacts SET user_id=? WHERE user_id=?').run(toId, fromId);
    db.prepare('UPDATE im_contacts SET contact_id=? WHERE contact_id=?').run(toId, fromId);
    db.prepare('UPDATE im_conversations SET owner_id=? WHERE owner_id=?').run(toId, fromId);

    // Keep canonical direct-conversation ordering (low_id < high_id lexicographically/numerically).
    const directs = db
      .prepare('SELECT id, low_id, high_id FROM im_conversations WHERE low_id=? OR high_id=?')
      .all(fromId, fromId);
    for (const c of directs) {
      const a = String(c.low_id) === fromId ? toId : String(c.low_id);
      const b = String(c.high_id) === fromId ? toId : String(c.high_id);
      const [low, high] = a < b ? [a, b] : [b, a];
      db.prepare('UPDATE im_conversations SET low_id=?, high_id=? WHERE id=?').run(low, high, c.id!);
    }

    db.prepare('UPDATE im_members SET user_id=? WHERE user_id=?').run(toId, fromId);
    db.prepare('UPDATE im_messages SET sender_id=? WHERE sender_id=?').run(toId, fromId);
    db.prepare('UPDATE im_events SET user_id=? WHERE user_id=?').run(toId, fromId);
    db.prepare('UPDATE im_files SET user_id=? WHERE user_id=?').run(toId, fromId);
    db.prepare('UPDATE im_avatars SET user_id=? WHERE user_id=?').run(toId, fromId);
    db.prepare('UPDATE im_stickers SET user_id=? WHERE user_id=?').run(toId, fromId);
    db.prepare('UPDATE im_admin_audit SET actor_id=? WHERE actor_id=?').run(toId, fromId);

    const optionalUserTables: [string, string][] = [
      ['im_trusted_credentials', 'user_id'],
      ['im_trusted_logins', 'user_id'],
      ['im_trusted_qr_invites', 'user_id'],
      ['im_trusted_ceremonies', 'user_id'],
      ['im_trusted_enroll_grants', 'user_id'],
      ['im_trusted_action_grants', 'user_id'],
      ['im_trusted_totp_grants', 'user_id'],
      ['im_trusted_events', 'user_id'],
      ['im_authenticator_setups', 'user_id'],
      ['im_external_setup_grants', 'user_id'],
      ['im_account_totp', 'user_id'],
      ['im_external_totp', 'user_id'],
      ['im_desktop_backup_grants', 'user_id'],
      ['im_usage_reset_proofs', 'account_id'],
      ['im_call_presence', 'agent_id'],
      ['im_calls', 'caller_id'],
      ['im_calls', 'agent_id'],
      ['im_call_signals', 'sender_id'],
      ['resource_policies', 'owner_id'],
      ['resource_usage', 'owner_id'],
      ['resource_relay_tickets', 'owner_id'],
    ];
    for (const [table, col] of optionalUserTables) {
      if (tableExists(db, table)) {
        db.prepare(`UPDATE ${table} SET ${col}=? WHERE ${col}=?`).run(toId, fromId);
      }
    }

    db.prepare('DELETE FROM im_users WHERE id=?').run(fromId);

    let lastUid: string | undefined;
    if (resetAllocator) {
      const ids = db
        .prepare('SELECT id FROM im_users')
        .all()
        .map((r) => BigInt(String(r.id)));
      const maxId = ids.length ? ids.reduce((a, b) => (a > b ? a : b)) : 9_999_999n;
      lastUid = maxId.toString();
      db.prepare("UPDATE im_uid_allocator SET last_uid=? WHERE name='user'").run(lastUid);
    }
    return { fromId, toId, username: String(source.username), ...(lastUid ? { lastUid } : {}) };
  };
  return db.isTransaction ? run() : db.transaction(run);
}
