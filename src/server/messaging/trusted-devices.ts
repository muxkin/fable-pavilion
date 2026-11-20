import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { z } from 'zod';
import type { AccountVault } from '../../shared/account-crypto.js';
import { verifyDeviceLoginApproval } from '../../shared/trusted-device-crypto.js';
import type { ChatUser } from '../../shared/messaging.js';
import type { MessagingHttp, MessagingReply, MessagingRequest } from './http.js';
import { ChatError, digest, type MessagingStore } from './store-core.js';
import type { AccountTotp } from './totp.js';

const id = z.string().uuid();
const tokenValue = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const passwordProof = z
  .string()
  .length(44)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const trustedDeviceName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);
const name = trustedDeviceName;
const binary = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+$/);
const webauthnResponse = z
  .object({
    id: binary.max(2048),
    rawId: binary.max(2048),
    response: z.object({ clientDataJSON: binary }).passthrough(),
    type: z.literal('public-key'),
    clientExtensionResults: z.object({}).passthrough(),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  })
  .strict();
const registrationResponse = webauthnResponse.extend({
  response: webauthnResponse.shape.response.extend({ attestationObject: binary }),
});
const authenticationResponse = webauthnResponse.extend({
  response: webauthnResponse.shape.response.extend({
    authenticatorData: binary,
    signature: binary,
    userHandle: binary.optional(),
  }),
});
const publicKey = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: tokenValue,
    y: tokenValue,
  })
  .strict();
const envelope = z
  .object({
    publicKey,
    iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
    data: z.string().regex(/^[A-Za-z0-9+/]{64}$/),
  })
  .strict();
const action = z.enum(['qr', 'revoke', 'enroll', 'totp-display', 'totp-provision', 'totp-add']);
const MAX_DEVICES = 12;
const MAX_EVENTS = 100;
const MAX_APPROVED_INVITES = 4;
const WEBAUTHN_TTL = 120_000;
const LOGIN_TTL = 180_000;
const INVITE_TTL = 120_000;
const APPROVAL_TTL = 60_000;
const TOTP_DISPLAY_TTL = 90_000;
const MAX_CODE_ATTEMPTS = 5;
const AUTHENTICATOR_SETUP_TTL = 5 * 60_000;
const MAX_SETUP_READS = 8;
const unboundQr = 'qr-unbound';
type Action = z.infer<typeof action>;
type Row = NonNullable<ReturnType<ReturnType<MessagingStore['db']['prepare']>['get']>>;
type AccountRow = { vault: string; revision: number };

type Dependencies = {
  origin: string;
  store: MessagingStore;
  human: (req: MessagingRequest) => ChatUser;
  token: (req: MessagingRequest) => string;
  cookieToken: (req: MessagingRequest) => string;
  session: (req: MessagingRequest, reply: MessagingReply, user: ChatUser) => { user: ChatUser };
  take: (key: string, max: number) => void;
  account: (id: string) => Row | undefined;
  verifyPassword: (proof: string, expected?: string) => Promise<boolean>;
  totp: AccountTotp;
  deviceLoginOnly?: boolean;
};

const secret = () => randomBytes(32).toString('base64url');
const unavailable = () => new ChatError(404, '请求不存在或已失效，请重新发起');
const stale = () => new ChatError(409, '账号或设备状态已变化，请重新操作');
const mapAccount = (row: Row | undefined): AccountRow | undefined =>
  row && { vault: String(row.vault), revision: Number(row.revision) };
const matchesHash = (expected: Row[string], secretValue: string) =>
  typeof expected === 'string' &&
  expected.length === 64 &&
  timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(digest(secretValue), 'utf8'));

async function validatePublicKey(key: z.infer<typeof publicKey>) {
  try {
    return await globalThis.crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
  } catch {
    throw new ChatError(400, '设备公钥不正确');
  }
}

async function bindRecipient(requestId: string, recipient: CryptoKey) {
  const { subtle } = globalThis.crypto;
  const exchange = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: recipient }, exchange.privateKey, 256);
  const { kty, crv, x, y } = await subtle.exportKey('jwk', exchange.publicKey);
  const proofKey = publicKey.parse({ kty, crv, x, y });
  const evidence = Buffer.from(shared).toString('base64url');
  const proof = Buffer.from(
    digest(`fable-pavilion:qr-possession:v1:${requestId}:${evidence}`),
    'hex',
  ).toString('base64url');
  return { proofKey, proofHash: digest(proof) };
}

