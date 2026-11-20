import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type {
  MessageHandler,
  MessageRoute,
  MessagingHttp,
  MessagingReply,
  MessagingRequest,
} from '../src/server/messaging/http.js';
import { MessagingStore } from '../src/server/messaging/store.js';
import { ChatError, digest } from '../src/server/messaging/store-core.js';
import { registerTrustedDevices } from '../src/server/messaging/trusted-devices.js';
import { AccountTotp } from '../src/server/messaging/totp.js';
import { createTrustedLoginKey, trustedLoginPossessionProof } from '../src/shared/trusted-device-crypto.js';

// Route/SQL regression tests stub authenticator signatures, keeping real option generation and QR ECDH.
vi.mock('@simplewebauthn/server', async (original) => ({
  ...(await original<typeof import('@simplewebauthn/server')>()),
  verifyRegistrationResponse: vi.fn(async ({ response }) => ({
    verified: true,
    registrationInfo: {
      credential: { id: response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
      credentialDeviceType: 'singleDevice',
    },
  })),
  verifyAuthenticationResponse: vi.fn(async ({ credential }) => ({
    verified: true,
    authenticationInfo: { newCounter: credential.counter + 1 },
  })),
}));

const primary = 'https://app.example.com';
const alias = 'https://alias.example.com';
const stores: MessagingStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  vi.clearAllMocks();
});

function fixture(configuredOrigin = primary) {
  const store = new MessagingStore(':memory:');
  stores.push(store);
  const user = store.createUser('human', 'origin-test', 'Origin Test', 'synthetic-password-hash');
  const vault = {
    version: 1,
    password: { iv: 'AAAAAAAAAAAAAAAA', data: 'AAAAAAAAAAAAAAAAAAAAAA==' },
    synthetic: 'unchanged-account-vault',
  };
  store.db
    .prepare('INSERT INTO im_account_crypto VALUES (?,?,?,?)')
    .run(user.id, JSON.stringify(vault), 'synthetic-recovery-hash', 7);
  const ownerToken = store.issueSession(user.id).token;
  const totp = new AccountTotp(store.db, randomBytes(32).toString('base64url'));
  const routes = new Map<string, MessageHandler>();
  const route =
    (method: string): MessageRoute =>
    (path: string, ...args: unknown[]) => {
      routes.set(`${method} ${path}`, args.at(-1) as MessageHandler);
    };
  const app: MessagingHttp = {
    get: route('GET'),
    post: route('POST'),
    put: route('PUT'),
    patch: route('PATCH'),
    delete: route('DELETE'),
    addHook() {},
    setErrorHandler() {},
  };
  const token = (req: MessagingRequest) => req.cookies.owner ?? '';
  const install = (origin = configuredOrigin) =>
    registerTrustedDevices(app, {
      origin,
      store,
      totp,
      token,
      cookieToken: token,
      human: (req) => {
        const actor = store.authenticate(token(req));
        if (!actor) throw new ChatError(401, '请先登录');
        return actor;
      },
      session: (_request, _reply, account) => ({ user: account }),
      take() {},
      account: (id) => store.db.prepare('SELECT * FROM im_account_crypto WHERE user_id=?').get(id),
      verifyPassword: async () => true,
    });
  const trusted = install();
  const request = (
    origin: string | undefined,
    method = 'POST',
    body: unknown = {},
    owner = true,
    headerOrigin = origin ?? configuredOrigin,
  ): MessagingRequest => ({
    url: '/',
    method,
    origin,
    headers: { origin: headerOrigin },
    cookies: owner ? { owner: ownerToken } : {},
    params: {},
    query: {},
    body,
    clientAddress: () => '127.0.0.1',
  });
  const call = async <T = any>(path: string, req: MessagingRequest): Promise<T> => {
    const handler = routes.get(`${req.method} ${path}`);
    if (!handler) throw Error('Missing fixture route');
    return (await handler(req, {} as MessagingReply)) as T;
  };
  const addCredential = (origin = primary) => {
    const id = randomUUID();
    const credentialId = randomBytes(32).toString('base64url');
    store.db
      .prepare('INSERT INTO im_trusted_credentials VALUES (?,?,?,?,?,?,?,?)')
      .run(id, user.id, credentialId, 'AQID', 0, 'Synthetic passkey', 'singleDevice', Date.now());
    store.db.prepare('INSERT INTO im_trusted_origins VALUES (?,?,?)').run('credential', id, origin);
    totp.enable(user.id);
    return { id, credentialId };
  };
  return { store, user, vault, ownerToken, trusted, totp, request, call, addCredential, install };
}

