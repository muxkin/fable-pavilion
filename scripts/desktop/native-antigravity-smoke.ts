import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { nodeSession } from '../../src/client/node-session.js';
import { platformRuntime } from '../../src/server/platform.js';
import { buildRelay } from '../../src/server/relay.js';
import { createIdentity } from '../../src/shared/secure-channel.js';
import { apiCall, type RpcCall } from '../../src/shared/rpc.js';
import { saveRecoveryCode } from '../lib/messaging-smoke.js';

// Development fixtures run in Node; the adapter and its product plugin must use
// the actual Rust executable. All Agent state is temporary synthetic data.
const executable = resolve(process.argv[2] ?? 'desktop/native/target/debug/agent-space-native');
assert(existsSync(executable), 'Build the pure Rust desktop adapter before running this smoke test');
assert(process.argv[3], 'Supply the native Antigravity plugin package directory');
const packageDirectory = resolve(process.argv[3]);
const manifest = JSON.parse(await readFile(join(packageDirectory, 'adapter.json'), 'utf8'));
assert.equal(manifest.product, 'antigravity');
const pluginExecutable = join(packageDirectory, manifest.entry);
const oldGateway = process.env.POCKET_NATIVE_TEST_OLD_GATEWAY === '1';
const legacyQuestions = oldGateway || process.env.POCKET_NATIVE_TEST_LEGACY_QUESTIONS === '1';
const legacyHistory = process.env.POCKET_NATIVE_TEST_LEGACY_HISTORY === '1';
type QuestionReceiptFault = 'committed' | 'uncommitted';
const browserChannel = process.env.POCKET_NATIVE_TEST_BROWSER || undefined;
const recoverRenderer = process.env.POCKET_NATIVE_TEST_RENDERER_RECOVERY === '1';
assert(
  browserChannel === undefined || browserChannel === 'msedge' || browserChannel === 'chrome',
  'Use msedge or chrome',
);
assert(!recoverRenderer || browserChannel, 'Renderer recovery requires a browser channel');
assert(!recoverRenderer || (!legacyQuestions && !legacyHistory), 'Renderer recovery requires current question and history support');
const root = await mkdtemp(join(tmpdir(), 'native-antigravity-smoke-'));
const state = join(root, 'state');
const agentHome = join(root, 'antigravity');
const backendId = 'antigravity-local';
const threadId = '11111111-1111-4111-8111-111111111111';
const createdId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const trajectoryId = '44444444-4444-4444-8444-444444444444';
const switchId = '55555555-5555-4555-8555-555555555555';
const replacementTrajectoryId = '66666666-6666-4666-8666-666666666666';
const initialTitle = 'Fixture Antigravity conversation';
const fixtureImage = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
  'base64',
);
const switchTitle = 'Fixture dense history conversation';
const recoveredAnswerMarker = 'Fixture continued after the native answer receipt was lost.';
const nativePlugin = {
  name: 'fixture-local-plugin',
  displayName: 'Fixture selectable plugin',
  path: 'file:///fixture/private/plugin-definition',
  logo: 'file:///fixture/private/plugin-logo',
};
const nextInvocation = 'MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION';
const extraQuestionOptions = Array.from({ length: 19 }, (_, index) => ({
  id: `extra-${index}`,
  text: `补充选项 ${index + 1}`,
}));
platformRuntime().privateDirectory(state);
await mkdir(join(agentHome, 'daemon'), { recursive: true, mode: 0o700 });
const phone = await createIdentity();
let host: string | undefined;
let ticket: string | undefined;
let pairingCode: string | undefined;

