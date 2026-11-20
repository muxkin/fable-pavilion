import { Buffer } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  TOTP_CODE_PATTERN,
  TOTP_PERIOD_MS,
  totpBase32,
  totpCounter,
  totpCounterBytes,
  totpFromHmac,
  totpProvisioningUri,
} from '../../shared/totp.js';
import type { MessagingDatabase } from './database.js';
import { ChatError } from './store-core.js';

const SECRET_BYTES = 20;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_FAILURES = 5;
const FAILURE_WINDOW = 60_000;
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
const associated = (userId: string) => Buffer.from(`fable-pavilion:account-totp:v1:${userId}`);
const unavailable = () => new ChatError(503, '动态码暂不可用，请使用扫码登录或账号恢复');

export function totpCode(seed: Uint8Array, counter: number) {
  return totpFromHmac(createHmac('sha1', seed).update(totpCounterBytes(counter)).digest());
}

export class AccountTotp {
  private readonly key?: Buffer;
  constructor(
    private readonly db: MessagingDatabase,
    key?: string,
  ) {
    if (key !== undefined && key !== '') {
      if (!keyPattern.test(key)) throw Error('POCKET_IM_TOTP_KEY must be 32 base64url bytes without padding');
      const bytes = Buffer.from(key, 'base64url');
      if (bytes.length !== 32 || bytes.toString('base64url') !== key)
        throw Error('POCKET_IM_TOTP_KEY must be 32 base64url bytes without padding');
      this.key = bytes;
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS im_account_totp (
        user_id TEXT PRIMARY KEY NOT NULL REFERENCES im_users(id) ON DELETE CASCADE,
        sealed_seed TEXT NOT NULL,
        last_counter INTEGER NOT NULL DEFAULT -1,
        failures INTEGER NOT NULL DEFAULT 0,
        failures_expire INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS im_external_totp (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES im_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, sealed_seed TEXT NOT NULL, created_at INTEGER NOT NULL,
        last_counter INTEGER NOT NULL DEFAULT -1, setup_hash TEXT UNIQUE, expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS im_external_totp_user ON im_external_totp(user_id);
      CREATE INDEX IF NOT EXISTS im_external_totp_expiry ON im_external_totp(expires_at);
    `);
  }

  get configured() {
    return this.key !== undefined;
  }

  enabled(userId: string) {
    return !!this.db.prepare('SELECT 1 FROM im_account_totp WHERE user_id=?').get(userId);
  }

  enable(userId: string) {
    if (!this.key) throw unavailable();
    if (this.enabled(userId)) return;
    const seed = randomBytes(SECRET_BYTES);
    try {
      this.db
        .prepare('INSERT OR IGNORE INTO im_account_totp(user_id,sealed_seed) VALUES (?,?)')
        .run(userId, this.wrap(userId, seed));
    } finally {
      seed.fill(0);
    }
  }

  display(userId: string, now = Date.now()) {
    const seed = this.unwrap(userId, this.record(userId)?.sealed_seed);
    try {
      const counter = totpCounter(now);
      return { code: totpCode(seed, counter), expiresAt: (counter + 1) * TOTP_PERIOD_MS };
    } finally {
      seed.fill(0);
    }
  }

  /** Seed export requires fresh passkey verification or a scoped registration/recovery setup grant. */
  provision(userId: string, accountLabel: string) {
    const seed = this.unwrap(userId, this.record(userId)?.sealed_seed);
    try {
      const secret = totpBase32(seed);
      return { secret, uri: totpProvisioningUri(secret, accountLabel) };
    } finally {
      seed.fill(0);
    }
  }

  external(userId: string) {
    return this.db
      .prepare(
        'SELECT id,name,created_at AS createdAt FROM im_external_totp WHERE user_id=? AND setup_hash IS NULL ORDER BY created_at DESC',
      )
      .all(userId);
  }

  beginExternal(userId: string, label: string, name: string, setupHash: string, expiresAt: number) {
    this.db.prepare('DELETE FROM im_external_totp WHERE expires_at<=?').run(Date.now());
    const existing = this.pendingExternal(userId, setupHash);
    if (existing) {
      const seed = this.unwrap(`${userId}:${existing.id}`, existing.sealed_seed);
      try {
        const secret = totpBase32(seed);
        return { secret, uri: totpProvisioningUri(secret, `${label} (${existing.name})`) };
      } finally {
        seed.fill(0);
      }
    }
    if (this.external(userId).length >= 12) throw new ChatError(409, '请先移除一个已添加的验证器');
    const id = randomUUID();
    const seed = randomBytes(SECRET_BYTES);
    try {
      this.db
        .prepare(
          'INSERT INTO im_external_totp(id,user_id,name,sealed_seed,created_at,setup_hash,expires_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(id, userId, name, this.wrap(`${userId}:${id}`, seed), Date.now(), setupHash, expiresAt);
      const secret = totpBase32(seed);
      return { secret, uri: totpProvisioningUri(secret, `${label} (${name})`) };
    } finally {
      seed.fill(0);
    }
  }

  pendingExternal(userId: string, setupHash: string) {
    return this.db
      .prepare(
        'SELECT id,name,sealed_seed FROM im_external_totp WHERE user_id=? AND setup_hash=? AND expires_at>?',
      )
      .get(userId, setupHash, Date.now());
  }

  finishExternal(userId: string, setupHash: string, code: string) {
    const row = this.pendingExternal(userId, setupHash);
    if (!row) return false;
    const counter = this.match(`${userId}:${row.id}`, row.sealed_seed, Buffer.from(code), Date.now());
    if (counter < 0) return false;
    if (this.external(userId).length >= 12) throw new ChatError(409, '请先移除一个已添加的验证器');
    return (
      Number(
        this.db
          .prepare(
            'UPDATE im_external_totp SET setup_hash=NULL,expires_at=NULL,last_counter=? WHERE id=? AND setup_hash=?',
          )
          .run(counter, row.id, setupHash).changes,
      ) === 1
    );
  }

  removeExternal(userId: string, id: string) {
    return !!this.db
      .prepare('DELETE FROM im_external_totp WHERE user_id=? AND id=? AND setup_hash IS NULL')
      .run(userId, id).changes;
  }

  cancelExternal(userId: string, setupHash: string) {
    this.db.prepare('DELETE FROM im_external_totp WHERE user_id=? AND setup_hash=?').run(userId, setupHash);
  }

  /** A failed match returns false so the caller can commit the failure with its login transaction. */
  verify(userId: string, code: string, now = Date.now()) {
    if (typeof code !== 'string' || !TOTP_CODE_PATTERN.test(code)) return false;
    if (!this.db.isTransaction) return this.db.transaction((): boolean => this.verify(userId, code, now));
    const row = this.record(userId);
    if (!row) throw unavailable();
    const expires = Number(row.failures_expire);
    const failures = now < expires ? Number(row.failures) : 0;
    if (failures >= MAX_FAILURES) throw new ChatError(429, '动态码尝试次数过多，请稍后再试');

    const provided = Buffer.from(code);
    const base = this.match(userId, row.sealed_seed, provided, now);
    const matches = this.db
      .prepare(
        'SELECT id,sealed_seed,last_counter FROM im_external_totp WHERE user_id=? AND setup_hash IS NULL',
      )
      .all(userId)
      .map((item) => ({
        id: item.id,
        last: Number(item.last_counter),
        match: this.match(`${userId}:${item.id}`, item.sealed_seed, provided, now),
      }))
      .filter((item) => item.match >= 0);
    if (
      (base >= 0 || matches.length) &&
      (base < 0 || base > Number(row.last_counter)) &&
      matches.every((item) => item.match > item.last)
    ) {
      if (base >= 0)
        this.db.prepare('UPDATE im_account_totp SET last_counter=? WHERE user_id=?').run(base, userId);
      for (const item of matches)
        this.db.prepare('UPDATE im_external_totp SET last_counter=? WHERE id=?').run(item.match, item.id);
      return true;
    }
    this.db
      .prepare('UPDATE im_account_totp SET failures=?,failures_expire=? WHERE user_id=?')
      .run(failures + 1, now < expires ? expires : now + FAILURE_WINDOW, userId);
    return false;
  }

  clear(userId: string) {
    this.db.prepare('DELETE FROM im_external_totp WHERE user_id=?').run(userId);
    this.db.prepare('DELETE FROM im_account_totp WHERE user_id=?').run(userId);
  }

  private record(userId: string) {
    return this.db
      .prepare(
        'SELECT sealed_seed,last_counter,failures,failures_expire FROM im_account_totp WHERE user_id=?',
      )
      .get(userId);
  }

  private match(owner: string, sealed: unknown, provided: Buffer, now: number) {
    const seed = this.unwrap(owner, sealed);
    try {
      const current = totpCounter(now);
      let matched = -1;
      for (const counter of [current - 1, current, current + 1]) {
        if (counter >= 0 && timingSafeEqual(provided, Buffer.from(totpCode(seed, counter))))
          matched = counter;
      }
      return matched;
    } finally {
      seed.fill(0);
    }
  }

  private wrap(owner: string, seed: Buffer) {
    if (!this.key) throw unavailable();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(associated(owner));
    const encrypted = Buffer.concat([cipher.update(seed), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  private unwrap(userId: string, sealed: unknown) {
    if (!this.key || typeof sealed !== 'string') throw unavailable();
    let seed: Buffer | undefined;
    try {
      const bytes = Buffer.from(sealed, 'base64url');
      if (bytes.length !== IV_BYTES + TAG_BYTES + SECRET_BYTES) throw unavailable();
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, IV_BYTES));
      decipher.setAAD(associated(userId));
      decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      seed = decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES));
      decipher.final();
      return seed;
    } catch {
      seed?.fill(0);
      throw unavailable();
    }
  }
}