function response(id = randomBytes(32).toString('base64url')) {
  return {
    id,
    rawId: id,
    type: 'public-key',
    clientExtensionResults: {},
    response: { clientDataJSON: 'AQ', authenticatorData: 'AQ', signature: 'AQ' },
  };
}

it.each([primary, alias])(
  'registers passkeys with the current request RP and exact origin: %s',
  async (origin) => {
    const f = fixture();
    const started = await f.call(
      '/crypto/trusted/enroll/options',
      f.request(origin, 'POST', {
        name: 'Synthetic device',
        auth: Buffer.alloc(32).toString('base64'),
      }),
    );
    expect(started.options.rp.id).toBe(new URL(origin).hostname);
    const registration = response();
    await expect(
      f.call(
        '/crypto/trusted/enroll',
        f.request(origin === primary ? alias : primary, 'POST', {
          id: started.id,
          response: { ...registration, response: { clientDataJSON: 'AQ', attestationObject: 'AQ' } },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
    await f.call(
      '/crypto/trusted/enroll',
      f.request(origin, 'POST', {
        id: started.id,
        response: { ...registration, response: { clientDataJSON: 'AQ', attestationObject: 'AQ' } },
      }),
    );
    expect(verifyRegistrationResponse).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedOrigin: origin,
        expectedRPID: new URL(origin).hostname,
      }),
    );
    expect(
      f.store.db.prepare("SELECT origin FROM im_trusted_origins WHERE kind='credential'").get()?.origin,
    ).toBe(origin);
    expect(f.store.user(f.user.id).id).toBe(f.user.id);
    expect(
      JSON.parse(String(f.store.db.prepare('SELECT vault FROM im_account_crypto').get()?.vault)),
    ).toEqual(f.vault);
  },
);

it('uses only current-RP credentials and rejects a ceremony completed on the other allowed origin', async () => {
  const f = fixture();
  const here = f.addCredential(primary);
  f.addCredential(alias);
  const started = await f.call(
    '/crypto/trusted/verify/options',
    f.request(primary, 'POST', { action: 'totp-display' }),
  );
  expect(started.options.rpId).toBe('app.example.com');
  expect(started.options.allowCredentials.map((item: { id: string }) => item.id)).toEqual([
    here.credentialId,
  ]);
  await expect(
    f.call(
      '/crypto/trusted/verify',
      f.request(alias, 'POST', { id: started.id, response: response(here.credentialId) }),
    ),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  const verified = await f.call(
    '/crypto/trusted/verify',
    f.request(primary, 'POST', { id: started.id, response: response(here.credentialId) }),
  );
  expect(verified.code).toMatch(/^\d{6}$/);
  expect(verifyAuthenticationResponse).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedOrigin: primary, expectedRPID: 'app.example.com' }),
  );
  await expect(
    f.call('/crypto/totp/display', f.request(alias, 'POST', { grant: verified.grant })),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    f.call('/crypto/totp/display', f.request(primary, 'POST', { grant: verified.grant })),
  ).resolves.toHaveProperty('code');
});

it('never uses an Origin header to select an RP and keeps the Node configured-origin fallback', async () => {
  const f = fixture(alias);
  f.addCredential(alias);
  await expect(
    f.call(
      '/crypto/trusted/verify/options',
      f.request(undefined, 'POST', { action: 'totp-display' }, true, primary),
    ),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    f.call(
      '/crypto/trusted/verify/options',
      f.request(alias, 'POST', { action: 'totp-display' }, true, 'https://attacker.example'),
    ),
  ).rejects.toMatchObject({ statusCode: 403 });
  const started = await f.call(
    '/crypto/trusted/verify/options',
    f.request(undefined, 'POST', { action: 'totp-display' }),
  );
  expect(started.options.rpId).toBe('alias.example.com');
  const bad = f.request(alias, 'POST', { action: 'totp-display' });
  delete bad.headers.origin;
  await expect(f.call('/crypto/trusted/verify/options', bad)).rejects.toMatchObject({ statusCode: 403 });
});