const fixture = await agentFixture();
const reserve = createServer();
reserve.listen(0, '127.0.0.1');
await once(reserve, 'listening');
const address = reserve.address();
assert(address && typeof address !== 'string');
await new Promise<void>((done, reject) => reserve.close((error) => (error ? reject(error) : done())));
const origin = `http://127.0.0.1:${address.port}`;
const enrollment = randomBytes(32).toString('hex');
const relay = await buildRelay({
  origin,
  enrollmentSecret: enrollment,
  webRoot: browserChannel ? resolve(process.env.TEST_WEB_ROOT ?? 'dist/web') : join(root, 'no-web'),
  assetOrigin: null,
  uploadOrigins: [],
  messaging: { registrationEnabled: true, deviceLoginOnly: false, totpKey: randomBytes(32).toString('base64url') },
});
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(POCKET_|CODEX_|NODE_|ANTIGRAVITY_)/i.test(key)),
  ),
  POCKET_NATIVE_STATE_DIR: state,
  POCKET_NATIVE_ORIGIN: origin,
  POCKET_NATIVE_ENROLLMENT: enrollment,
  POCKET_NATIVE_CODEX_HOME: join(root, 'absent-codex'),
  POCKET_NATIVE_READ_ONLY: '0',
  POCKET_NATIVE_P2P: '0',
  POCKET_NATIVE_UPDATES: '0',
};
const scoped = (path: string, method = 'GET', body?: unknown): RpcCall => ({
  ...apiCall(path, method, body),
  backendId,
});
type Session = Awaited<ReturnType<typeof nodeSession>>;
let adapter: Awaited<ReturnType<typeof launch>> | undefined;
let session: Session | undefined;
let phase = 'install';
let browserFailure: unknown;
try {
  assert.equal(
    execFileSync(executable, ['--adapter', 'install', packageDirectory], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(),
    `${manifest.name}@${manifest.version}`,
  );
  await writeFile(
    join(state, 'instances.json'),
    JSON.stringify([
      {
        id: backendId,
        name: 'Fixture Antigravity',
        plugin: manifest.name,
        version: manifest.version,
        config: { home: agentHome },
      },
    ]),
    { mode: 0o600 },
  );
  platformRuntime().privateFile(join(state, 'instances.json'));
  await relay.app.listen({ host: '127.0.0.1', port: address.port });
  phase = 'direct plugin contract';
  await testPluginProcess();
  phase = 'gateway startup and encrypted history';
  adapter = await launch();
  if (browserChannel) {
    phase = 'browser session switching';
    try {
      await testBrowserSwitching(browserChannel);
    } catch (error) {
      // Keep the encrypted protocol result available to distinguish a browser
      // failure from a native transfer failure. The suite still fails below.
      browserFailure = error;
      console.error('Antigravity browser acceptance failed:', error);
    }
    // Browser pairing consumes the first enrollment code. Start the protocol
    // tests with a fresh code and the same temporary gateway identity.
    await adapter.stop();
    fixture.reset();
    adapter = await launch();
  }
  session = await connect();
  const modelStatus = await session.rpc<{ capabilities: { modelSettings: boolean; nextMessageModel?: boolean } }>(
    scoped('/status'),
  );
  assert.equal(modelStatus.capabilities.modelSettings, false);
  assert.equal(modelStatus.capabilities.nextMessageModel, oldGateway ? undefined : true);
  const backends = await session.rpc<{ backends: { id: string; product: string; connected: boolean }[] }>(
    apiCall('/backends'),
  );
  assert(
    backends.backends.some(
      (backend) => backend.id === backendId && backend.product === 'antigravity' && backend.connected,
    ),
  );
  const threads = await session.rpc<{ threads: { id: string; title: string; projectName: string }[] }>(
    scoped('/threads'),
  );
  assert(threads.threads.some((thread) => thread.id === threadId));
  assert.equal(threads.threads.find((thread) => thread.id === threadId)?.projectName, 'Fixture project');
  const history = await session.rpc<{
    thread: { model: string; modelName: string };
    messages: { role: string; text: string }[];
  }>(scoped(`/threads/${threadId}/history`));
  assert(history.messages.some((message) => message.role === 'user' && message.text === 'fixture question'));
  assert.equal(history.thread.model, 'fixture');
  assert.equal(history.thread.modelName, 'Fixture model');
  assert(
    history.messages.some((message) => message.role === 'assistant' && message.text === 'fixture answer'),
  );

  phase = 'native grouped weekly and five-hour quotas';
  const readUsage = (refresh = false) =>
    session!.rpc<{
      available: boolean;
      canReset?: boolean;
      buckets: {
        id: string;
        name: string;
        windows: { label: string; usedPercent: number; durationMinutes?: number; resetsAt?: number }[];
      }[];
    }>(scoped(refresh ? '/usage?refresh=1' : '/usage'));
  const usage = await readUsage();
  assert.equal(usage.available, true);
  assert.equal(usage.canReset, false);
  assert.deepEqual(
    usage.buckets.map((bucket) => bucket.name),
    ['Gemini Models', 'Claude and GPT models', 'Gemini 4 Argon'],
  );
  assert.deepEqual(
    usage.buckets.map((bucket) => bucket.windows.length),
    [2, 2, 1],
  );
  assert.equal(usage.buckets[0].windows[0].usedPercent, 3.7257);
  assert.equal(usage.buckets[0].windows[1].usedPercent, 10.877);
  assert.equal(usage.buckets[0].windows[0].durationMinutes, 10080);
  assert.equal(usage.buckets[0].windows[1].durationMinutes, 300);
  assert.equal(usage.buckets[0].windows[0].resetsAt, Date.parse('2026-11-26T11:09:35Z'));
  assert.equal(usage.buckets[2].windows[0].resetsAt, undefined);
  assert.equal(usage.buckets[1].windows[1].usedPercent, 100, 'Explicit zero was lost');
  assert(!JSON.stringify(usage).includes('private-fixture-account'));
  assert(!JSON.stringify(usage).includes(fixture.token));
  const refreshedUsage = await readUsage(true);
  assert.equal(refreshedUsage.buckets[0].id, usage.buckets[0].id);
  assert.deepEqual(fixture.calls.quotaRefresh, [false, true]);
  fixture.setQuotaMode('unsupported');
  assert.equal((await readUsage()).available, false, 'Per-model quotas replaced an unavailable summary');
  fixture.setQuotaMode('none');
  assert.equal((await readUsage()).available, false, 'Missing quota data became a fabricated allowance');
  fixture.setQuotaMode('primary');

  let latest: Record<string, any> | undefined;
  const updates = new Map<string, Record<string, any>>();
  const unsubscribe = session.onEvent((event) => {
    if (event.type !== 'sync' || event.backendId !== backendId || event.threadId !== threadId) return;
    for (const update of event.updates ?? []) {
      latest = update.thread;
      for (const message of update.changed ?? []) updates.set(message.id, message);
    }
  });
  await session.request('watch', { backendId, threadId });
  await waitFor(() => latest?.canSend === true, 'Antigravity watch did not publish a writable snapshot');
  assert.equal(latest?.projectName, 'Fixture project');
  const pluginPid = await assertRustChildren(adapter.child.pid!);
  const operation = (id: string) =>
    session!.rpc<{ state: string; turnId?: string; resultThreadId?: string }>(scoped(`/operations/${id}`));
  phase = 'native question, answer, and continuation';
  fixture.askQuestion();
  await waitFor(
    () => latest?.requests?.some((request: any) => request.kind === 'question'),
    'Native question did not appear on the encrypted subscription',
  );
  const question = latest!.requests[0];
  assert.equal(question.actionable, true);
  assert.equal(latest!.canSteer, false, 'Pending questions did not block append');
  assert.equal(question.acceptsWriteInQuestionIds, legacyQuestions ? undefined : true);
  assert.equal(latest!.canSend, false);
  assert.equal(question.questions[1].multiSelect, true);
  const responseBody = {
    requestId: randomUUID(),
    targetRequestId: question.id,
    expectedTurnId: question.turnId,
    expectedFingerprint: question.fingerprint,
    answers: { 'question-0': ['红'], 'question-1': ['甲', '乙'], 'question-2': ['补充内容'] },
  };
  const responseCall = scoped(`/threads/${threadId}/responses`, 'POST', responseBody);
  const staleAnswerId = randomUUID();
  await session.rpc(
    scoped(`/threads/${threadId}/responses`, 'POST', {
      ...responseBody,
      requestId: staleAnswerId,
      expectedFingerprint: '0'.repeat(64),
    }),
  );
  await waitFor(
    async () => (await operation(staleAnswerId)).state === 'rejected',
    'Stale native question answer was not rejected',
  );
  assert.equal(fixture.calls.answer, 0, 'Stale question answer reached the native RPC');
  await session.rpc(responseCall);
  await waitFor(
    async () => (await operation(responseBody.requestId)).state === 'completed',
    'Native question answer did not complete',
  );
  await session.rpc(responseCall);
  assert.equal(fixture.calls.answer, 1, 'Duplicate submission repeated the native interaction');
  await waitFor(
    () => latest?.pendingRequests === 0 && latest?.canSend === true,
    'Native execution did not resume after the answer',
  );
  assert([...updates.values()].some((message) => message.text === 'fixture continued after answer'));

  if (!legacyQuestions && !legacyHistory) {
    for (const [fault, expected] of [['committed', 'completed'], ['uncommitted', 'uncertain']] as const) {
      phase = `native question receipt loss (${fault})`;
      fixture.askQuestion();
      await waitFor(
        () => latest?.requests?.some((request: any) => request.kind === 'question' && request.actionable),
        'The next native question did not appear on the encrypted subscription',
      );
      const shown: { id: string; turnId: string; fingerprint: string } = latest!.requests[0];
      const requestId = randomUUID();
      const call = scoped(`/threads/${threadId}/responses`, 'POST', {
        ...responseBody,
        requestId,
        targetRequestId: shown.id,
        expectedTurnId: shown.turnId,
        expectedFingerprint: shown.fingerprint,
      });
      const previousAnswers: number = fixture.calls.answer;
      const previousDrops = fixture.calls.answerReplyLost;
      fixture.loseNextQuestionReceipt(fault);
      await session.rpc(call);
      await waitFor(
        async () => (await operation(requestId)).state === expected,
        `A lost native answer receipt should settle as ${expected} when ${fault}`,
      );
      assert.equal((await session.rpc<{ state: string }>(call)).state, expected, 'The same answer operation lost its recorded state');
      assert.equal(fixture.calls.answer, previousAnswers + 1, 'Lost receipt replayed the native answer');
      assert.equal(fixture.calls.answerReplyLost, previousDrops + 1, 'Native fixture did not drop the HTTP reply');
      if (fault === 'committed') {
        await waitFor(
          () => latest?.canSend === true && [...updates.values()].some((message) => message.text === recoveredAnswerMarker),
          'Native execution did not resume after the recorded answer',
        );
      } else {
        assert.equal(latest?.requests?.[0]?.id, shown.id, 'The uncommitted question unexpectedly changed');
        fixture.dismissQuestion();
        await waitFor(() => latest?.canSend === true, 'Fixture did not dismiss the uncommitted question');
      }
    }
  }

  phase = 'one-time command approval and stale-scope rejection';
  for (const decision of ['decline', 'accept'] as const) {
    const previousApprovals: number = fixture.calls.approval;
    fixture.requestCommandApproval(decision === 'accept');
    await waitFor(
      () => latest?.requests?.some((request: any) => request.kind === 'command' && request.actionable),
      'Native command approval was not projected',
    );
    const approval: { id: string; turnId: string; fingerprint: string; description: string; decisions: string[] } = latest!.requests[0];
    assert.equal(approval.description, "printf 'fixture command'");
    assert.deepEqual(approval.decisions, ['accept', 'decline']);
    const scope = {
      targetRequestId: approval.id,
      expectedTurnId: approval.turnId,
      expectedFingerprint: approval.fingerprint,
    };
    if (decision === 'accept') {
      for (const invalid of [
        { decision: 'acceptForSession' },
        { expectedTurnId: 'fixture-stale-execution' },
        { expectedFingerprint: '0'.repeat(64) },
      ]) {
        const requestId = randomUUID();
        await session.rpc(scoped(`/threads/${threadId}/responses`, 'POST', {
          ...scope, decision, ...invalid, requestId,
        }));
        await waitFor(async () => (await operation(requestId)).state === 'rejected', 'Invalid command approval was accepted');
      }
      assert.equal(fixture.calls.approval, previousApprovals, 'An invalid approval reached Antigravity');
    }
    const requestId = randomUUID();
    const call = scoped(`/threads/${threadId}/responses`, 'POST', { ...scope, decision, requestId });
    await session.rpc(call);
    await waitFor(async () => (await operation(requestId)).state === 'completed', `Command ${decision} did not complete`);
    await session.rpc(call);
    assert.equal(fixture.calls.approval, previousApprovals + 1, `Command ${decision} dispatched more than once`);
    await waitFor(() => latest?.canSend === true, 'Command decision did not close the request');
  }

  phase = 'send and duplicate send';
  const skillList = await session.rpc<{ skills: { id: string; name: string }[] }>(
    scoped(`/threads/${threadId}/skills`),
  );
  assert.equal(skillList.skills.length, 1, 'System commands leaked into selectable skills');
  const skillId = skillList.skills[0].id;
  assert.match(skillId, /^[a-f0-9]{64}$/);
  fixture.setSkillsEnabled(false);
  const staleSkillId = randomUUID();
  await session.rpc(
    scoped(`/threads/${threadId}/messages`, 'POST', {
      requestId: staleSkillId,
      text: 'fixture stale skill',
      skillIds: [skillId],
    }),
  );
  await waitFor(
    async () => (await operation(staleSkillId)).state === 'rejected',
    'Removed native skill was not rejected',
  );
  assert.equal(fixture.calls.send, 0, 'Stale native skill reached SendUserCascadeMessage');
  fixture.setSkillsEnabled(true);
  phase = 'native selectable plugin and stale scope rejection';
  const readPlugins = (id: string) =>
    session!.rpc<{ plugins: { id: string; name: string; description: string }[] }>(
      scoped(`/threads/${id}/plugins`),
    );
  const { plugins } = await readPlugins(threadId);
  assert.equal(plugins.length, 1);
  const [plugin] = plugins;
  assert.match(plugin.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(plugin, {
    id: plugin.id, name: nativePlugin.displayName, description: 'Fixture plugin description',
  });
  assert.notEqual(plugin.id, (await readPlugins(switchId)).plugins[0].id);
  fixture.setPluginEnabled(false);
  const stalePluginId = randomUUID();
  await session.rpc(
    scoped(`/threads/${threadId}/messages`, 'POST', {
      requestId: stalePluginId, text: 'fixture stale plugin', pluginIds: [plugin.id],
    }),
  );
  await waitFor(
    async () => (await operation(stalePluginId)).state === 'rejected',
    'Removed native plugin was not rejected',
  );
  assert.equal(fixture.calls.send, 0, 'Stale native plugin reached SendUserCascadeMessage');
  fixture.setPluginEnabled(true);
  if (!oldGateway) {
    fixture.setNextModelEnabled(false);
    const staleModelId = randomUUID();
    await session.rpc(scoped('/threads/' + threadId + '/messages', 'POST', {
      requestId: staleModelId,
      text: 'fixture removed model',
      model: 'fixture-next',
    }));
    await waitFor(
      async () => (await operation(staleModelId)).state === 'rejected',
      'Removed message model was not rejected',
    );
    assert.equal(fixture.calls.send, 0, 'Removed model reached SendUserCascadeMessage');
    fixture.setNextModelEnabled(true);
  }
  const digest = createHash('sha256').update(fixtureImage).digest('hex');
  const upload = await session.rpc<{ id: string }>(scoped(`/threads/${threadId}/uploads`, 'POST', {
    name: 'fixture.png', size: fixtureImage.length, sha256: digest, hashes: [digest],
  }));
  const data = { backendId, threadId, fileId: upload.id };
  assert(host);
  const ready = await session.ready;
  const bulk = await nodeSession(
    origin, host, phone, ready.ticket,
    { type: 'authenticate', protocol: 2, sessionId: ready.sessionId }, 'bulk',
  );
  let originalUpload: string;
  try {
    await bulk.request('file', { ...data, action: 'write', index: 0 }, fixtureImage);
    originalUpload = (await bulk.request('file', { ...data, action: 'finish' })).value.path;
  } finally {
    bulk.close();
  }
  const sendId = randomUUID();
  const send = scoped(`/threads/${threadId}/messages`, 'POST', {
    requestId: sendId,
    text: 'fixture send once',
    skillIds: [skillId],
    pluginIds: [plugin.id],
    uploadIds: [upload.id],
    ...(!oldGateway && { model: 'fixture-next' }),
  });
  await session.rpc(send);
  await waitFor(
    async () => ['accepted', 'completed'].includes((await operation(sendId)).state),
    'Send operation was not accepted',
  );
  await session.rpc(send);
  assert.equal(fixture.calls.send, 1, 'Duplicate request dispatched a second native send');
  assert.deepEqual(await readFile(originalUpload), fixtureImage, 'App moved the gateway upload');
  const withImage = await session.rpc<{
    messages: { text: string; attachments?: { name: string; path: string; media?: string }[] }[];
  }>(scoped(`/threads/${threadId}/history`));
  const attachment = withImage.messages.find((msg) => msg.text === 'fixture send once')?.attachments?.[0];
  assert(attachment && attachment.name === 'fixture.png' && attachment.media === 'image');
  const download = await session.rpc<{ id: string; mime: string }>(
    scoped(`/threads/${threadId}/media`, 'POST', { path: attachment.path }),
  );
  assert.equal(download.mime, 'image/png');
  const verifyBulk = await nodeSession(
    origin, host, phone, ready.ticket,
    { type: 'authenticate', protocol: 2, sessionId: ready.sessionId }, 'bulk',
  );
  try {
    const fetched = await verifyBulk.request('file', {
      backendId, threadId, fileId: download.id, action: 'read', index: 0,
    });
    assert.deepEqual(Buffer.from(fetched.bytes!), fixtureImage);
  } finally {
    verifyBulk.close();
  }
  await waitFor(() => latest?.activeTurnId, 'Running Antigravity turn was not synchronized');
  const turn = latest!.activeTurnId;
  phase = 'same-execution native append and stale turn rejection';
  assert.equal(latest!.canSteer, true);
  const steer = (requestId: string, expectedTurnId: string) =>
    scoped(`/threads/${threadId}/steer`, 'POST', {
      requestId, expectedTurnId, text: 'fixture append to active execution',
    });
  const staleSteerId = randomUUID();
  await session.rpc(steer(staleSteerId, 'stale-turn'));
  await waitFor(
    async () => (await operation(staleSteerId)).state === 'rejected',
    'Stale append operation was not rejected',
  );
  const photoSteerId = randomUUID();
  await session.rpc(scoped(`/threads/${threadId}/steer`, 'POST', {
    requestId: photoSteerId, expectedTurnId: turn, text: 'fixture append with photo', uploadIds: [upload.id],
  }));
  await waitFor(
    async () => (await operation(photoSteerId)).state === 'rejected',
    'Append with an uploaded photo was not rejected',
  );
  assert.equal(fixture.calls.steer, 0, 'Stale append reached the Antigravity RPC');
  const steerId = randomUUID();
  await session.rpc(steer(steerId, turn));
  await waitFor(
    async () => (await operation(steerId)).turnId === turn,
    'Native appended message was not correlated to the current execution',
  );
  await session.rpc(steer(steerId, turn));
  assert.equal(fixture.calls.steer, 1, 'Duplicate append reached the Antigravity RPC');
  phase = 'native queue add and stable-ID removal';
  const queueId = randomUUID();
  const emptyQueue = latest!.queueFingerprint;
  assert.match(emptyQueue, /^[a-f0-9]{64}$/);
  const queue = scoped(`/threads/${threadId}/queue`, 'POST', {
    requestId: queueId,
    expectedQueueFingerprint: emptyQueue,
    text: 'fixture queue first',
  });
  await session.rpc(queue);
  await waitFor(
    async () => (await operation(queueId)).state === 'completed',
    'Native queue add did not complete',
  );
  await waitFor(() => latest?.queuedMessages?.length === 1, 'Native queue item was not synchronized');
  assert.equal(latest!.queuedMessages[0].text, 'fixture queue first');
  assert(![...updates.values()].some((message) => message.text === 'fixture queue first'));
  await session.rpc(queue);
  assert.equal(fixture.calls.queueAdd, 1, 'Duplicate request queued twice');

  const staleQueueId = randomUUID();
  await session.rpc(
    scoped(`/threads/${threadId}/queue`, 'POST', {
      requestId: staleQueueId,
      expectedQueueFingerprint: emptyQueue,
      text: 'fixture stale queue',
    }),
  );
  await waitFor(
    async () => (await operation(staleQueueId)).state === 'rejected',
    'Stale native queue add was accepted',
  );
  assert.equal(fixture.calls.queueAdd, 1, 'Stale queue fingerprint reached the native send API');

  const secondQueueId = randomUUID();
  await session.rpc(
    scoped(`/threads/${threadId}/queue`, 'POST', {
      requestId: secondQueueId,
      expectedQueueFingerprint: latest!.queueFingerprint,
      text: 'fixture queue second',
    }),
  );
  await waitFor(() => latest?.queuedMessages?.length === 2, 'Second native queue item was not synchronized');
  const [firstQueued, secondQueued] = latest!.queuedMessages;
  assert.equal(secondQueued.text, 'fixture queue second');
  assert.notEqual(firstQueued.id, queueId, 'Fixture did not exercise the distinct native queue identifier');
  const staleRemoveId = randomUUID();
  await session.rpc(
    scoped(`/threads/${threadId}/queue-remove`, 'POST', {
      requestId: staleRemoveId,
      expectedQueueFingerprint: emptyQueue,
      messageId: firstQueued.id,
    }),
  );
  await waitFor(
    async () => (await operation(staleRemoveId)).state === 'rejected',
    'Stale queue deletion was accepted',
  );
  assert.equal(fixture.calls.queueRemove, 0, 'Stale queue deletion reached the native delete API');

  for (const item of [firstQueued, secondQueued]) {
    const requestId = randomUUID();
    const remove = scoped(`/threads/${threadId}/queue-remove`, 'POST', {
      requestId,
      expectedQueueFingerprint: latest!.queueFingerprint,
      messageId: item.id,
    });
    await session.rpc(remove);
    await waitFor(
      async () => (await operation(requestId)).state === 'completed',
      'Native queue deletion did not complete',
    );
    await waitFor(
      () => !latest?.queuedMessages?.some((row: any) => row.id === item.id),
      'Deleted native queue item remained visible',
    );
    await session.rpc(remove);
    if (item === firstQueued) assert.deepEqual(latest!.queuedMessages, [secondQueued]);
  }
  assert.equal(fixture.calls.queueRemove, 2, 'Duplicate deletion reached the native delete API');
  assert.equal(latest!.queueFingerprint, emptyQueue);
  phase = 'stale interrupt';
  const staleId = randomUUID();
  await session.rpc(
    scoped(`/threads/${threadId}/interrupt`, 'POST', { requestId: staleId, expectedTurnId: 'stale-turn' }),
  );
  await waitFor(
    async () => ['rejected', 'failed', 'uncertain'].includes((await operation(staleId)).state),
    'Stale interrupt was not rejected',
  );
  assert.equal(fixture.calls.interrupt, 0, 'Stale expectedTurnId reached native cancellation');
  const interruptId = randomUUID();
  phase = 'interrupt';
  await session.rpc(
    scoped(`/threads/${threadId}/interrupt`, 'POST', { requestId: interruptId, expectedTurnId: turn }),
  );
  await waitFor(
    async () => ['completed', 'interrupted'].includes((await operation(interruptId)).state),
    'Interrupt operation was not confirmed',
  );
  assert.equal(fixture.calls.interrupt, 1);
  await waitFor(() => latest?.activeTurnId === null, 'Completed turn was not synchronized');

  const createId = randomUUID();
  phase = 'create with first-message model and duplicate create';
  const create = scoped('/threads/new/create', 'POST', {
    requestId: createId,
    prompt: 'fixture create once',
    projectId,
    title: '原生测试会话',
    model: 'fixture-next',
  });
  await session.rpc(create);
  await waitFor(
    async () => (await operation(createId)).state === 'completed',
    'Create operation was not completed',
  );
  assert.equal((await operation(createId)).resultThreadId, createdId);
  await session.rpc(create);
  assert.equal(fixture.calls.create, 1, 'Duplicate create dispatched twice');
  assert.equal(fixture.calls.rename, 1, 'Creation title did not reach native annotations exactly once');

  phase = 'rename and duplicate rename';
  const renameId = randomUUID();
  const newTitle = '远程改名 · Fixture';
  const rename = scoped(`/threads/${threadId}/rename`, 'POST', { requestId: renameId, title: newTitle });
  await session.rpc(rename);
  await waitFor(async () => (await operation(renameId)).state === 'completed', 'Rename was not completed');
  await waitFor(() => latest?.title === newTitle, 'Native title was not synchronized');
  const renamed = await session.rpc<{ threads: { id: string; title: string }[] }>(scoped('/threads'));
  assert(renamed.threads.some((thread) => thread.id === threadId && thread.title === newTitle));
  await session.rpc(rename);
  assert.equal(fixture.calls.rename, 2, 'Duplicate rename reached native annotations');

  const missingRename = randomUUID();
  await session.rpc(
    scoped('/threads/44444444-4444-4444-8444-444444444444/rename', 'POST', {
      requestId: missingRename,
      title: 'Rename must not reach the native API',
    }),
  );
  await waitFor(
    async () => (await operation(missingRename)).state === 'rejected',
    'Unknown rename target was accepted',
  );
  assert.equal(fixture.calls.rename, 2, 'Unknown rename target reached native annotations');

  phase = 'uncertain rename and no replay';
  const uncertainRenameId = randomUUID();
  const uncertainRename = scoped(`/threads/${threadId}/rename`, 'POST', {
    requestId: uncertainRenameId,
    title: 'fixture unknown rename outcome',
  });
  await session.rpc(uncertainRename);
  await waitFor(
    async () => (await operation(uncertainRenameId)).state === 'uncertain',
    'Lost rename response was not marked uncertain',
  );
  await session.rpc(uncertainRename);
  assert.equal(fixture.calls.rename, 3, 'An uncertain rename was replayed');

  if (!oldGateway) {
    phase = 'failed execution observation';
    const failedId = randomUUID();
    const failed = scoped(`/threads/${threadId}/messages`, 'POST', {
      requestId: failedId,
      text: 'fixture failed execution',
    });
    await session.rpc(failed);
    await waitFor(
      async () => (await operation(failedId)).state === 'failed',
      'A native executor error did not mark its correlated operation failed',
    );
    await session.rpc(failed);
    assert.equal(fixture.calls.send, 3, 'A failed execution was replayed');
  }
  const expectedSendCount = oldGateway ? 3 : 4;

  const uncertainId = randomUUID();
  phase = 'uncertain write and no replay';
  const uncertain = scoped(`/threads/${threadId}/messages`, 'POST', {
    requestId: uncertainId,
    text: 'fixture unknown outcome',
  });
  await session.rpc(uncertain);
  await waitFor(
    async () => (await operation(uncertainId)).state === 'uncertain',
    'A lost native write response was not marked uncertain',
  );
  await session.rpc(uncertain);
  assert.equal(fixture.calls.send, expectedSendCount, 'An uncertain write was replayed');

  await fixture.rotate();
  phase = 'daemon restart';
  assert(
    (await session.rpc<{ threads: { id: string }[] }>(scoped('/threads'))).threads.some(
      (thread) => thread.id === threadId,
    ),
    'Daemon token/port rotation did not recover',
  );
  if (pluginPid) {
    phase = 'plugin crash recovery';
    process.kill(pluginPid, 'SIGKILL');
    await waitFor(async () => {
      try {
        const status = await session!.rpc<{ connected: boolean }>(scoped('/status'));
        const replacement = await assertRustChildren(adapter!.child.pid!);
        return replacement && replacement !== pluginPid && status.connected;
      } catch {
        return false;
      }
    }, 'A crashed Rust plugin did not recover');
    const replacement = await assertRustChildren(adapter.child.pid!);
    assert(replacement && replacement !== pluginPid, 'Plugin recovery did not start a new process');
  }
  assert.equal(fixture.calls.send, expectedSendCount, 'Plugin reconnect replayed a prior send');
  unsubscribe();
  await session.request('unwatch', { backendId, threadId });
  session.close();
  session = undefined;
  await adapter.stop();
  phase = 'gateway restart and durable operations';
  adapter = await launch();
  session = await connect();
  assert.equal((await operation(createId)).resultThreadId, createdId, 'Restart lost durable create result');
  assert.equal(
    (await operation(uncertainRenameId)).state,
    'uncertain',
    'Restart lost unknown rename outcome',
  );
  assert.equal((await operation(uncertainId)).state, 'uncertain', 'Restart lost unknown write outcome');
  let restored = false;
  const removeRestored = session.onEvent((event) => {
    if (event.type === 'sync' && event.backendId === backendId && event.threadId === threadId) {
      restored ||= event.updates.some(
        (update: { thread: { synchronized?: boolean } }) => update.thread.synchronized,
      );
    }
  });
  try {
    await session.request('watch', { backendId, threadId });
    await waitFor(() => restored, 'Restart did not restore the Antigravity subscription');
  } finally {
    removeRestored();
  }
  await session.rpc(create);
  await session.rpc(uncertainRename);
  await session.rpc(uncertain);
  assert.equal(fixture.calls.create, 1, 'Restart replayed an existing create');
  assert.equal(fixture.calls.rename, 3, 'Restart replayed an uncertain rename');
  assert.equal(fixture.calls.send, expectedSendCount, 'Restart replayed an uncertain write');
  session.close();
  session = undefined;
  await adapter.stop();
  phase = 'read-only gateway';
  adapter = await launch(true);
  session = await connect();
  const status = await session.rpc<{
    connected: boolean;
    writesEnabled: boolean;
    capabilities: { questions: boolean; renameThread: boolean; queue: boolean; steer: boolean; nextMessageModel?: boolean };
  }>(scoped('/status'));
  assert.equal(status.connected, true);
  assert.equal(status.writesEnabled, false, 'Read-only mode still advertised writes');
  assert.equal(status.capabilities.questions, false, 'Read-only mode still advertised question responses');
  assert.equal(status.capabilities.nextMessageModel, oldGateway ? undefined : false);
  assert.equal(status.capabilities.renameThread, false, 'Read-only mode still advertised rename');
  assert.equal(status.capabilities.queue, false, 'Read-only mode still advertised queue');
  assert.equal(status.capabilities.steer, false, 'Read-only mode still advertised append');
  const readOnlyId = randomUUID();
  await assert.rejects(
    session.rpc(
      scoped(`/threads/${threadId}/messages`, 'POST', { requestId: readOnlyId, text: 'must not dispatch' }),
    ),
  );
  assert.equal(fixture.calls.send, expectedSendCount, 'Read-only request reached Antigravity');
  const readOnlyRenameId = randomUUID();
  await session.rpc(
    scoped(`/threads/${threadId}/rename`, 'POST', {
      requestId: readOnlyRenameId,
      title: 'Read-only rename must not dispatch',
    }),
  );
  await waitFor(
    async () => (await operation(readOnlyRenameId)).state === 'rejected',
    'Read-only rename was not rejected',
  );
  assert.equal(fixture.calls.rename, 3, 'Read-only rename reached native annotations');
  if (!oldGateway) {
    phase = 'auto-discovery';
    session.close();
    session = undefined;
    await adapter.stop();
    await rm(join(state, 'instances.json'));
    env.POCKET_NATIVE_ANTIGRAVITY_HOME = agentHome;
    adapter = await launch();
    session = await connect();
    const discovered = await session.rpc<{ backends: { id: string; product: string; connected: boolean }[] }>(
      apiCall('/backends'),
    );
    assert(
      discovered.backends.some(
        (backend) => backend.id === backendId && backend.product === 'antigravity' && backend.connected,
      ),
      'Installed Antigravity plugin was not auto-discovered without instances.json',
    );
    assert.equal(
      existsSync(join(state, 'instances.json')),
      false,
      'Auto-discovery rewrote instance configuration',
    );
    assert.equal(
      (await operation(createId)).resultThreadId,
      createdId,
      'Auto-discovery changed durable operation identity',
    );
    session.close();
    session = undefined;
    await adapter.stop();
    env.POCKET_NATIVE_ANTIGRAVITY = '0';
    adapter = await launch();
    session = await connect();
    const disabled = await session.rpc<{ backends: { id: string }[] }>(apiCall('/backends'));
    assert(
      !disabled.backends.some((backend) => backend.id === backendId),
      'Disabled auto-discovery still registered Antigravity',
    );
  }
  assert.deepEqual(fixture.errors, []);
  console.log(
    'Native Antigravity: framed SDK plugin, encrypted history/watch, grouped quotas, selectable skills and plugins, scoped stale-ID rejection, structured questions and continuation, one-time command approval, next-message model, verified photos, native queue, guarded same-execution append and interrupt, durable deduplication, daemon rotation, Rust process recovery, identity/pairing restart and read-only checks passed.',
  );
  if (browserFailure) {
    phase = 'browser acceptance';
    throw browserFailure;
  }
} catch (error) {
  console.error(`Native Antigravity smoke failed during ${phase}`);
  throw error;
} finally {
  session?.close();
  await adapter?.stop();
  await relay.app.close();
  await fixture.close();
  await rm(root, { recursive: true, force: true });
}

async function connect() {
  assert(host && pairingCode);
  const first = !ticket;
  const session = await nodeSession(
    origin,
    host,
    phone,
    ticket ?? createHash('sha256').update(pairingCode).digest('hex'),
    first
      ? {
          type: 'pair',
          protocol: 2,
          sessionId: randomUUID(),
          code: pairingCode,
          name: 'Antigravity fixture phone',
        }
      : { type: 'authenticate', protocol: 2, sessionId: randomUUID() },
  );
  const ready = await session.ready;
  ticket = ready.ticket;
  return session;
}

async function waitFor(check: () => unknown | Promise<unknown>, message: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(75);
  }
  throw Error(message);
}

async function testBrowserSwitching(channel: 'msedge' | 'chrome') {
  assert(host && pairingCode);
  const { chromium, expect } = await import('@playwright/test');
  const headed = process.env.POCKET_NATIVE_TEST_BROWSER_HEADED === '1';
  const browser = await chromium.launch({
    channel,
    headless: !headed,
    args: headed ? ['--window-size=3840,2160'] : [],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 3680, height: 2000 }, locale: 'zh-CN' });
    await page.addInitScript({
      content: `
        (() => {
          const sockets = [];
          const Socket = window.WebSocket;
          window.closeSyntheticControlLinks = () => {
            for (const socket of sockets) socket.close();
          };
          window.WebSocket = class extends Socket {
            constructor(url, protocols) {
              super(url, protocols);
              if (new URL(url, location.href).pathname === '/connect') sockets.push(this);
            }
          };
        })();
      `,
    });
    const errors: Error[] = [];
    let crashed = false;
    page.on('pageerror', (error) => errors.push(error));
    page.on('crash', () => {
      crashed = true;
    });
    await page.goto(`${origin}/?page=messages`);
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    await page.getByLabel('昵称', { exact: true }).fill('Antigravity 验收');
    await page.getByLabel('用户名', { exact: true }).fill('antigravity-fixture');
    await page.getByLabel('密码', { exact: true }).fill('fixture-antigravity-password');
    await page.getByRole('button', { name: '创建账户', exact: true }).click();
    await saveRecoveryCode(page);
    await expect(page.getByText('还没有聊天记录')).toBeVisible();
    await page.goto(`${origin}/#pair=${pairingCode}&host=${host}`);
    await page.getByRole('button', { name: '连接电脑', exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('page') === 'workbench' && !url.hash);
    await page.goto(`${origin}/?page=workbench&backend=${backendId}&thread=${threadId}`);
    await page.getByRole('tab', { name: '最近', exact: true }).click();
    const transcript = page.getByRole('region', { name: '聊天记录' });
    const sparseMarker = transcript.getByText('fixture answer', { exact: true });
    const denseMarker = transcript.getByText('Synthetic history marker.', { exact: true });
    const sparseThread = page.getByRole('button', { name: new RegExp(initialTitle) });
    await expect(sparseMarker).toBeVisible({ timeout: 15000 });
    fixture.failHistory(switchId);
    const denseThread = page.getByRole('button', { name: new RegExp(switchTitle) });
    await denseThread.click();
    const retry = transcript.getByRole('button', { name: '重新加载会话', exact: true });
    await expect(retry).toBeVisible({ timeout: 22000 });
    await expect(sparseMarker).toHaveCount(0);
    await retry.click();
    await expect(transcript.getByText('正在读取会话…', { exact: true })).toBeVisible();
    fixture.failHistory(undefined);
    await expect(denseMarker).toBeVisible({ timeout: 15000 });
    await sparseThread.click();
    await expect(sparseMarker).toBeVisible({ timeout: 15000 });
    for (let index = 0; index < 24; index++) {
      const dense = index % 2 === 0;
      await (dense ? denseThread : sparseThread).click();
      await page.waitForURL((url) => url.searchParams.get('thread') === (dense ? switchId : threadId));
      await expect(dense ? denseMarker : sparseMarker).toBeVisible({ timeout: 15000 });
      await expect(dense ? sparseMarker : denseMarker).toHaveCount(0);
      if (dense && index >= 12) {
        const tool = transcript.locator('.activity-group').last();
        await tool.locator('summary').click();
        await expect(tool.locator('.activity-body')).toBeVisible();
      }
    }
    await denseThread.click();
    await expect(denseMarker).toBeVisible({ timeout: 15000 });
    await page.reload();
    await page.getByRole('tab', { name: '最近', exact: true }).click();
    await expect(denseMarker).toBeVisible({ timeout: 15000 });
    const staleMarker = 'Synthetic delayed history from the other conversation.';
    const currentMarker = 'Synthetic history update after rapid switching.';
    const heldHistory = fixture.holdNextHistory(threadId, staleMarker);
    try {
      await sparseThread.click();
      await page.waitForURL((url) => url.searchParams.get('thread') === threadId);
      await expect.poll(() => heldHistory.started, { timeout: 15000 }).toBe(true);
      await denseThread.click();
      await page.waitForURL((url) => url.searchParams.get('thread') === switchId);
      await expect(denseMarker).toBeVisible({ timeout: 15000 });
    } finally {
      heldHistory.release();
    }
    await expect.poll(() => heldHistory.replied, { timeout: 15000 }).toBe(true);
    // A fresh update confirms the selected watch still works after the old response.
    fixture.appendHistoryMarker(switchId, currentMarker);
    await expect(transcript.getByText(currentMarker, { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(transcript.getByText(staleMarker, { exact: true })).toHaveCount(0);
    await expect(sparseMarker).toHaveCount(0);
    assert.equal(new URL(page.url()).searchParams.get('thread'), switchId);
    assert.equal(crashed, false, 'Browser renderer crashed after rapid Antigravity session switching');
    await sparseThread.click();
    await expect(sparseMarker).toBeVisible({ timeout: 15000 });

    const pagedRow = (index: number) =>
      transcript.getByText(`Synthetic paged record ${index}.`, { exact: true });
    fixture.beginPagedHistory();
    await denseThread.click();
    await expect(pagedRow(159)).toBeVisible({ timeout: 15000 });
    await expect(pagedRow(59)).toHaveCount(0);
    const older = transcript.getByRole('button', { name: '更早记录', exact: true });
    await older.click();
    await expect(pagedRow(0)).toBeVisible();
    await expect(older).toHaveCount(0);
    fixture.advancePagedHistory(1);
    await expect(pagedRow(160)).toBeVisible();
    await expect(pagedRow(60)).toHaveCount(1);
    await expect(pagedRow(110)).toHaveCount(1);
    for (const last of [190, 220]) {
      fixture.advancePagedHistory(30);
      await expect(pagedRow(last)).toBeVisible();
    }
    const pagedRecords = transcript.getByText(/^Synthetic paged record \d+\.$/);
    await expect(pagedRecords).toHaveText(
      Array.from({ length: 221 }, (_, index) => `Synthetic paged record ${index}.`),
    );
    fixture.advancePagedHistory(65);
    await expect(pagedRow(285)).toBeVisible();
    await expect(pagedRow(170)).toHaveCount(legacyHistory ? 0 : 1);
    await expect(pagedRow(220)).toHaveCount(legacyHistory ? 0 : 1);
    await expect(pagedRow(221)).toHaveCount(0);
    if (!legacyHistory) {
      const network = page.getByRole('button', { name: /^网络连接 · / });
      await page.context().setOffline(true);
      try {
        await page.evaluate(() => {
          const close = (window as Window & { closeSyntheticControlLinks?: () => void }).closeSyntheticControlLinks;
          if (!close) throw new Error('Synthetic WebSocket hooks missing');
          close();
        });
        await expect(network).toHaveAttribute('data-quality', 'offline', { timeout: 15000 });
        // The cached latest page predates the gap. It cannot reset the live history.
        await older.click();
        await expect(older).toBeEnabled();
        await expect(pagedRow(170)).toHaveCount(1);
        await expect(pagedRow(220)).toHaveCount(1);
      } finally {
        await page.context().setOffline(false);
        await page.evaluate(() => {
          window.dispatchEvent(new Event('online'));
          window.dispatchEvent(new Event('pageshow'));
        });
      }
      await expect(network).toHaveAttribute('data-quality', /^(relay|poor)$/, { timeout: 20000 });
    }
    for (const first of legacyHistory ? [136, 36, 0] : [221]) {
      await older.click();
      await expect(pagedRow(first)).toBeVisible();
    }
    await expect(pagedRecords).toHaveText(
      Array.from({ length: 286 }, (_, index) => `Synthetic paged record ${index}.`),
    );
    async function fillQuestions() {
      await page.getByRole('button', { name: '回答问题（3 题）' }).click();
      if (legacyQuestions) {
        await page.getByRole('radio', { name: '红', exact: true }).check();
      } else {
        await page.getByRole('radio', { name: '自行填写', exact: true }).check();
        await page.getByRole('textbox', { name: '你的回答', exact: true }).fill('红');
      }
      await page.getByRole('button', { name: '下一题' }).click();
      await page.getByRole('checkbox', { name: '甲', exact: true }).check();
      await page.getByRole('checkbox', { name: '乙', exact: true }).check();
      if (!legacyQuestions) {
        for (const { text } of extraQuestionOptions) {
          await page.getByRole('checkbox', { name: text, exact: true }).check();
        }
      }
      await page.getByRole('button', { name: '下一题' }).click();
      await page.getByRole('textbox', { name: '你的回答', exact: true }).fill('补充内容');
      await page.getByRole('button', { name: '核对答案' }).click();
      return page.getByRole('button', { name: '提交全部回答（3 题）' });
    }
    if (!legacyHistory) {
      const replacementRow = (index: number) =>
        transcript.getByText(`Synthetic replacement record ${index}.`, { exact: true });
      fixture.replacePagedHistory();
      await expect(replacementRow(285)).toBeVisible();
      await expect(pagedRecords).toHaveCount(0);
      await older.click();
      await expect(replacementRow(136)).toBeVisible();
      fixture.rewindPagedHistory(240);
      await expect(transcript.getByText('Synthetic rewind marker.', { exact: true })).toBeVisible();
      await expect(replacementRow(136)).toHaveCount(0);
      await expect(replacementRow(285)).toHaveCount(0);
      await expect(older).toBeVisible();
      if (!legacyQuestions) {
        await older.click();
        await expect(replacementRow(90)).toBeVisible();
        fixture.askQuestion(true, switchId);
        const answer = await fillQuestions();
        await expect(answer).toBeEnabled();
        const previousAnswers = fixture.calls.answer;
        fixture.failPagedHistory(true);
        try {
          await expect(answer).toBeDisabled();
        } finally {
          fixture.failPagedHistory(false);
        }
        await expect(answer).toBeEnabled();
        await answer.click();
        try {
          await expect.poll(() => fixture.calls.answer).toBe(previousAnswers + 1);
        } catch (error) {
          console.error('Synthetic bounded answer status:', {
            feedback: await page.locator('.question-feedback').allTextContents(),
            alerts: await page.getByRole('alert').allTextContents(),
            fixtureErrors: fixture.errors,
          });
          throw error;
        }
        await expect(transcript.getByText('fixture continued after answer', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: '回答问题（3 题）' })).toHaveCount(0);
        await expect(replacementRow(90)).toHaveCount(1);
      }
    }
    await page.getByRole('button', { name: new RegExp(initialTitle) }).click();
    await expect(sparseMarker).toBeVisible({ timeout: 15000 });
    await expect(pagedRow(160)).toHaveCount(0);
    await page.reload();
    await expect(sparseMarker).toBeVisible({ timeout: 15000 });
    fixture.askQuestion(!legacyQuestions);
    await (await fillQuestions()).click();
    await expect(transcript.getByText('fixture continued after answer', { exact: true })).toBeVisible();
    if (!oldGateway) {
      const picker = page.getByRole('button', { name: '选择下一条消息的模型' });
      await picker.click();
      await page.getByRole('button', { name: '选择模型', exact: true }).click();
      await page.getByRole('radio', { name: /Fixture next model/ }).click();
      await page.getByRole('button', { name: '用于下一条消息' }).click();
      await expect(picker).toHaveText('Fixture next model');
      await page.reload();
      await expect(transcript.getByText('fixture continued after answer', { exact: true })).toBeVisible();
      await expect(picker).toHaveText('Fixture next model');
    }

    await expect(page.getByLabel('添加附件', { exact: true })).toHaveCount(0);
    const photoInput = page.getByLabel('添加照片', { exact: true });
    // A cached transcript and model draft can render while the gateway watch
    // is still reconnecting. setInputFiles does not wait for an enabled input.
    await expect(photoInput).toBeEnabled({ timeout: 20000 });
    await page.getByRole('button', { name: '工具', exact: true }).click();
    await page.getByRole('button', { name: '插件', exact: true }).click();
    await page.getByRole('checkbox', { name: new RegExp(nativePlugin.displayName) }).check();
    await page.getByRole('button', { name: '添加到消息', exact: true }).click();
    await expect(page.getByRole('button', { name: `移除插件 ${nativePlugin.displayName}` })).toBeVisible();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('Fixture browser plugin and photo');
    await photoInput.setInputFiles({
      name: 'browser-fixture.png', mimeType: 'application/octet-stream', buffer: fixtureImage,
    });
    try {
      await expect(page.locator('.composer-attachments').getByText('browser-fixture.png', { exact: true }))
        .toBeVisible({ timeout: 20000 });
      await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
    } catch (error) {
      console.error('Synthetic photo upload status:', await page.locator('.upload-progress-panel').allTextContents());
      throw error;
    }
    const image = transcript.getByRole('img', { name: 'browser-fixture.png' });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
    await expect(page.getByRole('button', { name: /^移除下一条消息的模型/ })).toHaveCount(0);
    fixture.startQueueTurn();
    const composer = page.getByRole('textbox', { name: '消息', exact: true });
    const appended = 'Fixture browser appendix';
    await composer.fill(appended);
    await page.getByRole('button', { name: '追加指令 ↑', exact: true }).click();
    await expect(transcript.getByText(appended, { exact: true })).toBeVisible();
    fixture.startQueueTurn();
    await expect(page.getByRole('button', { name: '中断任务', exact: true })).toBeEnabled();
    const queuedText = 'Fixture browser queue text';
    await composer.fill(queuedText);
    await page.getByRole('button', { name: '排队', exact: true }).click();
    await page.getByRole('button', { name: '会话工具', exact: true }).click();
    const toolDialog = page.getByRole('dialog', { name: '会话工具' });
    await expect(toolDialog.getByText(queuedText, { exact: true })).toBeVisible();
    await toolDialog.getByRole('button', { name: '移除', exact: true }).click();
    await expect(toolDialog.getByText(queuedText, { exact: true })).toHaveCount(0);
    assert.equal(crashed, false, 'Browser renderer crashed while using Antigravity');
    assert.deepEqual(errors, [], 'Antigravity workbench raised page errors');
    if (recoverRenderer) {
      await page.keyboard.press('Escape');
      await page.getByRole('tab', { name: '最近', exact: true }).click();
      fixture.beginPagedHistory();
      await denseThread.click();
      await page.waitForURL((url) => url.searchParams.get('thread') === switchId);
      const beforeCrash = 'Synthetic marker before renderer loss.';
      const updateWhileDown = 'Synthetic update during renderer loss.';
      fixture.appendHistoryMarker(switchId, beforeCrash);
      await expect(transcript.getByText(beforeCrash, { exact: true })).toBeVisible({ timeout: 15000 });
      const originalUrl = page.url();

      async function protocolDeadline<T>(pending: Promise<T>, label: string) {
        return Promise.race([
          pending,
          delay(7000, undefined, { ref: false }).then(() => { throw new Error(label + ' timed out'); }),
        ]);
      }
      const originalSession = await page.context().newCDPSession(page);
      const targetBefore = await protocolDeadline(originalSession.send('Target.getTargetInfo'), 'Original target lookup');
      const rendererLoss = page.waitForEvent('crash', { timeout: 12000 });
      void originalSession.send('Page.crash').catch(() => {});
      await rendererLoss;
      assert.equal(crashed, true, 'The browser did not report a renderer crash');
      fixture.appendHistoryMarker(switchId, updateWhileDown);
      fixture.askQuestion(true, switchId);

      // Playwright invalidates normal locators after a crash. A fresh protocol
      // session drives and observes refresh on the original browser tab.
      const recoverySession = await protocolDeadline(page.context().newCDPSession(page), 'Attach to the crashed tab');
      const targetAfter = await protocolDeadline(recoverySession.send('Target.getTargetInfo'), 'Restored target lookup');
      assert.equal(targetAfter.targetInfo.targetId, targetBefore.targetInfo.targetId);
      const started = performance.now();
      await protocolDeadline(recoverySession.send('Page.reload', { ignoreCache: true }), 'Reload the original tab');
      const inspect = `(() => {
        const transcript = document.querySelector('[aria-label="聊天记录"]');
        const text = transcript?.textContent ?? '';
        return {
          url: location.href,
          before: text.includes(${JSON.stringify(beforeCrash)}),
          during: text.includes(${JSON.stringify(updateWhileDown)}),
          freshQuestion: Boolean(transcript?.querySelector('.question-open[aria-label^="回答问题"]')),
          leakedOtherConversation: text.includes('fixture answer'),
        };
      })()`;
      await waitFor(async () => {
        try {
          const { result } = await protocolDeadline(recoverySession.send('Runtime.evaluate', { expression: inspect, returnByValue: true }), 'Read restored history');
          const snapshot = result.value;
          return snapshot?.url === originalUrl && snapshot.before && snapshot.during &&
            snapshot.freshQuestion && !snapshot.leakedOtherConversation;
        } catch {
          // The previous JavaScript context is gone until the new renderer starts.
          return false;
        }
      }, 'The refreshed tab did not restore the same history, live update and pending question');

      const restoreMs = Math.round(performance.now() - started);

      async function actInRestoredRenderer(expression: string, label: string) {
        await waitFor(async () => {
          const { result } = await protocolDeadline(recoverySession.send('Runtime.evaluate', { expression, returnByValue: true }), 'Use restored question');
          return result.value === true;
        }, label);
      }
      async function clickRestored(label: string, selector = '.question-dialog button') {
        await actInRestoredRenderer(`(() => {
          const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find((element) =>
            element.getAttribute('aria-label') === ${JSON.stringify(label)}
              || element.textContent.trim() === ${JSON.stringify(label)},
          );
          if (!button || button.matches(':disabled')) return false;
          button.click();
          return true;
        })()`, 'Could not click restored ' + label);
      }
      async function selectRestored(label: string) {
        await actInRestoredRenderer(`(() => {
          const option = [...document.querySelectorAll('.question-dialog .question-option')].find(
            (element) => element.textContent.trim() === ${JSON.stringify(label)},
          );
          const input = option?.querySelector('input');
          if (!input || input.matches(':disabled')) return false;
          input.click();
          return true;
        })()`, 'Could not choose restored option ' + label);
      }
      async function writeRestored(value: string) {
        await actInRestoredRenderer(`(() => {
          const textarea = document.querySelector('.question-dialog textarea[aria-label="你的回答"]');
          if (!textarea || textarea.matches(':disabled')) return false;
          textarea.value = ${JSON.stringify(value)};
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`, 'Could not fill the restored question');
      }
      const previousAnswers = fixture.calls.answer;
      const previousLostReceipts = fixture.calls.answerReplyLost;
      await clickRestored('回答问题（3 题）', '.question-open');
      await selectRestored('自行填写');
      await writeRestored('红');
      await clickRestored('下一题');
      for (const { text } of [{ text: '甲' }, { text: '乙' }, ...extraQuestionOptions]) {
        await selectRestored(text);
      }
      await clickRestored('下一题');
      await writeRestored('补充内容');
      await clickRestored('核对答案');
      fixture.loseNextQuestionReceipt('committed');
      await clickRestored('提交全部回答（3 题）');
      await actInRestoredRenderer(`(() => {
        const transcript = document.querySelector('[aria-label="聊天记录"]');
        return transcript?.textContent.includes(${JSON.stringify(recoveredAnswerMarker)}) &&
          !transcript.querySelector('.question-open');
      })()`, 'The restored question did not reach native continuation');
      assert.equal(fixture.calls.answer, previousAnswers + 1);
      assert.equal(fixture.calls.answerReplyLost, previousLostReceipts + 1);
      console.log(
        `Confirmed renderer loss and same-tab recovery in ${restoreMs} ms in ${channel} ${browser.version()} `
        + `(${process.platform}, ${headed ? 'headed' : 'headless'}): selected paged conversation, existing messages, new native event; `
        + `the original native task continued after one answer despite a lost acknowledgement.`,
      );
    }

    console.log(
      `Antigravity session switching (including a delayed response after reload), history retry and pagination, questions, next-message model, plugins, photos, same-task append and queue UI passed in ${channel} ${browser.version()} (${process.platform}, ${headed ? 'headed' : 'headless'}).`,
    );
  } finally {
    await browser.close();
  }
}

async function launch(readOnly = false) {
  if (process.platform === 'win32') {
    for (const name of ['device-identity-v2.json', 'state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm']) {
      if (existsSync(join(state, name))) platformRuntime().privateFile(join(state, name));
    }
  }
  const child = spawn(executable, ['--headless', '--print-pair'], {
    env: { ...env, POCKET_NATIVE_READ_ONLY: readOnly ? '1' : '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4000);
  });
  const exited = once(child, 'close');
  void exited.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => lines.close(), 15_000);
  const stop = async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  };
  try {
    for await (const line of lines) {
      if (!line.startsWith(origin)) continue;
      const params = new URLSearchParams(new URL(line).hash.slice(1));
      if (host)
        assert.equal(params.get('host'), host, 'Native adapter replaced the existing device identity');
      host ??= params.get('host') ?? undefined;
      pairingCode = params.get('pair') ?? undefined;
      assert(host && pairingCode);
      return { child, stop };
    }
    throw Error(`Native adapter did not become ready: ${diagnostics}`);
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function assertRustChildren(parent: number): Promise<number | undefined> {
  if (process.platform !== 'linux') return undefined;
  // Tokio may spawn the plugin from any worker thread. Linux exposes each
  // child's parent task, so checking only the process leader misses real hosts.
  const childrenOf = async (pid: number) => {
    const tasks = await readdir(`/proc/${pid}/task`);
    const rows = await Promise.all(
      tasks.map((task) => readFile(`/proc/${pid}/task/${task}/children`, 'utf8').catch(() => '')),
    );
    return [...new Set(rows.flatMap((row) => row.trim().split(/\s+/).filter(Boolean).map(Number)))];
  };
  const children = await childrenOf(parent);
  assert(children.length > 0, 'Native adapter did not start an independent plugin process');
  let plugin: number | undefined;
  const inspect = async (pid: number) => {
    const image = await readlink(`/proc/${pid}/exe`);
    assert(
      !/^(?:node|python(?:\d+(?:\.\d+)*)?)$/i.test(basename(image)),
      `Unexpected bundled runtime ${basename(image)}`,
    );
    if (/^agent-space-adapter-antigravity(?:\.exe)?$/.test(basename(image))) plugin = pid;
    const descendants = await childrenOf(pid);
    for (const descendant of descendants) await inspect(descendant);
  };
  for (const child of children) await inspect(child);
  assert(plugin, 'Antigravity was not running as a separate Rust plugin');
  return plugin;
}

async function testPluginProcess() {
  const child = spawn(pluginExecutable, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'close');
  void exited.catch(() => {});
  child.stderr.resume();
  const generation = randomUUID();
  const pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  let bytes = Buffer.alloc(0);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length) {
      const boundary = bytes.indexOf('\r\n\r\n');
      if (boundary < 0) {
        assert(bytes.length <= 128);
        return;
      }
      const size = Number(/^Content-Length: ([0-9]+)$/.exec(bytes.subarray(0, boundary).toString())?.[1]);
      assert(size > 0 && size <= 8 * 1024 * 1024, 'Invalid framed native response length');
      if (bytes.length < boundary + 4 + size) return;
      const reply = JSON.parse(bytes.subarray(boundary + 4, boundary + 4 + size).toString());
      bytes = bytes.subarray(boundary + 4 + size);
      if (reply.method) continue;
      const entry = pending.get(reply.id);
      assert(entry, 'Native plugin response lost correlation');
      assert.equal(reply.generation, generation);
      clearTimeout(entry.timer);
      pending.delete(reply.id);
      entry.resolve(reply);
    }
  });
  child.on('close', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Error('Native plugin exited before replying'));
    }
    pending.clear();
  });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = randomUUID();
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, generation } }),
    );
    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('Native plugin response timed out'));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    return result;
  };
  try {
    assert.equal((await request('adapter/check', { sdk: 1 })).result.sdk, 1);
    assert.equal(
      (
        await request('adapter/initialize', {
          sdk: 1,
          id: backendId,
          name: 'Fixture Antigravity',
          stateDirectory: join(root, 'direct-plugin-state'),
          readOnly: false,
          config: { home: agentHome },
        })
      ).result.sdk,
      1,
    );
    const info = await request('adapter/status');
    assert.equal(info.result.info.id, backendId);
    assert.equal(info.result.info.product, 'antigravity');
    assert.equal(info.result.info.connected, true);
    assert.equal(info.result.status.writesEnabled, true);
    assert.equal(info.result.status.capabilities.renameThread, true);
    assert.equal(info.result.status.capabilities.nextMessageModel, undefined);
    const unsupportedModel = await request('adapter/write', {
      thread: threadId,
      requestId: randomUUID(),
      action: { Send: { text: 'fixture legacy host model violation', model: 'fixture-next' } },
    });
    assert.equal(unsupportedModel.result.state, 'rejected');
    assert.equal(fixture.calls.send, 0, 'A host without message model support sent the message');
    if (!oldGateway) {
      assert.equal(
        info.result.info.presentation.creation.empty,
        true,
        'Antigravity must allow creating its first conversation without an anchor thread',
      );
    }
    assert(!JSON.stringify(info).includes(fixture.token), 'Product credentials escaped plugin boundary');
    const history = await request('adapter/read', {
      method: 'history.read',
      params: { id: threadId },
      query: {},
    });
    assert(history.result.messages.some((message: { text: string }) => message.text === 'fixture answer'));
    assert.equal(history.result.thread.historyTrajectoryId, legacyHistory ? undefined : trajectoryId);
    assert.equal(history.result.thread.historyStepCount, legacyHistory ? undefined : 2);
    const watchId = randomUUID();
    await waitFor(async () => {
      const view = await request('adapter/view', { thread: threadId, watchId });
      return (
        view.result?.thread?.synchronized &&
        view.result.messages.some((message: { text: string }) => message.text === 'fixture answer')
      );
    }, 'Native plugin subscription did not become ready');
    await request('adapter/unwatch', { thread: threadId, watchId });
    const unsupported = await request('GetAllCascadeTrajectories');
    assert.equal(typeof unsupported.error.message, 'string');
    assert.equal(
      (await request('adapter/status')).result.info.connected,
      true,
      'Business error corrupted plugin framing',
    );
    fixture.clearHistory();
    assert.deepEqual(
      (
        await request('adapter/read', {
          method: 'threads.list',
          params: {},
          query: {},
        })
      ).result.threads,
      [],
    );
    const firstChat = await request('adapter/write', {
      thread: 'new',
      requestId: randomUUID(),
      action: {
        Create: {
          title: null,
          prompt: 'fixture first conversation',
          project: projectId,
          settings: {},
        },
      },
    });
    assert.equal(firstChat.result.state, 'completed');
    assert.equal(
      firstChat.result.resultThreadId,
      createdId,
      'An empty Antigravity history could not create its first project conversation',
    );
    fixture.reset();
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    for (const entry of pending.values()) clearTimeout(entry.timer);
  }
}

