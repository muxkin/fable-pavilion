import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename as renameFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nodeSession } from '../../src/client/node-session.js';
import { buildRelay } from '../../src/server/relay.js';
import { apiCall } from '../../src/shared/rpc.js';
import { createIdentity } from '../../src/shared/secure-channel.js';
import { createDshFixture, defaultDshProjections, dshModelId } from './lib/dsh-fixture.js';
import {
  allocateLocalPort,
  runCleanups,
  spawnNativeAdapter,
  waitFor,
  type RunningNativeAdapter,
} from './lib/native-helpers.js';

const executable = resolve(process.argv[2] ?? 'desktop/native/target/release/agent-space-native');
assert(existsSync(executable), `Rust desktop adapter executable not found: ${executable}`);
const plugin = process.argv[3] ? resolve(process.argv[3]) : undefined;
const bundled = process.env.POCKET_NATIVE_TEST_BUNDLED_PLUGINS === '1';
assert(bundled || plugin, 'Supply the DSH plugin directory or test an installer with bundled plugins');

const state = await mkdtemp(join(tmpdir(), 'native-dsh-smoke-'));
const legacy = join(state, 'legacy');
const legacyWork = join(legacy, 'original-workspace');
const legacyDesktop = join(legacy, 'desktop-settings.json');
const legacyEnv = join(legacy, 'gateway.env');
const externalEnv = join(legacy, 'external-gateway.env');
const overrideEnv = join(legacy, 'override-gateway.env');
let configSource: 'initial-env' | 'desktop-settings' | 'explicit-env' = 'initial-env';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const png = await readFile('src/web/public/app-icon-32.png');
const workspacePdf = Buffer.from('%PDF-1.7\nfixture document\n');
const sessionZip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');

let fixture: Awaited<ReturnType<typeof createDshFixture>> | undefined;
let relay: Awaited<ReturnType<typeof buildRelay>> | undefined;
let running: RunningNativeAdapter | undefined;
let phase = 'setup';

async function launch(origin: string, tokenZero: string) {
  const args = ['--headless', '--print-pair'];
  const removedWork =
    process.platform === 'linux' && configSource === 'initial-env' ? join(legacy, 'removed-runtime') : undefined;
  if (removedWork) await mkdir(removedWork, { mode: 0o700 });
  // The old Linux installer removes its runtime directory before restarting the adapter.
  const launchArgs = removedWork
    ? ['-c', 'cd "$1" && rmdir "$1" && shift && exec "$@"', 'fixture', removedWork, executable, ...args]
    : args;
  running = await spawnNativeAdapter({
    command: removedWork ? '/bin/sh' : executable,
    args: launchArgs,
    origin,
    stopSignal: 'SIGINT',
    timeoutMs: 15_000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(POCKET_|CODEX_)/i.test(key))),
      CODEX_HOME: join(state, 'no-codex'),
      POCKET_NATIVE_STATE_DIR: state,
      POCKET_NATIVE_ANTIGRAVITY: '0',
      POCKET_NATIVE_LEGACY_STATE: legacy,
      ...(configSource === 'initial-env'
        ? { POCKET_ENV_FILE: legacyEnv }
        : { POCKET_NATIVE_LEGACY_DESKTOP_SETTINGS: legacyDesktop }),
      ...(configSource === 'explicit-env' ? { POCKET_ENV_FILE: overrideEnv } : {}),
      RUST_DSH_TEST_TOKEN_0: tokenZero,
    },
  });
  return running;
}

async function stopAdapter() {
  const current = running;
  running = undefined;
  await current?.stop();
}

const wait = <T>(check: () => T | Promise<T>, description = `DSH state during ${phase}`) =>
  waitFor(check, { description, timeoutMs: 8_000, intervalMs: 30 });

