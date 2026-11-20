import { desktopAuthorizationContract, relayContract } from '../contracts/relay.js';
import { desktopBackupContract } from '../contracts/desktop-backup.js';
import { anonymousAccessContract } from '../contracts/anonymous-access.js';
import { unboundQrContract } from '../contracts/unbound-qr.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import sharp from 'sharp';
import { AccountClient, TrustedLoginRequired } from '../../src/client/account.js';
import { EncryptedMessagingClient } from '../../src/client/encrypted-messaging.js';
import { createIdentity, identityKey, base64, type Identity } from '../../src/shared/secure-channel.js';
import { hostProof, relayFrame, type RelayRoute } from '../../src/shared/relay-protocol.js';
import { desktopAuthorizationProof } from '../../src/shared/desktop-authorization.js';
import { nodeSession } from '../../src/client/node-session.js';
import { HostService } from '../../src/server/host-service.js';
import { Store } from '../../src/server/store.js';
import { BackendRegistry } from '../../src/server/backends/registry.js';
import { CodexBackend } from '../../packages/adapter-codex/src/backend.js';
import { DesktopAdapter } from '../../packages/adapter-codex/src/desktop.js';
import { HistoryIndex } from '../../packages/adapter-codex/src/history.js';
import { fixtureConfig, historyFixture, FakeTransport, THREAD } from '../helpers.js';
import { temporaryRuntime } from '../temporary-runtime.js';
import { apiCall } from '../../src/shared/rpc.js';

let mf: Miniflare, origin: string, previousOrigin: string;
anonymousAccessContract((path, init) => fetch(`${origin}/api/im${path}`, init));
unboundQrContract(async () => ({ origin, session }));
const enrollment = 'isolated-cloudflare-test-enrollment-32';
const sockets: WebSocket[] = [];
const translationRequests: unknown[] = [];
beforeAll(async () => {
  mkdirSync('.implementation/cloudflare-test/assets', { recursive: true });
  writeFileSync('.implementation/cloudflare-test/assets/index.html', '<html>isolated test</html>');
  execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'deploy',
      '--dry-run',
      '--outdir',
      '.implementation/cloudflare-test',
      '--assets',
      '.implementation/cloudflare-test/assets',
    ],
    { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe' },
  );
  const portServer = createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  previousOrigin = `http://localhost:${port}`;
  const options = {
    ...convertV4MiniflareOptions({
      name: 'pocket-test',
      modules: true,
      scriptPath: '.implementation/cloudflare-test/index.js',
      compatibilityDate: '2026-11-04',
      compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
      host: '127.0.0.1',
      port,
      bindings: {
        POCKET_PUBLIC_ORIGIN: origin,
        POCKET_ORIGIN_ALIASES: previousOrigin,
        POCKET_IM_IDENTITY_ORIGIN: previousOrigin,
        POCKET_RELAY_ENROLLMENT: enrollment,
        POCKET_IM_HUMAN_CONTACTS: 'true',
        POCKET_IM_TOTP_KEY: Buffer.alloc(32, 42).toString('base64url'),
        POCKET_TRANSLATION_URL: 'https://translate.test/translate',
      },
      durableObjects: {
        RELAY: { className: 'RelayHub', useSQLite: true },
        MESSAGING: { className: 'MessagingHub', useSQLite: true },
      },
      r2Buckets: ['IM_MEDIA'],
      images: { binding: 'IMAGES' },
      outboundService: async (request: Request) => {
        if (request.url !== 'https://translate.test/translate' || request.method !== 'POST')
          return new Response(null, { status: 404 });
        translationRequests.push(await request.json());
        return Response.json({ translatedText: '测试译文' });
      },
      serviceBindings: {
        ASSETS: async (request) =>
          new Response('<html>test application</html>', {
            headers: {
              'Content-Type':
                new URL(request.url).pathname === '/assets/test.js' ? 'text/javascript' : 'text/html',
            },
          }),
      },
    }),
    unsafeInspectDurableObjects: true,
  };
  // Workerd's local HTTP socket does not deliver peer disconnects as Request.signal.
  // Supply the edge abort through a service binding to exercise both Worker and DO cleanup.
  const cancellation = convertV4MiniflareOptions({
    name: 'sync-cancellation-driver',
    modules: true,
    compatibilityDate: '2026-11-04',
    compatibilityFlags: ['enable_request_signal'],
    serviceBindings: { APP: 'pocket-test' },
    script: `export default {
      async fetch(request, env) {
        const client = new AbortController();
        const timer = setTimeout(() => client.abort(), 1500);
        try {
          return await env.APP.fetch(request, { signal: client.signal });
        } catch (error) {
          if (!client.signal.aborted) throw error;
          return new Response(null, { status: 499 });
        } finally {
          clearTimeout(timer);
        }
      }
    };`,
  });
  mf = new Miniflare({
    ...options,
    workers: [...options.workers, ...cancellation.workers],
  });
  await mf.ready;
});
afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await mf?.dispose();
});

