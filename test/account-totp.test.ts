import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { AccountTotp, totpCode } from '../src/server/messaging/totp.js';
import { MessagingStore } from '../src/server/messaging/store.js';
import { TOTP_PERIOD_MS, totpCounter } from '../src/shared/totp.js';

const stores: MessagingStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = new MessagingStore(':memory:');
  stores.push(store);
  const alice = store.createUser('human', 'totp-alice', 'Alice', '').id;
  const bob = store.createUser('human', 'totp-bob', 'Bob', '').id;
  const key = randomBytes(32).toString('base64url');
  return { store, totp: new AccountTotp(store.db, key), key, alice, bob };
}

it('matches the 6-digit SHA-1 subset of RFC 6238 Appendix B', () => {
  const seed = Buffer.from('12345678901234567890');
  for (const [seconds, expected] of [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ] as const) {
    expect(totpCode(seed, totpCounter(seconds * 1000))).toBe(expected);
  }
});

it('protects the provisioning secret in the database and emits a standard otpauth URI', () => {
  const { store, totp, key, alice, bob } = fixture();
  expect(totp.enabled(alice)).toBe(false);
  totp.enable(alice);
  totp.enable(bob);
  const provisioning = totp.provision(alice, 'Alice@pavilion.example');
  expect(provisioning.secret).toMatch(/^[A-Z2-7]{32}$/);
  const parsed = new URL(provisioning.uri);
  expect(parsed.protocol).toBe('otpauth:');
  expect(parsed.hostname).toBe('totp');
  expect(decodeURIComponent(parsed.pathname)).toBe('/Fable Pavilion:Alice@pavilion.example');
  expect(parsed.searchParams.get('secret')).toBe(provisioning.secret);
  expect(parsed.searchParams.get('issuer')).toBe('Fable Pavilion');
  expect(parsed.searchParams.get('digits')).toBe('6');
  expect(parsed.searchParams.get('period')).toBe('30');
  expect(parsed.searchParams.get('algorithm')).toBe('SHA1');

  const sealed = store.db.prepare('SELECT sealed_seed FROM im_account_totp WHERE user_id=?').get(alice)!
    .sealed_seed as string;
  expect(Buffer.from(sealed, 'base64url')).toHaveLength(48);
  expect(sealed).not.toContain(provisioning.secret);
  totp.enable(alice);
  expect(new AccountTotp(store.db, key).provision(alice, 'Alice@pavilion.example')).toEqual(provisioning);
  expect(new AccountTotp(store.db).enabled(alice)).toBe(true);
  expect(() => new AccountTotp(store.db).display(alice)).toThrow();
  expect(() => new AccountTotp(store.db, randomBytes(32).toString('base64url')).display(alice)).toThrow();
  store.db.prepare('UPDATE im_account_totp SET sealed_seed=? WHERE user_id=?').run(sealed, bob);
  expect(() => totp.display(bob)).toThrow();
});

it('accepts one skew window, rejects replay across requests and persists a per-account rate limit', () => {
  const { store, totp, key, alice, bob } = fixture();
  totp.enable(alice);
  totp.enable(bob);
  const now = 1_200_000;
  const prior = totp.display(alice, now - TOTP_PERIOD_MS);
  expect(prior.expiresAt).toBe(now);
  expect(store.transaction(() => totp.verify(alice, prior.code, now))).toBe(true);
  const restarted = new AccountTotp(store.db, key);
  expect(store.transaction(() => restarted.verify(alice, prior.code, now))).toBe(false);

  const possibilities = new Set(
    [-1, 0, 1].map((step) => totp.display(alice, now + step * TOTP_PERIOD_MS).code),
  );
  const invalid = Array.from({ length: 4 }, (_, i) => String(i).padStart(6, '0')).find(
    (code) => !possibilities.has(code),
  )!;
  for (let i = 0; i < 4; i++) {
    expect(store.transaction(() => restarted.verify(alice, invalid, now))).toBe(false);
  }
  expect(() => store.transaction(() => restarted.verify(alice, invalid, now))).toThrow('动态码尝试次数过多');
  expect(store.transaction(() => restarted.verify(bob, totp.display(bob, now).code, now))).toBe(true);
  const later = now + 60_001;
  expect(store.transaction(() => restarted.verify(alice, totp.display(alice, later).code, later))).toBe(true);
});

it('clears the stored secret on recovery and only creates a fresh secret when enabled again', () => {
  const { totp, alice } = fixture();
  totp.enable(alice);
  const old = totp.provision(alice, 'Alice').secret;
  totp.clear(alice);
  expect(totp.enabled(alice)).toBe(false);
  expect(() => totp.provision(alice, 'Alice')).toThrow();
  totp.enable(alice);
  expect(totp.provision(alice, 'Alice').secret).not.toBe(old);
});
