import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { peerIdFromString } from '@libp2p/peer-id';
import { desktopAuthorizationSchema } from '../../shared/desktop-authorization.js';
import {
  keybookSyncChallengeSchema,
  keybookSyncLifetime,
  keybookSyncProof,
} from '../../shared/keybook-sync.js';
import { hostIdSchema } from '../../shared/relay-protocol.js';
import type { ChatUser } from '../../shared/messaging.js';
import type { DesktopAuthorizations } from '../desktop-authorization.js';
import type { MessagingHttp, MessagingRequest } from './http.js';
import { ChatError, digest, type MessagingStore } from './store-core.js';
import type { AccountTotp } from './totp.js';

const capability = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const payloadHash = z.string().regex(/^[a-f0-9]{64}$/);
const deviceId = z.string().uuid();
const lifetime = 120_000;
const unavailable = () => new ChatError(404, '备份授权不存在或已失效，请重新授权');
type Row = NonNullable<ReturnType<ReturnType<MessagingStore['db']['prepare']>['get']>>;

interface Dependencies {
  store: MessagingStore;
  desktops?: DesktopAuthorizations;
  totp: AccountTotp;
  origin: string;
  human: (req: MessagingRequest) => ChatUser;
  token: (req: MessagingRequest) => string;
  take: (key: string, max: number) => void;
  authorizeSetup: (req: MessagingRequest, grant: string) => void;
  verifyPassword: (proof: string, expected?: string) => Promise<boolean>;
}

