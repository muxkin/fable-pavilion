import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { TrustedLoginRequired, type AccountClient } from '../../src/client/account.js';
import {
  desktopAuthorizationProof,
  type DesktopAuthorization,
} from '../../src/shared/desktop-authorization.js';
import { base64, createIdentity, identityKey } from '../../src/shared/secure-channel.js';
import { recoveryKeys } from '../../src/shared/account-crypto.js';
import { keybookSyncProof, type KeybookSyncChallenge } from '../../src/shared/keybook-sync.js';

interface RawReply {
  status: number;
  body: any;
}
interface BackupSession {
  account: AccountClient;
  request: AccountClient['request'];
  raw(
    path: string,
    method: string,
    body: unknown,
    options?: { origin?: string | null; site?: string },
  ): Promise<RawReply>;
  cookie(): string;
}
export interface DesktopBackupRuntime {
  origin: string;
  alias?: string;
  session(): BackupSession;
  expire(capability: string): Promise<void>;
  rows(): Promise<Record<string, unknown>[]>;
}
interface Prepared {
  ticket: string;
  expiresAt: number;
  document: {
    version: number;
    origin: string;
    account: { id: string; username: string; displayName: string };
    revision: number;
    totpSecret: string;
  };
}

const prefix = '/crypto/desktop-backup';
const password = 'synthetic-desktop-backup-password';
const nextPassword = 'synthetic-desktop-backup-new-password';
const payloadHash = createHash('sha256').update('synthetic-encrypted-backup-document').digest('hex');
const totpHash = (prepared: Prepared) =>
  createHash('sha256').update(prepared.document.totpSecret).digest('hex');
let fixtureNumber = 0;

async function fixture(runtime: DesktopBackupRuntime) {
  const owner = runtime.session();
  const registration = await owner.account.register(`backup_${++fixtureNumber}`, 'Backup fixture', password);
  const identity = await createIdentity();
  const intent = {
    hostId: identity.peerId,
    name: 'Disposable backup computer',
    ticket: createHash('sha256').update(randomUUID()).digest('hex'),
    issuedAt: Date.now(),
  };
  async function signed(changes: Partial<typeof intent> = {}, origin = runtime.origin) {
    const value = { ...intent, ...changes };
    return {
      ...value,
      signature: base64(await identityKey(identity).sign(desktopAuthorizationProof(origin, value))),
    };
  }
  const authorization = await signed();
  await owner.request('/desktop-devices/approve', 'POST', { accountId: registration.user.id, authorization });
  const scope = { hostId: identity.peerId, deviceId: randomUUID() };
  async function syncChallenge(
    changes: Partial<Omit<KeybookSyncChallenge, 'signature'>> = {},
    origin = runtime.origin,
  ) {
    const value = {
      ...scope,
      accountId: registration.user.id,
      revision: owner.account.revision,
      nonce: randomBytes(32).toString('base64url'),
      issuedAt: Date.now(),
      ...changes,
    };
    return { ...value, signature: base64(await identityKey(identity).sign(keybookSyncProof(origin, value))) };
  }
  const body = { ...scope, authorization };
  const prepare = () => owner.request<Prepared>(`${prefix}/prepare`, 'POST', body);
  const seal = (ticket: string, hash = payloadHash) =>
    owner.request<{ proof: string; expiresAt: number }>(`${prefix}/seal`, 'POST', {
      ticket,
      payloadHash: hash,
    });
  return { owner, registration, signed, authorization, scope, body, prepare, seal, syncChallenge };
}

