import type { MessagingHttp, MessagingReply, MessagingRequest } from './http.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ChatError, digest, type MessagingStore } from './store-core.js';
import { USER_ID_PATTERN, USERNAME_PATTERN } from '../../shared/account-identity.js';
import { canonical, fingerprint, type AccountVault } from '../../shared/account-crypto.js';
import { hostIdSchema } from '../../shared/relay-protocol.js';
import type { DesktopAuthorizations } from '../desktop-authorization.js';
import type { ChatUser } from '../../shared/messaging.js';
import { registerTrustedDevices, trustedDeviceName } from './trusted-devices.js';
import { AccountTotp } from './totp.js';
import { registerDesktopBackups } from './desktop-backup.js';

const b64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const encryptedValue = z.object({ iv: b64.length(16), data: b64.min(24).max(1_500_000) }).strict();
const publicKey = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().length(43),
    y: z.string().length(43),
    ext: z.boolean().optional(),
    key_ops: z.array(z.string()).max(2).optional(),
  })
  .strict();
export const accountPublicKeys = z.object({ encryption: publicKey, signing: publicKey }).strict();
export const vaultSchema = z
  .object({
    version: z.literal(1),
    salt: b64.length(44),
    password: encryptedValue.optional(),
    recovery: encryptedValue,
    secrets: encryptedValue,
    publicKeys: accountPublicKeys,
  })
  .strict();