let fixtureClient = 0;
function session(site = origin) {
  // Independent synthetic devices must not share the production per-IP authentication quota.
  const address = `192.0.2.${++fixtureClient}`;
  let cookie = '';
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`${site}/api/im${path}`, {
      method,
      headers: {
        Origin: site,
        Cookie: cookie,
        'CF-Connecting-IP': address,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
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
    account,
    request,
    client() {
      const client = new EncryptedMessagingClient(site, cookie.split('=')[1]);
      client.account.activate(account.user!, account.secrets!, account.vault, account.revision);
      return client;
    },
    cookie: () => cookie,
  };
}

/** Only the account's existing registration session may supply the real second factor. */
async function loginFromRegisteredSession(
  target: ReturnType<typeof session>,
  registered: ReturnType<typeof session>,
  identifier: string,
  password: string,
) {
  let challenge: TrustedLoginRequired['request'] | undefined;
  try {
    await target.account.login(identifier, password, false, { trusted: true });
    throw Error('Password-only login unexpectedly completed');
  } catch (error) {
    expect(error).toBeInstanceOf(TrustedLoginRequired);
    challenge = (error as TrustedLoginRequired).request;
  }
  expect(target.cookie()).toBe('');
  expect(target.account.secrets).toBeUndefined();
  await expect(target.request('/crypto/totp/display', 'POST', {})).rejects.toMatchObject({ status: 401 });
  const { code } = await registered.request<{ code: string }>('/crypto/totp/display', 'POST', {});
  expect(code).toMatch(/^\d{6}$/);
  await target.account.completeTrustedLogin(challenge!, code, password);
}
function connect(auth: (challenge: string) => object | Promise<object>, site = origin) {
  const ws = new WebSocket(`${site.replace('http:', 'ws:')}/connect`, {
    headers: { Origin: site },
    family: 4,
  });
  sockets.push(ws);
  return new Promise<WebSocket>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('close', (code) => reject(Error(`Closed ${code}`)));
    ws.on('message', (raw, binary) => {
      if (binary) return;
      const value = JSON.parse(raw.toString());
      if (value.type === 'challenge')
        void Promise.resolve(auth(value.challenge))
          .then((message) => ws.send(JSON.stringify(message)))
          .catch(reject);
      if (value.type === 'registered' || value.type === 'joined') resolve(ws);
    });
  });
}
async function host(
  identity: Identity,
  lane: 'control' | 'bulk' = 'control',
  secret = enrollment,
  site = origin,
) {
  return connect(
    async (challenge) => ({
      type: 'host',
      hostId: identity.peerId,
      lane,
      signature: base64(await identityKey(identity).sign(hostProof(challenge, identity.peerId, lane))),
      enrollment: secret,
    }),
    site,
  );
}