function independentTotp(secret: string, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret].map((value) => alphabet.indexOf(value).toString(2).padStart(5, '0')).join('');
  const seed = Buffer.from(bits.match(/.{8}/g)!.map((value) => Number.parseInt(value, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const mac = createHmac('sha1', seed).update(counter).digest();
  return String((mac.readUInt32BE(mac.at(-1)! & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** The same security assertions exercise Node SQLite and the actual workerd/DO bindings. */
export function desktopBackupContract(setup: () => Promise<DesktopBackupRuntime>) {
  it('syncs an existing complete session using a one-use native signature without replacing desktop enrollment', async () => {
    const runtime = await setup();
    const f = await fixture(runtime);
    await f.owner.request('/crypto/authenticator/cancel', 'POST', {
      grant: f.registration.authenticatorSetup!.grant,
    });
    const challenge = await f.syncChallenge();
    const body = { ...f.scope, challenge };
    const attempts = await Promise.allSettled([
      f.owner.request<Prepared>(`${prefix}/prepare`, 'POST', body),
      f.owner.request<Prepared>(`${prefix}/prepare`, 'POST', body),
    ]);
    expect(attempts.map((value) => value.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(attempts.find((value) => value.status === 'rejected')).toMatchObject({ reason: { status: 404 } });
    const prepared = (
      attempts.find((value) => value.status === 'fulfilled') as PromiseFulfilledResult<Prepared>
    ).value;
    expect(prepared.document.account.id).toBe(f.registration.user.id);
    await expect(f.owner.request(`${prefix}/prepare`, 'POST', body)).rejects.toMatchObject({ status: 404 });
    // A native sync proof does not revoke or replace the existing signed desktop ticket.
    const ready = await f.owner.request<{ ready: boolean }>('/desktop-devices/ready', 'POST', {
      accountId: f.registration.user.id,
      hostId: f.scope.hostId,
      ticket: f.authorization.ticket,
    });
    expect(typeof ready.ready).toBe('boolean');
    await expect(f.prepare()).resolves.toHaveProperty('ticket');
  });

  it('rejects wrong origin, account, revision, device, host, expired and forged native challenges', async () => {
    const runtime = await setup();
    const f = await fixture(runtime);
    const otherIdentity = await createIdentity();
    for (const changes of [
      { accountId: 'other-account' },
      { revision: f.owner.account.revision + 1 },
      { deviceId: randomUUID() },
      { hostId: otherIdentity.peerId },
      { issuedAt: Date.now() - 120001 },
      { issuedAt: Date.now() + 60000 },
    ]) {
      await expect(
        f.owner.request(`${prefix}/prepare`, 'POST', {
          ...f.scope,
          challenge: await f.syncChallenge(changes),
        }),
      ).rejects.toMatchObject({ status: 404 });
    }
    await expect(
      f.owner.request(`${prefix}/prepare`, 'POST', {
        ...f.scope,
        challenge: await f.syncChallenge({}, 'https://foreign.invalid'),
      }),
    ).rejects.toMatchObject({ status: 404 });
    const valid = await f.syncChallenge();
    await expect(
      f.owner.request(`${prefix}/prepare`, 'POST', {
        ...f.scope,
        challenge: { ...valid, signature: Buffer.alloc(64, 1).toString('base64') },
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.owner.request(`${prefix}/prepare`, 'POST', {
        ...f.body,
        challenge: valid,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const anonymous = runtime.session();
    await expect(
      anonymous.request(`${prefix}/prepare`, 'POST', { ...f.scope, challenge: valid }),
    ).rejects.toMatchObject({ status: 401 });
    await f.owner.request(`/desktop-devices/${f.scope.hostId}`, 'DELETE', {
      accountId: f.registration.user.id,
    });
    await expect(
      f.owner.request(`${prefix}/prepare`, 'POST', { ...f.scope, challenge: await f.syncChallenge() }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('requires a complete owner session, an owned host and a fresh signed or setup authorization', async () => {
    const runtime = await setup();
    const f = await fixture(runtime);
    const anonymous = runtime.session(),
      pending = runtime.session(),
      other = runtime.session();
    await other.account.register(`backup_other_${++fixtureNumber}`, 'Other fixture', password);
    await expect(pending.account.login(f.registration.user.id, password)).rejects.toBeInstanceOf(
      TrustedLoginRequired,
    );
    expect(pending.cookie()).toBe('');
    for (const caller of [anonymous, pending]) {
      await expect(caller.request(`${prefix}/prepare`, 'POST', f.body)).rejects.toMatchObject({
        status: 401,
      });
      await expect(
        caller.request(`${prefix}/seal`, 'POST', { ticket: 'a'.repeat(43), payloadHash }),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(other.request(`${prefix}/prepare`, 'POST', f.body)).rejects.toMatchObject({ status: 403 });
    await expect(f.owner.request(`${prefix}/prepare`, 'POST', f.scope)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      f.owner.request(`${prefix}/prepare`, 'POST', {
        ...f.body,
        setupGrant: f.registration.authenticatorSetup!.grant,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.owner.request(`${prefix}/prepare`, 'POST', { ...f.scope, setupGrant: 'a'.repeat(43) }),
    ).rejects.toMatchObject({ status: 404 });
    const unowned = await createIdentity();
    await expect(
      f.owner.request(`${prefix}/prepare`, 'POST', { ...f.body, hostId: unowned.peerId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      f.owner.request(`${prefix}/prepare`, 'POST', {
        ...f.body,
        authorization: await f.signed({ issuedAt: Date.now() - 6 * 60_000 }),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.owner.request(`${prefix}/prepare`, 'POST', {
        ...f.body,
        authorization: await f.signed({}, 'https://foreign.invalid'),
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await f.owner.raw(`${prefix}/prepare`, 'POST', f.body, { origin: 'https://foreign.invalid' })).status,
    ).toBe(403);
    await expect(
      f.owner.request(`${prefix}/prepare`, 'POST', { ...f.body, unexpected: true }),
    ).rejects.toMatchObject({ status: 400 });
    const valid = await f.prepare();
    expect(valid.document.account.id).toBe(f.registration.user.id);
  });

  it('exports the actual account code only through the scoped first-session setup grant and seals to that session', async () => {
    const runtime = await setup();
    const f = await fixture(runtime);
    const grant = f.registration.authenticatorSetup!.grant;
    const prepared = await f.owner.request<Prepared>(`${prefix}/prepare`, 'POST', {
      ...f.scope,
      setupGrant: grant,
    });
    expect(prepared.document).toMatchObject({
      version: 1,
      origin: runtime.origin,
      account: { id: f.registration.user.id },
      revision: f.owner.account.revision,
    });
    expect(prepared.document.totpSecret).toMatch(/^[A-Z2-7]{32}$/);
    const displayed = await f.owner.request<{ code: string; expiresAt: number }>(
      '/crypto/totp/display',
      'POST',
      {},
    );
    // Compare to that display response's period, including a boundary crossed during the request.
    expect(independentTotp(prepared.document.totpSecret, displayed.expiresAt - 1) === displayed.code).toBe(
      true,
    );
    const other = runtime.session();
    await other.account.register(`backup_other_${++fixtureNumber}`, 'Other fixture', password);
    await expect(
      other.request(`${prefix}/seal`, 'POST', { ticket: prepared.ticket, payloadHash }),
    ).rejects.toMatchObject({ status: 404 });
    const second = runtime.session();
    let challenge: TrustedLoginRequired | undefined;
    try {
      await second.account.login(f.registration.user.id, password);
    } catch (error) {
      expect(error).toBeInstanceOf(TrustedLoginRequired);
      challenge = error as TrustedLoginRequired;
    }
    expect(challenge).toBeDefined();
    await second.account.completeTrustedLogin(challenge!.request, displayed.code, password);
    await expect(
      second.request(`${prefix}/prepare`, 'POST', { ...f.scope, setupGrant: grant }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      second.request(`${prefix}/seal`, 'POST', { ticket: prepared.ticket, payloadHash }),
    ).rejects.toMatchObject({ status: 404 });
    await f.owner.request('/crypto/authenticator/cancel', 'POST', { grant });
    await expect(
      f.owner.request(`${prefix}/prepare`, 'POST', { ...f.scope, setupGrant: grant }),
    ).rejects.toMatchObject({ status: 404 });
    const sealed = await f.seal(prepared.ticket);
    const rows = await runtime.rows();
    expect(
      rows.some(
        (row) =>
          row.hash === createHash('sha256').update(sealed.proof).digest('hex') &&
          row.stage === 'sealed' &&
          row.payload_hash === payloadHash,
      ),
    ).toBe(true);
    const stored = JSON.stringify(rows);
    for (const secret of [
      prepared.ticket,
      sealed.proof,
      prepared.document.totpSecret,
      f.registration.authenticatorSetup!.grant,
      f.owner.cookie().split('=')[1],
    ])
      expect(stored.includes(secret)).toBe(false);
  });

  it('binds payload, host, device and origin, then admits exactly one seal and one redemption', async () => {
    const runtime = await setup();
    const f = await fixture(runtime);
    const anonymous = runtime.session();
    const prepared = await f.prepare();
    await expect(
      f.owner.request(`${prefix}/seal`, 'POST', { ticket: prepared.ticket, payloadHash, extra: true }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (
        await f.owner.raw(
          `${prefix}/seal`,
          'POST',
          { ticket: prepared.ticket, payloadHash },
          { origin: 'https://foreign.invalid' },
        )
      ).status,
    ).toBe(403);
    const attempts = await Promise.allSettled([f.seal(prepared.ticket), f.seal(prepared.ticket)]);
    expect(attempts.map((value) => value.status).sort()).toEqual(['fulfilled', 'rejected']);
    const sealed = (
      attempts.find((value) => value.status === 'fulfilled') as PromiseFulfilledResult<{
        proof: string;
        expiresAt: number;
      }>
    ).value;
    expect(attempts.find((value) => value.status === 'rejected')).toMatchObject({ reason: { status: 404 } });
    await expect(f.seal(prepared.ticket)).rejects.toMatchObject({ status: 404 });
    const recoveryAuth = (await recoveryKeys(f.owner.account.recoveryCode)).auth;
    const body = { ...f.scope, proof: sealed.proof, payloadHash, totpHash: totpHash(prepared), recoveryAuth };
    for (const changes of [
      { hostId: (await createIdentity()).peerId },
      { deviceId: randomUUID() },
      { payloadHash: 'f'.repeat(64) },
      { totpHash: 'e'.repeat(64) },
      { recoveryAuth: Buffer.alloc(32).toString('base64') },
      { proof: prepared.ticket },
    ])
      await expect(
        anonymous.request(`${prefix}/redeem`, 'POST', { ...body, ...changes }),
      ).rejects.toMatchObject({ status: 404 });
    await expect(
      anonymous.request(`${prefix}/redeem`, 'POST', { ...body, extra: true }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (await anonymous.raw(`${prefix}/redeem`, 'POST', body, { origin: 'https://foreign.invalid' })).status,
    ).toBe(403);
    if (runtime.alias)
      expect(
        (
          await anonymous.raw(`${prefix}/redeem`, 'POST', body, {
            site: runtime.alias,
            origin: runtime.alias,
          })
        ).status,
      ).toBe(404);
    const redemptions = await Promise.all([
      anonymous.raw(`${prefix}/redeem`, 'POST', body, { origin: null }),
      anonymous.raw(`${prefix}/redeem`, 'POST', body, { origin: null }),
    ]);
    expect(redemptions.map((value) => value.status).sort()).toEqual([200, 404]);
    expect(redemptions.find((value) => value.status === 200)!.body).toMatchObject({
      accountId: f.registration.user.id,
      revision: f.owner.account.revision,
      origin: runtime.origin,
      ...f.scope,
    });
    await expect(anonymous.request(`${prefix}/redeem`, 'POST', body)).rejects.toMatchObject({ status: 404 });
  });

  it('expires both prepared and sealed capabilities without waiting for production TTLs', async () => {
    const runtime = await setup();
    const f = await fixture(runtime);
    const prepared = await f.prepare();
    expect(prepared.expiresAt).toBeGreaterThan(Date.now());
    expect(prepared.expiresAt - Date.now()).toBeLessThanOrEqual(120_000);
    await runtime.expire(prepared.ticket);
    await expect(f.seal(prepared.ticket)).rejects.toMatchObject({ status: 404 });
    const next = await f.prepare();
    const sealed = await f.seal(next.ticket);
    await runtime.expire(sealed.proof);
    await expect(
      runtime.session().request(`${prefix}/redeem`, 'POST', {
        ...f.scope,
        proof: sealed.proof,
        payloadHash,
        totpHash: totpHash(next),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('invalidates prepared and sealed grants when the account vault revision changes', async () => {
    const runtime = await setup();
    const f = await fixture(runtime);
    const first = await f.prepare();
    await f.owner.account.changePassword(password, nextPassword);
    const freshSetup = f.owner.account.authenticatorSetup!;
    expect(freshSetup.grant).not.toBe(f.registration.authenticatorSetup!.grant);
    expect(freshSetup.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    const provisioning = await f.owner.request<{ secret: string }>('/crypto/authenticator/setup', 'POST', {
      grant: freshSetup.grant,
    });
    expect(provisioning.secret === first.document.totpSecret).toBe(true);
    await expect(
      f.owner.request('/crypto/authenticator/setup', 'POST', {
        grant: f.registration.authenticatorSetup!.grant,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(f.seal(first.ticket)).rejects.toMatchObject({ status: 404 });
    const second = await f.prepare();
    expect(second.document.revision).toBe(first.document.revision + 1);
    const sealed = await f.seal(second.ticket);
    await f.owner.account.changePassword(nextPassword, password);
    await expect(
      runtime.session().request(`${prefix}/redeem`, 'POST', {
        ...f.scope,
        proof: sealed.proof,
        payloadHash,
        totpHash: totpHash(second),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects sealed grants after the source session ends and both stages after host revocation', async () => {
    const runtime = await setup();
    const f = await fixture(runtime);
    const document = await f.prepare();
    const sealed = await f.seal(document.ticket);
    await f.owner.request('/logout', 'POST', {});
    await expect(
      runtime.session().request(`${prefix}/redeem`, 'POST', {
        ...f.scope,
        proof: sealed.proof,
        payloadHash,
        totpHash: totpHash(document),
      }),
    ).rejects.toMatchObject({ status: 404 });
    const next = await fixture(runtime);
    const pending = await next.prepare();
    const granted = await next.seal((await next.prepare()).ticket);
    await next.owner.request(`/desktop-devices/${next.scope.hostId}`, 'DELETE', {
      accountId: next.registration.user.id,
    });
    await expect(next.seal(pending.ticket)).rejects.toMatchObject({ status: 404 });
    await expect(
      runtime.session().request(`${prefix}/redeem`, 'POST', {
        ...next.scope,
        proof: granted.proof,
        payloadHash,
        totpHash: totpHash(pending),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(next.prepare()).rejects.toMatchObject({ status: 403 });
  });
}
