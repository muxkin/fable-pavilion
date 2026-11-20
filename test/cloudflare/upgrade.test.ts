import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions, type DurableObjectStorageHandle } from 'miniflare';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, scryptSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { AccountClient, TrustedLoginRequired } from '../../src/client/account.js';
import { EncryptedMessagingClient } from '../../src/client/encrypted-messaging.js';
import {
  encryptFor,
  privateId,
  parseEnvelope,
  protectAccount,
  sealPrivate,
  unlockAccount,
} from '../../src/shared/account-crypto.js';
import { sealTrustedLoginRoot } from '../../src/shared/trusted-device-crypto.js';
import { createIdentity } from '../../src/shared/secure-channel.js';

const name = 'cloudflare-upgrade-test';
const directory = mkdtempSync(join(tmpdir(), 'pocket-cf-upgrade-'));
const ownerId = '9007199254740993';
const agentId = '9007199254740994';
const username = 'legacy-upgrade-owner';
const password = 'isolated-existing-account-password';
const totpKey = randomBytes(32).toString('base64url');
const legacyToken = randomBytes(32).toString('base64url');
const cid = randomUUID();
const messageId = randomUUID();
const clientId = 'legacy-message-client-id';
const messageText = 'An encrypted message written before trusted devices existed';
const vaultName = 'host:pre-trusted-adapter';
const vaultValue = {
  deviceId: 'legacy-device',
  routeTicket: 'synthetic-private-route',
  attachments: ['kept'],
};
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest();
let mf: Miniflare, origin: string, port: number;
let messaging: DurableObjectStorageHandle, relay: DurableObjectStorageHandle;
let owner: Awaited<ReturnType<typeof protectAccount>>;
let vaultItemId: string;
let hostId: string;
let legacyCiphertext: string;
let expected: Record<string, unknown>;

function options(bootstrap = false, configured = true) {
  return {
    ...convertV4MiniflareOptions({
      name,
      rootPath: directory,
      modules: true,
      ...(bootstrap
        ? {
            script: `
        import { DurableObject } from 'cloudflare:workers';
        export class MessagingHub extends DurableObject { fetch() { return Response.json({legacy:true}); } }
        export class RelayHub extends DurableObject { fetch() { return Response.json({legacy:true}); } }
        export default { fetch() { return Response.json({legacy:true}); } };
      `,
          }
        : { scriptPath: join(directory, 'worker/index.js') }),
      compatibilityDate: '2026-11-04',
      compatibilityFlags: ['nodejs_compat'],
      host: '127.0.0.1',
      port,
      bindings: {
        POCKET_PUBLIC_ORIGIN: origin,
        POCKET_IM_HUMAN_CONTACTS: 'true',
        ...(configured ? { POCKET_IM_TOTP_KEY: totpKey } : {}),
      },
      durableObjects: {
        RELAY: { className: 'RelayHub', useSQLite: true },
        MESSAGING: { className: 'MessagingHub', useSQLite: true },
      },
      r2Buckets: ['IM_MEDIA'],
      images: { binding: 'IMAGES' },
      serviceBindings: { ASSETS: async () => new Response('isolated account upgrade') },
    }),
    unsafeInspectDurableObjects: true,
  };
}

function session(initialToken?: string) {
  let cookie = initialToken ? `pocket_im_session=${initialToken}` : '';
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`${origin}/api/im${path}`, {
      method,
      headers: { Origin: origin, Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = response.headers.get('Set-Cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const value = response.status === 204 ? undefined : ((await response.json()) as any);
    if (!response.ok) throw Object.assign(Error(value.error), { status: response.status });
    return value as T;
  };
  const account = new AccountClient(request);
  return {
    request,
    account,
    cookie: () => cookie,
    client() {
      const client = new EncryptedMessagingClient(origin, cookie.split('=')[1]);
      client.account.activate(account.user!, account.secrets!, account.vault!, account.revision);
      return client;
    },
  };
}

/** Standard P-256 WebAuthn messages, independently signed; the Worker verifies every signature. */
function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const id = randomBytes(32),
    credentialId = id.toString('base64url');
  let counter = 0;
  const data = (challenge: string, type: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const prefix = (flags: number) => {
    const value = Buffer.alloc(37);
    digest(Buffer.from(new URL(origin).hostname)).copy(value);
    value[32] = flags;
    value.writeUInt32BE(counter, 33);
    return value;
  };
  const credential = {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    clientExtensionResults: {},
  };
  return {
    register(challenge: string) {
      const key = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
          [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
        ]),
      );
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      const authData = Buffer.concat([prefix(0x45), Buffer.alloc(16), length, id, key]);
      const attestation = isoCBOR.encode(
        new Map<string, Parameters<typeof isoCBOR.encode>[0]>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', new Uint8Array(authData)],
        ]),
      );
      return {
        ...credential,
        response: {
          clientDataJSON: data(challenge, 'webauthn.create').toString('base64url'),
          attestationObject: Buffer.from(attestation).toString('base64url'),
          transports: ['internal'],
        },
      };
    },
    authenticate(challenge: string) {
      counter++;
      const clientData = data(challenge, 'webauthn.get'),
        authData = prefix(0x05);
      return {
        ...credential,
        response: {
          clientDataJSON: clientData.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: sign('sha256', Buffer.concat([authData, digest(clientData)]), privateKey).toString(
            'base64url',
          ),
          userHandle: Buffer.from(ownerId).toString('base64url'),
        },
      };
    },
  };
}