/** Secret-free, one-use receipts bind a local backup to its actual account and receiving desktop. */
export function registerDesktopBackups(app: MessagingHttp, d: Dependencies) {
  const { db } = d.store;
  db.exec(`CREATE TABLE IF NOT EXISTS im_desktop_backup_grants (
    hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_hash TEXT NOT NULL,
    revision INTEGER NOT NULL, origin TEXT NOT NULL, host_id TEXT NOT NULL,
    device_id TEXT NOT NULL, stage TEXT NOT NULL, payload_hash TEXT, totp_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS im_desktop_backup_grants_expiry ON im_desktop_backup_grants(expires_at);`);
  db.exec(`CREATE TABLE IF NOT EXISTS im_desktop_backup_challenges (
    hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
  );`);
  const account = (id: string) =>
    db.prepare('SELECT revision,recovery_hash FROM im_account_crypto WHERE user_id=?').get(id);
  const origin = (req: MessagingRequest) => req.origin ?? d.origin;
  function checkOrigin(req: MessagingRequest, native = false) {
    const value = origin(req);
    const url = new URL(value);
    if (
      url.origin !== value ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      ) ||
      (req.headers.origin && req.headers.origin !== value) ||
      (!native && req.headers.origin !== value)
    )
      throw new ChatError(403, '请求来源不受信任');
    return value;
  }
  function actor(req: MessagingRequest) {
    checkOrigin(req);
    const user = d.human(req);
    const current = account(user.id);
    if (!user.encrypted || !current) throw new ChatError(403, '请先登录并解锁对应账号');
    return {
      user,
      revision: Number(current.revision),
      sessionHash: digest(d.token(req)),
      origin: origin(req),
    };
  }
  function live(row: Row) {
    return (
      Number(row.expires_at) > Date.now() &&
      account(String(row.user_id))?.revision === row.revision &&
      !!db
        .prepare('SELECT 1 FROM im_sessions WHERE hash=? AND user_id=? AND expires_at>?')
        .get(row.session_hash, row.user_id, Date.now())
    );
  }
  async function owns(userId: string, hostId: string) {
    return !!d.desktops && (await d.desktops.list(userId)).some((host) => host.hostId === hostId);
  }
  function sweep() {
    db.prepare('DELETE FROM im_desktop_backup_grants WHERE expires_at<=?').run(Date.now());
    db.prepare('DELETE FROM im_desktop_backup_challenges WHERE expires_at<=?').run(Date.now());
  }
  function owned(req: MessagingRequest, ticket: string, stage: string) {
    const current = actor(req);
    const row = db.prepare('SELECT * FROM im_desktop_backup_grants WHERE hash=?').get(digest(ticket));
    if (
      !row ||
      row.stage !== stage ||
      row.user_id !== current.user.id ||
      row.session_hash !== current.sessionHash ||
      row.revision !== current.revision ||
      row.origin !== current.origin ||
      !live(row)
    )
      throw unavailable();
    return { current, row };
  }

  app.post('/crypto/desktop-backup/prepare', { bodyLimit: 8192 }, async (req) => {
    const current = actor(req);
    d.take(`desktop-backup-prepare:${current.user.id}`, 12);
    const body = z
      .object({
        hostId: hostIdSchema,
        deviceId,
        authorization: desktopAuthorizationSchema.optional(),
        setupGrant: capability.optional(),
        challenge: keybookSyncChallengeSchema.optional(),
      })
      .strict()
      .refine(
        (value) => [value.authorization, value.setupGrant, value.challenge].filter(Boolean).length === 1,
      )
      .parse(req.body);
    if (!(await owns(current.user.id, body.hostId))) throw new ChatError(403, '这台电脑尚未由当前账号授权');
    if (body.authorization) {
      if (
        body.authorization.hostId !== body.hostId ||
        (await d.desktops!.approve(current.user.id, body.authorization, current.origin)) !== 'ok'
      )
        throw unavailable();
    } else if (body.challenge) {
      const challenge = body.challenge;
      if (
        challenge.hostId !== body.hostId ||
        challenge.deviceId !== body.deviceId ||
        challenge.accountId !== current.user.id ||
        challenge.revision !== current.revision ||
        challenge.issuedAt > Date.now() + 30_000 ||
        challenge.issuedAt + keybookSyncLifetime <= Date.now()
      )
        throw unavailable();
      try {
        const key = peerIdFromString(challenge.hostId).publicKey;
        if (
          !key ||
          !(await key.verify(
            keybookSyncProof(current.origin, challenge),
            Buffer.from(challenge.signature, 'base64'),
          ))
        )
          throw unavailable();
      } catch {
        throw unavailable();
      }
    } else d.authorizeSetup(req, body.setupGrant!);
    // Recheck after provider I/O: a concurrent sign-out, recovery or desktop revocation wins.
    const latest = actor(req);
    if (
      latest.user.id !== current.user.id ||
      latest.revision !== current.revision ||
      latest.sessionHash !== current.sessionHash ||
      !(await owns(current.user.id, body.hostId))
    )
      throw unavailable();
    return d.store.transaction(() => {
      if (
        !db
          .prepare('SELECT 1 FROM im_sessions WHERE hash=? AND user_id=? AND expires_at>?')
          .get(current.sessionHash, current.user.id, Date.now()) ||
        Number(account(current.user.id)?.revision) !== current.revision
      )
        throw unavailable();
      sweep();
      if (body.challenge) {
        const challenge = body.challenge;
        if (challenge.issuedAt + keybookSyncLifetime <= Date.now()) throw unavailable();
        const hash = digest(`${current.origin}\n${body.hostId}\n${body.deviceId}\n${challenge.nonce}`);
        if (db.prepare('SELECT 1 FROM im_desktop_backup_challenges WHERE hash=?').get(hash))
          throw unavailable();
        db.prepare('INSERT INTO im_desktop_backup_challenges VALUES (?,?)').run(
          hash,
          challenge.issuedAt + keybookSyncLifetime,
        );
      }
      const provisioning = d.totp.configured
        ? d.totp.provision(current.user.id, current.user.username)
        : undefined;
      const ticket = randomBytes(32).toString('base64url'),
        expiresAt = Date.now() + lifetime;
      db.prepare(`INSERT INTO im_desktop_backup_grants VALUES (?,?,?,?,?,?,?,'prepared',NULL,?,?)`).run(
        digest(ticket),
        current.user.id,
        current.sessionHash,
        current.revision,
        current.origin,
        body.hostId,
        body.deviceId,
        provisioning ? digest(provisioning.secret) : '',
        expiresAt,
      );
      return {
        ticket,
        expiresAt,
        document: {
          version: 1 as const,
          origin: current.origin,
          account: {
            id: current.user.id,
            username: current.user.username,
            displayName: current.user.displayName,
          },
          revision: current.revision,
          ...(provisioning ? { totpSecret: provisioning.secret } : {}),
        },
      };
    });
  });

  app.post('/crypto/desktop-backup/seal', { bodyLimit: 4096 }, async (req) => {
    const body = z.object({ ticket: capability, payloadHash }).strict().parse(req.body);
    const { current, row } = owned(req, body.ticket, 'prepared');
    d.take(`desktop-backup-seal:${current.user.id}`, 12);
    if (!(await owns(current.user.id, String(row.host_id)))) throw unavailable();
    return d.store.transaction(() => {
      owned(req, body.ticket, 'prepared');
      const proof = randomBytes(32).toString('base64url');
      db.prepare("UPDATE im_desktop_backup_grants SET hash=?,stage='sealed',payload_hash=? WHERE hash=?").run(
        digest(proof),
        body.payloadHash,
        digest(body.ticket),
      );
      return { proof, expiresAt: Number(row.expires_at) };
    });
  });

  app.post('/crypto/desktop-backup/redeem', { bodyLimit: 4096 }, async (req) => {
    checkOrigin(req, true);
    const body = z
      .object({
        proof: capability,
        hostId: hostIdSchema,
        deviceId,
        payloadHash,
        totpHash: z.union([payloadHash, z.literal('')]).optional().default(''),
        recoveryAuth: z
          .string()
          .regex(/^[A-Za-z0-9+/]{43}=$/)
          .optional(),
      })
      .strict()
      .parse(req.body);
    d.take(`desktop-backup-redeem:${body.hostId}`, 24);
    const row = db.prepare('SELECT * FROM im_desktop_backup_grants WHERE hash=?').get(digest(body.proof));
    if (
      !row ||
      row.stage !== 'sealed' ||
      row.host_id !== body.hostId ||
      row.device_id !== body.deviceId ||
      row.payload_hash !== body.payloadHash ||
      row.totp_hash !== body.totpHash ||
      row.origin !== origin(req) ||
      !live(row) ||
      !(await owns(String(row.user_id), body.hostId))
    )
      throw unavailable();
    if (
      body.recoveryAuth &&
      !(await d.verifyPassword(body.recoveryAuth, String(account(String(row.user_id))?.recovery_hash)))
    )
      throw unavailable();
    if (!(await owns(String(row.user_id), body.hostId))) throw unavailable();
    return d.store.transaction(() => {
      const latest = db
        .prepare('SELECT * FROM im_desktop_backup_grants WHERE hash=?')
        .get(digest(body.proof));
      if (!latest || latest.stage !== 'sealed' || !live(latest)) throw unavailable();
      db.prepare('DELETE FROM im_desktop_backup_grants WHERE hash=?').run(digest(body.proof));
      return {
        accountId: String(row.user_id),
        revision: Number(row.revision),
        origin: String(row.origin),
        hostId: body.hostId,
        deviceId: body.deviceId,
      };
    });
  });
}