try {
  fixture = await createDshFixture({ png, workspacePdf, sessionZip });
  const {
    instances,
    one,
    two,
    eventFrame,
    interaction,
    projectionFrame,
    project,
    push,
    record,
    user,
  } = fixture;

  const port = await allocateLocalPort();
  const origin = 'http://127.0.0.1:' + port;
  const enrollment = randomBytes(32).toString('hex');
  relay = await buildRelay({
    origin,
    enrollmentSecret: enrollment,
    webRoot: join(state, 'no-web'),
    assetOrigin: null,
    uploadOrigins: [],
  });
  const phone = await createIdentity();

  const legacyConfig = join(legacyWork, 'old-backends.json');
  await mkdir(legacy, { mode: 0o700 });
  await writeFile(
    legacyEnv,
    [
      `RUST_DSH_TEST_TOKEN_1=${two.token}`,
      `POCKET_PUBLIC_ORIGIN=${origin}`,
      `POCKET_RELAY_ENROLLMENT=${enrollment}`,
      'POCKET_P2P=0',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  await writeFile(
    join(state, 'instances.json'),
    JSON.stringify([
      {
        id: one.id,
        name: one.id,
        plugin: '@agent-remote/adapter-dsh',
        config: { url: fixture.url, version: '0.2.1-rc.5' },
        secrets: { token: 'RUST_DSH_TEST_TOKEN_0' },
      },
      {
        id: two.id,
        name: two.id,
        type: 'dsh',
        url: fixture.url,
        tokenEnv: 'RUST_DSH_TEST_TOKEN_1',
        version: '0.2.1-rc.5',
      },
    ]),
    { mode: 0o600 },
  );
  await relay.app.listen({ host: '127.0.0.1', port });

  if (plugin && !bundled) {
    phase = 'missing plugin isolation and installation';
    const withoutPlugin = await launch(origin, one.token);
    const session = await nodeSession(
      origin,
      withoutPlugin.host,
      await createIdentity(),
      hash(withoutPlugin.pairCode),
      {
        type: 'pair',
        protocol: 2,
        sessionId: randomUUID(),
        code: withoutPlugin.pairCode,
        name: 'Missing DSH plugin fixture',
      },
    );
    try {
      const { backends } = await session.rpc<{ backends: { id: string; connected: boolean }[] }>(
        apiCall('/backends'),
      );
      assert.deepEqual(
        backends.map(({ id, connected }) => [id, connected]),
        instances.map(({ id }) => [id, false]),
      );
    } finally {
      session.close();
      await stopAdapter();
    }
    execFileSync(executable, ['--adapter', 'install', plugin], {
      env: { ...process.env, POCKET_NATIVE_STATE_DIR: state },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  }

  phase = 'pairing and initial history';
  const started = await launch(origin, one.token);
  const host = started.host;
  let session = await nodeSession(origin, host, phone, hash(started.pairCode), {
    type: 'pair',
    protocol: 2,
    sessionId: randomUUID(),
    code: started.pairCode,
    name: 'DSH fixture',
  });
  const ready = await session.ready;
  const views = new Map<string, { thread: any; messages: Map<string, any>; order: string[] }>();
  function listen() {
    return session.onEvent((value) => {
      if (value.type !== 'sync' || value.threadId !== 'shared') return;
      for (const update of value.updates) {
        const messages = views.get(value.backendId)?.messages ?? new Map();
        for (const msg of update.changed) messages.set(msg.id, msg);
        views.set(value.backendId, { thread: update.thread, messages, order: update.order });
      }
    });
  }
  let remove = listen();
  const rpc = <T>(backendId: string, path: string, method = 'GET', body?: unknown) =>
    session.rpc<T>({ ...apiCall(path, method, body), backendId });
  const operation = (id: string, expectedState: string, backendId = one.id) =>
    wait(async () => {
      const op = await rpc<{ state: string }>(backendId, '/operations/' + id);
      return op.state === expectedState && op;
    }, `operation ${id} on ${backendId} did not reach ${expectedState}`);
  const watch = async (backendId: string) => {
    await session.request('watch', { backendId, threadId: 'shared' });
    await wait(() => views.get(backendId)?.thread.synchronized === true, `${backendId} watch did not synchronize`);
  };

  try {
    const { backends } = await session.rpc<{
      backends: {
        id: string;
        connected: boolean;
        adapterVersion?: string;
        presentation?: { creation?: { attachments?: boolean; tools?: boolean } };
      }[];
    }>(apiCall('/backends'));
    assert.deepEqual(
      backends.map(({ id, connected }) => [id, connected]),
      instances.map(({ id }) => [id, true]),
    );
    assert(backends.every((entry) => entry.adapterVersion), 'Expected the independent DSH plugin');
    assert.equal(backends.find(({ id }) => id === one.id)?.presentation?.creation?.attachments, true);
    assert.equal(backends.find(({ id }) => id === one.id)?.presentation?.creation?.tools, true);
    const oneStatus = await rpc<{ capabilities: { renameThread?: boolean } }>(one.id, '/status');
    assert.equal(oneStatus.capabilities.renameThread, true, 'Writable DSH did not advertise renameThread');
    const appearancePath = `/backends/${one.id}/appearance`;
    const customized = await session.rpc<{ revision: number; values: { name: string } }>(
      apiCall(appearancePath, 'POST', { revision: 0, patch: { name: 'DSH 测试外观' } }),
    );
    assert.equal(customized.revision, 1);
    assert.equal(customized.values.name, 'DSH 测试外观');
    const renamed = await session.rpc<{ backends: { id: string; name: string }[] }>(apiCall('/backends'));
    assert.equal(renamed.backends.find(({ id }) => id === one.id)?.name, 'DSH 测试外观');
    assert.equal(renamed.backends.find(({ id }) => id === two.id)?.name, two.id);
    const open = randomUUID();
    await rpc(one.id, '/threads/shared/open', 'POST', { requestId: open });
    await operation(open, 'completed');
    assert.equal(one.opens, 0);
    for (const instance of instances) {
      const { threads } = await rpc<{ threads: { id: string; title: string }[] }>(instance.id, '/threads');
      assert.deepEqual([threads[0].id, threads[0].title], ['shared', instance.id]);
      const history = await rpc<{ messages: { text: string }[] }>(instance.id, '/threads/shared/history');
      assert.equal(history.messages[0].text, 'Rust DSH history');
      await watch(instance.id);
    }

    phase = 'scoped attachment staging';
    const attachment = Buffer.from('staged DSH attachment');
    const digest = hash(attachment);
    const uploadSpec = { name: 'scope.txt', size: attachment.length, sha256: digest, hashes: [digest] };
    const upload = await rpc<{ id: string }>(one.id, '/threads/shared/uploads', 'POST', uploadSpec);
    const file = { fileId: upload.id, backendId: one.id, threadId: 'shared' };
    await assert.rejects(session.request('file', { ...file, action: 'missing', backendId: two.id }));
    await assert.rejects(session.request('file', { ...file, action: 'missing', threadId: 'different' }));
    await assert.rejects(session.request('file', { ...file, action: 'write', index: 0 }, Uint8Array.of(0)));
    await session.request('file', { ...file, action: 'write', index: 0 }, attachment);
    assert.deepEqual((await session.request('file', { ...file, action: 'missing' })).value.missing, []);
    await session.request('file', { ...file, action: 'finish' });
    assert.deepEqual(
      Buffer.from((await session.request('file', { ...file, action: 'read', index: 0 })).bytes!),
      attachment,
    );
    await assert.rejects(session.request('file', { ...file, action: 'read', index: 0, backendId: two.id }));

    phase = 'send, stream, steer, queue and interrupt';
    const requestId = randomUUID();
    const send = { requestId, text: 'first' };
    await rpc(one.id, '/threads/shared/messages', 'POST', send);
    await operation(requestId, 'accepted');
    await rpc(one.id, '/threads/shared/messages', 'POST', send);
    await assert.rejects(rpc(one.id, '/threads/shared/messages', 'POST', { ...send, text: 'different' }), {
      status: 409,
    });
    assert.equal(one.calls.filter((call) => call.method === 'session/prompt').length, 1);
    assert.equal(two.calls.filter((call) => call.method === 'session/prompt').length, 0);
    await rpc(two.id, '/threads/shared/messages', 'POST', { requestId, text: 'second instance' });
    await operation(requestId, 'accepted', two.id);
    assert.equal(two.calls.filter((call) => call.method === 'session/prompt').length, 1);
    record(one, 'turn/start', { turn: 8 });
    user(one, 8, requestId, 'first');
    push(one, {
      type: 'assistant-stream',
      frame: { type: 'start', revision: 1, attemptId: 'attempt', turn: 8, step: 1 },
    });
    push(one, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        revision: 2,
        attemptId: 'attempt',
        index: 0,
        chunk: { type: 'text-delta', index: 0, text: 'streaming' },
      },
    });
    await wait(() => views.get(one.id)?.messages.get('stream-attempt')?.text === 'streaming');
    assert.equal(views.get(two.id)?.thread.activeTurnId, null);

    const stale = randomUUID();
    await rpc(one.id, '/threads/shared/steer', 'POST', {
      requestId: stale,
      expectedTurnId: '7',
      text: 'old',
    });
    await operation(stale, 'rejected');
    const steer = randomUUID();
    await rpc(one.id, '/threads/shared/steer', 'POST', {
      requestId: steer,
      expectedTurnId: '8',
      text: 'steer',
    });
    await operation(steer, 'accepted');
    user(one, 8, steer, 'steer');
    const queued = randomUUID();
    const beforeQueue = views.get(one.id)?.thread.queueFingerprint;
    assert.equal(typeof beforeQueue, 'string');
    await rpc(one.id, '/threads/shared/queue', 'POST', {
      requestId: queued,
      text: 'queued',
      expectedQueueFingerprint: beforeQueue,
    });
    await operation(queued, 'accepted');
    await wait(() =>
      views.get(one.id)?.thread.queuedMessages.some((item: any) => item.id === 'queue-' + queued),
    );
    const staleRemoval = randomUUID();
    await rpc(one.id, '/threads/shared/queue-remove', 'POST', {
      requestId: staleRemoval,
      messageId: 'queue-' + queued,
      expectedQueueFingerprint: beforeQueue,
    });
    await operation(staleRemoval, 'rejected');
    assert(!one.calls.some((call) => call.method === 'session/updateQueue'));
    const removed = randomUUID();
    await rpc(one.id, '/threads/shared/queue-remove', 'POST', {
      requestId: removed,
      messageId: 'queue-' + queued,
      expectedQueueFingerprint: views.get(one.id)?.thread.queueFingerprint,
    });
    await operation(removed, 'completed');
    await wait(() => views.get(one.id)?.thread.queuedMessages.length === 0);
    const cancel = randomUUID();
    await rpc(one.id, '/threads/shared/interrupt', 'POST', { requestId: cancel, expectedTurnId: '8' });
    await operation(cancel, 'interrupted');
    await operation(steer, 'interrupted');
    await operation(requestId, 'interrupted');
    await wait(
      () =>
        views.get(one.id)?.thread.canSend === true && !views.get(one.id)?.order.includes('stream-attempt'),
    );

    phase = 'gap reopen, rename, legacy drafts and media references';
    const reopen = one.opens;
    record(one, 'turn/start', { turn: 9 }, false);
    record(one, 'turn/end', { turn: 9, reason: { kind: 'completed' } });
    await wait(() => one.opens > reopen && views.get(one.id)?.thread.synchronized === true);
    const rename = randomUUID();
    await rpc(one.id, '/threads/shared/rename', 'POST', { requestId: rename, title: 'renamed' });
    await operation(rename, 'completed');

    await wait(() => views.get(one.id)?.thread.title === 'renamed');
    const stage = async (name: string, data: Buffer) => {
      const digestValue = hash(data);
      const { id } = await rpc<{ id: string }>(one.id, '/threads/shared/uploads', 'POST', {
        name,
        size: data.length,
        sha256: digestValue,
        hashes: [digestValue],
      });
      const target = { fileId: id, backendId: one.id, threadId: 'shared' };
      await session.request('file', { ...target, action: 'write', index: 0 }, data);
      await session.request('file', { ...target, action: 'finish' });
      return id;
    };
    const describe = (backendId: string, path: string) =>
      rpc<{ id: string; mime: string }>(backendId, '/threads/shared/media', 'POST', { path });
    const download = async (path: string, mime: string) => {
      const manifest = await describe(one.id, path);
      assert.equal(manifest.mime, mime);
      const reply = await session.request('file', { ...file, fileId: manifest.id, action: 'read', index: 0 });
      return Buffer.from(reply.bytes!);
    };
    const fileRef = 'dsh-file:sha256:' + digest;
    const imageRef = 'dsh-image:sha256:' + hash(png);
    await assert.rejects(describe(one.id, fileRef), { status: 404 });
    await assert.rejects(describe(two.id, imageRef), { status: 404 });
    const legacyDraftId = randomUUID();
    const legacyDraftName = 'old-draft.txt';
    const legacyDraftBytes = Buffer.from('DSH draft saved by the Node adapter');
    const legacyDraftRoot = join(legacy, 'backends', one.id, 'uploads');
    const legacyDraftPath = join(legacyDraftRoot, legacyDraftId, legacyDraftName);
    await mkdir(join(legacyDraftRoot, legacyDraftId), { mode: 0o700, recursive: true });
    await writeFile(legacyDraftPath, legacyDraftBytes, { mode: 0o600 });
    await writeFile(
      join(legacyDraftRoot, legacyDraftId + '.json'),
      JSON.stringify({
        id: legacyDraftId,
        name: legacyDraftName,
        size: legacyDraftBytes.length,
        sha256: hash(legacyDraftBytes),
        device: ready.device.id,
        thread: 'shared',
        file: legacyDraftPath,
        complete: true,
      }),
      { mode: 0o600 },
    );
    const completeLegacy = '/threads/shared/uploads/' + legacyDraftId + '/complete';
    assert.deepEqual(await rpc(one.id, completeLegacy, 'POST'), {
      id: legacyDraftId,
      name: legacyDraftName,
      path: legacyDraftPath,
    });
    await assert.rejects(rpc(two.id, completeLegacy, 'POST'));
    await assert.rejects(describe(two.id, legacyDraftPath));
    assert.deepEqual(await download(legacyDraftPath, 'text/plain'), legacyDraftBytes);
    const imageUpload = await stage('image.png', png);
    const mediaSend = { requestId: randomUUID(), text: '', uploadIds: [upload.id, imageUpload, legacyDraftId] };
    await assert.rejects(rpc(two.id, '/threads/shared/messages', 'POST', mediaSend));
    await rpc(one.id, '/threads/shared/messages', 'POST', mediaSend);
    await operation(mediaSend.requestId, 'accepted');
    await rpc(one.id, '/threads/shared/messages', 'POST', mediaSend);
    assert.equal(one.calls.filter((call) => call.method === 'session/uploadFileBinary').length, 2);
    assert.equal(one.calls.filter((call) => call.request.requestId === mediaSend.requestId).length, 1);
    await wait(() => views.get(one.id)?.messages.get(mediaSend.requestId)?.attachments?.length === 3);
    assert.deepEqual(views.get(one.id)?.messages.get(mediaSend.requestId)?.attachments, [
      { path: fileRef, name: 'scope.txt' },
      { path: imageRef, name: 'image.png' },
      { path: 'dsh-file:sha256:' + hash(legacyDraftBytes), name: legacyDraftName },
    ]);
    assert.deepEqual(await download(fileRef, 'text/plain'), attachment);
    assert.deepEqual(await download(imageRef, 'image/png'), png);
    await assert.rejects(describe(two.id, fileRef), { status: 404 });
    assert.deepEqual(await rpc(one.id, '/threads/shared/references?q=report'), {
      files: [{ name: 'report copy.pdf', path: 'report copy.pdf' }],
    });
    record(one, 'assistant/message', {
      message: {
        id: 'workspace-link',
        role: 'assistant',
        content: [
          { type: 'text', text: '[Document](./notes/../report%20copy.pdf) and `[private](secret.pdf)`' },
        ],
      },
    });
    await assert.rejects(describe(two.id, 'report%20copy.pdf'), { status: 404 });
    await assert.rejects(describe(one.id, 'secret.pdf'), { status: 404 });
    assert.deepEqual(await download('report%20copy.pdf', 'application/pdf'), workspacePdf);
    assert.equal(one.calls.filter(({ method }) => method === '/api/file').length, 1);

    const legacyData = Buffer.from('original DSH file from the Node adapter');
    const legacyDigest = 'sha256:' + hash(legacyData);
    const oldPath = join(legacy, 'uploads', randomUUID(), 'old.txt');
    const receiptDir = join(legacy, 'backends', one.id, 'receipts');
    await mkdir(join(oldPath, '..'), { recursive: true, mode: 0o700 });
    await mkdir(receiptDir, { recursive: true, mode: 0o700 });
    await writeFile(oldPath, legacyData, { mode: 0o600 });
    await writeFile(
      join(receiptDir, hash(JSON.stringify(['shared', legacyDigest])) + '.json'),
      JSON.stringify({ path: oldPath }),
      { mode: 0o600 },
    );
    record(one, 'assistant/message', {
      message: {
        id: 'legacy-media',
        role: 'assistant',
        content: [
          {
            type: 'file',
            attachment: { attachmentId: legacyDigest, bytes: legacyData.length, name: 'old.txt' },
          },
        ],
      },
    });
    record(one, 'assistant/message', {
      message: { id: 'later', role: 'assistant', content: [{ type: 'text', text: 'Newer record' }] },
    });
    one.pageWindow = 1;
    assert.deepEqual(await download('dsh-file:' + legacyDigest, 'text/plain'), legacyData);
    assert.deepEqual(await download('report%20copy.pdf', 'application/pdf'), workspacePdf);
    assert(one.calls.some(({ method }) => method === 'session/page'));
    one.pageWindow = 100;
    await writeFile(oldPath, Buffer.alloc(legacyData.length, 0x01), { mode: 0o600 });
    await assert.rejects(describe(one.id, 'dsh-file:' + legacyDigest));

    const raceUpload = await stage('race.txt', Buffer.from('changed turn'));
    const race = { requestId: randomUUID(), text: '', uploadIds: [raceUpload] };
    await rpc(one.id, '/threads/shared/messages', 'POST', race);
    await operation(race.requestId, 'rejected');
    assert(!one.calls.some((call) => call.request.requestId === race.requestId));
    record(one, 'turn/end', { turn: 21, reason: { kind: 'completed' } });
    await wait(() => views.get(one.id)?.thread.canSend === true);

    phase = 'approvals, questions and interactive waterfall events';
    const cards = () => (views.get(one.id)?.thread.requests ?? []) as any[];
    const cardFor = (eventId: string) =>
      wait(() => cards().find((card) => card.id.endsWith(':' + eventId)), `card for event ${eventId}`);
    const responseTo = (card: any, reply: object, responseRequestId = randomUUID()) => ({
      requestId: responseRequestId,
      targetRequestId: card.id,
      expectedTurnId: card.turnId,
      expectedFingerprint: card.fingerprint,
      ...reply,
    });
    const respond = async (body: ReturnType<typeof responseTo>, expectedState: string) => {
      await rpc(one.id, '/threads/shared/responses', 'POST', body);
      await operation(body.requestId, expectedState);
    };
    const outcome = (id: string) =>
      wait(() => one.eventReplies.find((entry) => entry.eventId === id)?.outcome, `event outcome for ${id}`);
    const approval = { toolName: 'fixture-tool', reason: 'Isolated approval' };
    const questions = [
      {
        id: 'mode',
        question: 'Select mode',
        multiSelect: true,
        options: [{ label: 'A', description: 'Fixture choice' }, { label: 'B' }],
      },
    ];
    await wait(() => one.eventClients.size === 1 && two.eventClients.size === 1, 'event clients did not connect');
    const unwatched = interaction(one, 'approval/request', approval, 'not-watched');
    assert.deepEqual(await outcome(unwatched), { kind: 'next' });
    const unknown = interaction(one, 'unsupported/event', {});
    assert.deepEqual(await outcome(unknown), { kind: 'next' });
    record(one, 'turn/start', { turn: 22 });
    await wait(() => views.get(one.id)?.thread.activeTurnId === '22');
    const approvalCallId = 'approval-call';
    const asked = interaction(one, 'approval/request', { ...approval, callId: approvalCallId });
    const beforeTool = await cardFor(asked);
    assert.equal(beforeTool.description, approval.reason);
    record(one, 'tool/call', {
      turn: 22,
      step: 1,
      callId: 'other-call',
      name: approval.toolName,
      arguments: JSON.stringify({ target: 'unrelated' }),
    });
    await wait(() => views.get(one.id)?.order.includes('tool-other-call'));
    assert.equal((await cardFor(asked)).description, approval.reason);
    const argumentsText = JSON.stringify({ command: 'printf "fixture approval"', cwd: '/fixture' });
    record(one, 'tool/call', {
      turn: 22,
      step: 1,
      callId: approvalCallId,
      name: approval.toolName,
      arguments: argumentsText,
    });
    const card = await wait(
      () => cards().find((entry) => entry.id === beforeTool.id && entry.description.includes(argumentsText)),
      'tool arguments did not enrich approval card',
    );
    assert.equal(card.description, `${approval.reason}\n\n工具参数：\n${argumentsText}`);
    assert.notEqual(card.fingerprint, beforeTool.fingerprint);
    assert.deepEqual(card.decisions, ['accept', 'decline', 'cancel']);
    assert.equal(card.turnId, '22');
    assert.deepEqual(views.get(two.id)?.thread.requests, []);
    const crossInstance = responseTo(card, { decision: 'accept' });
    await rpc(two.id, '/threads/shared/responses', 'POST', crossInstance);
    await operation(crossInstance.requestId, 'rejected', two.id);
    assert(!two.eventReplies.some((entry) => entry.eventId === asked));
    await respond(responseTo(beforeTool, { decision: 'accept' }), 'rejected');
    await respond(responseTo(card, { decision: 'accept', expectedTurnId: '21' }), 'rejected');
    await respond(responseTo(card, { decision: 'acceptForSession' }), 'rejected');
    await assert.rejects(
      rpc(
        one.id,
        '/threads/shared/responses',
        'POST',
        responseTo(card, {
          decision: 'accept',
          scope: 'session',
        }),
      ),
    );
    await respond(responseTo(card, { decision: 'decline', expectedFingerprint: '0'.repeat(64) }), 'rejected');
    const decision = responseTo(card, { decision: 'accept' });
    await respond(decision, 'completed');
    assert.deepEqual(await outcome(asked), { kind: 'result', value: 'allowed-once' });
    await respond(decision, 'completed');
    assert.equal(one.eventReplies.filter((entry) => entry.eventId === asked).length, 1);
    await wait(() => !cards().length);

    for (const [choice, value] of [
      ['decline', 'rejected'],
      ['cancel', 'cancelled'],
    ] as const) {
      const event = interaction(one, 'approval/request', approval);
      await respond(responseTo(await cardFor(event), { decision: choice }), 'completed');
      assert.deepEqual(await outcome(event), { kind: 'result', value });
      await wait(() => !cards().length);
    }

    const cancelled = interaction(one, 'approval/request', approval);
    const obsolete = await cardFor(cancelled);
    eventFrame(one, { type: 'cancel', eventId: cancelled });
    await wait(() => !cards().length);
    await respond(responseTo(obsolete, { decision: 'accept' }), 'rejected');
    assert(!one.eventReplies.some((entry) => entry.eventId === cancelled));

    const concurrent = interaction(one, 'approval/request', approval);
    const competingCard = await cardFor(concurrent);
    one.competingEvents.add(concurrent);
    await respond(responseTo(competingCard, { decision: 'decline' }), 'rejected');
    await wait(() => !cards().length);

    const question = interaction(one, 'user-questions/request', { questions });
    const pending = await cardFor(question);
    assert.equal(pending.kind, 'question');
    assert.equal(pending.acceptsWriteInQuestionIds, true);
    await respond(responseTo(pending, { answers: { other: ['A'] } }), 'rejected');
    await respond(responseTo(pending, { answers: { mode: ['A', 'Other'] } }), 'completed');
    assert.deepEqual(await outcome(question), {
      kind: 'result',
      value: { answers: [{ id: 'mode', selected: ['A'], custom: 'Other' }] },
    });
    const literal = interaction(one, 'user-questions/request', { questions });
    const literalCard = await cardFor(literal);
    await respond(responseTo(literalCard, { answers: { mode: ['Other'] }, writeInQuestionIds: [] }), 'rejected');
    await respond(responseTo(literalCard, { answers: { mode: ['A'] }, writeInQuestionIds: ['mode'] }), 'completed');
    assert.deepEqual(await outcome(literal), {
      kind: 'result',
      value: { answers: [{ id: 'mode', selected: [], custom: 'A' }] },
    });
    one.timed.set('call-timed', 900);
    const timed = interaction(one, 'user-questions/request', {
      questions,
      wait: { timed: true, callId: 'call-timed' },
    });
    const timedCard = await cardFor(timed);
    assert.deepEqual(await outcome(timed), { kind: 'next' });
    await wait(() => one.releasedWaits.includes('call-timed') && !cards().length);
    await respond(responseTo(timedCard, { answers: { mode: ['B'] } }), 'rejected');
    project(one, 'shared', 'userQuestions', {
      active: [{ state: 'continued', callId: 'call-timed', questions }],
      settled: [],
    });
    const late = await wait(() => cards().find((entry) => entry.kind === 'async-question'));
    assert.equal(late.turnId, null);
    assert.equal(late.acceptsWriteInQuestionIds, true);
    await respond(responseTo(late, { answers: { mode: ['B'] }, writeInQuestionIds: ['mode'] }), 'completed');
    assert.deepEqual(one.calls.findLast(({ method }) => method === 'userQuestions/answer')?.request, {
      agentId: 'shared',
      callId: 'call-timed',
      answer: { answers: [{ id: 'mode', selected: [], custom: 'B' }] },
    });
    await wait(() => !cards().length);

    const uncertainEvent = interaction(one, 'approval/request', approval);
    const uncertainCard = await cardFor(uncertainEvent);
    one.lostEvents.add(uncertainEvent);
    const uncertainResponse = responseTo(uncertainCard, { decision: 'decline' });
    await respond(uncertainResponse, 'uncertain');
    await respond(uncertainResponse, 'uncertain');
    assert.equal(one.eventReplies.filter((entry) => entry.eventId === uncertainEvent).length, 1);

    const beforeDisconnect = interaction(one, 'approval/request', approval);
    const disconnectedCard = await cardFor(beforeDisconnect);
    const [eventSocket, binding] = [...one.eventClients][0];
    eventSocket.terminate();
    await wait(
      () => !cards().length && [...one.eventClients.values()].some(({ client }) => client !== binding.client),
    );
    await respond(responseTo(disconnectedCard, { decision: 'accept' }), 'rejected');
    assert(!one.eventReplies.some((entry) => entry.eventId === beforeDisconnect));
    assert.equal(views.get(one.id)?.thread.synchronized, true);

    const noWatcher = interaction(one, 'approval/request', approval);
    await cardFor(noWatcher);
    await session.request('unwatch', { backendId: one.id, threadId: 'shared' });
    assert.deepEqual(await outcome(noWatcher), { kind: 'next' });
    await wait(() => one.eventClients.size === 0);
    views.delete(one.id);
    await watch(one.id);
    record(one, 'turn/end', { turn: 22, reason: { kind: 'completed' } });
    await wait(() => views.get(one.id)?.thread.canSend === true);

    phase = 'models, controls, skills, goals and ZIP export';
    const models = await rpc<{ models: { id: string; efforts: string[] }[] }>(one.id, '/models');
    assert.deepEqual(
      models.models.map(({ id, efforts }) => [id, efforts]),
      [
        [dshModelId('base'), ['default']],
        [dshModelId('advanced'), ['high']],
        [dshModelId('drop'), ['default']],
      ],
    );
    const controls = await rpc<{ actions: string[]; presets: { id: string }[] }>(
      one.id,
      '/threads/shared/controls',
    );
    assert.deepEqual(controls.actions, ['permission', 'preset', 'plan', 'compact', 'feedback', 'goal']);
    assert.deepEqual((await rpc<{ actions: string[] }>(two.id, '/threads/shared/controls')).actions, [
      'permission',
      'preset',
      'plan',
    ]);
    assert.deepEqual(
      controls.presets.map(({ id }) => id),
      ['standard', 'custom'],
    );
    await wait(() => views.get(one.id)?.thread.model === dshModelId('base'));
    const modelChange = {
      requestId: randomUUID(),
      model: dshModelId('advanced'),
      effort: 'high',
      mode: 'default',
      expectedMode: 'default',
      serviceTier: 'default',
      expectedServiceTier: null,
      expectedModel: dshModelId('base'),
      expectedEffort: 'default',
    };
    await rpc(one.id, '/threads/shared/settings', 'POST', modelChange);
    await operation(modelChange.requestId, 'completed');
    await wait(() => views.get(one.id)?.thread.reasoningEffort === 'high');
    await rpc(one.id, '/threads/shared/settings', 'POST', modelChange);
    assert.equal(one.calls.filter((call) => call.method === 'session/selectModel').length, 1);
    assert.equal(views.get(two.id)?.thread.model, dshModelId('base'));
    projectionFrame(one, {
      type: 'projection',
      sessionId: 'shared',
      key: 'modelSelection',
      seq: one.projectionSeq - 1,
      value: defaultDshProjections().modelSelection,
    });
    project(one, 'shared', 'plan', { active: true }, false);
    const staleModel = {
      ...modelChange,
      requestId: randomUUID(),
      expectedModel: dshModelId('advanced'),
      expectedEffort: 'high',
    };
    await rpc(one.id, '/threads/shared/settings', 'POST', staleModel);
    await operation(staleModel.requestId, 'rejected');
    assert.equal(one.calls.filter((call) => call.method === 'session/selectModel').length, 1);
    assert.equal(views.get(one.id)?.thread.model, dshModelId('advanced'));

    const control = async (value: object, expected = 'completed') => {
      const controlRequestId = randomUUID();
      await rpc(one.id, '/threads/shared/control', 'POST', { requestId: controlRequestId, control: value });
      return operation(controlRequestId, expected);
    };
    const permissionRevision = views.get(one.id)?.thread.controls.permissionRevision;
    assert.equal(typeof permissionRevision, 'string');
    await control({ action: 'permission', expected: 'ask', value: 'ask\n/plan' }, 'rejected');
    await control({ action: 'permission', expected: 'restricted', value: 'ask' }, 'rejected');
    assert(!one.calls.some((call) => call.method === 'commands/execute'));
    await control({
      action: 'permission',
      expected: 'ask',
      expectedRevision: permissionRevision,
      value: 'restricted',
    });
    await wait(() => views.get(one.id)?.thread.controls.permission === 'restricted');
    await control({ action: 'plan', enabled: false });
    await wait(() => views.get(one.id)?.thread.controls.plan === false);
    await control({ action: 'plan', enabled: true });
    await wait(() => views.get(one.id)?.thread.mode === 'plan');
    project(one, 'shared', 'turnOutline', [{ turn: 8 }], false);
    await control({ action: 'preset', value: 'custom' }, 'rejected');
    project(one, 'shared', 'turnOutline', []);
    await control({ action: 'preset', value: 'custom' });
    await wait(() => views.get(one.id)?.thread.controls.preset === 'custom');

    assert.deepEqual(await rpc(one.id, '/threads/shared/skills'), {
      skills: [{ id: 'fixture-skill', name: 'fixture-skill', description: 'Fixture skill', source: 'DSH' }],
    });
    assert.deepEqual(await rpc(two.id, '/threads/shared/skills'), { skills: [] });
    const staleSkill = { requestId: randomUUID(), text: 'stale skill', skillIds: ['missing-skill'] };
    await rpc(one.id, '/threads/shared/messages', 'POST', staleSkill);
    await operation(staleSkill.requestId, 'rejected');
    assert(!one.calls.some(({ request }) => request.requestId === staleSkill.requestId));
    const skillSend = { requestId: randomUUID(), text: 'skill prompt', skillIds: ['fixture-skill'] };
    await rpc(one.id, '/threads/shared/messages', 'POST', skillSend);
    await operation(skillSend.requestId, 'accepted');
    assert.deepEqual(
      one.calls.find(({ request }) => request.requestId === skillSend.requestId)?.request.content,
      [{ type: 'text', text: '/fixture-skill\nskill prompt' }],
    );
    await assert.rejects(
      rpc(one.id, '/threads/shared/messages', 'POST', {
        ...skillSend,
        requestId: randomUUID(),
        skillIds: ['fixture-skill\n/compact'],
      }),
    );

    const compact = (await control({ action: 'compact' })) as { turnId?: string };
    assert.equal(typeof compact.turnId, 'string');
    await wait(() => views.get(one.id)?.messages.get('command-' + compact.turnId)?.output === 'Compacted');
    one.failCompact = true;
    const failedCompact = (await control({ action: 'compact' }, 'failed')) as { turnId?: string };
    await wait(
      () => views.get(one.id)?.messages.get('command-' + failedCompact.turnId)?.output === 'Fixture failure',
    );
    await control({ action: 'feedback', text: '   Fixture feedback ' });
    const readGoal = async () =>
      (
        await rpc<{
          goal: null | {
            ref: { id: string; revision: number };
            objective: string;
            phase: string;
            activation: string;
          };
        }>(one.id, '/threads/shared/controls')
      ).goal;
    assert.equal(await readGoal(), null);
    await control({ action: 'goal', operation: 'create', objective: 'Fixture goal' });
    const firstGoal = (await readGoal())!;
    assert.deepEqual([firstGoal.phase, firstGoal.activation, firstGoal.ref.revision], ['active', 'armed', 1]);
    await control({ action: 'goal', operation: 'pause', ref: { ...firstGoal.ref, revision: 2 } }, 'rejected');
    assert(!one.calls.some(({ method }) => method === 'goals/pause'));
    const lostGoal = {
      requestId: randomUUID(),
      control: {
        action: 'goal',
        operation: 'edit',
        ref: firstGoal.ref,
        objective: 'lost goal response',
      },
    };
    await rpc(one.id, '/threads/shared/control', 'POST', lostGoal);
    await operation(lostGoal.requestId, 'uncertain');
    await rpc(one.id, '/threads/shared/control', 'POST', lostGoal);
    assert.equal(one.calls.filter(({ method }) => method === 'goals/edit').length, 1);
    assert.equal((await readGoal())?.objective, 'lost goal response');
    for (const [goalOperation, expectedPhase] of [
      ['pause', 'paused'],
      ['resume', 'active'],
      ['complete', 'complete'],
    ] as const) {
      const current = (await readGoal())!;
      await control({ action: 'goal', operation: goalOperation, ref: current.ref });
      const result = (await readGoal())!;
      assert.deepEqual([result.phase, result.ref.revision], [expectedPhase, current.ref.revision + 1]);
    }
    await control({ action: 'goal', operation: 'clear', ref: (await readGoal())!.ref });
    assert.equal(await readGoal(), null);
    const zip = await rpc<{ id: string; mime: string; name: string }>(
      one.id,
      '/threads/shared/export',
      'POST',
    );
    assert.equal(zip.mime, 'application/zip');
    assert(zip.name.endsWith('.zip'));
    const zipFile = { fileId: zip.id, backendId: one.id, threadId: 'shared', action: 'read', index: 0 };
    assert.deepEqual(Buffer.from((await session.request('file', zipFile)).bytes!), sessionZip);
    await assert.rejects(session.request('file', { ...zipFile, backendId: two.id }));
    await assert.rejects(rpc(one.id, '/threads/not-watched/export', 'POST'), { status: 404 });
    const lostSetting = {
      ...staleModel,
      requestId: randomUUID(),
      model: dshModelId('drop'),
      effort: 'default',
      mode: 'plan',
      expectedMode: 'plan',
    };
    await rpc(one.id, '/threads/shared/settings', 'POST', lostSetting);
    await operation(lostSetting.requestId, 'uncertain');
    await wait(() => views.get(one.id)?.thread.model === dshModelId('drop'));

    phase = 'project grouping and thread creation';
    assert.equal(views.get(one.id)?.thread.projectId, 'work-dsh-one');
    assert.equal(views.get(one.id)?.thread.projectName, 'Workspace dsh-one');
    assert.deepEqual(await rpc(one.id, '/threads/new/skills?creation=1&projectId=work-dsh-one'), {
      skills: [{ id: 'fixture-skill', name: 'fixture-skill', description: 'Fixture skill', source: 'DSH' }],
    });
    const grouped = await rpc<{ threads: { id: string; projectId: string }[] }>(
      one.id,
      '/threads?project=work-dsh-one',
    );
    assert.equal(grouped.threads[0].projectId, 'work-dsh-one');
    assert.deepEqual(await rpc(one.id, '/projects'), {
      projects: [{ id: 'work-dsh-one', name: 'Workspace dsh-one', count: 1 }],
      total: 1,
      ungrouped: 0,
    });
    const createDraftId = randomUUID();
    const createAttachment = Buffer.from('dsh create attachment bytes');
    const createDigest = hash(createAttachment);
    const createUpload = await rpc<{ id: string }>(one.id, `/threads/new:${createDraftId}/uploads`, 'POST', {
      name: 'create.txt',
      size: createAttachment.length,
      sha256: createDigest,
      hashes: [createDigest],
    });
    await session.request(
      'file',
      { fileId: createUpload.id, backendId: one.id, threadId: `new:${createDraftId}`, action: 'write', index: 0 },
      createAttachment,
    );
    await session.request('file', {
      fileId: createUpload.id,
      backendId: one.id,
      threadId: `new:${createDraftId}`,
      action: 'finish',
    });
    const create = randomUUID();
    await rpc(one.id, '/threads/new/create', 'POST', {
      requestId: create,
      title: 'new session',
      prompt: 'initial',
      projectId: 'work-dsh-one',
      model: dshModelId('advanced'),
      thinking: 'high',
      permission: 'restricted',
      agentPreset: 'custom',
      plan: true,
      draftId: createDraftId,
      uploadIds: [createUpload.id],
      skillIds: ['fixture-skill'],
    });
    const completed = (await operation(create, 'completed')) as { resultThreadId?: string };
    assert.equal(completed.resultThreadId, 'created-' + create);
    const createdPrompt = one.calls.find(
      ({ method, request }) => method === 'session/prompt' && request.sessionId === 'created-' + create,
    );
    assert(createdPrompt, 'Missing creation session/prompt call');
    assert(
      (createdPrompt.request.content as { type: string; text?: string }[]).some(
        (part) => part.type === 'text' && part.text === '/fixture-skill\ninitial',
      ),
      'Creation skill prompt did not reach DSH',
    );
    assert(
      (createdPrompt.request.content as { type: string }[]).some((part) => part.type === 'file'),
      'Creation attachment did not reach DSH',
    );
    assert.equal(one.created.get('created-' + create), 'new session');
    assert.deepEqual(one.projections.get('created-' + create), {
      modelSelection: { next: { provider: 'fixture', model: 'advanced', reasoningEffort: 'high' } },
      permissions: { currentValue: 'restricted' },
      agentPreset: 'custom',
      plan: { active: true },
      turnOutline: [],
    });
    const createOrder = one.calls
      .filter(
        ({ request }) => request.sessionId === 'created-' + create || request.agentId === 'created-' + create,
      )
      .map(({ method }) => method);
    assert.equal(createOrder.at(-1), 'session/prompt');
    assert(createOrder.indexOf('session/selectModel') < createOrder.indexOf('session/prompt'));
    const partial = randomUUID();
    await rpc(one.id, '/threads/new/create', 'POST', {
      requestId: partial,
      title: 'partial',
      prompt: 'lost initial response',
      projectId: 'work-dsh-one',
    });
    const incomplete = (await operation(partial, 'uncertain')) as { resultThreadId?: string };
    assert.equal(incomplete.resultThreadId, 'created-' + partial);
    assert(!two.created.size);

    phase = 'restart recovery and legacy desktop settings migration';
    const lost = randomUUID();
    await rpc(one.id, '/threads/shared/messages', 'POST', { requestId: lost, text: 'lost response' });
    await operation(lost, 'uncertain');
    const restartCount = one.calls.length;
    remove();
    session.close();
    await stopAdapter();
    await mkdir(legacyWork, { mode: 0o700 });
    await renameFile(join(state, 'instances.json'), legacyConfig);
    const oldEnvironment = `RUST_DSH_TEST_TOKEN_1=${two.token}\nPOCKET_BACKENDS_FILE=old-backends.json\nPOCKET_PUBLIC_ORIGIN=https://unused.invalid\nPOCKET_P2P=0\n`;
    await writeFile(externalEnv, oldEnvironment, { mode: 0o600 });
    await writeFile(
      legacyDesktop,
      JSON.stringify({
        origin,
        legacyGateway: { workingDirectory: legacyWork, environmentFile: externalEnv },
      }),
      { mode: 0o600 },
    );
    await rm(join(state, 'service-origin'));
    configSource = 'desktop-settings';
    await launch(origin, one.token);
    views.clear();
    session = await nodeSession(origin, host, phone, ready.ticket, {
      type: 'authenticate',
      protocol: 2,
      sessionId: randomUUID(),
    });
    remove = listen();
    await watch(one.id);
    await watch(two.id);
    assert.deepEqual(await download(fileRef, 'text/plain'), attachment);
    await rpc(one.id, '/threads/shared/settings', 'POST', lostSetting);
    await operation(lostSetting.requestId, 'uncertain');
    assert.equal(
      one.calls.filter(({ method, request }) => method === 'session/selectModel' && request.model === 'drop')
        .length,
      1,
    );
    await rpc(one.id, '/threads/shared/messages', 'POST', { requestId: lost, text: 'lost response' });
    await operation(lost, 'uncertain');
    assert.equal(one.calls.length, restartCount);
    record(one, 'turn/start', { turn: 10 });
    user(one, 10, lost, 'lost response');
    record(one, 'turn/end', { turn: 10, reason: { kind: 'completed' } });
    await operation(lost, 'completed');

    phase = 'migrated read-only policy';
    remove();
    session.close();
    await stopAdapter();
    await writeFile(overrideEnv, oldEnvironment + 'POCKET_READ_ONLY=1\n', { mode: 0o600 });
    configSource = 'explicit-env';
    const beforeReadOnly = one.eventSessions;
    await launch(origin, one.token);
    views.clear();
    session = await nodeSession(origin, host, phone, ready.ticket, {
      type: 'authenticate',
      protocol: 2,
      sessionId: randomUUID(),
    });
    remove = listen();
    await watch(one.id);
    assert.equal(one.eventSessions, beforeReadOnly);
    assert.equal(views.get(one.id)?.thread.canSend, false);
    assert.equal((await rpc<{ writesEnabled: boolean }>(one.id, '/status')).writesEnabled, false);
    assert.deepEqual((await rpc<{ actions: string[] }>(one.id, '/threads/shared/controls')).actions, []);
    await assert.rejects(rpc(one.id, '/threads/shared/uploads', 'POST', uploadSpec));
    await assert.rejects(session.request('file', { ...file, action: 'finish' }));
    assert.deepEqual(
      Buffer.from((await session.request('file', { ...file, action: 'read', index: 0 })).bytes!),
      attachment,
    );
    const blocked = randomUUID();
    const before = one.calls.length;
    await rpc(one.id, '/threads/shared/messages', 'POST', {
      requestId: blocked,
      text: 'blocked by migrated read-only config',
    });
    await operation(blocked, 'rejected');
    assert.equal(one.calls.length, before);
    await control({ action: 'plan', enabled: false }, 'rejected');
    assert.equal(one.calls.length, before);
    const readonlyZip = await rpc<{ id: string }>(one.id, '/threads/shared/export', 'POST');
    assert.deepEqual(
      Buffer.from((await session.request('file', { ...zipFile, fileId: readonlyZip.id })).bytes!),
      sessionZip,
    );
  } finally {
    remove();
    session.close();
  }
  assert.deepEqual(fixture.errors, [], 'Synthetic DSH fixture recorded unexpected errors');
  console.log(
    'Rust DSH: media, native skills and controls, goals, ZIP export, approvals and questions, recovery, replay, legacy environment and read-only policy passed.',
  );
} catch (error) {
  const stderr = running?.stderrTail();
  console.error(
    `Native DSH smoke failed during ${phase}${stderr ? `\n--- adapter stderr ---\n${stderr}` : ''}`,
  );
  throw error;
} finally {
  await runCleanups([
    () => stopAdapter(),
    () => fixture?.close(),
    () => relay?.app.close(),
    () => rm(state, { recursive: true, force: true }),
  ]);
}