it('serves the same health, API isolation and static cache/security headers', async () => {
  const health = await fetch(`${origin}/health`);
  expect(await health.json()).toEqual({ ok: true, protocol: 2 });
  expect(health.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect((await fetch(`${origin}/version.json`)).headers.get('Cache-Control')).toBe('no-cache');
  expect((await fetch(`${origin}/assets/test.js`)).headers.get('Cache-Control')).toContain('immutable');
  expect((await fetch(`${origin}/assets/missing.js`)).headers.get('Cache-Control')).toBe('no-cache');
  expect((await fetch(`${origin}/api/not-found`)).status).toBe(404);
  expect((await fetch(`${origin}/api/im/me`, { headers: { Origin: 'https://evil.test' } })).status).toBe(403);
  expect(
    (
      await fetch(`${origin}/api/im/crypto/parameters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'x'.repeat(5000) }),
      })
    ).status,
  ).toBe(413);
  expect(
    (
      await fetch(`${origin}/api/im/crypto/parameters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
    ).status,
  ).toBe(400);
});

it('uses the existing account, encrypted messaging, recovery and R2 attachment protocols', async () => {
  const a = session(previousOrigin),
    b = session(),
    outsider = session();
  await a.account.register('alice', 'Alice', 'strong-password-alice');
  await b.account.register('bob', 'Bob', 'strong-password-bob');
  await outsider.account.register('eve', 'Eve', 'strong-password-eve');
  await a.account.writeItem('host:fixture', { private: 'pairing-secret-marker' });
  const alice = a.client(),
    bob = b.client();
  const csrf = await fetch(`${origin}/api/im/me`, {
    method: 'PATCH',
    headers: { Cookie: a.cookie(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'forbidden' }),
  });
  expect(csrf.status).toBe(403);
  await alice.addContact(b.account.user!.id);
  const { conversation } = await alice.direct(b.account.user!.id),
    cid = conversation.id;
  const sent = await alice.send(cid, 'encrypted-test-marker', 'stable-message');
  expect((await alice.send(cid, 'encrypted-test-marker', 'stable-message')).message.id).toBe(sent.message.id);
  expect((await bob.history(cid)).messages[0].text).toBe('encrypted-test-marker');
  const { cursor } = await bob.sync(0, 0);
  const pending = bob.sync(cursor, 5000);
  await alice.send(cid, 'wake-long-poll', 'long-poll-message');
  expect((await pending).events.some((event) => event.type === 'message')).toBe(true);
  // Larger than a DO SQL row: ciphertext must go straight to R2, without transient BLOB storage.
  const data = new Uint8Array(9 * 1024 * 1024).fill(97);
  const uploaded = await alice.upload(cid, 'private-large.txt', new Blob([data]));
  await alice.send(cid, '', 'attachment-message', { attachmentIds: [uploaded.file.id] });
  const file = (await bob.history(cid)).messages.at(-1)!.attachments[0];
  const downloaded = await bob.download(file.url);
  expect(createHash('sha256').update(new Uint8Array(downloaded.data)).digest('hex')).toBe(
    createHash('sha256').update(data).digest('hex'),
  );
  const denied = await fetch(new URL(file.url, origin), { headers: { Cookie: outsider.cookie() } });
  expect(denied.status).toBe(404);
  const storage = await mf.unsafeGetDurableObjectStorage('pocket-test', 'MessagingHub', {
    name: 'accounts-v1',
  });
  const rows = await storage.exec('SELECT text FROM im_messages');
  expect(JSON.stringify(rows)).not.toContain('encrypted-test-marker');
  expect((await storage.exec('SELECT length(data) AS n FROM im_files'))[0].n).toBe(0);
  expect((await (await mf.getR2Bucket('IM_MEDIA')).list()).objects).toHaveLength(1);
  await mf.unsafeEvictDurableObject('pocket-test', 'MessagingHub', { name: 'accounts-v1' });
  const fresh = session();
  const address = `${a.account.user!.id}@${new URL(previousOrigin).host}`;
  expect(a.account.user!.address).toBe(address);
  await loginFromRegisteredSession(fresh, a, address, 'strong-password-alice');
  expect(fresh.account.user).toMatchObject({ id: a.account.user!.id, address });
  expect(fresh.account.secrets!.root).toBe(a.account.secrets!.root);
  expect(await fresh.account.readItem('host:fixture')).toEqual({ private: 'pairing-secret-marker' });
  expect((await fresh.client().history(cid)).messages[0].text).toBe('encrypted-test-marker');
  const recovered = session();
  await recovered.account.login('alice', a.account.recoveryCode, true);
  expect(recovered.account.secrets!.root).toBe(a.account.secrets!.root);
  // No HTTP request wakes the message hub: a persisted alarm must expire this card.
  const card = await fresh.client().send(cid, '', 'expiry-card', {
    interaction: {
      kind: 'approval',
      recipientId: b.account.user!.id,
      title: 'Test approval',
      description: 'Fixture',
      expiresAt: Date.now() + 2000,
    },
  });
  await mf.unsafeEvictDurableObject('pocket-test', 'MessagingHub', { name: 'accounts-v1' });
  await expect
    .poll(
      async () =>
        (await storage.exec('SELECT status FROM im_message_features WHERE message_id=?', card.message.id))[0]
          .status,
      { timeout: 10000 },
    )
    .toBe('expired');
});

it('releases a sync slot when a client cancels its long poll', async () => {
  const client = session();
  await client.account.register('cancel-sync', 'Sync fixture', 'isolated-sync-password');
  const { cursor } = await client.request<{ cursor: number }>('/sync?cursor=0&wait=0');
  const sync = async (wait: number, signal?: AbortSignal) => {
    const response = await fetch(`${origin}/api/im/sync?cursor=${cursor}&wait=${wait}`, {
      headers: { Origin: origin, Cookie: client.cookie() },
      signal,
    });
    await response.text();
    return response.status;
  };
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map(({ signal }) => sync(10_000, signal).catch((error: unknown) => error));
  try {
    const driver = await mf.getWorker('sync-cancellation-driver');
    const canceled = driver.fetch(`${origin}/api/im/sync?cursor=${cursor}&wait=10000`, {
      headers: { Origin: origin, Cookie: client.cookie(), 'CF-Connecting-IP': '127.0.0.1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await sync(25)).toBe(429);
    expect((await canceled).status).toBe(499);
    await expect.poll(() => sync(25), { timeout: 2000 }).toBe(200);
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.all(pending);
  }
});

it('binds initial Authenticator setup to the real registration session and confirms a standard external TOTP', async () => {
  const registered = session(),
    other = session(),
    anonymous = session();
  const created = await registered.account.register('setup-owner', 'Setup owner', 'isolated-setup-password');
  await other.account.register('setup-other', 'Other fixture', 'isolated-other-password');
  const setup = created.authenticatorSetup;
  expect(setup?.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(setup!.expiresAt).toBeGreaterThan(Date.now());
  expect(setup!.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  await expect(
    anonymous.request('/crypto/authenticator/setup', 'POST', { grant: setup!.grant }),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    other.request('/crypto/authenticator/setup', 'POST', { grant: setup!.grant }),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    (
      await fetch(`${origin}/api/im/crypto/authenticator/setup`, {
        method: 'POST',
        headers: {
          Origin: 'https://foreign.test',
          Cookie: registered.cookie(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ grant: setup!.grant }),
      })
    ).status,
  ).toBe(403);
  const provisioning = await registered.request<{ secret: string; uri: string }>(
    '/crypto/authenticator/setup',
    'POST',
    { grant: setup!.grant },
  );
  const uri = new URL(provisioning.uri);
  expect(uri.protocol).toBe('otpauth:');
  expect(uri.searchParams.get('digits')).toBe('6');
  expect(uri.searchParams.get('period')).toBe('30');
  expect(uri.searchParams.get('secret')).toBe(provisioning.secret);

  // Independently derive the RFC 6238 value from the seed shown to an external authenticator.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...provisioning.secret]
    .map((value) => alphabet.indexOf(value).toString(2).padStart(5, '0'))
    .join('');
  const seed = Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac('sha1', seed).update(counter).digest();
  const offset = mac.at(-1)! & 15;
  const code = String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
  expect(
    await registered.request('/crypto/authenticator/confirm', 'POST', { grant: setup!.grant, code }),
  ).toEqual({ ok: true });
  await expect(
    registered.request('/crypto/authenticator/setup', 'POST', { grant: setup!.grant }),
  ).rejects.toMatchObject({ status: 404 });
  expect(await registered.request('/crypto/trusted')).toMatchObject({
    required: true,
    totpEnabled: true,
    devices: [],
  });

  const skipped = await other.request<{ code: string }>('/crypto/totp/display', 'POST', {});
  expect(skipped.code).toMatch(/^\d{6}$/);
  expect(
    await other.request('/crypto/authenticator/cancel', 'POST', {
      grant: other.account.authenticatorSetup!.grant,
    }),
  ).toEqual({ ok: true });
  expect((await other.request<{ code: string }>('/crypto/totp/display', 'POST', {})).code).toMatch(/^\d{6}$/);
});

it('keeps both hostnames available while requiring origin-matched desktop authorization', async () => {
  const legacy = session(previousOrigin),
    current = session();
  const password = 'strong-migration-password';
  const { user } = await legacy.account.register('migrationuser', 'Migrating user', password);
  await loginFromRegisteredSession(current, legacy, user.address, password);

  expect(await (await fetch(`${previousOrigin}/health`)).json()).toEqual({ ok: true, protocol: 2 });
  expect((await fetch(`${previousOrigin}/?page=downloads`)).status).toBe(200);
  expect((await mf.dispatchFetch('https://foreign.example/health')).status).toBe(403);
  for (const [site, other] of [
    [origin, previousOrigin],
    [previousOrigin, origin],
  ]) {
    expect((await fetch(`${site}/api/im/me`, { headers: { Origin: other } })).status).toBe(403);
    expect((await fetch(`${site}/connect`, { headers: { Origin: other } })).status).toBe(403);
  }

  const identity = await createIdentity();
  const key = identityKey(identity);
  const intent = {
    hostId: identity.peerId,
    name: 'Existing computer',
    ticket: 'a'.repeat(64),
    issuedAt: Date.now(),
  };
  const data = {
    accountId: user.id,
    authorization: {
      ...intent,
      signature: base64(await key.sign(desktopAuthorizationProof(previousOrigin, intent))),
    },
  };
  await expect(current.request('/desktop-devices/approve', 'POST', data)).rejects.toMatchObject({
    status: 400,
  });
  await expect(legacy.request('/desktop-devices/approve', 'POST', data)).resolves.toEqual({ ok: true });
  await expect(current.request('/desktop-devices')).resolves.toEqual({
    devices: [{ hostId: intent.hostId, name: intent.name }],
  });
  const manifestPath = '/downloads/desktop/native/rust/linux/x64-musl/latest.json';
  const objectKey = 'desktop-releases/native/rust/linux/x64-musl/latest.json';
  const bucket = await mf.getR2Bucket('IM_MEDIA');
  const manifest = { fixture: 'existing manifest' };
  await bucket.put(objectKey, JSON.stringify(manifest));
  try {
    for (const site of [previousOrigin, origin]) {
      expect(await (await fetch(`${site}${manifestPath}`)).json()).toEqual(manifest);
    }
  } finally {
    await bucket.delete(objectKey);
  }
});

it('translates a signed-in user’s selection through the configured Worker provider', async () => {
  const reader = session();
  await reader.account.register('translation-reader', 'Reader', 'strong-password-reader');
  expect(await reader.request('/translation')).toEqual({ available: true });
  expect(translationRequests).toEqual([]);
  expect(
    await reader.request('/translation', 'POST', { text: ' Selected text ', targetLanguage: 'zh' }),
  ).toEqual({ translatedText: '测试译文' });
  expect(translationRequests).toEqual([{ q: 'Selected text', source: 'auto', target: 'zh', format: 'text' }]);
});

it('processes avatars through the Images binding with authenticated download', async () => {
  const a = session();
  await a.account.register('avataruser', 'Avatar', 'strong-avatar-password');
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#aa77cc' } })
    .png()
    .toBuffer();
  const result = await fetch(`${origin}/api/im/me/avatar`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: a.cookie(), 'Content-Type': 'application/octet-stream' },
    body: png,
  });
  expect(result.status, await result.clone().text()).toBe(200);
  const { user } = (await result.json()) as any;
  const image = await fetch(new URL(user.avatarUrl, origin), { headers: { Cookie: a.cookie() } });
  expect(image.status).toBe(200);
  expect(await sharp(Buffer.from(await image.arrayBuffer())).metadata()).toMatchObject({
    format: 'webp',
    width: 256,
    height: 256,
  });
});

it('retains v2 host authentication, routes and both lanes through hibernation', async () => {
  const identity = await createIdentity(),
    ticket = 'a'.repeat(32);
  const control = await host(identity, 'control', enrollment, previousOrigin),
    bulk = await host(identity, 'bulk', enrollment, previousOrigin);
  const routes: RelayRoute[] = [{ ticket, expires: Date.now() + 60000 }];
  control.send(JSON.stringify({ type: 'routes', routes }));
  const joined = once(control, 'message');
  const client = await connect(() => ({ type: 'join', hostId: identity.peerId, lane: 'control', ticket }));
  const [join] = await joined,
    id = JSON.parse(join.toString()).id;
  let received = once(control, 'message');
  client.send(Buffer.from('opaque-ciphertext'));
  expect((await received)[0].subarray(36).toString()).toBe('opaque-ciphertext');
  await mf.unsafeEvictDurableObject('pocket-test', 'RelayHub', { name: 'relay-v2', webSockets: 'hibernate' });
  received = once(client, 'message');
  control.send(relayFrame(id, Buffer.from('after-hibernation')));
  expect((await received)[0].toString()).toBe('after-hibernation');
  const bulkJoin = once(bulk, 'message');
  const bulkClient = await connect(() => ({ type: 'join', hostId: identity.peerId, lane: 'bulk', ticket }));
  const bulkId = JSON.parse((await bulkJoin)[0].toString()).id;
  received = once(bulkClient, 'message');
  bulk.send(relayFrame(bulkId, Buffer.alloc(65536, 3)));
  expect((await received)[0].length).toBe(65536);
  await expect(host(await createIdentity(), 'control', 'wrong-secret')).rejects.toThrow('1008');
  // Registered identities reconnect without re-enrollment, exactly as on the VPS.
  const replacement = await host(identity, 'control', '');
  replacement.close();
  bulk.close();
  client.close();
  bulkClient.close();
});

it('pairs the unchanged Gateway and client, resumes encrypted RPC, and keeps bulk separate', async () => {
  const config = fixtureConfig();
  historyFixture(config);
  config.origin = origin;
  config.p2p = { enabled: false, stunUrls: [] };
  config.relay = { origin, enrollment };
  const store = new Store(config.stateDir, temporaryRuntime),
    transport = new FakeTransport();
  const registry = new BackendRegistry().register(
    new CodexBackend(config, new DesktopAdapter(config, () => transport), new HistoryIndex(config.codexHome)),
  );
  const identity = await createIdentity(),
    phone = await createIdentity(),
    sessionId = crypto.randomUUID();
  const gateway = new HostService(config, identity, { store, registry });
  const pairing = store.mintPairing();
  const links: Awaited<ReturnType<typeof nodeSession>>[] = [];
  try {
    await registry.start();
    gateway.start();
    const link = await nodeSession(
      origin,
      identity.peerId,
      phone,
      createHash('sha256').update(pairing.code).digest('hex'),
      { type: 'pair', protocol: 2, sessionId, code: pairing.code, name: 'CF fixture' },
    );
    links.push(link);
    const ready = await link.ready;
    expect((await link.rpc<{ total: number }>(apiCall('/projects'))).total).toBe(1);
    const bulk = await nodeSession(
      origin,
      identity.peerId,
      phone,
      ready.ticket,
      { type: 'authenticate', protocol: 2, sessionId },
      'bulk',
    );
    links.push(bulk);
    const requestId = crypto.randomUUID(),
      call = apiCall(`/threads/${THREAD}/messages`, 'POST', { requestId, text: 'cf-single-delivery' });
    await link.rpc(call);
    await expect.poll(() => store.operation(requestId)?.state).toBe('accepted');
    const count = transport.calls.length;
    await mf.unsafeEvictDurableObject('pocket-test', 'RelayHub', {
      name: 'relay-v2',
      webSockets: 'hibernate',
    });
    await link.rpc(call);
    expect(transport.calls).toHaveLength(count);
    expect((await bulk.request('ping')).value).toEqual({ ok: true });
    link.close();
    const resumed = await nodeSession(origin, identity.peerId, phone, ready.ticket, {
      type: 'authenticate',
      protocol: 2,
      sessionId,
    });
    links.push(resumed);
    expect(await resumed.rpc(apiCall(`/operations/${requestId}`))).toMatchObject({ state: 'accepted' });
  } finally {
    for (const link of links) link.close();
    gateway.stop();
    registry.stop();
    store.close();
    rmSync(config.desktopRoot, { recursive: true, force: true });
  }
});

it('accepts more than eight sockets across rotated tickets, both lanes, and hibernation', async () => {
  const identity = await createIdentity(),
    peerId = (await createIdentity()).peerId;
  const control = await host(identity),
    bulk = await host(identity, 'bulk');
  const routes = ['q', 'r'].map((v) => ({ ticket: v.repeat(32), peerId, expires: Date.now() + 60000 }));
  control.send(JSON.stringify({ type: 'routes', routes }));
  const clients: WebSocket[] = [];
  for (let i = 0; i < 8; i++)
    clients.push(
      await connect(() => ({
        type: 'join',
        hostId: identity.peerId,
        lane: i % 2 ? 'bulk' : 'control',
        ticket: routes[i % 2].ticket,
      })),
    );
  await mf.unsafeEvictDurableObject('pocket-test', 'RelayHub', { name: 'relay-v2', webSockets: 'hibernate' });
  clients.push(
    await connect(() => ({ type: 'join', hostId: identity.peerId, lane: 'bulk', ticket: routes[1].ticket })),
  );
  const closed = once(clients[0], 'close');
  clients[0].close();
  await closed;
  clients.push(
    await connect(() => ({
      type: 'join',
      hostId: identity.peerId,
      lane: 'control',
      ticket: routes[0].ticket,
    })),
  );
  for (const client of clients) client.close();
  control.close();
  bulk.close();
});

it('keeps exact string UIDs and rolls back multi-table registration failures in DO SQLite', async () => {
  const storage = await mf.unsafeGetDurableObjectStorage('pocket-test', 'MessagingHub', {
    name: 'accounts-v1',
  });
  await storage.exec("UPDATE im_uid_allocator SET last_uid='9007199254740992' WHERE name='user'");
  const count = (await storage.exec('SELECT count(*) AS n FROM im_users'))[0].n;
  await storage.exec(
    "CREATE TRIGGER fixture_fail_vault BEFORE INSERT ON im_account_crypto BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END",
  );
  try {
    await expect(
      session().account.register('rollbackuser', 'Rollback', 'strong-rollback-password'),
    ).rejects.toMatchObject({ status: 500 });
    expect((await storage.exec('SELECT count(*) AS n FROM im_users'))[0].n).toBe(count);
    expect((await storage.exec("SELECT last_uid FROM im_uid_allocator WHERE name='user'"))[0].last_uid).toBe(
      '9007199254740992',
    );
  } finally {
    await storage.exec('DROP TRIGGER fixture_fail_vault');
  }
  const a = session();
  await a.account.register('largeuiduser', 'Large UID', 'strong-uid-password');
  expect(a.account.user!.id).toBe('9007199254740993');
});

relayContract(async () => ({ connect, enrollment }));

it('serves only the public desktop release prefix from R2, with resumable downloads', async () => {
  const bucket = await mf.getR2Bucket('IM_MEDIA');
  await bucket.put('desktop-releases/linux/x64/AgentSpace-0.4.0-linux-x64.AppImage', '0123456789');
  await bucket.put('private/hidden.png', 'not public');
  const response = await fetch(`${origin}/downloads/desktop/linux/x64/AgentSpace-0.4.0-linux-x64.AppImage`, {
    headers: { Range: 'bytes=3-6' },
  });
  expect(response.status).toBe(206);
  expect(response.headers.get('Content-Range')).toBe('bytes 3-6/10');
  expect(await response.text()).toBe('3456');
  expect((await fetch(`${origin}/downloads/desktop/private/hidden.png`)).status).toBe(404);
  expect((await fetch(`${origin}/downloads/desktop/releases.json`)).status).toBe(404);
});

desktopAuthorizationContract(async () => ({ origin, enrollment, connect, session }));

desktopBackupContract(async () => {
  const storage = await mf.unsafeGetDurableObjectStorage('pocket-test', 'MessagingHub', {
    name: 'accounts-v1',
  });
  return {
    origin,
    alias: previousOrigin,
    session() {
      const device = session();
      return {
        ...device,
        async raw(
          path: string,
          method: string,
          body: unknown,
          options?: { origin?: string | null; site?: string },
        ) {
          const response = await fetch(`${options?.site ?? origin}/api/im${path}`, {
            method,
            headers: {
              Cookie: device.cookie(),
              ...(options?.origin !== null ? { Origin: options?.origin ?? origin } : {}),
              'Content-Type': 'application/json',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          return {
            status: response.status,
            body: response.status === 204 ? undefined : await response.json(),
          };
        },
      };
    },
    async expire(capability) {
      await storage.exec(
        'UPDATE im_desktop_backup_grants SET expires_at=? WHERE hash=?',
        Date.now() - 1,
        createHash('sha256').update(capability).digest('hex'),
      );
    },
    async rows() {
      return storage.exec('SELECT * FROM im_desktop_backup_grants');
    },
  };
});