it('does not transfer a passkey-backed enrollment approval to another origin', async () => {
  const f = fixture();
  const passkey = f.addCredential(alias);
  f.addCredential(primary);
  const started = await f.call(
    '/crypto/trusted/verify/options',
    f.request(alias, 'POST', { action: 'enroll' }),
  );
  const approved = await f.call(
    '/crypto/trusted/verify',
    f.request(alias, 'POST', {
      id: started.id,
      response: response(passkey.credentialId),
    }),
  );
  const payload = {
    name: 'Additional trusted device',
    auth: Buffer.alloc(32).toString('base64'),
    approval: approved.approval,
  };
  await expect(
    f.call('/crypto/trusted/enroll/options', f.request(primary, 'POST', payload)),
  ).rejects.toMatchObject({ statusCode: 409 });
  const registration = await f.call('/crypto/trusted/enroll/options', f.request(alias, 'POST', payload));
  expect(registration.options.rp.id).toBe('alias.example.com');
});

it('rejects a credential from another RP even if its ID is supplied directly', async () => {
  const f = fixture();
  const foreign = f.addCredential(alias);
  f.addCredential(primary);
  const started = await f.call(
    '/crypto/trusted/verify/options',
    f.request(primary, 'POST', { action: 'totp-display' }),
  );
  await expect(
    f.call(
      '/crypto/trusted/verify',
      f.request(primary, 'POST', {
        id: started.id,
        response: response(foreign.credentialId),
      }),
    ),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
});

it('keeps account-wide 2FA enabled when no passkey exists for the current RP', async () => {
  const f = fixture();
  f.addCredential(alias);
  expect(f.trusted.required(f.user.id)).toBe(true);
  await expect(
    f.call('/crypto/trusted/verify/options', f.request(primary, 'POST', { action: 'enroll' })),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    f.call(
      '/crypto/trusted/enroll/options',
      f.request(primary, 'POST', {
        name: 'Unapproved new realm',
        auth: Buffer.alloc(32).toString('base64'),
      }),
    ),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(
    f.trusted.passwordChallenge(f.request(primary, 'POST', {}, false), f.user.id, 7, 'New phone'),
  ).toHaveProperty('claim');
});

it('binds password/TOTP challenges to their origin without consuming the code on a mismatched request', async () => {
  const f = fixture();
  f.addCredential(alias);
  const login = f.trusted.passwordChallenge(f.request(alias, 'POST', {}, false), f.user.id, 7, 'New phone');
  const code = f.totp.display(f.user.id).code;
  const payload = { id: login.id, claim: login.claim, code };
  await expect(
    f.call('/crypto/login/code', f.request(primary, 'POST', payload, false)),
  ).rejects.toMatchObject({ statusCode: 404 });
  const completed = await f.call('/crypto/login/code', f.request(alias, 'POST', payload, false));
  expect(completed.user.id).toBe(f.user.id);
  expect(completed.vault).toEqual(f.vault);
  expect(completed.revision).toBe(7);
});

it('keeps invite claims, owner polling and cancellations on the origin that created the QR', async () => {
  const f = fixture();
  f.addCredential(alias);
  const invite = await f.call('/crypto/qr/invite', f.request(alias));
  const key = await createTrustedLoginKey();
  const claim = {
    id: invite.id,
    secret: invite.secret,
    name: 'Synthetic recipient',
    publicKey: key.publicKey,
  };
  await expect(
    f.call('/crypto/qr/invite/claim', f.request(primary, 'POST', claim, false)),
  ).rejects.toMatchObject({ statusCode: 404 });
  const poll = f.request(primary, 'GET');
  poll.params = { id: invite.id };
  await expect(f.call('/crypto/qr/invite/:id', poll)).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    f.call('/crypto/qr/invite/cancel', f.request(primary, 'POST', { id: invite.id })),
  ).rejects.toMatchObject({ statusCode: 404 });
  const claimed = await f.call('/crypto/qr/invite/claim', f.request(alias, 'POST', claim, false));
  expect(
    f.store.db.prepare("SELECT origin FROM im_trusted_origins WHERE kind='login' AND id=?").get(claimed.id)
      ?.origin,
  ).toBe(alias);
});

it('binds QR inspection, approval and final redemption to one origin and recipient key', async () => {
  const f = fixture();
  const passkey = f.addCredential(alias);
  f.addCredential(primary);
  const key = await createTrustedLoginKey();
  const login = await f.call(
    '/crypto/qr/start',
    f.request(
      alias,
      'POST',
      { identifier: f.user.username, name: 'Synthetic recipient', publicKey: key.publicKey },
      false,
    ),
  );
  const proof = await trustedLoginPossessionProof(key.privateKey, login.proofKey, login.id);
  const body = { id: login.id, claim: login.claim, proof };
  const view = f.request(primary, 'GET');
  view.params = { id: login.id };
  await expect(f.call('/crypto/qr/:id', view)).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    f.call('/crypto/trusted/verify/options', f.request(primary, 'POST', { action: 'qr', target: login.id })),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(f.call('/crypto/qr/redeem', f.request(primary, 'POST', body, false))).rejects.toMatchObject({
    statusCode: 404,
  });
  const started = await f.call(
    '/crypto/trusted/verify/options',
    f.request(alias, 'POST', { action: 'qr', target: login.id }),
  );
  const encrypted = {
    publicKey: key.publicKey,
    iv: Buffer.alloc(12).toString('base64'),
    data: Buffer.alloc(48).toString('base64'),
  };
  await f.call(
    '/crypto/trusted/verify',
    f.request(alias, 'POST', {
      id: started.id,
      response: response(passkey.credentialId),
      envelope: encrypted,
    }),
  );
  await expect(f.call('/crypto/qr/redeem', f.request(primary, 'POST', body, false))).rejects.toMatchObject({
    statusCode: 404,
  });
  const completed = await f.call('/crypto/qr/redeem', f.request(alias, 'POST', body, false));
  expect(completed.user.id).toBe(f.user.id);
  expect(completed.vault).toEqual(f.vault);
  expect(completed.envelope).toEqual(encrypted);
});

it('migrates legacy credentials and transient rows once without changing identities, sessions or vaults', async () => {
  const f = fixture(alias);
  const passkey = f.addCredential(alias);
  const pending = f.trusted.passwordChallenge(
    f.request(alias, 'POST', {}, false),
    f.user.id,
    7,
    'Legacy phone',
  );
  for (const [table, count] of [
    ['im_trusted_credentials', 8],
    ['im_trusted_logins', 11],
    ['im_trusted_qr_invites', 8],
    ['im_trusted_ceremonies', 9],
    ['im_trusted_enroll_grants', 6],
    ['im_trusted_totp_grants', 6],
  ] as const) {
    expect(f.store.db.prepare(`PRAGMA table_info(${table})`).all()).toHaveLength(count);
  }
  // Old runtimes still use positional INSERTs. These must work after the upgrade.
  const grantHash = digest('synthetic-legacy-display-grant');
  f.store.db
    .prepare('INSERT INTO im_trusted_totp_grants VALUES (?,?,?,?,?,?)')
    .run(grantHash, f.user.id, digest(f.ownerToken), passkey.credentialId, 7, Date.now() + 60_000);
  f.store.db.exec('DROP TABLE im_trusted_origins');
  f.install();
  f.install(primary);
  expect(
    f.store.db
      .prepare("SELECT origin FROM im_trusted_origins WHERE kind='credential' AND id=?")
      .get(passkey.id)?.origin,
  ).toBe(alias);
  expect(
    f.store.db
      .prepare("SELECT origin FROM im_trusted_origins WHERE kind='totp-grant' AND id=?")
      .get(grantHash)?.origin,
  ).toBe(alias);
  expect(
    f.store.db.prepare("SELECT origin FROM im_trusted_origins WHERE kind='login' AND id=?").get(pending.id)
      ?.origin,
  ).toBe(alias);
  expect(f.store.authenticate(f.ownerToken)?.id).toBe(f.user.id);
  expect(
    f.store.db.prepare('SELECT claim_hash FROM im_trusted_logins WHERE id=?').get(pending.id)?.claim_hash,
  ).toBe(digest(pending.claim));
  expect(JSON.parse(String(f.store.db.prepare('SELECT vault FROM im_account_crypto').get()?.vault))).toEqual(
    f.vault,
  );
});
