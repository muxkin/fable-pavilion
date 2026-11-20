import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildRelay } from '../src/server/relay.js';
import { AccountClient, TrustedLoginRequired } from '../src/client/account.js';
import { passwordKeys, protectAccount, recoveryKeys } from '../src/shared/account-crypto.js';
import { sealTrustedLoginRoot } from '../src/shared/trusted-device-crypto.js';
import { createHash } from 'node:crypto';
import { totpCode } from '../src/server/messaging/totp.js';
import { totpCounter } from '../src/shared/totp.js';
import { TEST_TOTP_KEY } from './secure-login-fixture.js';
import { unboundQrContract } from './contracts/unbound-qr.js';

const origin = 'https://secure.test';
const password = 'synthetic-secure-account-password';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(key: string | undefined = TEST_TOTP_KEY) {
  const directory = mkdtempSync(join(tmpdir(), 'default-device-login-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'accounts.sqlite');
  const start = (totpKey: string | undefined) =>
    buildRelay({
      origin,
      webRoot: '/missing',
      assetOrigin: null,
      uploadOrigins: [],
      enrollmentSecret: 'synthetic-secure-auth-enrollment-key',
      messaging: { database, totpKey },
    });
  let relay = await start(key);
  cleanups.push(() => relay.app.close());
  const db = new DatabaseSync(database);
  cleanups.push(() => db.close());
  const session = () => {
    let cookie = '';
    const responses = new Map<string, any>();
    const raw = (
      path: string,
      method = 'GET',
      body?: unknown,
      headers?: Record<string, string | undefined>,
    ) =>
      relay.app.inject({
        method: method as 'GET',
        url: `/api/im${path}`,
        headers: Object.fromEntries(
          Object.entries({ host: 'secure.test', origin, cookie, ...headers }).filter(
            ([, value]) => value !== undefined,
          ),
        ),
        payload: body as object,
      });
    const request = async <T = any>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      const response = await raw(path, method, body);
      if (response.cookies.length)
        cookie = response.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
      if (response.statusCode >= 400)
        throw Object.assign(Error(response.json().error), { status: response.statusCode });
      const result = response.json() as T;
      responses.set(path, result);
      return result;
    };
    return {
      account: new AccountClient(request),
      request,
      raw,
      cookie: () => cookie,
      last: (path: string) => responses.get(path),
    };
  };
  const restart = async (nextKey: string | undefined) => {
    await relay.app.close();
    relay = await start(nextKey);
  };
  return { session, db, restart };
}

async function loginProof(account: AccountClient) {
  return (await passwordKeys(password, account.vault!.salt)).auth;
}

unboundQrContract(async () => {
  const { session } = await fixture();
  return { origin, session };
});

it('creates default TOTP atomically and never upgrades a password-only pending request into a session', async () => {
  const f = await fixture();
  const owner = f.session(),
    waiting = f.session();
  await owner.account.register('default-owner', 'Owner', password);
  expect(await owner.request('/crypto/trusted')).toMatchObject({
    required: true,
    totpEnabled: true,
    hasCredentials: false,
    devices: [],
  });
  const code = await owner.request('/crypto/totp/display', 'POST', {});
  expect(code.code).toMatch(/^\d{6}$/);
  expect(code.expiresAt % 30_000).toBe(0);
  expect(code).not.toHaveProperty('secret');
  const proof = await loginProof(owner.account);
  const fakeRecovery = await waiting.raw('/crypto/login', 'POST', {
    identifier: 'default-owner',
    auth: proof,
    recovery: true,
  });
  expect(fakeRecovery.statusCode).toBe(401);
  expect(fakeRecovery.cookies).toHaveLength(0);
  const count = () => Number(f.db.prepare('SELECT COUNT(*) AS count FROM im_sessions').get()!.count);
  expect(count()).toBe(1);
  let pending: any;
  for (const trusted of [undefined, false, true]) {
    const result = await waiting.raw('/crypto/login', 'POST', {
      identifier: 'default-owner',
      auth: proof,
      trusted,
    });
    expect(result.statusCode).toBe(200);
    expect(result.cookies).toHaveLength(0);
    pending = result.json().trustedLogin;
    expect(pending.claim).toHaveLength(43);
    expect(result.json()).not.toHaveProperty('vault');
    expect(result.json()).not.toHaveProperty('user');
    expect(count()).toBe(1);
  }
  expect((await waiting.raw('/crypto/totp/display', 'POST', {})).statusCode).toBe(401);
  expect((await waiting.raw('/crypto/account')).statusCode).toBe(401);
  expect(await waiting.request('/me')).toEqual({ user: null });
  await waiting.account.completeTrustedLogin(pending, code.code, password);
  expect(waiting.account.secrets!.root).toBe(owner.account.secrets!.root);
  expect(count()).toBe(2);
  const again = await f
    .session()
    .request('/crypto/login', 'POST', { identifier: 'default-owner', auth: proof });
  expect(
    (
      await f.session().raw('/crypto/login/code', 'POST', {
        id: again.trustedLogin.id,
        claim: again.trustedLogin.claim,
        code: code.code,
      })
    ).statusCode,
  ).toBe(401);
  expect(count()).toBe(2);
});

it('allows signed-in devices to refresh codes, while checking grants when supplied and retaining fresh seed-export verification', async () => {
  const f = await fixture();
  const owner = f.session();
  await owner.account.register('display-owner', 'Owner', password);
  expect((await owner.request('/crypto/totp/display', 'POST', {})).code).toMatch(/^\d{6}$/);
  expect((await owner.request('/crypto/totp/display', 'POST', {})).code).toMatch(/^\d{6}$/);
  expect((await owner.raw('/crypto/totp/display', 'POST', { grant: 'A'.repeat(43) })).statusCode).toBe(404);
  expect(
    (await owner.raw('/crypto/totp/display', 'POST', {}, { origin: 'https://other.test' })).statusCode,
  ).toBe(403);
  expect((await owner.raw('/crypto/totp/display', 'POST', {}, { origin: undefined })).statusCode).toBe(403);
  expect(
    (await owner.raw('/crypto/trusted/verify/options', 'POST', { action: 'totp-provision' })).statusCode,
  ).toBe(403);
  expect((await owner.raw('/crypto/totp/display', 'POST', { action: 'totp-provision' })).statusCode).toBe(
    400,
  );
  await owner.request('/logout', 'POST', {});
  expect((await owner.raw('/crypto/totp/display', 'POST', {})).statusCode).toBe(401);
});

it('hands an unchanged E2E vault to the QR recipient with a complete session and no passkeys', async () => {
  const f = await fixture();
  const owner = f.session(),
    recipient = f.session(),
    stranger = f.session();
  await owner.account.register('qr-owner', 'Owner', password);
  await stranger.account.register('qr-stranger', 'Other', password);
  const handle = await recipient.account.startQrLogin('qr-owner', 'New phone');
  expect(recipient.cookie()).toBe('');
  const current = await owner.request(`/crypto/qr/${handle.id}`);
  const envelope = await sealTrustedLoginRoot(owner.account.secrets!, {
    origin,
    requestId: handle.id,
    accountId: owner.account.user!.id,
    recipientPublicKey: current.publicKey,
  });
  const body = { id: handle.id, envelope };
  expect((await stranger.raw('/crypto/qr/approve', 'POST', body)).statusCode).toBe(404);
  expect((await recipient.raw('/crypto/qr/approve', 'POST', body)).statusCode).toBe(401);
  expect((await owner.raw('/crypto/qr/approve', 'POST', body, { origin: undefined })).statusCode).toBe(403);
  expect(await owner.request('/crypto/qr/approve', 'POST', body)).toEqual({ ok: true });
  expect((await owner.raw('/crypto/qr/approve', 'POST', body)).statusCode).toBe(404);
  await recipient.account.checkQrLogin(handle, origin);
  expect(recipient.account.secrets!.root).toBe(owner.account.secrets!.root);
  expect(recipient.account.user!.id).toBe(owner.account.user!.id);
  expect((await recipient.request('/crypto/totp/display', 'POST', {})).code).toMatch(/^\d{6}$/);
});

it('supports the reverse invitation flow while retaining origin, owner-session and key-possession checks', async () => {
  const f = await fixture();
  const owner = f.session(),
    recipient = f.session();
  await owner.account.register('invite-owner', 'Owner', password);
  const invite = await owner.request('/crypto/qr/invite', 'POST', {});
  const handle = await recipient.account.claimQrInvitation(invite.id, invite.secret, 'New phone');
  const status = await owner.request(`/crypto/qr/invite/${invite.id}`);
  expect(status.state).toBe('claimed');
  const envelope = await sealTrustedLoginRoot(owner.account.secrets!, {
    origin,
    requestId: handle.id,
    accountId: owner.account.user!.id,
    recipientPublicKey: status.request.publicKey,
  });
  expect(
    (
      await recipient.raw('/crypto/qr/redeem', 'POST', {
        id: handle.id,
        claim: handle.claim,
        proof: 'A'.repeat(43),
      })
    ).statusCode,
  ).toBe(404);
  await owner.request('/crypto/qr/approve', 'POST', { id: handle.id, envelope });
  await recipient.account.checkQrLogin(handle, origin);
  expect(recipient.account.secrets!.root).toBe(owner.account.secrets!.root);
  expect((await owner.request(`/crypto/qr/invite/${invite.id}`)).state).toBe('completed');
});

it('migrates existing humans without changing UID, vault or complete sessions and never seeds agents', async () => {
  const f = await fixture();
  const owner = f.session();
  await owner.account.register('legacy-owner', 'Owner', password);
  const invitation = await owner.request('/agent-invitations', 'POST', {});
  const agentVault = await protectAccount('synthetic-legacy-agent-password');
  const agent = await f.session().request('/agents/register', 'POST', {
    invitation: invitation.invitation,
    username: 'legacy-agent',
    displayName: 'Agent',
    vault: agentVault.vault,
  });
  const saved = f.db.prepare('SELECT * FROM im_account_crypto').all();
  const sessions = f.db.prepare('SELECT * FROM im_sessions').all();
  f.db.exec('DELETE FROM im_account_totp');
  await f.restart(TEST_TOTP_KEY);
  expect(f.db.prepare('SELECT * FROM im_account_crypto').all()).toEqual(saved);
  expect(f.db.prepare('SELECT * FROM im_sessions').all()).toEqual(sessions);
  expect(f.db.prepare('SELECT 1 FROM im_account_totp WHERE user_id=?').get(agent.user.id)).toBeUndefined();
  expect((await owner.request('/crypto/totp/display', 'POST', {})).code).toMatch(/^\d{6}$/);
  const sealed = f.db.prepare('SELECT sealed_seed FROM im_account_totp').get()!.sealed_seed;
  await f.restart(TEST_TOTP_KEY);
  expect(f.db.prepare('SELECT sealed_seed FROM im_account_totp').get()!.sealed_seed).toBe(sealed);
  expect((await owner.request('/me')).user.id).toBe(owner.account.user!.id);
  expect(
    (
      await f.session().request('/crypto/login', 'POST', {
        identifier: 'legacy-owner',
        auth: await loginProof(owner.account),
      })
    ).trustedLogin,
  ).toHaveProperty('claim');
});

it('fails closed without a TOTP key while preserving existing human data, recovery authentication and Agent enrollment', async () => {
  const f = await fixture();
  const owner = f.session(),
    anonymous = f.session();
  await owner.account.register('missing-key-owner', 'Owner', password);
  const recovery = owner.account.recoveryCode;
  await f.restart(undefined);
  expect((await owner.request('/me')).user.id).toBe(owner.account.user!.id);
  expect((await owner.request('/crypto/account')).vault).toEqual(owner.account.vault);
  expect((await owner.raw('/crypto/totp/display', 'POST', {})).statusCode).toBe(503);
  expect(
    (
      await anonymous.raw('/crypto/login', 'POST', {
        identifier: 'missing-key-owner',
        auth: await loginProof(owner.account),
      })
    ).statusCode,
  ).toBe(503);
  await expect(anonymous.account.register('blocked-registration', 'Blocked', password)).rejects.toMatchObject(
    { status: 503 },
  );
  expect(anonymous.cookie()).toBe('');
  expect(f.db.prepare("SELECT 1 FROM im_users WHERE username='blocked-registration'").get()).toBeUndefined();
  const restored = f.session();
  await restored.account.login('missing-key-owner', recovery, true);
  expect(restored.account.secrets!.root).toBe(owner.account.secrets!.root);
  await expect(
    restored.account.changePassword(recovery, 'replacement-strong-password', true),
  ).rejects.toMatchObject({ status: 503 });
  expect((await owner.request('/crypto/account')).vault).toEqual(owner.account.vault);
  const invite = await owner.request('/agent-invitations', 'POST', {});
  const protectedAgent = await protectAccount('synthetic-agent-password');
  const agent = await anonymous.request('/agents/register', 'POST', {
    invitation: invite.invitation,
    username: 'unaffected-agent',
    displayName: 'Agent',
    vault: protectedAgent.vault,
  });
  expect(agent.user.kind).toBe('agent');
  expect(f.db.prepare('SELECT 1 FROM im_account_totp WHERE user_id=?').get(agent.user.id)).toBeUndefined();
});

it('rotates the code seed on recovery without switching protection off or changing E2E identity', async () => {
  const f = await fixture();
  const owner = f.session(),
    recovered = f.session();
  await owner.account.register('recovery-owner', 'Owner', password);
  const oldSeed = f.db.prepare('SELECT sealed_seed FROM im_account_totp').get()!.sealed_seed;
  const recovery = owner.account.recoveryCode;
  await recovered.account.login('recovery-owner', recovery, true);
  await recovered.account.changePassword(recovery, 'replacement-strong-password', true);
  const current = await recovered.request('/crypto/trusted');
  expect(current).toMatchObject({ required: true, totpEnabled: true, hasCredentials: false });
  expect(f.db.prepare('SELECT sealed_seed FROM im_account_totp').get()!.sealed_seed).not.toBe(oldSeed);
  expect(recovered.account.secrets!.root).toBe(owner.account.secrets!.root);
  expect((await owner.raw('/crypto/totp/display', 'POST', {})).statusCode).toBe(401);
  expect((await recovered.request('/crypto/totp/display', 'POST', {})).code).toMatch(/^\d{6}$/);
});

it.each(['im_account_totp', 'im_authenticator_setups'])(
  'rolls back account, seed and session without issuing a cookie if bootstrap creation fails in %s',
  async (table) => {
    const f = await fixture();
    f.db.exec(
      `CREATE TRIGGER fail_bootstrap BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`,
    );
    const account = f.session();
    await expect(account.account.register('rollback-owner', 'Owner', password)).rejects.toMatchObject({
      status: 500,
    });
    expect(account.cookie()).toBe('');
    expect(f.db.prepare('SELECT 1 FROM im_users').get()).toBeUndefined();
    expect(f.db.prepare('SELECT 1 FROM im_account_crypto').get()).toBeUndefined();
    expect(f.db.prepare('SELECT 1 FROM im_sessions').get()).toBeUndefined();
  },
);

function authenticatorSeed(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0,
    value = 0;
  const bytes: number[] = [];
  for (const letter of secret) {
    value = (value << 5) | alphabet.indexOf(letter);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return new Uint8Array(bytes);
}

it('offers a short registration-bound standard Authenticator setup and consumes it only after a real 6-digit confirmation', async () => {
  const f = await fixture();
  const owner = f.session();
  await owner.account.register('authenticator-owner', 'Owner', password);
  const setup = owner.last('/crypto/register').authenticatorSetup;
  expect(setup.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(setup.expiresAt - Date.now()).toBeGreaterThan(295_000);
  expect(setup.expiresAt - Date.now()).toBeLessThanOrEqual(300_000);
  const stored = f.db.prepare('SELECT * FROM im_authenticator_setups').get()!;
  expect(stored.hash).toBe(createHash('sha256').update(setup.grant).digest('hex'));
  expect(JSON.stringify(stored)).not.toContain(setup.grant);
  const provisioning = await owner.request('/crypto/authenticator/setup', 'POST', { grant: setup.grant });
  expect(provisioning.secret).toMatch(/^[A-Z2-7]{32}$/);
  expect(provisioning.expiresAt).toBe(setup.expiresAt);
  const uri = new URL(provisioning.uri);
  expect(uri.protocol).toBe('otpauth:');
  expect(uri.hostname).toBe('totp');
  expect(uri.searchParams.get('secret')).toBe(provisioning.secret);
  expect(uri.searchParams.get('digits')).toBe('6');
  expect(uri.searchParams.get('period')).toBe('30');
  expect(uri.searchParams.get('algorithm')).toBe('SHA1');
  const seed = authenticatorSeed(provisioning.secret);
  const counter = totpCounter(Date.now());
  const possible = new Set([-1, 0, 1].map((skew) => totpCode(seed, counter + skew)));
  const wrong = ['000000', '000001', '000002', '000003'].find((code) => !possible.has(code))!;
  expect(
    (await owner.raw('/crypto/authenticator/confirm', 'POST', { grant: setup.grant, code: wrong }))
      .statusCode,
  ).toBe(401);
  expect(f.db.prepare('SELECT attempts FROM im_authenticator_setups').get()!.attempts).toBe(1);
  const code = totpCode(seed, totpCounter(Date.now()));
  expect(await owner.request('/crypto/authenticator/confirm', 'POST', { grant: setup.grant, code })).toEqual({
    ok: true,
  });
  expect((await owner.raw('/crypto/authenticator/setup', 'POST', { grant: setup.grant })).statusCode).toBe(
    404,
  );
  expect(
    (await owner.raw('/crypto/authenticator/confirm', 'POST', { grant: setup.grant, code })).statusCode,
  ).toBe(404);
  expect(f.db.prepare('SELECT 1 FROM im_authenticator_setups').get()).toBeUndefined();
  expect(await owner.request('/crypto/trusted')).toMatchObject({ required: true, totpEnabled: true });
});

it('never exports a seed from ordinary, password-pending, other-user or other-device sessions without the exact bootstrap grant', async () => {
  const f = await fixture();
  const owner = f.session(),
    waiting = f.session(),
    stranger = f.session();
  await owner.account.register('setup-scope-owner', 'Owner', password);
  await stranger.account.register('setup-scope-other', 'Other', password);
  const { grant } = owner.last('/crypto/register').authenticatorSetup;
  expect((await owner.raw('/crypto/authenticator/setup', 'POST', {})).statusCode).toBe(400);
  expect((await owner.raw('/crypto/authenticator/setup', 'POST', { grant: 'A'.repeat(43) })).statusCode).toBe(
    404,
  );
  expect((await stranger.raw('/crypto/authenticator/setup', 'POST', { grant })).statusCode).toBe(404);
  const pending = await waiting.request('/crypto/login', 'POST', {
    identifier: 'setup-scope-owner',
    auth: await loginProof(owner.account),
  });
  expect(pending).not.toHaveProperty('authenticatorSetup');
  expect((await waiting.raw('/crypto/authenticator/setup', 'POST', { grant })).statusCode).toBe(401);
  const { code } = await owner.request('/crypto/totp/display', 'POST', {});
  await waiting.account.completeTrustedLogin(pending.trustedLogin, code, password);
  expect(waiting.last('/crypto/login/code')).not.toHaveProperty('authenticatorSetup');
  expect((await waiting.raw('/crypto/authenticator/setup', 'POST', { grant })).statusCode).toBe(404);
  expect(
    (await owner.raw('/crypto/authenticator/setup', 'POST', { grant }, { origin: 'https://other.test' }))
      .statusCode,
  ).toBe(403);
  expect(
    (await owner.raw('/crypto/authenticator/setup', 'POST', { grant }, { origin: undefined })).statusCode,
  ).toBe(403);
  expect((await owner.request('/crypto/authenticator/setup', 'POST', { grant })).secret).toBeTruthy();
});

it('lets registration skip external software without disabling the built-in code and limits repeated seed reads', async () => {
  const f = await fixture();
  const owner = f.session();
  await owner.account.register('skip-setup-owner', 'Owner', password);
  const { grant } = owner.last('/crypto/register').authenticatorSetup;
  for (let i = 0; i < 8; i++)
    expect((await owner.request('/crypto/authenticator/setup', 'POST', { grant })).secret).toBeTruthy();
  expect((await owner.raw('/crypto/authenticator/setup', 'POST', { grant })).statusCode).toBe(429);
  expect(await owner.request('/crypto/authenticator/cancel', 'POST', { grant })).toEqual({ ok: true });
  expect((await owner.raw('/crypto/authenticator/setup', 'POST', { grant })).statusCode).toBe(404);
  expect((await owner.request('/crypto/totp/display', 'POST', {})).code).toMatch(/^\d{6}$/);
});

it('rejects expired, revoked, revision-mismatched and origin-mismatched setup grants', async () => {
  const f = await fixture();
  const owner = f.session();
  await owner.account.register('expired-setup-owner', 'Owner', password);
  const { grant, expiresAt } = owner.last('/crypto/register').authenticatorSetup;
  f.db.prepare('UPDATE im_authenticator_setups SET expires_at=?').run(Date.now() - 1);
  expect((await owner.raw('/crypto/authenticator/setup', 'POST', { grant })).statusCode).toBe(404);
  f.db
    .prepare('UPDATE im_authenticator_setups SET expires_at=?,origin=?')
    .run(expiresAt, 'https://other.test');
  expect((await owner.raw('/crypto/authenticator/setup', 'POST', { grant })).statusCode).toBe(404);
  f.db.prepare('UPDATE im_authenticator_setups SET origin=?,revision=revision+1').run(origin);
  expect((await owner.raw('/crypto/authenticator/setup', 'POST', { grant })).statusCode).toBe(404);
  await owner.request('/logout', 'POST', {});
  expect((await owner.raw('/crypto/authenticator/setup', 'POST', { grant })).statusCode).toBe(401);
});

it('grants fresh session/revision-bound setup after a proven password change and preserves the ordinary-change TOTP seed', async () => {
  const f = await fixture();
  const owner = f.session(),
    recovered = f.session();
  await owner.account.register('fresh-recovery-setup', 'Owner', password);
  const oldGrant = owner.last('/crypto/register').authenticatorSetup.grant;
  await recovered.account.login('fresh-recovery-setup', owner.account.recoveryCode, true);
  expect(recovered.last('/crypto/login')).not.toHaveProperty('authenticatorSetup');
  await recovered.account.changePassword(owner.account.recoveryCode, 'replacement-password-for-setup', true);
  const setup = recovered.last('/crypto/password').authenticatorSetup;
  expect(setup.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(setup.grant).not.toBe(oldGrant);
  expect((await recovered.raw('/crypto/authenticator/setup', 'POST', { grant: oldGrant })).statusCode).toBe(
    404,
  );
  const recoverySeed = (
    await recovered.request('/crypto/authenticator/setup', 'POST', { grant: setup.grant })
  ).secret;
  const originalTotp = f.db
    .prepare('SELECT sealed_seed,last_counter FROM im_account_totp WHERE user_id=?')
    .get(owner.account.user!.id);
  await recovered.account.changePassword('replacement-password-for-setup', 'ordinary-next-password');
  const ordinarySetup = recovered.last('/crypto/password').authenticatorSetup;
  expect(ordinarySetup.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(ordinarySetup.grant).not.toBe(setup.grant);
  expect(ordinarySetup.expiresAt).toBeGreaterThan(Date.now());
  expect(ordinarySetup.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  expect(
    f.db
      .prepare('SELECT sealed_seed,last_counter FROM im_account_totp WHERE user_id=?')
      .get(owner.account.user!.id),
  ).toEqual(originalTotp);
  const grantRow = f.db
    .prepare('SELECT session_hash,revision,user_id FROM im_authenticator_setups WHERE hash=?')
    .get(createHash('sha256').update(ordinarySetup.grant).digest('hex'))!;
  expect(grantRow).toMatchObject({
    user_id: recovered.account.user!.id,
    revision: recovered.account.revision,
    session_hash: createHash('sha256').update(recovered.cookie().split('=')[1]).digest('hex'),
  });
  const ordinarySeed = (
    await recovered.request('/crypto/authenticator/setup', 'POST', { grant: ordinarySetup.grant })
  ).secret;
  expect(ordinarySeed === recoverySeed).toBe(true);
  const displayed = await recovered.request('/crypto/totp/display', 'POST', {});
  expect(
    totpCode(authenticatorSeed(recoverySeed), totpCounter(displayed.expiresAt - 1)) === displayed.code,
  ).toBe(true);
  expect(
    (await recovered.raw('/crypto/authenticator/setup', 'POST', { grant: setup.grant })).statusCode,
  ).toBe(404);
  const another = f.session();
  let challenge: TrustedLoginRequired | undefined;
  try {
    await another.account.login('fresh-recovery-setup', 'ordinary-next-password');
  } catch (error) {
    expect(error).toBeInstanceOf(TrustedLoginRequired);
    challenge = error as TrustedLoginRequired;
  }
  expect(challenge).toBeDefined();
  await another.account.completeTrustedLogin(challenge!.request, displayed.code, 'ordinary-next-password');
  expect(
    (await another.raw('/crypto/authenticator/setup', 'POST', { grant: ordinarySetup.grant })).statusCode,
  ).toBe(404);
  expect(recovered.account.secrets!.root).toBe(owner.account.secrets!.root);
});

it('registers login devices per completed session and revokes only the selected session', async () => {
  const f = await fixture();
  const owner = f.session();
  const second = f.session();
  const outsider = f.session();
  await owner.account.register('login-devices-owner', 'Owner', password);
  await outsider.account.register('login-devices-outsider', 'Other', password);
  const pending = await second.request('/crypto/login', 'POST', {
    identifier: 'login-devices-owner',
    auth: await loginProof(owner.account),
  });
  expect((await owner.request('/login-devices')).devices).toHaveLength(1);
  const { code } = await owner.request('/crypto/totp/display', 'POST', {});
  await second.request('/crypto/login/code', 'POST', {
    id: pending.trustedLogin.id,
    claim: pending.trustedLogin.claim,
    code,
  });
  const { devices } = await owner.request('/login-devices');
  expect(devices).toHaveLength(2);
  expect(devices[0]).toMatchObject({ current: true });
  expect((await owner.request('/login-devices')).devices.map(({ id }: { id: string }) => id)).toEqual(
    devices.map(({ id }: { id: string }) => id),
  );
  expect((await outsider.raw(`/login-devices/${devices[1].id}`, 'DELETE')).statusCode).toBe(404);
  expect((await owner.raw(`/login-devices/${devices[0].id}`, 'DELETE')).statusCode).toBe(404);
  await owner.request(`/login-devices/${devices[1].id}`, 'DELETE');
  expect((await second.raw('/me')).statusCode).toBe(401);
  expect((await owner.request('/login-devices')).devices).toHaveLength(1);
});

it('adds revocable independent authenticator seeds from a scoped grant without requiring a passkey', async () => {
  const f = await fixture();
  const owner = f.session();
  await owner.account.register('external-authenticator-owner', 'Owner', password);
  const initialGrant = owner.last('/crypto/register').authenticatorSetup.grant;
  const builtin = await owner.request('/crypto/authenticator/setup', 'POST', { grant: initialGrant });
  const { grant } = await owner.request('/crypto/authenticators/options', 'POST', {});
  const first = await owner.request('/crypto/authenticator/setup', 'POST', { grant, name: '验证器一' });
  expect(first.secret).not.toBe(builtin.secret);
  expect((await owner.request('/crypto/authenticator/setup', 'POST', { grant })).secret).toBe(first.secret);
  const seed = authenticatorSeed(first.secret);
  const counter = totpCounter(Date.now());
  await owner.request('/crypto/authenticator/confirm', 'POST', { grant, code: totpCode(seed, counter - 1) });
  const { authenticators } = await owner.request('/crypto/trusted');
  expect(authenticators).toEqual([expect.objectContaining({ name: '验证器一' })]);
  const other = f.session();
  const pending = await other.request('/crypto/login', 'POST', {
    identifier: 'external-authenticator-owner',
    auth: await loginProof(owner.account),
  });
  await other.request('/crypto/login/code', 'POST', {
    id: pending.trustedLogin.id,
    claim: pending.trustedLogin.claim,
    code: totpCode(seed, counter),
  });
  await owner.request(`/crypto/authenticators/${authenticators[0].id}`, 'DELETE', {
    auth: await loginProof(owner.account),
  });
  expect(await owner.request('/crypto/trusted')).toMatchObject({ totpEnabled: true, authenticators: [] });
  expect((await owner.raw('/crypto/authenticator/setup', 'POST', { grant })).statusCode).toBe(404);
});

it('replaces only the recovery credential while preserving the account root and login password', async () => {
  const f = await fixture();
  const owner = f.session();
  await owner.account.register('recovery-rotate-owner', 'Owner', password);
  const original = owner.account.recoveryCode!;
  const previous = owner.account.vault!;
  await owner.account.rotateRecovery(password);
  expect(owner.account.recoveryCode).not.toBe(original);
  expect(owner.account.vault).toMatchObject({
    password: previous.password,
    publicKeys: previous.publicKeys,
    salt: previous.salt,
  });
  const other = f.session();
  expect(
    (
      await other.raw('/crypto/login', 'POST', {
        identifier: 'recovery-rotate-owner',
        auth: (await recoveryKeys(original)).auth,
        recovery: true,
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await other.request('/crypto/login', 'POST', {
        identifier: 'recovery-rotate-owner',
        auth: (await recoveryKeys(owner.account.recoveryCode!)).auth,
        recovery: true,
      })
    ).user.id,
  ).toBe(owner.account.user!.id);
});