async function upgradeWorker(configured: boolean) {
  await mf.setOptions(options(false, configured));
  messaging = await mf.unsafeGetDurableObjectStorage(name, 'MessagingHub', { name: 'accounts-v1' });
  relay = await mf.unsafeGetDurableObjectStorage(name, 'RelayHub', { name: 'relay-v2' });
}

async function snapshot() {
  return {
    users: await messaging.exec('SELECT * FROM im_users ORDER BY id'),
    allocator: await messaging.exec('SELECT * FROM im_uid_allocator'),
    crypto: await messaging.exec('SELECT * FROM im_account_crypto ORDER BY user_id'),
    item: await messaging.exec('SELECT * FROM im_vault_items WHERE id=?', vaultItemId),
    session: await messaging.exec(
      'SELECT * FROM im_sessions WHERE hash=?',
      digest(legacyToken).toString('hex'),
    ),
    messages: await messaging.exec('SELECT * FROM im_messages WHERE id=?', messageId),
    contacts: await messaging.exec('SELECT * FROM im_contacts ORDER BY user_id,contact_id'),
    members: await messaging.exec('SELECT * FROM im_members ORDER BY user_id'),
    desktops: await relay.exec('SELECT * FROM desktop_enrollments'),
    hosts: await relay.exec('SELECT * FROM hosts'),
  };
}