export function registerTrustedDevices(app: MessagingHttp, d: Dependencies) {
  const { store, human, take, totp } = d;
  const { db } = store;
  // req.origin is the URL origin already validated by the hosting adapter, never the Origin header.
  const originContext = (req: MessagingRequest) => {
    const origin = req.origin ?? d.origin;
    const recognized = new URL(origin);
    const rpId = recognized.hostname;
    const literalAddress = /^\d+(?:\.\d+){3}$/.test(rpId) || rpId.includes(':');
    const secure =
      recognized.origin === origin &&
      (recognized.protocol === 'https:' ||
        (recognized.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(rpId)));
    return {
      origin,
      rpId,
      available: secure,
      passkeyAvailable: secure && !literalAddress,
    };
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS im_trusted_credentials (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL, counter INTEGER NOT NULL, name TEXT NOT NULL,
      device_type TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS im_trusted_credentials_user ON im_trusted_credentials(user_id);
    CREATE TABLE IF NOT EXISTS im_trusted_logins (
      id TEXT PRIMARY KEY, user_id TEXT, revision INTEGER, kind TEXT NOT NULL,
      device_name TEXT NOT NULL, claim_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
      public_key TEXT, proof_hash TEXT, envelope TEXT,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS im_trusted_logins_user ON im_trusted_logins(user_id,expires_at);
    CREATE INDEX IF NOT EXISTS im_trusted_logins_expiry ON im_trusted_logins(expires_at);
    CREATE TABLE IF NOT EXISTS im_trusted_qr_invites (
      id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, user_id TEXT NOT NULL,
      session_hash TEXT NOT NULL, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      state TEXT NOT NULL, login_id TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS im_trusted_invites_actor ON im_trusted_qr_invites(user_id,session_hash);
    CREATE INDEX IF NOT EXISTS im_trusted_invites_expiry ON im_trusted_qr_invites(expires_at);
    CREATE TABLE IF NOT EXISTS im_trusted_ceremonies (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_hash TEXT NOT NULL,
      revision INTEGER NOT NULL, action TEXT NOT NULL, target TEXT, name TEXT,
      challenge TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS im_trusted_ceremonies_expiry ON im_trusted_ceremonies(expires_at);
    CREATE TABLE IF NOT EXISTS im_trusted_enroll_grants (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_hash TEXT NOT NULL,
      credential_id TEXT NOT NULL, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS im_trusted_enroll_grants_expiry ON im_trusted_enroll_grants(expires_at);
    CREATE TABLE IF NOT EXISTS im_trusted_totp_grants (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_hash TEXT NOT NULL,
      credential_id TEXT NOT NULL, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS im_trusted_totp_grants_actor ON im_trusted_totp_grants(user_id,session_hash);
    CREATE INDEX IF NOT EXISTS im_trusted_totp_grants_expiry ON im_trusted_totp_grants(expires_at);
    CREATE TABLE IF NOT EXISTS im_trusted_events (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
      name TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS im_trusted_events_user ON im_trusted_events(user_id,created_at,id);
    CREATE TABLE IF NOT EXISTS im_authenticator_setups (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_hash TEXT NOT NULL,
      revision INTEGER NOT NULL, origin TEXT NOT NULL, expires_at INTEGER NOT NULL,
      reads INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS im_authenticator_setups_expiry ON im_authenticator_setups(expires_at);
    CREATE INDEX IF NOT EXISTS im_authenticator_setups_user ON im_authenticator_setups(user_id);
    CREATE TABLE IF NOT EXISTS im_external_setup_grants (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_hash TEXT NOT NULL,
      revision INTEGER NOT NULL, origin TEXT NOT NULL, expires_at INTEGER NOT NULL,
      reads INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS im_external_setup_grants_expiry ON im_external_setup_grants(expires_at);
    CREATE INDEX IF NOT EXISTS im_external_setup_grants_user ON im_external_setup_grants(user_id);
    CREATE TABLE IF NOT EXISTS im_trusted_origins (
      kind TEXT NOT NULL, id TEXT NOT NULL, origin TEXT NOT NULL,
      PRIMARY KEY (kind,id)
    );
  `);
  // A sidecar preserves the original column counts for safe runtime rollback.
  // Legacy rows were created with the single configured origin. Bind them once, never overwrite.
  const originTables = [
    ['credential', 'im_trusted_credentials', 'id'],
    ['login', 'im_trusted_logins', 'id'],
    ['invite', 'im_trusted_qr_invites', 'id'],
    ['ceremony', 'im_trusted_ceremonies', 'id'],
    ['enroll-grant', 'im_trusted_enroll_grants', 'hash'],
    ['totp-grant', 'im_trusted_totp_grants', 'hash'],
  ] as const;
  type OriginKind = (typeof originTables)[number][0];
  for (const [kind, table, key] of originTables) {
    db.prepare(
      `INSERT OR IGNORE INTO im_trusted_origins(kind,id,origin) SELECT ?,${key},? FROM ${table}`,
    ).run(kind, d.origin);
  }
  const boundOrigin = (kind: OriginKind, key: Row[string]) =>
    db.prepare('SELECT origin FROM im_trusted_origins WHERE kind=? AND id=?').get(kind, key)?.origin;
  const bindOrigin = (kind: OriginKind, key: string, origin: string) =>
    db.prepare('INSERT INTO im_trusted_origins(kind,id,origin) VALUES (?,?,?)').run(kind, key, origin);
  const withOrigin = (kind: OriginKind, row: Row | undefined): Row | undefined =>
    row && { ...row, origin: boundOrigin(kind, row.id) ?? null };
  const withRp = (row: Row): Row & { rp_id: string } => ({
    ...row,
    rp_id: new URL(String(boundOrigin('credential', row.id))).hostname,
  });
  const devices = (userId: string) =>
    db
      .prepare('SELECT * FROM im_trusted_credentials WHERE user_id=? ORDER BY created_at,id')
      .all(userId)
      .map(withRp);
  const recordEvent = (
    userId: string,
    kind: 'login' | 'enrolled' | 'revoked' | 'recovered',
    deviceName: string,
  ) => {
    db.prepare('INSERT INTO im_trusted_events VALUES (?,?,?,?,?)').run(
      randomUUID(),
      userId,
      kind,
      deviceName,
      Date.now(),
    );
    db.prepare(
      `DELETE FROM im_trusted_events WHERE user_id=? AND id NOT IN (
      SELECT id FROM im_trusted_events WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ?)`,
    ).run(userId, userId, MAX_EVENTS);
  };
  const hasCredentials = (userId: string) =>
    !!db.prepare('SELECT 1 FROM im_trusted_credentials WHERE user_id=? LIMIT 1').get(userId);
  const required = (userId: string) => !!d.account(userId);
  const usesServerTotp = (account: AccountRow) =>
    !d.deviceLoginOnly && !!(JSON.parse(account.vault) as AccountVault).password;

  const originCheck = (req: MessagingRequest, passkey = false) => {
    const context = originContext(req);
    if (!context.available || (passkey && !context.passkeyAvailable))
      throw new ChatError(403, '此操作需要 HTTPS 或本机安全连接');
    if (req.headers.origin && req.headers.origin !== context.origin)
      throw new ChatError(403, '请求来源不受信任');
    if (req.method !== 'GET' && req.headers.origin !== context.origin)
      throw new ChatError(403, '请求缺少同源验证');
    return context;
  };
  const actor = (req: MessagingRequest) => {
    const user = human(req);
    const account = mapAccount(d.account(user.id));
    if (!account) throw new ChatError(403, '请先解锁账号');
    return { user, account, sessionHash: digest(d.token(req)), ...originContext(req) };
  };
  const stillActor = (req: MessagingRequest, userId: string, revision: number) => {
    const current = actor(req);
    if (current.user.id !== userId || current.account.revision !== revision) throw stale();
    return current;
  };
  const credential = (userId: string, credentialId: string) => {
    const row = db
      .prepare('SELECT * FROM im_trusted_credentials WHERE user_id=? AND credential_id=?')
      .get(userId, credentialId);
    return row && withRp(row);
  };
  const inviteById = (inviteId: string) =>
    withOrigin('invite', db.prepare('SELECT * FROM im_trusted_qr_invites WHERE id=?').get(inviteId));
  const inviteByLogin = (loginId: string) =>
    withOrigin('invite', db.prepare('SELECT * FROM im_trusted_qr_invites WHERE login_id=?').get(loginId));
  const inviteCurrent = (invite: Row) =>
    Number(invite.expires_at) > Date.now() &&
    mapAccount(d.account(String(invite.user_id)))?.revision === invite.revision &&
    required(String(invite.user_id)) &&
    !!db
      .prepare('SELECT 1 FROM im_sessions WHERE hash=? AND user_id=? AND expires_at>?')
      .get(invite.session_hash, invite.user_id, Date.now());
  const activeLogin = (requestId: string, origin: string, ownerSessionHash?: string) => {
    const row = withOrigin(
      'login',
      db.prepare('SELECT * FROM im_trusted_logins WHERE id=? AND expires_at>?').get(requestId, Date.now()),
    );
    if (row?.origin !== origin) return undefined;
    if (row?.kind === 'qr') {
      const invite = inviteByLogin(requestId);
      if (
        invite &&
        (invite.origin !== row.origin ||
          invite.user_id !== row.user_id ||
          invite.revision !== row.revision ||
          (invite.state !== 'claimed' && invite.state !== 'approved') ||
          (ownerSessionHash !== undefined && invite.session_hash !== ownerSessionHash) ||
          !inviteCurrent(invite))
      )
        return undefined;
    }
    return row;
  };
  const sweep = () => {
    const now = Date.now();
    db.prepare('DELETE FROM im_trusted_logins WHERE expires_at<=?').run(now);
    db.prepare('DELETE FROM im_trusted_ceremonies WHERE expires_at<=?').run(now);
    db.prepare('DELETE FROM im_trusted_enroll_grants WHERE expires_at<=?').run(now);
    db.prepare('DELETE FROM im_trusted_totp_grants WHERE expires_at<=?').run(now);
    db.prepare('DELETE FROM im_authenticator_setups WHERE expires_at<=?').run(now);
    db.prepare('DELETE FROM im_external_setup_grants WHERE expires_at<=?').run(now);
    db.prepare('DELETE FROM im_trusted_qr_invites WHERE expires_at<=?').run(now - LOGIN_TTL);
    for (const [kind, table, key] of originTables) {
      db.prepare(
        `DELETE FROM im_trusted_origins WHERE kind=? AND id NOT IN (SELECT ${key} FROM ${table})`,
      ).run(kind);
    }
  };

  function createLogin(
    req: MessagingRequest,
    kind: 'code' | 'qr' | typeof unboundQr,
    deviceName: string,
    userId?: string,
    revision?: number,
    binding?: { requestId: string; key: string; proofHash: string; expiresAt?: number },
  ) {
    const requestId = binding?.requestId ?? randomUUID();
    const claim = secret();
    const expiresAt = binding?.expiresAt ?? Date.now() + LOGIN_TTL;
    const create = () => {
      sweep();
      db.prepare(
        `INSERT INTO im_trusted_logins
        (id,user_id,revision,kind,device_name,claim_hash,expires_at,public_key,proof_hash) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        requestId,
        userId ?? null,
        revision ?? null,
        kind,
        deviceName,
        digest(claim),
        expiresAt,
        binding?.key ?? null,
        binding?.proofHash ?? null,
      );
      bindOrigin('login', requestId, originContext(req).origin);
      return {
        id: requestId,
        claim,
        expiresAt,
        ...(requiresQrSignature(kind) && { deviceBound: true }),
      };
    };
    return db.isTransaction ? create() : store.transaction(create);
  }

  function passwordChallenge(req: MessagingRequest, userId: string, revision: number, deviceName: string) {
    originCheck(req);
    requireTotpConfigured();
    if (!totp.enabled(userId))
      throw new ChatError(409, '请先在已登录的可信设备查看动态码，或使用扫码登录或恢复码');
    return createLogin(req, 'code', deviceName, userId, revision);
  }

  function validateQr(current: ReturnType<typeof actor>, target: string) {
    const row = activeLogin(target, current.origin, current.sessionHash);
    if (!row || row.envelope) throw unavailable();
    if (row.kind === unboundQr && row.user_id === null && row.revision === null) return row;
    if (row.kind !== 'qr' || row.user_id !== current.user.id || row.revision !== current.account.revision)
      throw unavailable();
    return row;
  }

  function requiresQrSignature(kind: Row[string]) {
    return kind === unboundQr || (kind === 'qr' && d.deviceLoginOnly);
  }

  function approveQr(
    current: ReturnType<typeof actor>,
    target: string,
    encrypted: z.infer<typeof envelope>,
    signed = false,
  ) {
    const row = validateQr(current, target);
    if (requiresQrSignature(row.kind) && !signed) throw new ChatError(409, '请更新客户端并重新扫码');
    if (row.kind === unboundQr) {
      // This is the only point at which the anonymous request becomes an account login.
      const bound = db
        .prepare(
          'UPDATE im_trusted_logins SET user_id=?,revision=?,envelope=? WHERE id=? AND user_id IS NULL AND revision IS NULL AND envelope IS NULL',
        )
        .run(current.user.id, current.account.revision, JSON.stringify(encrypted), target);
      if (bound.changes !== 1) throw unavailable();
    } else {
      db.prepare('UPDATE im_trusted_logins SET envelope=? WHERE id=?').run(JSON.stringify(encrypted), target);
      db.prepare("UPDATE im_trusted_qr_invites SET state='approved' WHERE login_id=?").run(target);
    }
    return { ok: true };
  }

  function ownedInvite(current: ReturnType<typeof actor>, inviteId: string) {
    const invite = inviteById(inviteId);
    if (
      !invite ||
      invite.origin !== current.origin ||
      invite.user_id !== current.user.id ||
      invite.session_hash !== current.sessionHash ||
      invite.revision !== current.account.revision ||
      !required(current.user.id)
    )
      throw unavailable();
    return invite;
  }

  function inviteForClaim(inviteId: string, inviteSecret: string, origin: string) {
    const invite = inviteById(inviteId);
    if (
      !invite ||
      invite.origin !== origin ||
      !matchesHash(invite.secret_hash, inviteSecret) ||
      !inviteCurrent(invite)
    )
      throw unavailable();
    if (invite.state !== 'waiting') throw new ChatError(409, '邀请二维码已使用或取消，请重新生成');
    return invite;
  }

  function cancelInvite(invite: Row) {
    db.prepare("UPDATE im_trusted_qr_invites SET state='cancelled' WHERE id=?").run(invite.id);
    if (invite.login_id) db.prepare('DELETE FROM im_trusted_logins WHERE id=?').run(invite.login_id);
  }

  function requireAnonymousRecipient(req: MessagingRequest) {
    if (
      [d.token(req), d.cookieToken(req)].some(
        (token) => token && token.length <= 256 && store.authenticate(token),
      )
    )
      throw new ChatError(409, '请在尚未登录的设备上继续扫码登录');
  }

  function requireTotpConfigured() {
    if (!totp.configured) throw new ChatError(503, '当前服务未配置动态码，请使用扫码登录或账号恢复');
  }

  // Called only inside a successful registration or recovery-password transaction.
  const legacySetup = 'im_authenticator_setups';
  const externalSetupGrants = 'im_external_setup_grants';

  function beginAuthenticatorSetup(
    req: MessagingRequest,
    userId: string,
    revision: number,
    sessionHash: string,
    table: typeof legacySetup | typeof externalSetupGrants = legacySetup,
  ) {
    requireTotpConfigured();
    const account = mapAccount(d.account(userId));
    if (
      !account ||
      !usesServerTotp(account) ||
      account.revision !== revision ||
      !totp.enabled(userId) ||
      !db
        .prepare('SELECT 1 FROM im_sessions WHERE hash=? AND user_id=? AND expires_at>?')
        .get(sessionHash, userId, Date.now())
    )
      throw stale();
    const grant = secret();
    const expiresAt = Date.now() + AUTHENTICATOR_SETUP_TTL;
    sweep();
    db.prepare(`DELETE FROM ${table} WHERE user_id=? AND session_hash=?`).run(userId, sessionHash);
    db.prepare(
      `INSERT INTO ${table}(hash,user_id,session_hash,revision,origin,expires_at) VALUES (?,?,?,?,?,?)`,
    ).run(digest(grant), userId, sessionHash, revision, originContext(req).origin, expiresAt);
    return { grant, expiresAt };
  }

  function setupGrant(current: ReturnType<typeof actor>, grant: string, allowExternal = true) {
    const hash = digest(grant);
    const tables = allowExternal ? ([externalSetupGrants, legacySetup] as const) : ([legacySetup] as const);
    for (const table of tables) {
      const row = db
        .prepare(
          `SELECT * FROM ${table} WHERE hash=? AND user_id=? AND session_hash=? AND revision=? AND origin=? AND expires_at>?`,
        )
        .get(
          hash,
          current.user.id,
          current.sessionHash,
          current.account.revision,
          current.origin,
          Date.now(),
        );
      if (row) return { row, hash, table };
    }
    throw unavailable();
  }

  app.post('/crypto/authenticators/options', { bodyLimit: 4096 }, async (req) => {
    originCheck(req);
    const current = actor(req);
    const { user, sessionHash, account } = current;
    take(`external-authenticator:${user.id}`, 6);
    const { auth, recoveryAuth } = z
      .object({
        auth: passwordProof.optional(),
        recoveryAuth: passwordProof.optional(),
      })
      .strict()
      .parse(req.body);
    if (!store.recentlyVerified(user.id, sessionHash)) {
      if (!auth || !recoveryAuth) throw new ChatError(403, '请验证身份后再添加验证器');
      const [password, recovery] = await Promise.all([
        d.verifyPassword(auth, store.credentials(user.id)?.passwordHash),
        d.verifyPassword(recoveryAuth, String(d.account(user.id)?.recovery_hash ?? '') || undefined),
      ]);
      if (!password || !recovery) throw new ChatError(403, '密码或恢复码不正确');
    }
    return store.transaction(() => {
      stillActor(req, user.id, account.revision);
      return beginAuthenticatorSetup(req, user.id, account.revision, sessionHash, externalSetupGrants);
    });
  });

  app.delete('/crypto/authenticators/:id', { bodyLimit: 4096 }, async (req) => {
    originCheck(req);
    const current = actor(req);
    const { user, account } = current;
    take(`external-authenticator-remove:${user.id}`, 6);
    const { id: target } = z.object({ id }).parse(req.params);
    const { auth } = z.object({ auth: passwordProof }).strict().parse(req.body);
    if (!(await d.verifyPassword(auth, store.credentials(user.id)?.passwordHash)))
      throw new ChatError(403, '密码不正确');
    return store.transaction(() => {
      stillActor(req, user.id, account.revision);
      if (!totp.removeExternal(user.id, target)) throw unavailable();
      return { ok: true };
    });
  });

  app.post('/crypto/authenticator/setup', { bodyLimit: 4096 }, (req) => {
    originCheck(req);
    requireTotpConfigured();
    const current = actor(req);
    take(`authenticator-setup:${current.user.id}`, 12);
    const { grant, name: label } = z
      .object({ grant: tokenValue, name: name.optional() })
      .strict()
      .parse(req.body);
    return store.transaction(() => {
      const { row, hash, table } = setupGrant(current, grant);
      if (Number(row.reads) >= MAX_SETUP_READS)
        throw new ChatError(429, '设置二维码查看次数已达上限，请完成验证或稍后重新添加');
      const pending = totp.pendingExternal(current.user.id, hash);
      const provisioning =
        pending || label || table === externalSetupGrants
          ? totp.beginExternal(
              current.user.id,
              current.user.username,
              label ?? '身份验证器',
              hash,
              Number(row.expires_at),
            )
          : totp.provision(current.user.id, current.user.username);
      db.prepare(`UPDATE ${table} SET reads=reads+1 WHERE hash=?`).run(hash);
      return { ...provisioning, expiresAt: Number(row.expires_at) };
    });
  });

  app.post('/crypto/authenticator/confirm', { bodyLimit: 4096 }, (req) => {
    originCheck(req);
    requireTotpConfigured();
    const current = actor(req);
    take(`authenticator-confirm:${current.user.id}`, 12);
    const { grant, code } = z
      .object({ grant: tokenValue, code: z.string().regex(/^\d{6}$/) })
      .strict()
      .parse(req.body);
    const valid = store.transaction(() => {
      const { row, hash, table } = setupGrant(current, grant);
      if (Number(row.attempts) >= MAX_CODE_ATTEMPTS) throw unavailable();
      const valid =
        table === externalSetupGrants || totp.pendingExternal(current.user.id, hash)
          ? totp.finishExternal(current.user.id, hash, code)
          : totp.verify(current.user.id, code);
      if (!valid) {
        if (Number(row.attempts) + 1 >= MAX_CODE_ATTEMPTS)
          db.prepare(`DELETE FROM ${table} WHERE hash=?`).run(hash);
        else db.prepare(`UPDATE ${table} SET attempts=attempts+1 WHERE hash=?`).run(hash);
        return false;
      }
      db.prepare(`DELETE FROM ${table} WHERE hash=?`).run(hash);
      return true;
    });
    if (!valid) throw new ChatError(401, '动态码不正确');
    return { ok: true };
  });

  app.post('/crypto/authenticator/cancel', { bodyLimit: 4096 }, (req) => {
    originCheck(req);
    const current = actor(req);
    take(`authenticator-cancel:${current.user.id}`, 12);
    const { grant } = z.object({ grant: tokenValue }).strict().parse(req.body);
    return store.transaction(() => {
      const { table, hash } = setupGrant(current, grant);
      totp.cancelExternal(current.user.id, hash);
      db.prepare(`DELETE FROM ${table} WHERE hash=?`).run(hash);
      return { ok: true };
    });
  });

  function qrRequest(row: Row) {
    return {
      id: row.id,
      name: row.device_name,
      expiresAt: row.expires_at,
      ...(requiresQrSignature(row.kind) && { deviceBound: true }),
      publicKey: JSON.parse(String(row.public_key)) as z.infer<typeof publicKey>,
    };
  }

  function startCeremony(
    req: MessagingRequest,
    current: ReturnType<typeof actor>,
    verb: Action | 'register',
    challenge: string,
    target?: string,
    deviceName?: string,
  ) {
    stillActor(req, current.user.id, current.account.revision);
    const ceremonyId = randomUUID();
    sweep();
    db.prepare(
      `INSERT INTO im_trusted_ceremonies
      (id,user_id,session_hash,revision,action,target,name,challenge,expires_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      ceremonyId,
      current.user.id,
      current.sessionHash,
      current.account.revision,
      verb,
      target ?? null,
      deviceName ?? null,
      challenge,
      Date.now() + WEBAUTHN_TTL,
    );
    bindOrigin('ceremony', ceremonyId, current.origin);
    return ceremonyId;
  }

  function consumeCeremony(req: MessagingRequest, ceremonyId: string, registering: boolean) {
    const current = actor(req);
    return store.transaction(() => {
      const row = db
        .prepare(
          `SELECT * FROM im_trusted_ceremonies
        WHERE id=? AND user_id=? AND session_hash=? AND revision=? AND expires_at>?`,
        )
        .get(ceremonyId, current.user.id, current.sessionHash, current.account.revision, Date.now());
      if (
        !row ||
        boundOrigin('ceremony', row.id) !== current.origin ||
        (row.action === 'register') !== registering
      )
        throw unavailable();
      db.prepare('DELETE FROM im_trusted_ceremonies WHERE id=?').run(ceremonyId);
      return { current, row };
    });
  }

  function complete(req: MessagingRequest, reply: MessagingReply, userId: string, current: AccountRow) {
    return {
      ...d.session(req, reply, store.user(userId)),
      vault: JSON.parse(current.vault) as AccountVault,
      revision: current.revision,
    };
  }

  app.get('/crypto/trusted', (req) => {
    const { user, sessionHash, account } = actor(req);
    const totpAvailable = usesServerTotp(account) && totp.configured;
    return {
      recentlyVerified: store.recentlyVerified(user.id, sessionHash),
      authenticators: totpAvailable ? totp.external(user.id) : [],
      available: originContext(req).available,
      required: required(user.id),
      hasCredentials: hasCredentials(user.id),
      passkeyAvailable: originContext(req).passkeyAvailable,
      passkeysHere: devices(user.id).some((row) => row.rp_id === originContext(req).rpId),
      totpAvailable,
      totpEnabled: totpAvailable && totp.enabled(user.id),
      ...(d.deviceLoginOnly && { deviceLoginOnly: true }),
      devices: devices(user.id).map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        deviceType: row.device_type,
      })),
      events: db
        .prepare(
          `SELECT id,kind,name,created_at AS createdAt FROM im_trusted_events
        WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 20`,
        )
        .all(user.id),
    };
  });

  app.post('/crypto/trusted/enroll/options', { bodyLimit: 4096 }, async (req) => {
    const { rpId } = originCheck(req, true);
    const current = actor(req);
    const { user, account, sessionHash } = current;
    if (!hasCredentials(user.id) && usesServerTotp(account)) requireTotpConfigured();
    take(`trusted-enroll:${user.id}`, 6);
    const body = z
      .object({ name, auth: passwordProof.optional(), approval: tokenValue.optional() })
      .strict()
      .parse(req.body);
    const passwordHash = store.credentials(user.id)?.passwordHash;
    const recent = !body.auth && !body.approval && store.recentlyVerified(user.id, sessionHash);
    if (body.auth && !(await d.verifyPassword(body.auth, passwordHash)))
      throw new ChatError(403, '密码不正确');
    if (!recent && !body.auth && (!body.approval || !hasCredentials(user.id)))
      throw new ChatError(403, '请重新验证身份');
    const existing = devices(user.id);
    if (existing.length >= MAX_DEVICES) throw new ChatError(409, '可信设备数量已达上限');
    const options = await generateRegistrationOptions({
      rpName: '子虚亭',
      rpID: rpId,
      userID: new TextEncoder().encode(user.id),
      userName: user.username,
      userDisplayName: user.displayName,
      timeout: WEBAUTHN_TTL,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      excludeCredentials: existing
        .filter((row) => row.rp_id === rpId)
        .map((row) => ({ id: String(row.credential_id) })),
      supportedAlgorithmIDs: [-7, -257],
    });
    return store.transaction(() => {
      stillActor(req, user.id, account.revision);
      if (store.credentials(user.id)?.passwordHash !== passwordHash) throw stale();
      let approvedBy: string | undefined;
      if (hasCredentials(user.id) && (!recent || body.approval)) {
        if (!body.approval) throw new ChatError(403, '请先用已有可信设备批准添加设备');
        const hashed = digest(body.approval);
        const approval = db
          .prepare(
            `SELECT credential_id FROM im_trusted_enroll_grants
          WHERE hash=? AND user_id=? AND session_hash=? AND revision=? AND expires_at>?`,
          )
          .get(hashed, user.id, sessionHash, account.revision, Date.now());
        if (
          !approval ||
          boundOrigin('enroll-grant', hashed) !== current.origin ||
          !credential(user.id, String(approval.credential_id))
        )
          throw stale();
        approvedBy = String(approval.credential_id);
        db.prepare('DELETE FROM im_trusted_enroll_grants WHERE hash=?').run(hashed);
      }
      if (!approvedBy && recent) {
        if (!store.recentlyVerified(user.id, sessionHash)) throw stale();
        approvedBy = devices(user.id)[0]?.credential_id as string | undefined;
      }
      const registration = startCeremony(req, current, 'register', options.challenge, approvedBy, body.name);
      return { id: registration, options };
    });
  });

  app.post('/crypto/trusted/enroll', { bodyLimit: 24 * 1024 }, async (req) => {
    const { origin, rpId } = originCheck(req, true);
    const body = z.object({ id, response: registrationResponse }).strict().parse(req.body);
    const { current, row } = consumeCeremony(req, body.id, true);
    const { user, account } = current;
    take(`trusted-enroll-finish:${user.id}`, 8);
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: body.response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
        expectedChallenge: String(row.challenge),
        expectedOrigin: origin,
        expectedRPID: rpId,
        requireUserVerification: true,
      });
    } catch {
      throw new ChatError(403, '无法验证可信设备，请重新操作');
    }
    if (!result.verified || !result.registrationInfo) throw new ChatError(403, '无法验证可信设备');
    const { credential: passkey, credentialDeviceType } = result.registrationInfo;
    store.transaction(() => {
      stillActor(req, user.id, account.revision);
      if (Number(row.expires_at) <= Date.now()) throw stale();
      if (row.target ? !credential(user.id, String(row.target)) : hasCredentials(user.id)) throw stale();
      if (devices(user.id).length >= MAX_DEVICES) throw new ChatError(409, '可信设备数量已达上限');
      if (db.prepare('SELECT 1 FROM im_trusted_credentials WHERE credential_id=?').get(passkey.id))
        throw new ChatError(409, '该凭据已登记');
      const credentialId = randomUUID();
      db.prepare(
        `INSERT INTO im_trusted_credentials
        (id,user_id,credential_id,public_key,counter,name,device_type,created_at)
        VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        credentialId,
        user.id,
        passkey.id,
        Buffer.from(passkey.publicKey).toString('base64'),
        passkey.counter,
        String(row.name),
        credentialDeviceType,
        Date.now(),
      );
      bindOrigin('credential', credentialId, origin);
      if (!row.target && usesServerTotp(account)) totp.enable(user.id);
      recordEvent(user.id, 'enrolled', String(row.name));
    });
    return { ok: true };
  });

  app.post('/crypto/trusted/verify/options', { bodyLimit: 4096 }, async (req) => {
    const { rpId } = originCheck(req, true);
    const current = actor(req);
    const { user } = current;
    take(`trusted-verify:${user.id}`, 15);
    const body = z.object({ action, target: id.optional() }).strict().parse(req.body);
    const existing = devices(user.id);
    const candidates = existing.filter((row) => row.rp_id === rpId);
    if (!candidates.length) throw new ChatError(403, '请在已登记通行密钥的域名使用可信设备');
    if (body.action === 'qr') {
      if (!body.target) throw unavailable();
      const login = validateQr(current, body.target);
      if (login.kind === unboundQr) throw new ChatError(409, '请更新客户端并重新扫码');
    } else if (body.action === 'revoke') {
      if (!existing.some((row) => row.id === body.target)) throw unavailable();
    } else if (body.target) {
      throw new ChatError(400, '请求目标不正确');
    }
    if (body.action === 'totp-display' || body.action === 'totp-provision') requireTotpConfigured();
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'required',
      timeout: WEBAUTHN_TTL,
      allowCredentials: candidates
        .filter((row) => body.action !== 'revoke' || row.id !== body.target || candidates.length === 1)
        .map((row) => ({ id: String(row.credential_id) })),
    });
    return { id: startCeremony(req, current, body.action, options.challenge, body.target), options };
  });

  app.post('/crypto/trusted/verify', { bodyLimit: 24 * 1024 }, async (req) => {
    const { origin, rpId } = originCheck(req, true);
    const body = z
      .object({ id, response: authenticationResponse, envelope: envelope.optional() })
      .strict()
      .parse(req.body);
    const { current, row } = consumeCeremony(req, body.id, false);
    const { user, account, sessionHash } = current;
    take(`trusted-verify-finish:${user.id}`, 20);
    const saved = credential(user.id, body.response.id);
    if (!saved || saved.rp_id !== rpId || (row.action === 'revoke' && saved.id === row.target))
      throw new ChatError(403, '请使用另一台已登记的可信设备');
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: body.response as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
        expectedChallenge: String(row.challenge),
        expectedOrigin: origin,
        expectedRPID: rpId,
        requireUserVerification: true,
        credential: {
          id: String(saved.credential_id),
          counter: Number(saved.counter),
          publicKey: new Uint8Array(Buffer.from(String(saved.public_key), 'base64')),
        },
      });
    } catch {
      throw new ChatError(403, '无法确认可信设备，请重新操作');
    }
    if (!result.verified) throw new ChatError(403, '无法确认可信设备');
    const requested = action.safeParse(row.action);
    if (!requested.success) throw unavailable();
    const verb = requested.data;
    if (verb === 'qr' && d.deviceLoginOnly) throw new ChatError(409, '请更新客户端并重新扫码');
    if (verb === 'qr') {
      if (!body.envelope) throw new ChatError(400, '缺少加密交接数据');
      await validatePublicKey(body.envelope.publicKey);
    } else if (body.envelope) {
      throw new ChatError(400, '请求包含多余的交接数据');
    }
    const target = String(row.target);
    return store.transaction(() => {
      stillActor(req, user.id, account.revision);
      if (Number(row.expires_at) <= Date.now()) throw stale();
      if (
        db
          .prepare('UPDATE im_trusted_credentials SET counter=? WHERE id=? AND counter=?')
          .run(result.authenticationInfo.newCounter, saved.id, saved.counter).changes !== 1
      )
        throw stale();
      if (verb === 'totp-add')
        return beginAuthenticatorSetup(req, user.id, account.revision, sessionHash, externalSetupGrants);
      if (verb === 'totp-display' || verb === 'totp-provision') {
        requireTotpConfigured();
        if (!usesServerTotp(account)) throw unavailable();
        totp.enable(user.id);
        if (verb === 'totp-provision') return totp.provision(user.id, user.username);
        const grant = secret();
        const grantExpiresAt = Date.now() + TOTP_DISPLAY_TTL;
        db.prepare('DELETE FROM im_trusted_totp_grants WHERE user_id=? AND session_hash=?').run(
          user.id,
          sessionHash,
        );
        db.prepare('INSERT INTO im_trusted_totp_grants VALUES (?,?,?,?,?,?)').run(
          digest(grant),
          user.id,
          sessionHash,
          saved.credential_id,
          account.revision,
          grantExpiresAt,
        );
        bindOrigin('totp-grant', digest(grant), origin);
        return { ...totp.display(user.id), grant, grantExpiresAt };
      }
      if (verb === 'qr') {
        return approveQr(current, target, body.envelope!);
      }
      if (verb === 'enroll') {
        const approval = secret();
        db.prepare('INSERT INTO im_trusted_enroll_grants VALUES (?,?,?,?,?,?)').run(
          digest(approval),
          user.id,
          sessionHash,
          saved.credential_id,
          account.revision,
          Date.now() + APPROVAL_TTL,
        );
        bindOrigin('enroll-grant', digest(approval), origin);
        return { approval };
      }
      const removed = db
        .prepare('SELECT * FROM im_trusted_credentials WHERE id=? AND user_id=?')
        .get(target, user.id);
      if (!removed) throw unavailable();
      db.prepare('DELETE FROM im_trusted_credentials WHERE id=?').run(target);
      clear(user.id, false);
      db.prepare('DELETE FROM im_sessions WHERE user_id=? AND hash<>?').run(user.id, sessionHash);
      recordEvent(user.id, 'revoked', String(removed.name));
      return { ok: true };
    });
  });

  app.post('/crypto/totp/display', { bodyLimit: 4096 }, (req) => {
    const { origin } = originCheck(req);
    requireTotpConfigured();
    const { user, account, sessionHash } = actor(req);
    if (!usesServerTotp(account)) throw unavailable();
    take(`trusted-totp-display:${user.id}`, 20);
    const { grant } = z.object({ grant: tokenValue.optional() }).strict().parse(req.body);
    if (grant !== undefined) {
      const row = db
        .prepare(
          `SELECT credential_id FROM im_trusted_totp_grants
        WHERE hash=? AND user_id=? AND session_hash=? AND revision=? AND expires_at>?`,
        )
        .get(digest(grant), user.id, sessionHash, account.revision, Date.now());
      if (
        !row ||
        boundOrigin('totp-grant', digest(grant)) !== origin ||
        !credential(user.id, String(row.credential_id))
      )
        throw unavailable();
    }
    totp.enable(user.id);
    return totp.display(user.id);
  });

  app.post('/crypto/qr/approve', { bodyLimit: 4096 }, async (req) => {
    originCheck(req);
    const current = actor(req);
    take(`trusted-qr-approve:${current.user.id}`, 20);
    const body = z
      .object({
        id,
        envelope,
        signature: z
          .string()
          .regex(/^[A-Za-z0-9+/]{86}==$/)
          .optional(),
      })
      .strict()
      .parse(req.body);
    const row = validateQr(current, body.id);
    await validatePublicKey(body.envelope.publicKey);
    const needsSignature = requiresQrSignature(row.kind);
    if (needsSignature) {
      const vault = JSON.parse(current.account.vault) as AccountVault;
      const approval = {
        origin: current.origin,
        accountId: current.user.id,
        revision: current.account.revision,
        requestId: body.id,
        expiresAt: Number(row.expires_at),
        recipientPublicKey: JSON.parse(String(row.public_key)),
        envelope: body.envelope,
      };
      if (
        !body.signature ||
        !(await verifyDeviceLoginApproval(vault.publicKeys.signing, approval, body.signature).catch(
          () => false,
        ))
      )
        throw new ChatError(403, '登录批准签名无效，请在已授权设备上重新核对');
    }
    return store.transaction(() => {
      stillActor(req, current.user.id, current.account.revision);
      return approveQr(current, body.id, body.envelope, needsSignature);
    });
  });

  app.get('/crypto/qr/:id', (req) => {
    originCheck(req);
    const current = actor(req);
    take(`trusted-qr-view:${current.user.id}`, 40);
    const { id: target } = z.object({ id }).parse(req.params);
    const row = validateQr(current, target);
    if (!required(current.user.id)) throw unavailable();
    return qrRequest(row);
  });

  app.post('/crypto/qr/invite', { bodyLimit: 4096 }, (req) => {
    const { origin } = originCheck(req);
    const { user, account, sessionHash } = actor(req);
    take(`trusted-invite-create:${user.id}`, 8);
    z.object({}).strict().parse(req.body);
    if (!required(user.id)) throw new ChatError(403, '请先登记可信设备');
    return store.transaction(() => {
      sweep();
      const now = Date.now();
      const approved = db
        .prepare(
          `SELECT COUNT(*) AS count FROM im_trusted_qr_invites WHERE user_id=? AND session_hash=?
          AND revision=? AND id IN (SELECT id FROM im_trusted_origins WHERE kind='invite' AND origin=?)
          AND expires_at>? AND state='approved'`,
        )
        .get(user.id, sessionHash, account.revision, origin, now);
      if (Number(approved?.count) >= MAX_APPROVED_INVITES)
        throw new ChatError(409, '有多台设备正在完成登录，请稍后再生成');
      const existing = db
        .prepare(
          `SELECT id,login_id FROM im_trusted_qr_invites WHERE user_id=? AND session_hash=?
          AND revision=? AND id IN (SELECT id FROM im_trusted_origins WHERE kind='invite' AND origin=?)
          AND expires_at>? AND state IN ('waiting','claimed')`,
        )
        .get(user.id, sessionHash, account.revision, origin, now);
      if (existing) cancelInvite(existing);
      const inviteId = randomUUID();
      const inviteSecret = secret();
      const expiresAt = now + INVITE_TTL;
      db.prepare(
        `INSERT INTO im_trusted_qr_invites
        (id,secret_hash,user_id,session_hash,revision,expires_at,state) VALUES (?,?,?,?,?,?,'waiting')`,
      ).run(inviteId, digest(inviteSecret), user.id, sessionHash, account.revision, expiresAt);
      bindOrigin('invite', inviteId, origin);
      return { id: inviteId, secret: inviteSecret, expiresAt };
    });
  });

  app.get('/crypto/qr/invite/:id', (req) => {
    originCheck(req);
    const current = actor(req);
    take(`trusted-invite-view:${current.sessionHash}`, 120);
    const { id: inviteId } = z.object({ id }).parse(req.params);
    const invite = ownedInvite(current, inviteId);
    const expiresAt = Number(invite.expires_at);
    if (invite.state === 'completed' || invite.state === 'cancelled')
      return { id: inviteId, expiresAt, state: invite.state };
    if (expiresAt <= Date.now()) return { id: inviteId, expiresAt, state: 'expired' };
    if (invite.state === 'claimed') {
      const row = validateQr(current, String(invite.login_id));
      return { id: inviteId, expiresAt, state: invite.state, request: qrRequest(row) };
    }
    return { id: inviteId, expiresAt, state: invite.state };
  });

  app.post('/crypto/qr/invite/cancel', { bodyLimit: 4096 }, (req) => {
    originCheck(req);
    const current = actor(req);
    take(`trusted-invite-cancel:${current.user.id}`, 12);
    const { id: inviteId } = z.object({ id }).strict().parse(req.body);
    return store.transaction(() => {
      const invite = ownedInvite(current, inviteId);
      if (invite.state === 'completed') throw new ChatError(409, '对方设备已登录');
      cancelInvite(invite);
      return { ok: true };
    });
  });

  app.post('/crypto/qr/invite/claim', { bodyLimit: 4096 }, async (req) => {
    const { origin } = originCheck(req);
    take(`trusted-invite-claim:${req.clientAddress()}`, 20);
    const body = z.object({ id, secret: tokenValue, name, publicKey }).strict().parse(req.body);
    requireAnonymousRecipient(req);
    inviteForClaim(body.id, body.secret, origin);
    const recipient = await validatePublicKey(body.publicKey);
    const requestId = randomUUID();
    const { proofKey, proofHash } = await bindRecipient(requestId, recipient);
    return store.transaction(() => {
      requireAnonymousRecipient(req);
      const invite = inviteForClaim(body.id, body.secret, origin);
      const pending = createLogin(req, 'qr', body.name, String(invite.user_id), Number(invite.revision), {
        requestId,
        key: JSON.stringify(body.publicKey),
        proofHash,
        expiresAt: Number(invite.expires_at),
      });
      db.prepare("UPDATE im_trusted_qr_invites SET state='claimed',login_id=? WHERE id=?").run(
        requestId,
        body.id,
      );
      return { ...pending, proofKey };
    });
  });

  app.post('/crypto/qr/start', { bodyLimit: 4096 }, async (req) => {
    originCheck(req);
    take(`trusted-qr-start:${req.clientAddress()}`, 12);
    const body = z
      .object({
        identifier: z.string().trim().min(1).max(1024).optional(),
        name,
        publicKey,
      })
      .strict()
      .parse(req.body);
    if (body.identifier === undefined) requireAnonymousRecipient(req);
    const recipient = await validatePublicKey(body.publicKey);
    const requestId = randomUUID();
    const { proofKey, proofHash } = await bindRecipient(requestId, recipient);
    const binding = { requestId, key: JSON.stringify(body.publicKey), proofHash };
    if (body.identifier === undefined) {
      return store.transaction(() => {
        requireAnonymousRecipient(req);
        return { ...createLogin(req, unboundQr, body.name, undefined, undefined, binding), proofKey };
      });
    }
    const user = store.credentials(body.identifier);
    const row = user ? mapAccount(d.account(user.id)) : undefined;
    const pending =
      user && row && required(user.id)
        ? createLogin(req, 'qr', body.name, user.id, row.revision, binding)
        : createLogin(req, 'qr', body.name, undefined, undefined, binding);
    return { ...pending, proofKey };
  });

  app.post('/crypto/qr/redeem', { bodyLimit: 4096 }, (req, reply) => {
    const { origin } = originCheck(req);
    take(`trusted-qr-redeem:${req.clientAddress()}`, 120);
    const body = z.object({ id, claim: tokenValue, proof: tokenValue }).strict().parse(req.body);
    return store.transaction(() => {
      const row = activeLogin(body.id, origin);
      if (
        !row ||
        (row.kind !== 'qr' && row.kind !== unboundQr) ||
        !matchesHash(row.claim_hash, body.claim) ||
        !matchesHash(row.proof_hash, body.proof)
      )
        throw unavailable();
      const invite = inviteByLogin(body.id);
      if (row.kind === unboundQr || invite) requireAnonymousRecipient(req);
      if (!row.envelope) return { pending: true };
      const current = mapAccount(d.account(String(row.user_id)));
      if (!current || current.revision !== row.revision || !required(String(row.user_id)))
        throw unavailable();
      if (invite) {
        if (invite.state !== 'approved') throw unavailable();
        db.prepare("UPDATE im_trusted_qr_invites SET state='completed' WHERE id=?").run(invite.id);
      }
      db.prepare('DELETE FROM im_trusted_logins WHERE id=?').run(body.id);
      recordEvent(String(row.user_id), 'login', String(row.device_name));
      return {
        ...complete(req, reply, String(row.user_id), current),
        envelope: JSON.parse(String(row.envelope)) as z.infer<typeof envelope>,
      };
    });
  });

  app.post('/crypto/login/code', { bodyLimit: 4096 }, (req, reply) => {
    const { origin } = originCheck(req);
    take(`trusted-code:${req.clientAddress()}`, 20);
    const body = z
      .object({ id, claim: tokenValue, code: z.string().regex(/^\d{6}$/) })
      .strict()
      .parse(req.body);
    const result = store.transaction(() => {
      const row = activeLogin(body.id, origin);
      if (!row || row.kind !== 'code' || !matchesHash(row.claim_hash, body.claim)) throw unavailable();
      const userId = String(row.user_id);
      const current = mapAccount(d.account(userId));
      if (!current || current.revision !== row.revision || !required(userId)) throw unavailable();
      if (Number(row.attempts) >= MAX_CODE_ATTEMPTS) throw new ChatError(429, '尝试次数过多，请重新登录');
      requireTotpConfigured();
      if (!totp.verify(userId, body.code)) {
        db.prepare('UPDATE im_trusted_logins SET attempts=attempts+1 WHERE id=?').run(body.id);
        return undefined;
      }
      db.prepare('DELETE FROM im_trusted_logins WHERE id=?').run(body.id);
      recordEvent(userId, 'login', String(row.device_name));
      return complete(req, reply, userId, current);
    });
    if (!result) throw new ChatError(401, '动态码不正确');
    return result;
  });

  function clear(userId: string, recovery: boolean, deviceOnly = false) {
    db.prepare('DELETE FROM im_authenticator_setups WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM im_external_setup_grants WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM im_trusted_logins WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM im_trusted_qr_invites WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM im_trusted_ceremonies WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM im_trusted_enroll_grants WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM im_trusted_totp_grants WHERE user_id=?').run(userId);
    if (recovery) {
      if (!deviceOnly) requireTotpConfigured();
      db.prepare('DELETE FROM im_trusted_credentials WHERE user_id=?').run(userId);
      totp.clear(userId);
      if (!deviceOnly) totp.enable(userId);
      recordEvent(userId, 'recovered', '账号恢复');
    }
  }

  return {
    required,
    hasCredentials,
    passwordChallenge,
    clear,
    requireConfigured: requireTotpConfigured,
    beginAuthenticatorSetup,
    authorizeAuthenticatorSetup(req: MessagingRequest, grant: string) {
      setupGrant(actor(req), grant, false);
    },
  };
}
