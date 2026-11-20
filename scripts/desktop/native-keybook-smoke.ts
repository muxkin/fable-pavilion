/** Real Rust/Noise/local-management acceptance; all state and account material are disposable. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountClient } from '../../src/client/account.js';
import { nodeSession } from '../../src/client/node-session.js';
import { hostIdentity } from '../../src/server/device-identity.js';
import { platformRuntime } from '../../src/server/platform.js';
import { buildRelay } from '../../src/server/relay.js';
import { Store } from '../../src/server/store.js';
import { desktopAuthorizationProof } from '../../src/shared/desktop-authorization.js';
import { apiCall } from '../../src/shared/rpc.js';
import { base64, createIdentity, identityKey } from '../../src/shared/secure-channel.js';

const binary = resolve(process.argv[2] ?? 'desktop/native/target/release/agent-space-native');
const directory = await mkdtemp(join(tmpdir(), 'native-keybook-'));
const state = join(directory, 'state');
platformRuntime().privateDirectory(directory);
const host = await hostIdentity(state);
const phone = await createIdentity();
const pairing = new Store(state);
const paired = pairing.pair(pairing.mintPairing().code, 'Synthetic keybook phone', phone.peerId)!;
pairing.close();
assert(paired.routeTicket);
const identityBefore = await readFile(join(state, 'device-identity-v2.json'));
// Elevated Windows gives Node-created files the Administrators owner; normalize the fixture only.
if (process.platform === 'win32') platformRuntime().privateFile(join(state, 'device-identity-v2.json'));
const legacySettings = join(directory, 'empty-legacy.json');
await writeFile(legacySettings, '{}', { mode: 0o600 });
const emptyEnvironment = join(directory, 'empty.env');
await writeFile(emptyEnvironment, '', { mode: 0o600 });
platformRuntime().privateFile(legacySettings);
platformRuntime().privateFile(emptyEnvironment);
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = (probe.address() as { port: number }).port;
await new Promise<void>((done) => probe.close(() => done()));
const origin = `http://127.0.0.1:${port}`;
const enrollment = randomBytes(32).toString('hex');
const password = 'synthetic-keybook-account-password';
const passphrase = 'synthetic-local-keybook-passphrase';
const sensitive = new Set([password, passphrase, enrollment]);
let cookie = '';
const request: AccountClient['request'] = async <T>(path: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`${origin}/api/im${path}`, {
    method,
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const next = response.headers.get('Set-Cookie');
  if (next) {
    cookie = next.split(';')[0];
    sensitive.add(cookie);
  }
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(Error('Synthetic account request failed'), { status: response.status });
  return value as T;
};
const relay = await buildRelay({
  origin,
  webRoot: join(directory, 'no-web'),
  enrollmentSecret: enrollment,
  assetOrigin: null,
  uploadOrigins: [],
  messaging: { totpKey: Buffer.alloc(32, 71).toString('base64url') },
});
await relay.app.listen({ host: '127.0.0.1', port });
let relayOpen = true;
let child: ChildProcess | undefined;
let management = '',
  managementToken = '';
let link: Awaited<ReturnType<typeof nodeSession>> | undefined;
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(POCKET_|CODEX_|XDG_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(key),
    ),
  ),
  POCKET_ENV_FILE: emptyEnvironment,
  POCKET_NATIVE_STATE_DIR: state,
  POCKET_NATIVE_LEGACY_DESKTOP_SETTINGS: legacySettings,
  POCKET_NATIVE_CODEX_HOME: join(directory, 'no-codex'),
  POCKET_NATIVE_P2P: '0',
  POCKET_NATIVE_UPDATES: '0',
  POCKET_NATIVE_READ_ONLY: '1',
  XDG_DATA_HOME: join(directory, 'data'),
  XDG_CONFIG_HOME: join(directory, 'config'),
  XDG_CACHE_HOME: join(directory, 'cache'),
  BROWSER: process.platform === 'win32' ? '' : '/usr/bin/true',
};

async function local(path: string, body?: unknown, options: { token?: string; origin?: string | null } = {}) {
  const response = await fetch(`${management}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${options.token ?? managementToken}`,
      ...(options.origin !== null ? { Origin: options.origin ?? management } : {}),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  return { status: response.status, value, cache: response.headers.get('Cache-Control') };
}
async function start() {
  child = spawn(binary, ['--configure', '--print-settings'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let diagnostics = '';
  child.stderr!.on('data', (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-4000);
  });
  const lines = createInterface({ input: child.stdout! });
  let endpoint: URL | undefined;
  const timeout = setTimeout(() => lines.close(), 20_000);
  try {
    for await (const line of lines)
      if (line.startsWith('http://127.0.0.1:')) {
        endpoint = new URL(line.trim());
        break;
      }
  } finally {
    clearTimeout(timeout);
    lines.close();
  }
  assert(endpoint?.hash, `Rust adapter did not issue a disposable local settings capability: ${diagnostics}`);
  management = endpoint.origin;
  sensitive.add(endpoint.hash.slice(1));
  const response = await fetch(`${management}/api/session`, {
    method: 'POST',
    headers: { Origin: management, 'Content-Type': 'application/json' },
    body: JSON.stringify(endpoint.hash.slice(1)),
  });
  assert.equal(response.status, 200);
  managementToken = (await response.json()).token;
  sensitive.add(managementToken);
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'close');
  await local('/quit', {}).catch(() => undefined);
  await Promise.race([
    exited,
    delay(6000, undefined, { ref: false }).then(() => {
      throw Error('Disposable adapter did not stop gracefully');
    }),
  ]);
  child = undefined;
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await delay(100);
  }
  throw Error('Disposable native gateway did not reach the expected state');
}
function independentCode(secret: string, expiresAt: number) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret].map((value) => alphabet.indexOf(value).toString(2).padStart(5, '0')).join('');
  const seed = Buffer.from(bits.match(/.{8}/g)!.map((value) => Number.parseInt(value, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor((expiresAt - 1) / 30_000)));
  const mac = createHmac('sha1', seed).update(counter).digest();
  return String((mac.readUInt32BE(mac.at(-1)! & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

try {
  const account = new AccountClient(request);
  const registration = await account.register('native_keybook_fixture', 'Native keybook fixture', password);
  sensitive.add(account.recoveryCode);
  const intent = {
    hostId: host.peerId,
    name: 'Synthetic keybook computer',
    ticket: 'c'.repeat(64),
    issuedAt: Date.now(),
  };
  const authorization = {
    ...intent,
    signature: base64(await identityKey(host).sign(desktopAuthorizationProof(origin, intent))),
  };
  await request('/desktop-devices/approve', 'POST', { accountId: registration.user.id, authorization });
  await start();
  assert.equal((await local('/security')).value.protection, 'unconfigured');
  // First import must initialize normal local protection without a separate password ceremony.
  const connection = await local('/connect', { origin, enrollment });
  let connectionError = String(connection.value.error ?? 'No local initialization error was returned');
  for (const secret of sensitive)
    if (secret) connectionError = connectionError.replaceAll(secret, '[synthetic credential redacted]');
  assert.equal(connection.status, 200, `Disposable adapter connection failed: ${connectionError}`);
  await until(async () => (await local('/status')).value.phase === 'online');
  assert.equal(
    (await local('/status')).value.account,
    null,
    'Relay connectivity alone is not an account login',
  );
  link = await nodeSession(origin, host.peerId, phone, paired.routeTicket, {
    type: 'authenticate',
    protocol: 2,
    sessionId: randomUUID(),
  });
  const ready = await link.ready;
  assert.equal(ready.device.id, paired.deviceId);
  const statusCall = apiCall(
    `/security/backup?origin=${encodeURIComponent(origin)}&accountId=${registration.user.id}`,
  );
  const initial = await link.rpc<any>(statusCall);
  assert(initial.supported && !initial.saved);
  assert.equal(initial.accountConfirmed, false);
  const challenge = await link.rpc<any>(
    apiCall('/security/backup/challenge', 'POST', {
      origin,
      accountId: registration.user.id,
      revision: account.revision,
    }),
  );
  assert.equal(challenge.hostId, host.peerId);
  assert.equal(challenge.deviceId, ready.device.id);
  assert.equal(challenge.accountId, registration.user.id);
  assert.equal(challenge.revision, account.revision);
  const prepared = await request<{
    ticket: string;
    document: {
      version: number;
      origin: string;
      account: { id: string };
      revision: number;
      totpSecret: string;
    };
  }>('/crypto/desktop-backup/prepare', 'POST', {
    hostId: host.peerId,
    deviceId: ready.device.id,
    challenge,
  });
  sensitive.add(prepared.ticket);
  sensitive.add(prepared.document.totpSecret);
  const document = JSON.stringify({ ...prepared.document, recoveryCode: account.recoveryCode });
  const sealed = await request<{ proof: string }>('/crypto/desktop-backup/seal', 'POST', {
    ticket: prepared.ticket,
    payloadHash: createHash('sha256').update(document).digest('hex'),
  });
  sensitive.add(sealed.proof);
  const tampered = JSON.stringify({ ...JSON.parse(document), totpSecret: 'A'.repeat(32) });
  await assert.rejects(
    link.rpc(apiCall('/security/backup', 'POST', { proof: sealed.proof, document: tampered })),
  );
  assert.equal((await link.rpc<any>(statusCall)).saved, false);
  const imported = await link.rpc<any>(
    apiCall('/security/backup', 'POST', { proof: sealed.proof, document }),
  );
  assert(imported.ok && imported.hasTotp && imported.hasRecovery);
  assert.equal((await link.rpc<any>(statusCall)).accountConfirmed, true);
  const accountStatus = (await local('/status')).value.account;
  assert.equal(accountStatus.state, 'signedIn');
  assert.equal(accountStatus.user.id, registration.user.id);
  assert.equal(accountStatus.user.username, registration.user.username);
  assert.equal(accountStatus.origin, origin);
  await assert.rejects(link.rpc(apiCall('/security/backup', 'POST', { proof: sealed.proof, document })));
  const metadata = await local('/security');
  assert.equal(metadata.cache, 'no-store');
  assert(['system', 'device'].includes(metadata.value.protection));
  assert.equal(metadata.value.locked, false);
  assert.equal(metadata.value.accounts.length, 1);
  const key = metadata.value.accounts[0].key;
  assert.equal(key, createHash('sha256').update(`${origin}\n${registration.user.id}`).digest('hex'));
  // A new authorization may have no fresh browser handoff; an existing same-revision recovery stays saved.
  const again = await request<{ ticket: string; document: object }>(
    '/crypto/desktop-backup/prepare',
    'POST',
    { hostId: host.peerId, deviceId: ready.device.id, authorization },
  );
  const withoutRecovery = JSON.stringify(again.document);
  const againProof = await request<{ proof: string }>('/crypto/desktop-backup/seal', 'POST', {
    ticket: again.ticket,
    payloadHash: createHash('sha256').update(withoutRecovery).digest('hex'),
  });
  sensitive.add(again.ticket);
  sensitive.add(againProof.proof);
  const refreshed = await link.rpc<any>(
    apiCall('/security/backup', 'POST', { proof: againProof.proof, document: withoutRecovery }),
  );
  assert.equal(
    refreshed.hasRecovery,
    true,
    'Same-revision reauthorization must report the retained recovery code',
  );
  assert.equal((await local('/security/recovery', { key })).value.recoveryCode, account.recoveryCode);
  const remote = JSON.stringify(await link.rpc<any>(statusCall));
  for (const secret of [prepared.document.totpSecret, account.recoveryCode]) assert(!remote.includes(secret));
  for (const method of [
    'security.code',
    'security.recovery',
    'security.backup.code',
    'security.backup.export',
  ])
    await assert.rejects(link.request('rpc', { call: { method, query: { key } } }));
  for (const action of ['code', 'recovery']) {
    assert.equal((await local(`/security/${action}`, { key }, { token: 'not-a-local-token' })).status, 401);
    assert.equal(
      (await local(`/security/${action}`, { key }, { origin: 'https://foreign.invalid' })).status,
      403,
    );
    assert.equal((await local(`/security/${action}`, { key }, { origin: null })).status, 403);
  }
  const code = await local('/security/code', { key });
  assert.equal(code.status, 200);
  assert(code.value.code === independentCode(prepared.document.totpSecret, code.value.expiresAt));
  assert.equal((await local('/security/recovery', { key })).value.recoveryCode, account.recoveryCode);
  assert.equal((await local('/security/lock', {})).status, 200);
  assert.equal((await local('/security/code', { key })).status, 200);
  assert.equal((await link.rpc<any>(statusCall)).needsLocalUnlock, false);
  const whileLocked = await request<{ ticket: string; document: object }>(
    '/crypto/desktop-backup/prepare',
    'POST',
    { hostId: host.peerId, deviceId: ready.device.id, authorization },
  );
  const lockedDocument = JSON.stringify({ ...whileLocked.document, recoveryCode: account.recoveryCode });
  const lockedProof = await request<{ proof: string }>('/crypto/desktop-backup/seal', 'POST', {
    ticket: whileLocked.ticket,
    payloadHash: createHash('sha256').update(lockedDocument).digest('hex'),
  });
  sensitive.add(lockedProof.proof);
  assert.equal(
    (
      await link.rpc<any>(
        apiCall('/security/backup', 'POST', { proof: lockedProof.proof, document: lockedDocument }),
      )
    ).ok,
    true,
  );
  const vault = await readFile(join(state, 'account-security-v1.json'), 'utf8');
  for (const secret of [passphrase, prepared.document.totpSecret, account.recoveryCode])
    assert(!vault.includes(secret), 'Persisted keybook contains plaintext credentials');
  if (process.platform !== 'win32')
    assert.equal((await stat(join(state, 'account-security-v1.json'))).mode & 0o777, 0o600);
  link.close();
  link = undefined;
  await relay.app.close();
  relayOpen = false;
  await stop();
  await start(); // --configure keeps the restarted adapter entirely offline.
  assert.equal((await local('/security')).value.locked, false);
  const offline = await local('/security/code', { key });
  assert(offline.value.code === independentCode(prepared.document.totpSecret, offline.value.expiresAt));
  assert.equal((await local('/security/recovery', { key })).value.recoveryCode, account.recoveryCode);
  const manual = Buffer.alloc(32, 52).toString('base64');
  sensitive.add(manual);
  assert.equal((await local('/security/recovery', { key, recoveryCode: manual })).status, 200);
  assert.equal((await local('/security/recovery', { key })).value.recoveryCode, manual);
  assert.equal((await local('/security')).value.accounts[0].recoverySource, 'manual');
  assert.equal((await local('/security/remove', { key })).status, 200);
  assert.equal((await local('/security')).value.accounts.length, 0);
  assert.equal((await local('/security/code', { key })).status, 400);
  assert.deepEqual(await readFile(join(state, 'device-identity-v2.json')), identityBefore);
  console.log(
    'Rust keybook: paired-device signed sync, password-free first import, server commitments, remote read denial, encrypted restart without unlock, offline TOTP/recovery, manual entry and removal passed',
  );
} catch (error) {
  let message = error instanceof Error ? (error.stack ?? error.message) : 'Native keybook smoke failed';
  for (const secret of sensitive)
    if (secret) message = message.replaceAll(secret, '[synthetic credential redacted]');
  console.error(message);
  process.exitCode = 1;
} finally {
  link?.close();
  await stop().catch(() => {
    child?.kill();
  });
  if (relayOpen) await relay.app.close();
  await rm(directory, { recursive: true, force: true });
}