beforeAll(async () => {
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'assets/index.html'), 'isolated upgrade');
  execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'deploy',
      '--dry-run',
      '--outdir',
      join(directory, 'worker'),
      '--assets',
      join(directory, 'assets'),
    ],
    { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe' },
  );
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Domain RP IDs are required for passkeys; Miniflare still binds only loopback.
  origin = `http://localhost:${port}`;
  mf = new Miniflare(options(true, false));
  await mf.ready;
  messaging = await mf.unsafeGetDurableObjectStorage(name, 'MessagingHub', { name: 'accounts-v1' });
  relay = await mf.unsafeGetDurableObjectStorage(name, 'RelayHub', { name: 'relay-v2' });
  await messaging.exec(readFileSync(new URL('./fixtures/pre-trusted-schema.sql', import.meta.url), 'utf8'));
  owner = await protectAccount(password);
  const agent = await protectAccount('isolated-legacy-agent-password');
  hostId = (await createIdentity()).peerId;
  const now = Date.now();
  const hashed = (auth: string) => {
    const salt = randomBytes(16).toString('hex');
    return `${salt}:${scryptSync(auth, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
  };
  for (const [id, kind, user, protectedAccount] of [
    [ownerId, 'human', username, owner],
    [agentId, 'agent', 'legacy-upgrade-agent', agent],
  ] as const) {
    await messaging.exec(
      'INSERT INTO im_users VALUES (?,?,?,?,?,?,?)',
      id,
      kind,
      user,
      user,
      hashed(protectedAccount.auth),
      kind === 'agent' ? ownerId : null,
      now - 86400000,
    );
    await messaging.exec(
      'INSERT INTO im_account_crypto VALUES (?,?,?,7)',
      id,
      JSON.stringify(protectedAccount.vault),
      hashed(protectedAccount.recoveryAuth),
    );
  }
  await messaging.exec("UPDATE im_uid_allocator SET last_uid=? WHERE name='user'", agentId);
  await messaging.exec(
    'INSERT INTO im_sessions VALUES (?,?,?)',
    digest(legacyToken).toString('hex'),
    ownerId,
    now + 86400000,
  );
  vaultItemId = await privateId(owner.secrets, vaultName);
  const ciphertext = await sealPrivate(owner.secrets, `vault:${ownerId}:${vaultItemId}`, vaultValue);
  await messaging.exec(
    'INSERT INTO im_vault_items VALUES (?,?,4,?)',
    ownerId,
    vaultItemId,
    JSON.stringify(ciphertext),
  );
  await messaging.exec('INSERT INTO im_contacts VALUES (?,?,?,0)', ownerId, agentId, 'Existing agent');
  await messaging.exec(
    "INSERT INTO im_conversations VALUES (?,?,?,'direct','',NULL,0)",
    cid,
    ownerId,
    agentId,
  );
  for (const id of [ownerId, agentId]) await messaging.exec('INSERT INTO im_members VALUES (?,?,0)', cid, id);
  const encrypted = await encryptFor(
    owner.secrets,
    ownerId,
    { [ownerId]: owner.vault.publicKeys, [agentId]: agent.vault.publicKeys },
    `message:${cid}:${clientId}:0`,
    { text: messageText, options: {}, state: 'complete', request: { text: messageText, options: {} } },
  );
  legacyCiphertext = encrypted;
  const envelope = parseEnvelope(encrypted);
  const fingerprint = digest(
    JSON.stringify({
      cid,
      text: { encrypted: envelope.operation, sender: envelope.sender, context: envelope.context },
      state: 'complete',
      attachmentIds: [],
      mentions: [],
      replyTo: null,
    }),
  ).toString('hex');
  await messaging.exec(
    `INSERT INTO im_messages
    (id,conversation_id,sender_id,client_id,text,created_at,updated_at,request_fingerprint)
    VALUES (?,?,?,?,?,?,?,?)`,
    messageId,
    cid,
    ownerId,
    clientId,
    encrypted,
    now - 86400000,
    now - 86400000,
    fingerprint,
  );
  await messaging.exec(
    'INSERT INTO im_events(user_id,type,conversation_id,message_id) VALUES (?,?,?,?)',
    ownerId,
    'message',
    cid,
    messageId,
  );
  await relay.exec(`
    CREATE TABLE hosts(id TEXT PRIMARY KEY,created INTEGER NOT NULL);
    CREATE TABLE routes(host TEXT NOT NULL,ticket TEXT NOT NULL,expires INTEGER NOT NULL,peer TEXT,PRIMARY KEY(host,ticket));
    CREATE TABLE sources(ip TEXT PRIMARY KEY,attempts INTEGER NOT NULL,failures INTEGER NOT NULL,reset INTEGER NOT NULL);
    CREATE TABLE desktop_enrollments(host TEXT PRIMARY KEY,account TEXT NOT NULL,name TEXT NOT NULL,ticket TEXT NOT NULL,issued INTEGER NOT NULL,revoked INTEGER);
    CREATE INDEX desktop_enrollments_owner ON desktop_enrollments(account);
  `);
  await relay.exec('INSERT INTO hosts VALUES (?,?)', hostId, now - 86400000);
  await relay.exec(
    'INSERT INTO desktop_enrollments VALUES (?,?,?,?,?,NULL)',
    hostId,
    ownerId,
    'Existing adapter',
    'a'.repeat(64),
    now - 86400000,
  );
  expected = await snapshot();
});
afterAll(async () => {
  await mf?.dispose();
  rmSync(directory, { recursive: true, force: true });
});

it('upgrades populated pre-trusted DO databases without replacing identities, vaults, sessions, desktops or messages', async () => {
  expect(
    await messaging.exec(
      "SELECT name FROM sqlite_master WHERE name LIKE 'im_trusted_%' OR name='im_account_totp'",
    ),
  ).toEqual([]);
  // Missing key fails closed for new logins while the original valid session and data remain usable.
  await upgradeWorker(false);
  const existing = session(legacyToken);
  expect(await existing.request('/me')).toMatchObject({ user: { id: ownerId, username, encrypted: true } });
  expect(existing.cookie()).toBe(`pocket_im_session=${legacyToken}`);
  expect(await existing.request('/crypto/trusted')).toMatchObject({
    available: true,
    required: true,
    hasCredentials: false,
    passkeyAvailable: true,
    totpAvailable: false,
    totpEnabled: false,
    devices: [],
  });
  await expect(existing.request('/crypto/totp/display', 'POST', {})).rejects.toMatchObject({ status: 503 });
  await expect(
    existing.request('/crypto/trusted/enroll/options', 'POST', {
      name: 'Missing-key fixture',
      auth: owner.auth,
    }),
  ).rejects.toMatchObject({ status: 503 });
  const passwordLogin = session();
  await expect(passwordLogin.account.login(username, password)).rejects.toMatchObject({ status: 503 });
  expect(passwordLogin.cookie()).toBe('');
  expect(passwordLogin.account.user).toBeUndefined();
  expect(passwordLogin.account.secrets).toBeUndefined();
  await expect(passwordLogin.request('/crypto/account')).rejects.toMatchObject({ status: 401 });
  expect(await existing.request('/desktop-devices')).toEqual({
    devices: [{ hostId, name: 'Existing adapter' }],
  });
  expect(await snapshot()).toEqual(expected);

  // Adding the service key creates the human's code without registering a passkey or logging them out.
  await upgradeWorker(true);
  const trusted = session(legacyToken);
  expect(await trusted.request('/crypto/trusted')).toMatchObject({
    required: true,
    hasCredentials: false,
    totpAvailable: true,
    totpEnabled: true,
    devices: [],
  });
  const pending = session();
  let challenge: TrustedLoginRequired['request'] | undefined;
  try {
    // Omitting the optional trusted flag must not allow a password-only session.
    await pending.account.login(username, password);
    throw Error('Dynamic code challenge missing');
  } catch (error) {
    expect(error).toBeInstanceOf(TrustedLoginRequired);
    challenge = (error as TrustedLoginRequired).request;
  }
  expect(pending.cookie()).toBe('');
  expect(pending.account.secrets).toBeUndefined();
  await expect(pending.request('/crypto/totp/display', 'POST', {})).rejects.toMatchObject({ status: 401 });
  await expect(pending.request('/crypto/account')).rejects.toMatchObject({ status: 401 });
  const { code, expiresAt } = await trusted.request<{ code: string; expiresAt: number }>(
    '/crypto/totp/display',
    'POST',
    {},
  );
  expect(code).toMatch(/^\d{6}$/);
  expect(expiresAt % 30000).toBe(0);
  expect(trusted.cookie()).toBe(`pocket_im_session=${legacyToken}`);
  await pending.account.completeTrustedLogin(challenge!, code, password);
  expect(pending.account.user!.id).toBe(ownerId);
  expect(pending.account.revision).toBe(7);
  expect(pending.account.secrets!.root).toBe(owner.secrets.root);
  expect(await pending.account.readItem(vaultName)).toEqual(vaultValue);
  expect((await pending.client().history(cid)).messages[0]).toMatchObject({
    id: messageId,
    text: messageText,
  });
  expect(
    await pending.request(`/conversations/${cid}/messages`, 'POST', { clientId, text: legacyCiphertext }),
  ).toMatchObject({ message: { id: messageId } });
  const repeat = session();
  const next = await repeat.request<any>('/crypto/login', 'POST', {
    identifier: username,
    auth: owner.auth,
    trusted: true,
  });
  expect(next.vault).toBeUndefined();
  await expect(
    repeat.request('/crypto/login/code', 'POST', {
      id: next.trustedLogin.id,
      claim: next.trustedLogin.claim,
      code,
    }),
  ).rejects.toMatchObject({ status: 401 });
  expect(repeat.cookie()).toBe('');

  // Both QR directions use the existing full session and encrypted handoff, before any passkey exists.
  const approveQr = async (id: string, publicKey: JsonWebKey) =>
    trusted.request('/crypto/qr/approve', 'POST', {
      id,
      envelope: await sealTrustedLoginRoot(owner.secrets, {
        origin,
        requestId: id,
        accountId: ownerId,
        recipientPublicKey: publicKey,
      }),
    });
  const qrDevice = session();
  const handle = await qrDevice.account.startQrLogin(username, 'Upgraded QR device');
  expect(await qrDevice.account.checkQrLogin(handle, origin)).toEqual({ pending: true });
  expect(qrDevice.cookie()).toBe('');
  await approveQr(handle.id, handle.key.publicKey);
  await qrDevice.account.checkQrLogin(handle, origin);
  expect(qrDevice.account.user!.id).toBe(ownerId);
  expect(qrDevice.account.secrets!.root).toBe(owner.secrets.root);
  expect(await qrDevice.account.readItem(vaultName)).toEqual(vaultValue);
  expect((await qrDevice.client().history(cid)).messages[0].text).toBe(messageText);
  await expect(qrDevice.account.checkQrLogin(handle, origin)).rejects.toMatchObject({ status: 404 });
  const invitation = await trusted.request<{ id: string; secret: string }>('/crypto/qr/invite', 'POST', {});
  const invited = session();
  const invitedHandle = await invited.account.claimQrInvitation(
    invitation.id,
    invitation.secret,
    'Invited upgraded device',
  );
  await expect(pending.request(`/crypto/qr/${invitedHandle.id}`)).rejects.toMatchObject({ status: 404 });
  expect(invited.cookie()).toBe('');
  await approveQr(invitedHandle.id, invitedHandle.key.publicKey);
  await invited.account.checkQrLogin(invitedHandle, origin);
  expect(invited.account.secrets!.root).toBe(owner.secrets.root);
  expect(await invited.account.readItem(vaultName)).toEqual(vaultValue);
  expect(await trusted.request('/crypto/trusted')).toMatchObject({ hasCredentials: false, devices: [] });

  // Seed export remains a separate operation that requires a fresh, independently signed passkey assertion.
  await expect(
    trusted.request('/crypto/trusted/verify/options', 'POST', { action: 'totp-provision' }),
  ).rejects.toMatchObject({ status: 403 });
  const passkey = authenticator();
  const registration = await trusted.request<{
    id: string;
    options: { challenge: string; user: { id: string } };
  }>('/crypto/trusted/enroll/options', 'POST', { name: 'Upgraded trusted device', auth: owner.auth });
  expect(Buffer.from(registration.options.user.id, 'base64url').toString()).toBe(ownerId);
  const attestation = passkey.register(registration.options.challenge);
  await trusted.request('/crypto/trusted/enroll', 'POST', { id: registration.id, response: attestation });
  await expect(
    trusted.request('/crypto/trusted/enroll', 'POST', { id: registration.id, response: attestation }),
  ).rejects.toMatchObject({ status: 404 });
  const approve = async (action: string) => {
    const ceremony = await trusted.request<{ id: string; options: { challenge: string } }>(
      '/crypto/trusted/verify/options',
      'POST',
      { action },
    );
    return trusted.request<any>('/crypto/trusted/verify', 'POST', {
      id: ceremony.id,
      response: passkey.authenticate(ceremony.options.challenge),
    });
  };
  const provisioning = await approve('totp-provision');
  const uri = new URL(provisioning.uri);
  expect(uri.protocol).toBe('otpauth:');
  expect(uri.searchParams.get('digits')).toBe('6');
  expect(uri.searchParams.get('period')).toBe('30');
  expect(uri.searchParams.get('secret')).toBe(provisioning.secret);
  const recovered = session();
  await recovered.account.login(username, owner.recoveryCode, true);
  expect(recovered.account.user!.id).toBe(ownerId);
  expect(recovered.account.secrets!.root).toBe(owner.secrets.root);
  expect(await recovered.account.readItem(vaultName)).toEqual(vaultValue);
  expect(await snapshot()).toEqual(expected);

  // Rehydrating the upgraded object keeps the original session, seed, credential counters and account bytes.
  const totp = await messaging.exec('SELECT * FROM im_account_totp');
  const credentials = await messaging.exec('SELECT * FROM im_trusted_credentials');
  expect(totp).toHaveLength(1);
  expect(credentials).toHaveLength(1);
  await mf.unsafeEvictDurableObject(name, 'MessagingHub', { name: 'accounts-v1' });
  expect(await trusted.request('/crypto/trusted')).toMatchObject({
    required: true,
    totpEnabled: true,
    hasCredentials: true,
  });
  expect(await messaging.exec('SELECT * FROM im_account_totp')).toEqual(totp);
  expect(await messaging.exec('SELECT * FROM im_trusted_credentials')).toEqual(credentials);
  expect((await trusted.request<{ code: string }>('/crypto/totp/display', 'POST', {})).code).toMatch(
    /^\d{6}$/,
  );
  expect(await snapshot()).toEqual(expected);
  expect((await unlockAccount(owner.vault, password)).secrets.root).toBe(owner.secrets.root);
}, 60000);