const credential = b64.length(44);
const actionGrant = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const usageResetScope = z.object({
  hostId: hostIdSchema,
  deviceId: z.string().uuid(),
  backendId: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),
  requestId: z.string().uuid(),
});
const protectSchema = z.object({ vault: vaultSchema, auth: credential, recoveryAuth: credential });
type Dependencies = {
  origin: string;
  store: MessagingStore;
  identity: (req: MessagingRequest) => ChatUser;
  human: (req: MessagingRequest) => ChatUser;
  token: (req: MessagingRequest) => string;
  cookieToken: (req: MessagingRequest) => string;
  session: (
    req: MessagingRequest,
    reply: MessagingReply,
    user: ChatUser,
    onIssued?: (sessionHash: string) => void,
    verified?: boolean,
  ) => { user: ChatUser };
  hash: (value: string, salt: string) => Promise<Buffer>;
  take: (key: string, max: number) => void;
  registrationEnabled?: boolean;
  registrationCode?: string;
  totpKey?: string;
  deviceLoginOnly?: boolean;
  desktops?: DesktopAuthorizations;
};
export async function registerAccounts(app: MessagingHttp, d: Dependencies) {
  const { store, identity, human, token, session, hash, take } = d;
  const account = (id: string) => store.db.prepare('SELECT * FROM im_account_crypto WHERE user_id=?').get(id);
  const hashed = async (value: string) => {
    const salt = randomBytes(16).toString('hex');
    return `${salt}:${(await hash(value, salt)).toString('hex')}`;
  };
  const verify = async (value: string, expected?: string) => {
    const [salt, digest] = (expected ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
    return timingSafeEqual(await hash(value, salt), Buffer.from(digest, 'hex')) && !!expected;
  };
  const totp = new AccountTotp(store.db, d.deviceLoginOnly ? undefined : d.totpKey);
  const trusted = registerTrustedDevices(app, { ...d, account, verifyPassword: verify, totp });
  registerDesktopBackups(app, {
    ...d,
    totp,
    authorizeSetup: trusted.authorizeAuthenticatorSetup,
    verifyPassword: verify,
  });
  if (d.deviceLoginOnly) {
    store.transaction(() => {
      const accounts = store.db
        .prepare(
          "SELECT u.id,c.vault,c.recovery_hash FROM im_users u LEFT JOIN im_account_crypto c ON c.user_id=u.id WHERE u.kind='human'",
        )
        .all();
      const pending = accounts.map((row) => {
        if (
          typeof row.vault !== 'string' ||
          typeof row.recovery_hash !== 'string' ||
          !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(row.recovery_hash)
        )
          throw Error('Device login migration requires a recovery key for every existing human account');
        return { id: String(row.id), vault: vaultSchema.parse(JSON.parse(row.vault)) };
      });
      const update = store.db.prepare('UPDATE im_account_crypto SET vault=? WHERE user_id=?');
      for (const { id, vault } of pending) {
        if (vault.password) {
          delete vault.password;
          update.run(JSON.stringify(vault), id);
          trusted.clear(id, false);
        }
        totp.clear(id);
      }
    });
  }
  // Existing complete sessions remain valid. Their devices can read the new account code immediately.
  // A missing server key must never turn a password check into a complete login.
  if (totp.configured) {
    store.transaction(() => {
      for (const user of store.db
        .prepare(
          "SELECT u.id,c.vault FROM im_users u JOIN im_account_crypto c ON c.user_id=u.id WHERE u.kind='human'",
        )
        .all())
        if (JSON.parse(String(user.vault)).password) totp.enable(String(user.id));
    });
  }
  const insert = (id: string, vault: AccountVault, recoveryHash: string) =>
    store.db
      .prepare('INSERT INTO im_account_crypto(user_id,vault,recovery_hash,revision) VALUES (?,?,?,1)')
      .run(id, JSON.stringify(vault), recoveryHash);
  app.post('/crypto/parameters', { bodyLimit: 4096 }, async (req) => {
    const { identifier } = z.object({ identifier: z.string().trim().min(1).max(1024) }).parse(req.body);
    const user = store.credentials(identifier),
      row = user && account(user.id);
    return { salt: row ? JSON.parse(String(row.vault)).salt : randomBytes(32).toString('base64') };
  });
  app.post('/crypto/register', { bodyLimit: 32 * 1024 }, async (req, reply) => {
    if (d.registrationEnabled === false) throw new ChatError(403, '本站已关闭注册');
    if (!d.deviceLoginOnly) trusted.requireConfigured();
    const body = protectSchema
      .extend({
        username: z.string().toLowerCase().regex(USERNAME_PATTERN),
        displayName: z.string().trim().min(1).max(60),
        registrationCode: z.string().max(256).optional(),
      })
      .parse(req.body);
    if (d.deviceLoginOnly === true ? body.vault.password : !body.vault.password)
      throw new ChatError(409, '登录策略已变化，请更新应用后重试');
    if (d.registrationCode && body.registrationCode !== d.registrationCode)
      throw new ChatError(403, '注册码不正确');
    const passwordHash = await hashed(body.auth),
      recoveryHash = await hashed(body.recoveryAuth);
    const result = store.transaction(() => {
      const user = store.createUser('human', body.username, body.displayName, passwordHash);
      insert(user.id, body.vault, recoveryHash);
      if (!d.deviceLoginOnly) totp.enable(user.id);
      let authenticatorSetup: ReturnType<typeof trusted.beginAuthenticatorSetup> | undefined;
      const signedIn = session(req, reply, store.user(user.id), (sessionHash) => {
        if (!d.deviceLoginOnly)
          authenticatorSetup = trusted.beginAuthenticatorSetup(req, user.id, 1, sessionHash);
      });
      return { ...signedIn, vault: body.vault, authenticatorSetup };
    });
    reply.code(201);
    return result;
  });
  app.post('/crypto/login', { bodyLimit: 4096 }, async (req, reply) => {
    const body = z
      .object({
        identifier: z.string().trim().min(1).max(1024),
        auth: credential,
        recovery: z.boolean().optional(),
        trusted: z.boolean().optional(),
        deviceName: trustedDeviceName.optional(),
      })
      .parse(req.body);
    if (!body.recovery && d.deviceLoginOnly)
      throw new ChatError(403, '请使用已授权设备扫码登录，或使用恢复码恢复账号');
    if (!body.recovery) trusted.requireConfigured();
    const user = store.credentials(body.identifier),
      row = user && account(user.id);
    take(`login:${user?.id ?? body.identifier}`, 15);
    if (
      !(await verify(
        body.auth,
        row ? (body.recovery ? String(row.recovery_hash) : user!.passwordHash) : undefined,
      ))
    )
      throw new ChatError(401, '用户名、密码或恢复码不正确');
    const current = account(user!.id);
    if (
      !current ||
      current.revision !== row!.revision ||
      store.credentials(user!.id)?.passwordHash !== user!.passwordHash
    )
      throw new ChatError(409, '账号状态已变化，请重新登录');
    if (!body.recovery) {
      if (!(JSON.parse(String(row!.vault)) as AccountVault).password)
        throw new ChatError(403, '此账号需要已授权设备扫码登录或使用恢复码');
      return {
        trustedLogin: trusted.passwordChallenge(
          req,
          user!.id,
          Number(row!.revision),
          body.deviceName ?? '新设备',
        ),
      };
    }
    return {
      ...session(req, reply, store.user(user!.id), undefined, false),
      vault: JSON.parse(String(row!.vault)),
      revision: Number(row!.revision),
    };
  });
  app.get('/crypto/account', async (req) => {
    const row = account(identity(req).id);
    return row
      ? {
          vault: JSON.parse(String(row.vault)),
          revision: Number(row.revision),
          ...(d.deviceLoginOnly && { deviceLoginOnly: true }),
        }
      : { vault: null, revision: 0 };
  });
  app.post('/crypto/password', { bodyLimit: 32 * 1024 }, async (req) => {
    const user = human(req),
      previous = account(user.id),
      existing = store.credentials(user.username)!;
    take(`password:${user.id}`, 5);
    const body = protectSchema
      .extend({
        currentAuth: credential,
        recovery: z.boolean().optional(),
        revision: z.number().int().positive(),
      })
      .parse(req.body);
    if (
      !previous ||
      !(await verify(
        body.currentAuth,
        body.recovery ? String(previous.recovery_hash) : existing.passwordHash,
      ))
    )
      throw new ChatError(403, '当前密码或恢复码不正确');
    const previousVault: AccountVault = JSON.parse(String(previous.vault));
    const deviceOnly = d.deviceLoginOnly === true || !previousVault.password;
    if (deviceOnly ? body.vault.password : !body.vault.password)
      throw new ChatError(409, '登录策略已变化，请更新应用后重试');
    if (canonical(previousVault.publicKeys) !== canonical(body.vault.publicKeys))
      throw new ChatError(400, '修改密码不能替换账号身份');
    const passwordHash = await hashed(body.auth),
      recoveryHash = await hashed(body.recoveryAuth);
    const authenticatorSetup = store.transaction(() => {
      if (
        Number(account(user.id)?.revision) !== body.revision ||
        store.credentials(user.username)?.passwordHash !== existing.passwordHash
      )
        throw new ChatError(409, '密码已变化，请重新登录');
      store.db
        .prepare('UPDATE im_account_crypto SET vault=?,recovery_hash=?,revision=revision+1 WHERE user_id=?')
        .run(JSON.stringify(body.vault), recoveryHash, user.id);
      store.changePassword(user.id, passwordHash, token(req));
      trusted.clear(user.id, body.recovery === true, deviceOnly);
      if (deviceOnly) {
        totp.clear(user.id);
        return undefined;
      }
      return trusted.beginAuthenticatorSetup(req, user.id, body.revision + 1, digest(token(req)));
    });
    return { ok: true, revision: body.revision + 1, authenticatorSetup };
  });
  app.post('/crypto/recovery/rotate', { bodyLimit: 4096 }, async (req) => {
    const user = human(req);
    take(`recovery-rotate:${user.id}`, 5);
    const previous = account(user.id);
    const passwordHash = store.credentials(user.id)?.passwordHash;
    const body = z
      .object({
        revision: z.number().int().positive(),
        auth: credential.optional(),
        approval: actionGrant.optional(),
        sessionConfirm: z.literal(true).optional(),
        recoveryAuth: credential,
        recovery: encryptedValue,
      })
      .strict()
      .parse(req.body);
    if (!previous) throw new ChatError(403, '请登录并解锁子虚亭账号');
    const previousVault = JSON.parse(String(previous.vault)) as AccountVault;
    const isDeviceOnly = d.deviceLoginOnly === true || !previousVault.password;
    const sessionHash = digest(token(req));
    if (body.approval) {
      trusted.consumeActionGrant(
        req,
        user.id,
        Number(previous.revision),
        sessionHash,
        'recovery-rotate',
        body.approval,
      );
    } else if (body.auth) {
      if (!(await verify(body.auth, passwordHash))) throw new ChatError(403, '当前密码不正确');
    } else if (body.sessionConfirm) {
      if (!isDeviceOnly) throw new ChatError(403, '请输入当前密码');
      if (trusted.hasOriginPasskey(req, user.id))
        throw new ChatError(403, '请使用本设备的通行密钥确认更换恢复码');
    } else {
      throw new ChatError(403, '请先完成身份确认');
    }
    const recoveryHash = await hashed(body.recoveryAuth);
    return store.transaction(() => {
      if (
        human(req).id !== user.id ||
        Number(previous.revision) !== body.revision ||
        Number(account(user.id)?.revision) !== body.revision ||
        store.credentials(user.id)?.passwordHash !== passwordHash
      )
        throw new ChatError(409, '账号设置已变化，请重试');
      const vault = JSON.parse(String(previous.vault)) as AccountVault;
      const deviceOnly = d.deviceLoginOnly === true || !vault.password;
      if (deviceOnly) {
        delete vault.password;
        totp.clear(user.id);
      }
      store.db
        .prepare('UPDATE im_account_crypto SET vault=?,recovery_hash=?,revision=revision+1 WHERE user_id=?')
        .run(JSON.stringify({ ...vault, recovery: body.recovery }), recoveryHash, user.id);
      trusted.clear(user.id, false, deviceOnly);
      return { revision: body.revision + 1, ...(deviceOnly && { deviceOnly: true }) };
    });
  });
  if (d.desktops) {
    const desktops = d.desktops;
    const ownsDesktop = async (accountId: string, hostId: string) =>
      (await desktops.list(accountId)).some((desktop) => desktop.hostId === hostId);
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS im_usage_reset_proofs (
        proof TEXT PRIMARY KEY, account_id TEXT NOT NULL, session_hash TEXT NOT NULL,
        revision INTEGER NOT NULL, host_id TEXT NOT NULL, device_id TEXT NOT NULL,
        backend_id TEXT NOT NULL, request_id TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS im_usage_reset_proofs_expiry ON im_usage_reset_proofs(expires_at);
    `);
    app.post('/crypto/usage-reset/confirm', { bodyLimit: 1024 }, async (req) => {
      const user = human(req);
      const { accountId, auth, approval, sessionConfirm, hostId, deviceId, backendId, requestId } =
        usageResetScope
          .extend({
            accountId: z.string().regex(USER_ID_PATTERN),
            auth: credential.optional(),
            approval: actionGrant.optional(),
            sessionConfirm: z.literal(true).optional(),
          })
          .strict()
          .parse(req.body);
      if (user.id !== accountId || !user.encrypted) throw new ChatError(403, '请登录对应的子虚亭账号');
      take(`usage-reset-account:${accountId}`, 5);
      take(`usage-reset-ip:${req.clientAddress()}`, 15);
      const current = account(accountId);
      const passwordHash = store.credentials(user.username)?.passwordHash;
      if (!current) throw new ChatError(403, '请登录对应的子虚亭账号');
      const currentVault = JSON.parse(String(current.vault)) as AccountVault;
      const isDeviceOnly = d.deviceLoginOnly === true || !currentVault.password;
      const sessionHash = digest(token(req));
      if (approval) {
        trusted.consumeActionGrant(
          req,
          accountId,
          Number(current.revision),
          sessionHash,
          'usage-reset',
          approval,
        );
      } else if (auth) {
        if (!(await verify(auth, passwordHash))) throw new ChatError(403, '子虚亭密码不正确');
      } else if (sessionConfirm) {
        if (!isDeviceOnly) throw new ChatError(403, '请先完成身份确认');
        if (trusted.hasOriginPasskey(req, accountId))
          throw new ChatError(403, '请使用本设备的通行密钥确认重置');
      } else {
        throw new ChatError(403, '请先完成身份确认');
      }
      if (!(await ownsDesktop(accountId, hostId)))
        throw new ChatError(
          403,
          '这台电脑尚未关联当前子虚亭账号，请刷新页面后重试或在子虚亭适配器中重新授权。',
        );
      if (
        human(req).id !== accountId ||
        Number(account(accountId)?.revision) !== Number(current.revision) ||
        store.credentials(user.username)?.passwordHash !== passwordHash
      )
        throw new ChatError(409, '账号状态已变化，请重新确认');
      const proof = randomBytes(32).toString('base64url');
      const now = Date.now();
      store.transaction(() => {
        store.db.prepare('DELETE FROM im_usage_reset_proofs WHERE expires_at<=?').run(now);
        store.db
          .prepare(
            `INSERT INTO im_usage_reset_proofs
            (proof,account_id,session_hash,revision,host_id,device_id,backend_id,request_id,expires_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            digest(proof),
            accountId,
            sessionHash,
            Number(current.revision),
            hostId,
            deviceId,
            backendId,
            requestId,
            now + 90_000,
          );
      });
      return { proof };
    });
    app.post('/crypto/usage-reset/redeem', { bodyLimit: 1024 }, async (req, reply) => {
      const { proof, hostId, deviceId, backendId, requestId } = usageResetScope
        .extend({ proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
        .strict()
        .parse(req.body);
      take(`usage-reset-redeem:${req.clientAddress()}`, 60);
      const scope = [digest(proof), hostId, deviceId, backendId, requestId] as const;
      const scoped =
        'proof=? AND host_id=? AND device_id=? AND backend_id=? AND request_id=? AND expires_at>?';
      const row = store.db
        .prepare(`SELECT account_id FROM im_usage_reset_proofs WHERE ${scoped}`)
        .get(...scope, Date.now());
      if (!row || !(await ownsDesktop(String(row.account_id), hostId)))
        throw new ChatError(403, '重置确认已失效，请重新确认');
      const now = Date.now();
      const deleted = store.db
        .prepare(
          `DELETE FROM im_usage_reset_proofs WHERE ${scoped}
          AND EXISTS (SELECT 1 FROM im_sessions s
            WHERE s.hash=session_hash AND s.user_id=account_id AND s.expires_at>?)
          AND EXISTS (SELECT 1 FROM im_account_crypto a
            WHERE a.user_id=account_id AND a.revision=im_usage_reset_proofs.revision)`,
        )
        .run(...scope, now, now);
      if (!deleted.changes) throw new ChatError(403, '重置确认已失效，请重新确认');
      reply.code(204).send();
    });
  }
  app.get('/crypto/keys/:id', async (req) => {
    identity(req);
    const { id } = z.object({ id: z.string().regex(USER_ID_PATTERN) }).parse(req.params);
    const row = account(id);
    if (!row) throw new ChatError(409, '对方的加密身份不存在');
    const publicKeys = JSON.parse(String(row.vault)).publicKeys;
    return { publicKeys, fingerprint: await fingerprint(publicKeys) };
  });
  app.get('/crypto/items', async (req) => {
    const user = identity(req);
    const { accountId } = z.object({ accountId: z.string().regex(USER_ID_PATTERN) }).parse(req.query);
    if (accountId !== user.id) throw new ChatError(409, '账号已切换，请重新登录');
    const legacyUserIds: string[] = [];
    try {
      const seen = new Set<string>([user.id]);
      const queue = [user.id];
      while (queue.length) {
        const current = queue.shift()!;
        const rows = store.db
          .prepare("SELECT detail FROM im_admin_audit WHERE action='migrate_uid' AND target=?")
          .all(current);
        for (const row of rows) {
          const detail = String(row.detail ?? '');
          let fromId: string | undefined;
          const match = detail.match(/\b(\d{4,20})\s*->\s*(\d{4,20})\b/);
          if (match && match[2] === current) fromId = match[1];
          else {
            try {
              const parsed = JSON.parse(detail) as { fromId?: unknown };
              if (typeof parsed.fromId === 'string') fromId = parsed.fromId;
            } catch {}
          }
          if (fromId && USER_ID_PATTERN.test(fromId) && !seen.has(fromId)) {
            seen.add(fromId);
            legacyUserIds.push(fromId);
            queue.push(fromId);
          }
        }
      }
    } catch {}
    return {
      items: store.db
        .prepare('SELECT id,revision,ciphertext FROM im_vault_items WHERE user_id=?')
        .all(user.id)
        .map((r) => ({
          id: r.id,
          revision: r.revision,
          ciphertext: r.ciphertext ? JSON.parse(String(r.ciphertext)) : null,
        })),
      ...(legacyUserIds.length ? { legacyUserIds } : {}),
    };
  });
  app.put('/crypto/items/:id', { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const user = identity(req);
    if (!account(user.id)) throw new ChatError(409, '请先启用账号加密');
    const { id } = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).parse(req.params);
    const { accountId, revision, ciphertext } = z
      .object({
        accountId: z.string().regex(USER_ID_PATTERN),
        revision: z.number().int().nonnegative(),
        ciphertext: encryptedValue.nullable(),
      })
      .parse(req.body);
    if (accountId !== user.id) throw new ChatError(409, '账号已切换，请重新登录');
    take(`vault:${user.id}`, 120);
    return store.transaction(() => {
      const old = store.db
        .prepare('SELECT revision FROM im_vault_items WHERE user_id=? AND id=?')
        .get(user.id, id);
      if (Number(old?.revision ?? 0) !== revision)
        throw new ChatError(409, '账号数据已在其他设备更新，请重试');
      const count = Number(
        store.db.prepare('SELECT count(*) AS n FROM im_vault_items WHERE user_id=?').get(user.id)!.n,
      );
      if (!old && count >= 1000) throw new ChatError(413, '账号配置条目过多');
      store.db
        .prepare(
          'INSERT INTO im_vault_items VALUES (?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET revision=excluded.revision,ciphertext=excluded.ciphertext',
        )
        .run(user.id, id, revision + 1, ciphertext ? JSON.stringify(ciphertext) : null);
      return { revision: revision + 1 };
    });
  });
}