async function agentFixture() {
  const calls = {
    send: 0,
    steer: 0,
    interrupt: 0,
    create: 0,
    answer: 0,
    answerReplyLost: 0,
    approval: 0,
    rename: 0,
    queueAdd: 0,
    queueRemove: 0,
    quotaRefresh: [] as boolean[],
  };
  const errors: string[] = [];
  let token = 'synthetic-daemon-token-one';
  let quotaMode: 'primary' | 'unsupported' | 'none' = 'primary';
  let skillsEnabled = true;
  let pluginEnabled = true;
  let nextModelEnabled = true;
  let unavailableHistory: string | undefined;
  let heldHistory: ReturnType<typeof holdNextHistory> | undefined;
  let pagedHistory = false;
  let pagedHistoryUnavailable = false;
  let pagedTrajectoryId = trajectoryId;
  let extendedQuestions = false;
  let nextQuestionReceiptFault: QuestionReceiptFault | undefined;
  let expectedCommandApproval: boolean | undefined;
  const skillInfo = {
    name: 'fixture-skill',
    type: 'SLASH_COMMAND_TYPE_SKILL',
    definitionPath: 'file:///fixture/skill/SKILL.md',
    modelFacingText: 'Fixture native skill instruction',
  };
  let server: ReturnType<typeof createServer>;
  type Conversation = {
    running: boolean;
    steps: Record<string, unknown>[];
    pending?: { id: string; requestId: string; text: string }[];
    annotations?: { title: string };
    executorMetadatas?: { executionId: string; terminationReason: string }[];
  };
  const initial = (): Conversation => ({
    running: false,
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        metadata: { executionId: 'history-execution' },
        userInput: { items: [{ text: 'fixture question' }] },
      },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        metadata: { executionId: 'history-execution' },
        plannerResponse: {
          response: 'fixture answer',
          thinking: 'private synthetic reasoning',
          signature: 'private synthetic signature',
        },
      },
    ],
  });
  const conversations = new Map<string, Conversation>();
  function resetConversations() {
    conversations.clear();
    conversations.set(threadId, initial());
    if (!browserChannel) {
      conversations.set(switchId, { running: false, steps: [] });
      return;
    }
    // Exercise the expensive render branches without using private chat history.
    const code = [
      '```typescript',
      ...Array.from({ length: 48 }, (_, i) => `const item${i} = { value: ${i}, active: true };`),
      '```',
    ].join('\n');
    const steps = Array.from({ length: 22 }, (_, i) => {
      const metadata = { executionId: `synthetic-dense-${i}` };
      return [
        {
          type: 'CORTEX_STEP_TYPE_USER_INPUT',
          metadata,
          userInput: { items: [{ text: `Synthetic prompt ${i}` }] },
        },
        ...Array.from({ length: 5 }, (_, command) => ({
          type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
          metadata,
          runCommand: {
            commandLine: `fixture-command ${command}`,
            combinedOutput: { full: 'synthetic output\n'.repeat(500) },
          },
        })),
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          metadata,
          plannerResponse: {
            response: i === 21 ? 'Synthetic history marker.' : `## Synthetic response ${i}\n\n${code}`,
          },
        },
      ];
    }).flat();
    conversations.set(switchId, { running: false, steps });
  }
  resetConversations();
  const command = "printf 'fixture command'";
  const nativeQuestions = [
    {
      question: '选颜色',
      options: [
        { id: 'red', text: '红' },
        { id: 'blue', text: '蓝' },
      ],
    },
    {
      question: '选择多项',
      isMultiSelect: true,
      options: [
        { id: 'first', text: '甲' },
        { id: 'second', text: '乙' },
        ...extraQuestionOptions,
      ],
    },
    { question: '写点什么' },
  ];
  const whenIdle = 'MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE';
  function protobufPart(tag: number, data: string | Buffer) {
    const value = typeof data === 'string' ? Buffer.from(data) : data;
    assert(value.length < 128, 'Choose short synthetic protobuf fixture fields');
    const key = (tag << 3) | 2;
    return Buffer.concat([
      Buffer.from(key < 128 ? [key, value.length] : [(key & 127) | 128, key >> 7, value.length]),
      value,
    ]);
  }
  function queueFrame(body: {
    conversationId: string;
    initialStepsPageBounds?: { startIndex?: number; endIndexExclusive?: number };
  }) {
    const id = body.conversationId;
    const conversation = conversations.get(id);
    assert(conversation, 'Requested unknown queue fixture conversation');
    const pending = conversation.pending ?? [];
    const bounds = body.initialStepsPageBounds;
    const paged = pagedHistory && id === switchId;
    const start = bounds?.startIndex ?? 0;
    const end = bounds?.endIndexExclusive ?? 0;
    const total = conversation.steps.length;
    if (paged && total > 160 && end === total && end - start > 50) {
      // A native update can exceed the byte cap as its newest step grows.
      // Its frame prefix is sufficient for the plugin to narrow the request.
      const header = Buffer.alloc(5);
      header.writeUInt32BE(32 * 1024 * 1024 + 1, 1);
      return header;
    }
    const steps = paged ? conversation.steps.slice(start, end) : [];
    const update = {
      conversationId: id,
      trajectoryId: nativeTrajectoryId(id),
      status: conversation.running ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
      mainTrajectoryUpdate: paged
        ? {
            stepsUpdate: {
              pageBounds: bounds,
              totalLength: total,
              indices: steps.map((_, index) => start + index),
              steps,
            },
          }
        : {},
      ...(pending.length && {
        pendingAgentMessagesUpdate: {
          indices: pending.map((_, index) => index),
          totalLength: pending.length,
          pendingAgentMessages: pending.map((row) => ({
            id: row.id,
            recipient: id,
            deliveryStrategy: whenIdle,
            stepPayload: protobufPart(
              19,
              Buffer.concat([protobufPart(3, protobufPart(1, row.text)), protobufPart(19, row.requestId)]),
            ).toString('base64'),
          })),
        },
      }),
    };
    const payload = Buffer.from(JSON.stringify({ update }));
    const header = Buffer.alloc(5);
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
  }
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      assert.equal(request.headers['x-codeium-csrf-token'], token);
      assert.equal(request.headers['connect-protocol-version'], '1');
      assert(request.url?.startsWith('/exa.language_server_pb.LanguageServerService/'));
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const method = request.url?.split('/').at(-1);
      const bytes = Buffer.concat(chunks);
      if (method === 'StreamAgentStateUpdates') {
        assert.equal(request.headers['content-type'], 'application/connect+json');
        assert.equal(bytes[0], 0);
        assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
        const streamRequest = JSON.parse(bytes.subarray(5).toString());
        if (pagedHistoryUnavailable && streamRequest.conversationId === switchId) {
          response.writeHead(503, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ code: 'unavailable', message: 'Synthetic paged history outage' }));
          return;
        }
        const frame = queueFrame(streamRequest);
        response.setHeader('Content-Type', 'application/connect+json');
        response.write(frame.subarray(0, 3));
        response.end(frame.subarray(3));
        return;
      }
      const body = JSON.parse(bytes.toString() || '{}');
      if (method === 'GetCascadeTrajectory' && body.cascadeId === unavailableHistory) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ code: 'unavailable', message: 'Synthetic history outage' }));
        return;
      }
      if (method === 'GetCascadeTrajectory' && pagedHistory && body.cascadeId === switchId) {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': 32 * 1024 * 1024 + 1,
        });
        response.end('{}');
        return;
      }
      if (method === 'RetrieveUserQuotaSummary' && quotaMode === 'unsupported') {
        response.writeHead(501, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ code: 'unimplemented', message: 'Synthetic unsupported quota summary API' }),
        );
        return;
      }
      const held = method === 'GetCascadeTrajectory' && body.cascadeId === heldHistory?.thread
        ? heldHistory
        : undefined;
      if (held) {
        heldHistory = undefined;
        held.started = true;
        await held.wait;
      }
      const receiptFault = method === 'HandleCascadeUserInteraction' && body.interaction?.askQuestion
        ? nextQuestionReceiptFault
        : undefined;
      if (receiptFault) nextQuestionReceiptFault = undefined;
      const result = await dispatch(method ?? '', body, held?.marker, receiptFault);
      if (receiptFault) {
        calls.answerReplyLost++;
        response.destroy();
        return;
      }
      if (
        (method === 'SendUserCascadeMessage' && body.items?.[0]?.text === 'fixture unknown outcome') ||
        (method === 'UpdateConversationAnnotations' &&
          body.annotations?.title === 'fixture unknown rename outcome')
      ) {
        response.destroy();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(result));
      if (held) held.replied = true;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ code: 'invalid_argument', message: 'Synthetic fixture rejected request' }),
      );
    }
  };
  const start = async () => {
    server = createServer((request, response) => {
      void handle(request, response);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    await writeFile(
      join(agentHome, 'daemon', `hub_${address.port}.json`),
      JSON.stringify({ pid: process.pid, httpPort: address.port, csrfToken: token, lsVersion: '2.33.0' }),
      { mode: 0o600 },
    );
  };
  const closeServer = async () => {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  };
  const dispatch = async (
    method: string,
    body: Record<string, any>,
    historyMarker?: string,
    receiptFault?: QuestionReceiptFault,
  ): Promise<unknown> => {
    switch (method) {
      case 'GetCapabilities':
        return {};
      case 'RetrieveUserQuotaSummary':
        assert.equal(typeof body.forceRefresh, 'boolean');
        calls.quotaRefresh.push(body.forceRefresh);
        return quotaSummary();
      case 'GetUserStatus':
        return {
          userStatus: {
            name: 'private-fixture-account',
            email: 'private-fixture-account@example.invalid',
            userTier: { name: 'Fixture Pro', id: 'private-fixture-account-tier' },
            planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } },
            cascadeModelConfigData: quotaMode === 'primary' ? quotaCatalog() : {},
          },
        };
      case 'GetAllCascadeTrajectories':
        assert.equal(body.excludeSubtrajectories, true);
        return {
          trajectorySummaries: Object.fromEntries(
            [...conversations].map(([id, conversation]) => [
              id,
              {
                summary:
                  id === threadId
                    ? initialTitle
                    : id === switchId
                      ? switchTitle
                      : 'Created fixture conversation',
                annotations: conversation.annotations,
                trajectoryId: nativeTrajectoryId(id),
                stepCount: conversation.steps.length,
                lastModifiedTime: '2026-11-19T06:00:00Z',
                workspaces: [{ workspaceFolderAbsoluteUri: 'file:///fixture/project' }],
                trajectoryMetadata: { projectId },
              },
            ]),
          ),
        };
      case 'GetCascadeTrajectory': {
        const conversation = conversations.get(body.cascadeId);
        assert(conversation, 'Requested unknown fixture conversation');
        return {
          status: conversation.running ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
          trajectory: {
            cascadeId: body.cascadeId,
            trajectoryId: nativeTrajectoryId(body.cascadeId),
            steps: historyMarker ? [...conversation.steps, historyMarkerStep(historyMarker)] : conversation.steps,
            executorMetadatas: conversation.executorMetadatas ?? [],
            generatorMetadata: [{ plannerConfig: { planModel: 'MODEL_FIXTURE' } }],
          },
        };
      }
      case 'ListProjects':
        return { projectIds: [projectId] };
      case 'ReadProjects':
        assert.deepEqual(body.ids, [projectId]);
        return { projects: [{ id: projectId, name: 'Fixture project' }] };
      case 'GetCascadeModelConfigData':
        return quotaCatalog();
      case 'GetSlashCommands':
        assert.equal(body.cascadeId, threadId);
        assert.deepEqual(body.workspaceUris, ['file:///fixture/project']);
        return {
          commands: [
            { info: { name: 'help', type: 'SLASH_COMMAND_TYPE_SYSTEM' }, title: 'Help' },
            ...(skillsEnabled
              ? [{ info: skillInfo, title: 'Fixture skill', description: 'Fixture skill description' }]
              : []),
          ],
        };
      case 'GetAllPlugins':
        assert.deepEqual(body, { workspaceUris: ['file:///fixture/project'] });
        return {
          plugins: [
            {
              ...nativePlugin,
              description: 'Fixture plugin description',
              disabled: !pluginEnabled,
            },
            {
              name: 'fixture-private-disabled',
              path: 'file:///fixture/private/disabled',
              forceDisabled: true,
            },
            {
              name: 'fixture-private-unauthenticated',
              path: 'file:///fixture/private/unauthenticated',
              authRequired: true,
            },
          ],
        };
      case 'SendUserCascadeMessage': {
        const conversation = conversations.get(body.cascadeId);
        assert(conversation);
        assert.equal(typeof body.clientMessageId, 'string');
        assert(Array.isArray(body.items) && (typeof body.items[0]?.text === 'string' || body.media?.length));
        const text = body.items[0]?.text;
        if (body.deliveryStrategy === nextInvocation) {
          assert.equal(conversation.running, true, 'Append reached a conversation without an active turn');
          const executionId = conversation.steps.at(-1)?.metadata as { executionId?: string };
          assert(executionId?.executionId);
          assert.deepEqual(Object.keys(body).sort(), ['cascadeId', 'clientMessageId', 'deliveryStrategy', 'items']);
          assert.deepEqual(body.items, [{ text }]);
          calls.steer++;
          conversation.steps.push({
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            metadata: { executionId: executionId.executionId },
            userInput: { items: body.items, clientMessageId: body.clientMessageId },
          });
          return {};
        }
        const media = [];
        if (body.media?.length) {
          assert.equal(body.media.length, 1);
          const image = body.media[0];
          assert.equal(image.mimeType, 'image/png');
          assert.deepEqual(await readFile(image.uri), fixtureImage);
          const nativeFolder = join(agentHome, 'brain', body.cascadeId, '.user_uploaded');
          await mkdir(nativeFolder, { recursive: true });
          const path = join(nativeFolder, basename(image.uri));
          try {
            await rename(image.uri, path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
            await writeFile(path, await readFile(image.uri));
            await rm(image.uri);
          }
          media.push({ mimeType: image.mimeType, displayName: image.displayName, uri: path });
        }
        if (body.deliveryStrategy === whenIdle) {
          assert(conversation.running, 'Queue did not reach the active native conversation');
          conversation.pending ??= [];
          conversation.pending.push({
            id: `native-queue-${++calls.queueAdd}`,
            requestId: body.clientMessageId,
            text: body.items[0].text,
          });
          return {};
        }
        assert.equal(conversation.running, false, 'Send reached a busy native conversation');
        if (text === 'fixture send once') {
          assert.deepEqual(
            body.items[1],
            { item: { slashCommand: { info: skillInfo, argumentValues: {} } } },
            'Selected skill was not sent as a native slash-command scope item',
          );
          assert.deepEqual(body.items[2], { item: { plugin: nativePlugin } });
        } else if (text === 'Fixture browser plugin and photo') {
          assert.deepEqual(body.items[1], { item: { plugin: nativePlugin } });
        }
        if (text === 'fixture create once') {
          assert.equal(body.cascadeId, createdId);
          assert.deepEqual(body.cascadeConfig, { plannerConfig: { planModel: 'MODEL_FIXTURE_NEXT' } });
        }
        const expectedModel = !oldGateway && (text === 'fixture send once' || media[0]?.displayName === 'browser-fixture.png');
        if (expectedModel) {
          assert.deepEqual(body.cascadeConfig, { plannerConfig: { planModel: 'MODEL_FIXTURE_NEXT' } });
        } else if (text === 'fixture failed execution') {
          assert.equal(body.cascadeConfig, undefined, 'A prior message model leaked into a later send');
        }
        calls.send++;
        if (text === 'fixture unknown outcome') return {};
        conversation.running = true;
        conversation.steps.push({
          type: 'CORTEX_STEP_TYPE_USER_INPUT',
          metadata: { executionId: `execution-${calls.send}` },
          userInput: { items: body.items, clientMessageId: body.clientMessageId, media },
        });
        if (text === 'fixture failed execution') {
          conversation.running = false;
          conversation.executorMetadatas ??= [];
          conversation.executorMetadatas.push({
            executionId: `execution-${calls.send}`,
            terminationReason: 'EXECUTOR_TERMINATION_REASON_ERROR',
          });
        }
        return {};
      }
      case 'DeleteAgentMessage': {
        assert.deepEqual(Object.keys(body).sort(), ['messageId', 'recipient']);
        const conversation = conversations.get(body.recipient);
        assert(conversation?.pending);
        const index = conversation.pending.findIndex((row) => row.id === body.messageId);
        assert(index >= 0, 'Deletion did not use a stable native pending-message ID');
        calls.queueRemove++;
        conversation.pending.splice(index, 1);
        return {};
      }
      case 'HandleCascadeUserInteraction': {
        assert(body.cascadeId === threadId || (pagedHistory && body.cascadeId === switchId));
        const conversation = conversations.get(body.cascadeId)!;
        assert.equal(conversation.running, true);
        assert.equal(body.interaction.trajectoryId, nativeTrajectoryId(body.cascadeId));
        const stepIndex = body.interaction.stepIndex;
        assert.equal(stepIndex, conversation.steps.length - 1);
        const step = conversation.steps[stepIndex];
        assert.equal(step.status, 'CORTEX_STEP_STATUS_WAITING');
        if (
          step.requestedInteraction &&
          typeof step.requestedInteraction === 'object' &&
          'permission' in step.requestedInteraction
        ) {
          assert.equal(body.cascadeId, threadId, 'Paged history must not approve commands');
          calls.approval++;
          assert.equal(typeof expectedCommandApproval, 'boolean');
          assert.deepEqual(body.interaction.permission, {
            allow: expectedCommandApproval, scope: 'PERMISSION_SCOPE_ONCE',
          });
          step.status = 'CORTEX_STEP_STATUS_DONE';
          step.completedInteractions = [
            { request: step.requestedInteraction, response: body.interaction },
          ];
          conversation.running = false;
          return {};
        }
        const [single, multi, freeform] = body.interaction.askQuestion.responses;
        if (extendedQuestions) {
          assert.equal(single.selectedOptionIds, undefined);
          assert.equal(single.writeInResponse, '红');
        } else {
          assert.deepEqual(single.selectedOptionIds, ['red']);
        }
        assert.deepEqual(multi.selectedOptionIds, [
          'first',
          'second',
          ...(extendedQuestions ? extraQuestionOptions.map(({ id }) => id) : []),
        ]);
        assert.equal(freeform.writeInResponse, '补充内容');
        calls.answer++;
        if (receiptFault === 'uncommitted') return {};
        const responses = [single, multi, freeform].map(({ isMultiSelect, options, ...answer }) => ({
          ...answer,
          ...(isMultiSelect && { isMultiSelect }),
          ...(options?.length && { options }),
        }));
        step.status = 'CORTEX_STEP_STATUS_DONE';
        step.completedInteractions = [
          {
            request: { askQuestion: { questions: nativeQuestions } },
            response: { ...body.interaction, askQuestion: { responses } },
          },
        ];
        conversation.steps.push({
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          metadata: { executionId: 'fixture-interaction-turn' },
          plannerResponse: { response: receiptFault ? recoveredAnswerMarker : 'fixture continued after answer' },
        });
        conversation.running = false;
        return {};
      }
      case 'CancelCascadeInvocation': {
        const conversation = conversations.get(body.cascadeId);
        assert(conversation?.running, 'Cancellation reached an idle native conversation');
        calls.interrupt++;
        conversation.running = false;
        const latest = [...conversation.steps]
          .reverse()
          .find((step: any) => step.metadata?.executionId) as any;
        assert(latest?.metadata.executionId);
        conversation.executorMetadatas ??= [];
        conversation.executorMetadatas.push({
          executionId: latest.metadata.executionId,
          terminationReason: 'EXECUTOR_TERMINATION_REASON_USER_CANCELED',
        });
        return {};
      }
      case 'StartCascade':
        assert.equal(body.source, 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT');
        assert.equal(body.trajectoryType, 'CORTEX_TRAJECTORY_TYPE_CASCADE');
        assert.equal(body.projectEnvConfig.projectId, projectId);
        calls.create++;
        conversations.set(createdId, { running: false, steps: [] });
        return { cascadeId: createdId };
      case 'UpdateConversationAnnotations': {
        assert.equal(body.mergeAnnotations, true);
        assert.equal(body.cascadeIds.length, 1);
        const conversation = conversations.get(body.cascadeIds[0]);
        assert(conversation);
        assert.deepEqual(Object.keys(body.annotations), ['title']);
        assert.equal(typeof body.annotations.title, 'string');
        assert.equal(body.annotations.title, body.annotations.title.trim());
        conversation.annotations = body.annotations;
        calls.rename++;
        return {};
      }
      default:
        throw Error(`Unimplemented synthetic Connect method: ${method}`);
    }
  };
  function quotaSummary() {
    if (quotaMode === 'none') return { response: { groups: [] } };
    const bucket = (bucketId: string, window: string, remainingFraction: number) => ({
      bucketId,
      window,
      remainingFraction,
      displayName: `${window} limit remaining`,
      description: bucketId.startsWith('gemini-') ? 'private-fixture-account' : undefined,
      resetTime: window === 'weekly' ? '2026-11-26T11:09:35Z' : '2026-11-19T11:09:35Z',
    });
    return {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'private-fixture-account',
            buckets: [
              bucket('gemini-weekly', 'weekly', 0.962743),
              bucket('gemini-5h', '5h', 0.89123),
              { bucketId: 'disabled', window: 'weekly', remainingFraction: 0.5, disabled: true },
              { bucketId: 'unknown', window: 'weekly', resetTime: '2026-11-26T11:09:35Z' },
              { bucketId: 'amount-only', window: 'weekly', remainingAmount: '20' },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [bucket('3p-weekly', 'weekly', 1), bucket('3p-5h', '5h', 0)],
          },
          { displayName: 'Gemini 4 Argon', buckets: [bucket('argon-weekly', 'weekly', 1)] },
        ],
      },
    };
  }

  function quotaCatalog() {
    return {
      clientModelConfigs: [
        {
          modelId: 'fixture',
          label: 'Fixture model',
          modelOrAlias: { model: 'MODEL_FIXTURE' },
          allowedTiers: ['TEAMS_TIER_PRO'],
          quotaInfo:
            quotaMode === 'none' ? {} : { remainingFraction: 0.75, resetTime: '2026-11-19T11:09:35Z' },
        },
        {
          modelId: 'fixture-zero',
          label: 'Exhausted fixture model',
          modelOrAlias: { model: 'MODEL_ZERO' },
          allowedTiers: ['TEAMS_TIER_PRO'],
          quotaInfo: quotaMode === 'none' ? {} : { remainingFraction: 0, resetTime: '2026-11-19T11:09:35Z' },
        },
        { modelId: 'fixture-disabled', label: 'Unavailable fixture model', quotaInfo: {} },
        ...(nextModelEnabled
          ? [{ modelId: 'fixture-next', label: 'Fixture next model', modelOrAlias: { model: 'MODEL_FIXTURE_NEXT' } }]
          : []),
      ],
    };
  }
  function nativeTrajectoryId(id: string) {
    return pagedHistory && id === switchId ? pagedTrajectoryId : trajectoryId;
  }
  function historyMarkerStep(text: string) {
    return {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      metadata: { executionId: 'synthetic-history-marker' },
      userInput: { items: [{ text }] },
    };
  }
  function holdNextHistory(thread: string, marker: string) {
    let resume!: () => void;
    const wait = new Promise<void>((resolve) => { resume = resolve; });
    const held = {
      thread,
      marker,
      started: false,
      replied: false,
      wait,
      release() {
        if (heldHistory === held) heldHistory = undefined;
        resume();
      },
    };
    assert(!heldHistory, 'Only one synthetic history response can be held');
    heldHistory = held;
    return held;
  }
  function appendPagedRows(count: number) {
    const { steps } = conversations.get(switchId)!;
    const start = steps.length;
    const name = pagedTrajectoryId === trajectoryId ? 'paged' : 'replacement';
    for (let index = start; index < start + count; index++) {
      steps.push({
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        metadata: { executionId: `${name}-record-${index}` },
        userInput: { items: [{ text: `Synthetic ${name} record ${index}.` }] },
      });
    }
  }
  await start();
  return {
    calls,
    errors,
    setQuotaMode(mode: 'primary' | 'unsupported' | 'none') {
      quotaMode = mode;
    },
    setSkillsEnabled(enabled: boolean) {
      skillsEnabled = enabled;
    },
    setPluginEnabled(enabled: boolean) {
      pluginEnabled = enabled;
    },
    setNextModelEnabled(enabled: boolean) {
      nextModelEnabled = enabled;
    },
    failHistory(thread: string | undefined) {
      unavailableHistory = thread;
    },
    failPagedHistory(unavailable: boolean) {
      pagedHistoryUnavailable = unavailable;
    },
    holdNextHistory,
    appendHistoryMarker(thread: string, text: string) {
      conversations.get(thread)!.steps.push(historyMarkerStep(text));
    },
    beginPagedHistory() {
      pagedHistory = true;
      pagedTrajectoryId = trajectoryId;
      conversations.set(switchId, { running: false, steps: [] });
      appendPagedRows(160);
    },
    advancePagedHistory(count: number) {
      assert(pagedHistory);
      appendPagedRows(count);
    },
    replacePagedHistory() {
      assert(pagedHistory);
      const { steps } = conversations.get(switchId)!;
      const count = steps.length;
      steps.length = 0;
      pagedTrajectoryId = replacementTrajectoryId;
      appendPagedRows(count);
    },
    rewindPagedHistory(count: number) {
      assert(pagedHistory);
      const { steps } = conversations.get(switchId)!;
      assert(count > 0 && count < steps.length);
      steps.length = count;
      steps[count - 1].userInput = { items: [{ text: 'Synthetic rewind marker.' }] };
    },
    askQuestion(extended = false, id = threadId) {
      extendedQuestions = extended;
      const conversation = conversations.get(id)!;
      conversation.running = true;
      conversation.steps.push({
        type: 'CORTEX_STEP_TYPE_ASK_QUESTION',
        status: 'CORTEX_STEP_STATUS_WAITING',
        metadata: { executionId: 'fixture-interaction-turn' },
        askQuestion: { questions: nativeQuestions },
      });
    },
    loseNextQuestionReceipt(fault: QuestionReceiptFault) {
      assert.equal(nextQuestionReceiptFault, undefined);
      nextQuestionReceiptFault = fault;
    },
    dismissQuestion() {
      const conversation = conversations.get(threadId)!;
      const step = conversation.steps.at(-1)!;
      assert.equal(step.type, 'CORTEX_STEP_TYPE_ASK_QUESTION');
      assert.equal(step.status, 'CORTEX_STEP_STATUS_WAITING');
      assert.equal(step.completedInteractions, undefined);
      step.status = 'CORTEX_STEP_STATUS_CANCELED';
      conversation.running = false;
    },
    clearHistory() {
      conversations.clear();
    },
    requestCommandApproval(allow: boolean) {
      const conversation = conversations.get(threadId)!;
      assert.equal(conversation.running, false);
      expectedCommandApproval = allow;
      conversation.running = true;
      conversation.steps.push({
        type: 'CORTEX_STEP_TYPE_GENERIC',
        status: 'CORTEX_STEP_STATUS_WAITING',
        metadata: {
          executionId: 'fixture-command-approval',
          sourceTrajectoryStepInfo: { trajectoryId, cascadeId: threadId, stepIndex: conversation.steps.length },
        },
        generic: { args: { CommandLine: command, BypassSandbox: 'false' } },
        requestedInteraction: {
          permission: { resource: { action: 'command', target: command }, approvalScopeFilter: ['PERMISSION_SCOPE_ONCE'] },
        },
      });
    },
    startQueueTurn() {
      const conversation = conversations.get(threadId)!;
      conversation.running = true;
      conversation.steps.push({
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        metadata: { executionId: 'fixture-browser-queue-turn' },
        plannerResponse: { response: 'Synthetic active queue turn.' },
      });
    },
    reset() {
      resetConversations();
      unavailableHistory = undefined;
      pagedHistory = false;
      pagedHistoryUnavailable = false;
      extendedQuestions = false;
      nextQuestionReceiptFault = undefined;
      expectedCommandApproval = undefined;
      calls.send = 0;
      calls.steer = 0;
      pluginEnabled = true;
      calls.interrupt = 0;
      calls.create = 0;
      calls.answer = 0;
      calls.answerReplyLost = 0;
      calls.approval = 0;
      calls.rename = 0;
      calls.queueAdd = 0;
      calls.queueRemove = 0;
      calls.quotaRefresh.length = 0;
    },
    get token() {
      return token;
    },
    async rotate() {
      await closeServer();
      token = 'synthetic-daemon-token-two';
      await start();
    },
    close: closeServer,
  };
}
