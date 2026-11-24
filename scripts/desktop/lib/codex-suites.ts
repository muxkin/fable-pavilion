import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { nodeSession } from '../../../src/client/node-session.js';
import { platformRuntime } from '../../../src/server/platform.js';
import type { CodexVoiceEvent } from '../../../src/shared/codex-voice.js';
import type { ControlCatalog } from '../../../src/shared/controls.js';
import { DeviceLink } from '../../../src/shared/device-link.js';
import { BLOCK_SIZE, decryptBlock, encryptBlock, type FileManifest } from '../../../src/shared/files.js';
import { apiCall } from '../../../src/shared/rpc.js';
import type { Identity } from '../../../src/shared/secure-channel.js';
import { uploadToStorage } from '../../../src/web/storage-upload.js';
import { registerWorkbenchFixture } from '../../lib/messaging-smoke.js';
import type { CodexGoalFixture } from './codex-goal-fixture.js';
import { verifyCodexGoalLifecycle, verifyCodexGoalUi } from './codex-goal-suite.js';
import type { ModernCodexFixture } from './codex-modern-fixture.js';
import { verifyModernCodexBrowser } from './codex-modern-suite.js';
import {
  CODEX_SMOKE_IDS,
  type CodexDesktopFixture,
  type QueueStateControl,
} from './codex-fixture.js';
import { waitFor } from './native-helpers.js';

export interface CodexVoiceOptions {
  threadId: string;
  voiceStopped: string;
}

export async function verifyCodexVoice(session: DeviceLink, other: DeviceLink, options: CodexVoiceOptions) {
  const { threadId, voiceStopped } = options;
  const { VOICE_FORK, voiceOffer, voiceAnswer, voiceSecret } = CODEX_SMOKE_IDS;
  type VoiceMessage = { backendId: string; threadId: string; sessionId: string; event: CodexVoiceEvent };
  const scope = { backendId: 'codex-local', threadId, sessionId: crypto.randomUUID() };
  const conflicting = { ...scope, sessionId: crypto.randomUUID() };
  const rejected = { ...scope, sessionId: crypto.randomUUID() };
  const messages: VoiceMessage[] = [];
  const foreignMessages: VoiceMessage[] = [];
  const listen = (device: DeviceLink, into: VoiceMessage[]) =>
    device.onEvent((event) => {
      if (event.type === 'voice-event') into.push(event as VoiceMessage);
    });
  const unsubscribe = listen(session, messages);
  const unsubscribeOther = listen(other, foreignMessages);
  const start = (id: typeof scope, sdp: string = voiceOffer, device = session) =>
    device.request('voice-start', { ...id, mode: 'fork', sdp });
  const stopped = async () =>
    (
      await readFile(voiceStopped, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      })
    )
      .trim()
      .split('\n')
      .filter(Boolean);
  try {
    const status = (await session.ready).status;
    assert.equal(status.capabilities.voice, true);
    assert.equal(status.capabilities.voiceMode, 'fork');
    await assert.rejects(start(scope, 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 111\r\n'));
    await start(scope);
    await waitFor(
      () => messages.some(({ event }) => event.type === 'transcript' && event.final),
      { description: 'Encrypted voice events did not reach the initiating device', timeoutMs: 10_000 },
    );
    assert.deepEqual(
      messages.map(({ backendId, threadId: id, sessionId, event }) => ({
        backendId,
        threadId: id,
        sessionId,
        event,
      })),
      [
        { ...scope, event: { type: 'started', voiceThreadId: VOICE_FORK } },
        { ...scope, event: { type: 'answer', sdp: voiceAnswer } },
        { ...scope, event: { type: 'transcript', role: 'assistant', text: 'He', final: false } },
        { ...scope, event: { type: 'transcript', role: 'assistant', text: 'Hello.', final: true } },
      ],
    );
    await session.request('voice-keepalive', scope);
    await assert.rejects(start(conflicting));
    await start(conflicting, voiceOffer, other);
    await waitFor(
      () =>
        foreignMessages.some(({ sessionId, event }) => sessionId === conflicting.sessionId && event.type === 'error'),
      { description: 'A second paired device was not warned that the line was busy', timeoutMs: 10_000 },
    );
    assert.deepEqual(await stopped(), []);
    await session.request('voice-stop', scope);
    await waitFor(async () => (await stopped()).includes(scope.sessionId), {
      description: 'Hangup did not stop the upstream voice session',
      timeoutMs: 10_000,
    });

    await start(rejected, voiceOffer + 'a=fixture-reject\r\n');
    await waitFor(
      () => messages.some(({ sessionId, event }) => sessionId === rejected.sessionId && event.type === 'error'),
      { description: 'The device did not receive a voice error event', timeoutMs: 10_000 },
    );
    await waitFor(async () => (await stopped()).includes(rejected.sessionId), {
      description: 'Error did not stop the upstream voice session',
      timeoutMs: 10_000,
    });
    assert.deepEqual(await stopped(), [scope.sessionId, rejected.sessionId]);
    assert(!JSON.stringify(messages).includes(voiceSecret), 'An upstream error leaked into the remote device');
    assert.deepEqual(
      foreignMessages.map(({ backendId, threadId: id, sessionId, event }) => ({
        backendId,
        threadId: id,
        sessionId,
        type: event.type,
      })),
      [{ ...conflicting, type: 'error' }],
      'Voice events escaped their paired connection',
    );
  } finally {
    unsubscribe();
    unsubscribeOther();
    await session.request('voice-stop', scope).catch(() => {});
    await session.request('voice-stop', rejected).catch(() => {});
  }
}

export interface CodexLiveOptions {
  origin: string;
  hostPeerId: string;
  stateDir: string;
  directory: string;
  threadId: string;
  legacyId: string;
  codexPackage?: string;
  forkCli?: string;
  testStorage: boolean;
  queue: QueueStateControl;
  goalFixture?: CodexGoalFixture;
}

export async function testCodexLive(
  session: Awaited<ReturnType<typeof nodeSession>>,
  ipc: CodexDesktopFixture,
  phone: Identity,
  options: CodexLiveOptions,
) {
  const { origin, hostPeerId, stateDir, directory, threadId, legacyId, codexPackage, forkCli, testStorage, queue, goalFixture } = options;
  const { FORK, FORK_REPLY, CREATED } = CODEX_SMOKE_IDS;
  let view: any;
  let update: any;
  const unsubscribe = session.onEvent((event) => {
    if (event.type === 'sync') {
      update = event.updates[0];
      view = update?.thread;
    }
  });
  let step = 'subscribing to Codex';
  const wait = (check: () => boolean | Promise<boolean>, timeoutMs = 6_000) =>
    waitFor(check, {
      description: `Native Codex control did not reach the expected state while ${step}`,
      timeoutMs,
      intervalMs: 65,
    });
  const operation = (id: string) =>
    session.rpc<{ state: string; error?: string; resultThreadId?: string; turnId?: string }>(
      apiCall(`/operations/${id}`),
    );
  try {
    await wait(async () => {
      const status = await session.rpc<{ capabilities: { openThread: boolean } }>(apiCall('/status'));
      return status.capabilities.openThread;
    }, 12_000);
    await session.request('watch', { threadId, backendId: 'codex-local' });
    await wait(() => view?.runtimeStatus === 'notLoaded');
    assert.equal(view.canSend, false);
    assert.equal(ipc.actions.filter((name) => name === 'navigate_to_codex_page').length, 0);
    if (goalFixture) {
      const catalog = await session.rpc<ControlCatalog>(apiCall(`/threads/${threadId}/controls`));
      assert(!catalog.actions.includes('goal'), 'Codex advertised goal writes on a history-only conversation');
    }
    const submit = async (suffix: string, input = {}, anchor = threadId, expectedState = 'completed') => {
      const requestId = crypto.randomUUID();
      const request = apiCall(`/threads/${anchor}/${suffix}`, 'POST', { requestId, ...input });
      await session.rpc(request);
      let observed = await operation(requestId);
      try {
        const forkTimeout = suffix === 'fork' && 'lastTurnId' in input && forkCli ? 20_000 : undefined;
        await wait(async () => {
          if (observed.state === expectedState) return true;
          observed = await operation(requestId);
          return observed.state === expectedState;
        }, suffix === 'open' ? 16_000 : forkTimeout);
      } catch (cause) {
        throw Error(
          `Codex ${suffix} expected ${expectedState}, received ${observed.state}${observed.error ? ' (' + observed.error + ')' : ''}`,
          { cause },
        );
      }
      return { request, operation: observed };
    };

    step = 'opening from a Codex snapshot larger than 32 MiB';
    const confirmLargeSnapshot = ipc.expectLargeSnapshot();
    const open = await submit('open').finally(confirmLargeSnapshot);
    await session.rpc(open.request);
    assert.equal(ipc.actions.filter((name) => name === 'navigate_to_codex_page').length, 1);
    await wait(() => view?.synchronized && view?.canSend);
    const largeOutput = update.changed.find((message: any) => message.id === 'large-snapshot-command');
    assert(Buffer.byteLength(JSON.stringify(update)) < 64 * 1024, 'Initial live update is too large');
    assert.equal(largeOutput?.text, '命令 · cat synthetic-output.txt · completed');
    assert.equal(largeOutput?.deferred, true);
    assert.equal(largeOutput?.output, undefined);
    const largeDetails = await session.rpc<{ message: { output: string } }>(
      apiCall(`/threads/${threadId}/content?messageId=large-snapshot-command`),
    );
    assert.equal(largeDetails.message.output, '0123456789abcdef'.repeat(1024) + '…');
    assert.equal(update.changed.find((message: any) => message.id === 'earlier-message').turnBoundary, true);
    assert.equal(update.changed.find((message: any) => message.id === 'earlier-progress').turnBoundary, undefined);
    assert.deepEqual(update.changed.find((message: any) => message.id === 'earlier-turn:timing').codex, {
      kind: 'turn-timing',
      state: 'completed',
      durationMs: 1056000,
    });
    assert.deepEqual(update.changed.find((message: any) => message.id === 'live-compaction').codex, {
      kind: 'compaction',
      state: 'running',
    });
    assert.deepEqual(update.changed.find((message: any) => message.id === 'live-agent').codex, {
      kind: 'subagent',
      state: 'started',
      agentId: 'fixture-agent',
      name: '验证',
    });
    const full = await session.rpc<{ message: { text: string; truncated: boolean } }>(
      apiCall(`/threads/${threadId}/content?messageId=earlier-message`),
    );
    assert.equal(full.message.truncated, false);
    assert.equal(full.message.text, 'earlier response '.repeat(1000));
    const activity = update.changed.find((message: any) => message.id === 'live-command');
    assert.equal(activity.text, '命令 · printf live · completed');
    assert.equal(activity.deferred, true);
    assert(!JSON.stringify(activity).includes('live output'));
    assert.equal(update.changed.find((message: any) => message.id === 'live-image').role, 'tool');
    const details = await session.rpc<{ message: Record<string, unknown> }>(
      apiCall(`/threads/${threadId}/content?messageId=live-command`),
    );
    assert.equal(details.message.output, 'live output');
    assert.equal(details.message.details, 'printf live\n退出码：0');
    assert.equal(details.message.deferred, false);
    assert(!JSON.stringify(details).includes('fixture-secret'));
    assert.equal(view.projectName, '材料研究');
    const usage = await session.rpc<{ available: boolean; buckets: unknown[] }>(apiCall('/usage'));
    assert.equal(usage.available, true);
    assert.deepEqual(usage.buckets, [
      {
        id: 'codex',
        name: 'codex',
        windows: [
          {
            label: '5 小时用量',
            usedPercent: 27,
            durationMinutes: 300,
            resetsAt: 1_800_000_000_000,
          },
        ],
      },
    ]);
    assert(!JSON.stringify(usage).includes('private-id'));

    step = 'managing the Codex goal';
    if (goalFixture) await verifyCodexGoalLifecycle(session, threadId, goalFixture, ipc);

    step = 'managing conversations and settings';
    assert.deepEqual(await session.rpc(apiCall('/threads/new/projects')), {
      projects: [{ id: 'native-project', name: '材料研究' }],
    });
    const created = await submit(
      'create',
      {
        title: '新建测试',
        prompt: '第一条消息',
        projectId: 'native-project',
        model: 'fixture-model',
        thinking: 'high',
      },
      'new',
    );
    await session.rpc(created.request);
    assert.equal(created.operation.resultThreadId, CREATED);
    assert.equal(ipc.actions.filter((name) => name === 'create_thread').length, 1);
    assert.equal(
      (await submit('fork', { lastTurnId: 'earlier-turn' }, threadId, forkCli ? 'completed' : 'rejected')).operation
        .resultThreadId,
      forkCli ? FORK_REPLY : undefined,
    );
    await submit('fork', { lastTurnId: 'not-a-reply' }, threadId, 'rejected');
    assert.equal((await submit('fork')).operation.resultThreadId, FORK);
    await submit('rename', { title: '已改名' });
    const models = await session.rpc<{ models: { id: string }[] }>(apiCall('/models'));
    assert.deepEqual(
      models.models.map(({ id }) => id),
      ['fixture-model'],
    );
    const settings = {
      model: 'fixture-model',
      effort: 'high',
      serviceTier: 'fast',
      mode: 'plan',
      expectedModel: 'fixture-model',
      expectedEffort: 'medium',
      expectedServiceTier: null,
      expectedMode: 'default',
    };
    await submit('settings', settings);
    await wait(() => view?.reasoningEffort === 'high' && view?.mode === 'plan' && view?.serviceTier === 'fast');
    await submit('settings', settings, threadId, 'rejected');
    const controls = await session.rpc<{ state: { permission: string; permissionRevision: string } }>(
      apiCall(`/threads/${threadId}/controls`),
    );
    assert.equal(controls.state.permission, ':workspace');
    await submit('control', {
      control: {
        action: 'permission',
        value: ':read-only',
        expected: ':workspace',
        expectedRevision: controls.state.permissionRevision,
      },
    });
    await wait(() => view?.controls?.permission === ':read-only');
    const { skills } = await session.rpc<{ skills: { id: string; name: string }[] }>(
      apiCall(`/threads/${threadId}/skills`),
    );
    const { plugins } = await session.rpc<{ plugins: { id: string; name: string }[] }>(
      apiCall(`/threads/${threadId}/plugins`),
    );
    assert.equal(skills[0]?.name, 'fixture');
    assert.equal(plugins[0]?.name, 'Fixture Plugin');

    step = 'sending and deduplicating messages';
    const id = crypto.randomUUID();
    const call = apiCall(`/threads/${threadId}/messages`, 'POST', {
      requestId: id,
      text: 'native smoke',
      uploadIds: [legacyId],
      skillIds: [skills[0].id],
      pluginIds: [plugins[0].id],
    });
    const releaseStart = codexPackage ? ipc.holdStart() : undefined;
    try {
      await session.rpc(call);
      if (releaseStart) {
        await wait(() => ipc.expected.send === 1);
        ipc.publishTurn();
        await wait(() => view?.activeTurnId === ipc.turn);
      }
    } finally {
      releaseStart?.();
    }
    await wait(async () => (await operation(id)).state === 'accepted');
    const early = crypto.randomUUID();
    await session.rpc(
      apiCall(`/threads/${threadId}/messages`, 'POST', { requestId: early, text: 'too early' }),
    );
    await wait(async () => (await operation(early)).state === 'rejected');
    ipc.publishTurn();
    await wait(() => view?.activeTurnId === ipc.turn);
    assert(update.order.includes('earlier-message'));
    assert(!update.changed.some((message: { id: string }) => message.id === 'earlier-message'));
    await session.rpc(call);
    await assert.rejects(session.rpc({ ...call, body: { requestId: id, text: 'different operation' } }));

    step = 'synchronizing the native queue';
    await wait(() => !!view?.queueFingerprint);
    const emptyQueue = view.queueFingerprint;
    const queued = await submit('queue', { text: '队列测试', expectedQueueFingerprint: emptyQueue });
    await wait(() => view?.queuedMessages?.length === 1);
    const queuedId = (queued.request.body as { requestId: string }).requestId;
    assert.equal(view.queuedMessages[0].id, queuedId);
    await submit('queue', { text: '过期队列', expectedQueueFingerprint: emptyQueue }, threadId, 'rejected');
    await submit('queue-remove', { messageId: queuedId, expectedQueueFingerprint: view.queueFingerprint });
    await wait(() => view?.queuedMessages?.length === 0);
    queue.setProtocolVersion(3);
    await submit('queue', { text: '新版队列测试', expectedQueueFingerprint: view.queueFingerprint });
    await wait(() => view?.queuedMessages?.length === 1);
    assert.deepEqual(queue.protocolAttempts, [3, 1, 3]);
    await submit('queue-remove', {
      messageId: view.queuedMessages[0].id,
      expectedQueueFingerprint: view.queueFingerprint,
    });
    await wait(() => view?.queuedMessages?.length === 0);

    step = 'responding to Codex approvals, questions and forms';
    const request = async (
      reqId: string | number,
      method: string,
      params: Record<string, unknown>,
      kind: string,
    ) => {
      ipc.setRequest(reqId, method, params);
      await wait(() => view?.requests?.find((entry: any) => entry.id === String(reqId))?.actionable);
      const pending = view.requests.find((entry: any) => entry.id === String(reqId));
      assert.equal(pending.kind, kind);
      return {
        targetRequestId: String(reqId),
        expectedTurnId: params.turnId,
        expectedFingerprint: pending.fingerprint,
      };
    };
    const command = await request(
      123,
      'item/commandExecution/requestApproval',
      { turnId: ipc.turn, command: 'echo fixture', availableDecisions: ['decline'] },
      'command',
    );
    await submit('responses', { ...command, decision: 'accept' }, threadId, 'rejected');
    await submit(
      'responses',
      { ...command, decision: 'decline', expectedFingerprint: '0'.repeat(64) },
      threadId,
      'rejected',
    );
    assert.equal(ipc.responseCount(), 0);
    await submit('responses', { ...command, decision: 'decline' });
    await wait(() => view?.pendingRequests === 0);
    const file = await request(
      'file',
      'item/fileChange/requestApproval',
      { turnId: ipc.turn, changes: [{ path: 'fixture.txt', kind: { type: 'update' }, diff: '+fixture' }] },
      'file',
    );
    await submit('responses', { ...file, decision: 'decline' });
    const permissionRequest = await request(
      'permission',
      'item/permissions/requestApproval',
      { turnId: ipc.turn, permissions: { fileSystem: { read: ['/allowed'], write: ['/write'] } } },
      'permissions',
    );
    await submit(
      'responses',
      { ...permissionRequest, permissionIds: ['fileSystem.read.9'] },
      threadId,
      'rejected',
    );
    await submit('responses', { ...permissionRequest, permissionIds: ['fileSystem.read.0'] });
    const question = await request(
      'question',
      'item/tool/requestUserInput',
      { turnId: ipc.turn, questions: [{ id: 'answer', question: '请回答', options: [{ label: '测试' }] }] },
      'question',
    );
    await submit('responses', { ...question, answers: { answer: ['测试'] } });
    const form = await request(
      'form',
      'mcpServer/elicitation/request',
      {
        turnId: ipc.turn,
        mode: 'form',
        requestedSchema: {
          type: 'object',
          required: ['confirmed'],
          properties: { confirmed: { type: 'boolean' } },
        },
      },
      'elicitation',
    );
    await submit(
      'responses',
      { ...form, action: 'accept', content: { confirmed: 'invalid' } },
      threadId,
      'rejected',
    );
    await submit('responses', { ...form, action: 'accept', content: { confirmed: true } });
    assert.equal(ipc.responseCount(), 5);

    step = 'uploading and downloading an attachment';
    const bytes = Buffer.alloc(1024 * 1024 + 43, 42);
    const blocks = [bytes.subarray(0, 1024 * 1024), bytes.subarray(1024 * 1024)];
    const digest = (chunk: Uint8Array) => createHash('sha256').update(chunk).digest('hex');
    const upload = await session.rpc<{ id: string }>(
      apiCall(`/threads/${threadId}/uploads`, 'POST', {
        name: 'native-attachment.txt',
        size: bytes.length,
        sha256: digest(bytes),
        hashes: blocks.map(digest),
      }),
    );
    const ready = await session.ready;
    const bulk = await nodeSession(
      origin,
      hostPeerId,
      phone,
      ready.ticket,
      { type: 'authenticate', protocol: 2, sessionId: ready.sessionId },
      'bulk',
    );
    try {
      const data = { fileId: upload.id, threadId, backendId: 'codex-local' };
      await assert.rejects(bulk.rpc(apiCall('/threads')));
      await assert.rejects(bulk.request('file', { ...data, action: 'write', index: 0 }, Uint8Array.of(0)));
      await bulk.request('file', { ...data, action: 'write', index: 0 }, blocks[0]);
      assert.deepEqual((await bulk.request('file', { ...data, action: 'missing' })).value.missing, [1]);
      await bulk.request('file', { ...data, action: 'write', index: 1 }, blocks[1]);
      const done = await bulk.request('file', { ...data, action: 'finish' });
      assert.deepEqual(await readFile(done.value.path), bytes);
      const oldClient = await session.rpc(apiCall(`/threads/${threadId}/uploads/${upload.id}/complete`, 'POST'));
      assert.deepEqual(oldClient, done.value);
      const described = await session.rpc<{ id: string }>(
        apiCall(`/threads/${threadId}/media`, 'POST', { path: done.value.path }),
      );
      assert.equal(described.id, upload.id);
      const fetched = await bulk.request('file', { ...data, action: 'read', index: 0 });
      assert.deepEqual(Buffer.from(fetched.bytes!), blocks[0]);
      await assert.rejects(
        session.rpc(
          apiCall(`/threads/${threadId}/media`, 'POST', { path: join(directory, 'state', 'state.sqlite') }),
        ),
      );
    } finally {
      bulk.close();
    }
    if (testStorage) await exerciseStorage(session, threadId, stateDir);

    step = 'steering and interrupting the active turn';
    const steer = crypto.randomUUID();
    await session.rpc(
      apiCall(`/threads/${threadId}/steer`, 'POST', {
        requestId: steer,
        expectedTurnId: ipc.turn,
        text: 'follow up',
        uploadIds: [upload.id],
      }),
    );
    await wait(async () => (await operation(steer)).state === 'accepted');
    const stale = crypto.randomUUID();
    await session.rpc(
      apiCall(`/threads/${threadId}/interrupt`, 'POST', { requestId: stale, expectedTurnId: 'stale-turn' }),
    );
    await wait(async () => (await operation(stale)).state === 'rejected');
    const stop = crypto.randomUUID();
    await session.rpc(
      apiCall(`/threads/${threadId}/interrupt`, 'POST', { requestId: stop, expectedTurnId: ipc.turn }),
    );
    await wait(async () => (await operation(stop)).state === 'interrupted' && !view?.activeTurnId);

    step = 'replying to optional questions and approving plans';
    ipc.asyncQuestion();
    await wait(() => view?.requests?.some((row: any) => row.kind === 'async-question'));
    const optional = view.requests.find((row: any) => row.kind === 'async-question');
    const reply = async (body: Record<string, unknown>) => {
      const replyId = crypto.randomUUID();
      await session.rpc(apiCall(`/threads/${threadId}/responses`, 'POST', { requestId: replyId, ...body }));
      await wait(async () => ['accepted', 'completed'].includes((await operation(replyId)).state));
      return operation(replyId);
    };
    const answered = await reply({
      targetRequestId: optional.id,
      expectedTurnId: optional.turnId,
      expectedFingerprint: optional.fingerprint,
      answers: { [optional.questions[0].id]: ['测试'] },
    });
    await wait(() => !view?.requests?.some((row: any) => row.kind === 'async-question'));
    const planTurn = answered.turnId;
    assert(planTurn);
    const plan = await request(
      'plan',
      'item/plan/requestImplementation',
      { threadId, turnId: planTurn, planContent: '测试计划' },
      'plan',
    );
    await reply({ ...plan, planDecision: 'implement' });
    await wait(() => view?.pendingRequests === 0);
    assert.deepEqual(ipc.expected, { send: 1, steer: 1, interrupt: 1 });
  } catch (cause) {
    throw new Error(`Native IPC smoke test failed while ${step}`, { cause });
  } finally {
    unsubscribe();
  }
}

export async function exerciseStorage(session: DeviceLink, threadId: string, stateDir: string) {
  const data = Buffer.alloc(38_513_257, 0x4a);
  const blocks = Array.from({ length: Math.ceil(data.length / BLOCK_SIZE) }, (_, index) =>
    data.subarray(index * BLOCK_SIZE, (index + 1) * BLOCK_SIZE),
  );
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const manifest = await session.rpc<FileManifest>(
    apiCall(`/threads/${threadId}/uploads`, 'POST', {
      name: 'synthetic-storage.mp4',
      size: data.length,
      sha256: hash(data),
      hashes: blocks.map(hash),
    }),
  );
  assert.equal(manifest.mime, 'video/mp4');
  assert.equal(manifest.storage, true);
  assert.equal(manifest.storageBatchBlocks, 25);
  const file = { backendId: 'codex-local', threadId, fileId: manifest.id };
  let objects = 0;
  for (let first = 0; first < blocks.length; first += manifest.storageBatchBlocks) {
    const indices = blocks
      .slice(first, first + manifest.storageBatchBlocks)
      .map((_, offset) => first + offset);
    const { value: plan } = await session.request('file', { ...file, action: 'storage-plan', indices });
    const parts = await Promise.all(indices.map((index) => encryptBlock(manifest, index, blocks[index])));
    await uploadToStorage(
      plan.upload,
      new File(parts as Uint8Array<ArrayBuffer>[], 'data', { type: 'application/octet-stream' }),
    );
    await session.request(
      'file',
      { ...file, action: 'storage-import', objectId: plan.objectId },
      undefined,
      120_000,
    );
    objects++;
  }
  const completed = await session.request('file', { ...file, action: 'finish' });
  assert.deepEqual(await readFile(completed.value.path), data);
  assert.equal(objects, 2);
  const { value: download } = await session.request('file', {
    ...file,
    action: 'storage-plan',
    indices: [0],
  });
  const response = await fetch(download.url, { headers: { Range: `bytes=0-${BLOCK_SIZE + 15}` } });
  assert.equal(response.status, 206);
  assert.deepEqual(
    Buffer.from(await decryptBlock(manifest, 0, new Uint8Array(await response.arrayBuffer()))),
    blocks[0],
  );
  await session.request('file', { ...file, action: 'storage-done', objectId: download.objectId });
  const db = new DatabaseSync(join(stateDir, 'state.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM native_storage_objects').get()?.count, 0);
  } finally {
    db.close();
  }
  console.log(
    'Private object storage round trip: 36.7 MiB in two uploads, byte verification and object cleanup passed.',
  );
}

export interface CodexBrowserDirectOptions {
  code: string;
  executablePath: string;
  fixture: CodexDesktopFixture;
  origin: string;
  hostPeerId: string;
  goalControls: boolean;
  modern?: { fixture: ModernCodexFixture; threadId: string };
  projectPdf: string;
  projectPng: string;
  pdfBytes: Buffer;
  viewed: ReadonlyArray<{ path: string; bytes: Buffer; width: number }>;
}

export async function verifyCodexBrowserDirect(options: CodexBrowserDirectOptions) {
  const { code, executablePath, fixture, origin, hostPeerId, goalControls, projectPdf, projectPng, pdfBytes, viewed } = options;
  const { browserReadOnlyPrompt } = CODEX_SMOKE_IDS;
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

  const { chromium, expect } = await import('@playwright/test');
  const browser = await chromium.launch({ executablePath });
  let context: import('@playwright/test').BrowserContext | undefined;
  let page: import('@playwright/test').Page | undefined;
  try {
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript(() => {
      const qa = ((window as any).__nativeQa = {
        direct: 0,
        relay: 0,
        peers: [] as RTCPeerConnection[],
        pdfs: new Map<string, Blob>(),
      });
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (object) => {
        const url = createObjectURL(object);
        if (object instanceof Blob && object.type === 'application/pdf') qa.pdfs.set(url, object);
        return url;
      };
      const Peer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Peer {
        constructor(config?: RTCConfiguration) {
          super(config);
          qa.peers.push(this);
        }
        createDataChannel(label: string, config?: RTCDataChannelInit) {
          const channel = super.createDataChannel(label, config);
          if (label === 'pocket-bulk-v2') {
            const send = channel.send.bind(channel) as (data: ArrayBuffer) => void;
            channel.send = ((data: ArrayBuffer) => {
              qa.direct += data.byteLength;
              send(data);
            }) as typeof channel.send;
          }
          return channel;
        }
      };
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket {
        private bulk = false;
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (typeof data === 'string') {
            const message = JSON.parse(data);
            this.bulk ||= message.type === 'join' && message.lane === 'bulk';
          } else if (this.bulk) {
            qa.relay += data instanceof Blob ? data.size : data.byteLength;
          }
          super.send(data);
        }
      };
    });
    page = await context.newPage();
    const errors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const location = message.location().url;
      const path = location.startsWith(origin) ? new URL(location).pathname : '';
      if (path === '/api/im/crypto/desktop-backup/prepare' && message.text().includes('403 (Forbidden)')) return;
      consoleErrors.push(path ? `${path}: ${message.text()}` : message.text());
    });
    await registerWorkbenchFixture(page, origin);
    await page.goto(origin + '/#pair=' + code + '&host=' + hostPeerId);
    await expect(page).toHaveTitle('子虚亭 · Fable Pavilion');
    await page.getByRole('button', { name: '连接电脑', exact: true }).click();
    await page.getByRole('tab', { name: '最近', exact: true }).click();
    await page.getByRole('button', { name: /测试会话/ }).click();
    assert.equal(new URL(page.url()).origin, origin);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    const evidence = process.env.POCKET_NATIVE_TEST_BROWSER_MEDIA_DIR;
    const pdfTrigger = page.getByRole('button', { name: projectPdf, exact: true });
    await pdfTrigger.click({ timeout: 15000 });
    const pdf = page.getByRole('dialog', { name: projectPdf, exact: true });
    const openPdf = pdf.getByRole('link', { name: '打开 PDF', exact: true });
    await expect(openPdf).toHaveAttribute('href', /^blob:/);
    const pdfUrl = await openPdf.getAttribute('href');
    assert.deepEqual(
      await openPdf.evaluate(async (link: HTMLAnchorElement) => {
        const resource: Blob | undefined = (window as any).__nativeQa.pdfs.get(link.href);
        if (!resource) throw Error('PDF viewer did not receive an object URL');
        const bytes = await resource.arrayBuffer();
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return {
          mime: resource.type,
          size: bytes.byteLength,
          sha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        };
      }),
      { mime: 'application/pdf', size: pdfBytes.length, sha256: digest(pdfBytes) },
    );
    if (evidence) await page.screenshot({ path: join(evidence, 'pdf-mobile.png') });
    const opened = page.waitForEvent('popup');
    await openPdf.click();
    const pdfTab = await opened;
    await pdfTab.waitForURL((url) => url.href === pdfUrl);
    await pdfTab.close();
    await page.keyboard.press('Escape');
    await expect(pdf).toBeHidden();
    await expect(pdfTrigger).toBeFocused();

    const thumbnail = page.getByRole('button', { name: `放大预览：${projectPng}`, exact: true });
    await thumbnail.click({ timeout: 15000 });
    const image = page.getByRole('dialog', { name: projectPng, exact: true });
    const preview = image.getByRole('img');
    await expect(preview).toBeVisible();
    assert.equal(
      await preview.evaluate(async (element: HTMLImageElement) => {
        await element.decode();
        return element.naturalWidth;
      }),
      32,
    );
    if (evidence) await page.screenshot({ path: join(evidence, 'png-mobile.png') });
    await image.getByRole('button', { name: '关闭图片预览', exact: true }).click();
    await expect(image).toBeHidden();

    await page.setViewportSize({ width: 1280, height: 800 });
    await pdfTrigger.click();
    await expect(openPdf).toBeVisible();
    if (evidence) await page.screenshot({ path: join(evidence, 'pdf-desktop.png') });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.deepEqual(consoleErrors, []);
    console.log('Chromium opened the historical PDF and decoded the PNG through the Rust adapter.');

    const draft = page.getByLabel('消息', { exact: true });
    await expect(draft).toBeEnabled({ timeout: 15000 });
    await expect(page.getByRole('button', { name: '继续此会话', exact: true })).toHaveCount(0);
    assert.equal(fixture.browserSends(), 0);
    await draft.fill('从历史会话直接发送');
    await page.locator('.composer .send-button').click();
    await expect.poll(fixture.browserSends, { timeout: 20000 }).toBe(1);
    await expect(draft).toBeEnabled();
    await expect(draft).toHaveValue('');
    console.log('Chromium opened the cold Codex conversation on send and delivered the message once.');
    const activities = page.locator('.activity-group').filter({ hasText: '执行命令' }).last();
    await activities.locator('summary').first().click();
    await expect(activities.getByText('命令 · printf live · completed', { exact: true })).toBeVisible();
    await activities.getByRole('button', { name: '展开活动详情', exact: true }).click();
    await activities.getByText('命令输出', { exact: true }).click();
    await expect(activities.getByText('live output', { exact: true })).toBeVisible();
    for (const [index, { width }] of viewed.entries()) {
      const card = activities.locator('[data-media-type=image]').nth(index);
      await card.scrollIntoViewIfNeeded();
      await expect
        .poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBe(width);
    }
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await expect(page.getByText('Fixture Model', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    const permission = page.getByRole('button', { name: '会话权限', exact: true });
    const permissions = page.getByRole('menu', { name: '会话权限', exact: true });
    await expect(permission).toHaveAttribute('title', '会话权限：工作区内修改');
    await permission.click();
    await expect(permissions.getByRole('menuitemradio', { name: /^完全访问/ })).toBeVisible();
    await permissions.getByRole('menuitemradio', { name: /^只读/ }).click();
    await expect(permission).toHaveAttribute('title', '会话权限：只读');
    const tools = page.getByRole('button', { name: '工具', exact: true });
    for (const [label, name] of [['技能', 'fixture'], ['插件', 'Fixture Plugin']]) {
      await tools.click();
      const panel = page.getByRole('dialog', { name: '工具', exact: true });
      await panel.getByRole('button', { name: label, exact: true }).click();
      const picker = page.getByRole('dialog', { name: `添加${label}`, exact: true });
      const choice = picker.getByRole('checkbox', { name, exact: true });
      await expect(choice).toBeEnabled();
      await choice.check();
      await picker.getByRole('button', { name: '添加到消息', exact: true }).click();
      await expect(page.getByRole('button', { name: `移除${label} ${name}`, exact: true })).toBeVisible();
    }
    await draft.fill(browserReadOnlyPrompt);
    await page.locator('.composer .send-button').click();
    await expect.poll(fixture.browserSends).toBe(2);
    await expect(draft).toHaveValue('');
    await permission.click();
    await expect(permissions.getByRole('menuitemradio', { name: /^只读/ })).toHaveAttribute('aria-checked', 'true');
    await permissions.getByRole('menuitemradio', { name: /^工作区内修改/ }).click();
    await expect(permission).toHaveAttribute('title', '会话权限：工作区内修改');
    console.log('Chromium changed Codex permissions and verified the next native turn inherited them and received the selected skill and plugin.');
    const approval = page.locator('[data-request-kind="command"]');
    for (const [decision, label] of [
      ['accept', '允许本次'],
      ['decline', '拒绝'],
    ] as const) {
      const command = `printf browser-fixture-${decision}`;
      const responseCount = fixture.responseCount();
      fixture.setRequest(`browser-approval-${decision}`, 'item/commandExecution/requestApproval', {
        turnId: null,
        command,
        availableDecisions: ['accept', 'decline'],
      });
      await expect(approval).toContainText(command);
      await approval.getByRole('button', { name: label, exact: true }).click();
      await expect(approval).toHaveCount(0);
      assert.equal(fixture.responseCount(), responseCount + 1);
    }
    console.log('Chromium approved and denied separate Codex requests through the Rust adapter.');
    const connected = () =>
      page!.evaluate(() =>
        (window as any).__nativeQa.peers.some((p: RTCPeerConnection) => p.connectionState === 'connected'),
      );
    await expect.poll(connected, { timeout: 20000 }).toBe(true);
    if (goalControls) await verifyCodexGoalUi(page);
    const size = 5 * 1024 * 1024;
    await page.getByLabel('添加附件', { exact: true }).setInputFiles({
      name: 'native-direct.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(size, 35),
    });
    await expect
      .poll(() => page!.evaluate(() => (window as any).__nativeQa.direct), { timeout: 25000 })
      .toBeGreaterThan(size);
    await expect(page.locator('.upload-chip')).toContainText('native-direct.bin', { timeout: 25000 });
    assert.equal(await page.evaluate(() => (window as any).__nativeQa.relay), 0);
    if (process.env.POCKET_NATIVE_TEST_BROWSER_SCREENSHOT)
      await page.screenshot({ path: process.env.POCKET_NATIVE_TEST_BROWSER_SCREENSHOT });
    if (options.modern) await verifyModernCodexBrowser(page, { origin, hostPeerId, ...options.modern });
    assert.deepEqual(errors, []);
    console.log(
      'Chromium confirmed a desktop approval response and uploaded 5 MiB through WebRTC without relay bulk payload.',
    );
  } catch (error) {
    const outputDir = process.env.TEST_OUTPUT;
    if (outputDir && page && !page.isClosed()) {
      await mkdir(outputDir, { recursive: true }).catch(() => {});
      await page.screenshot({ path: join(outputDir, 'codex-browser-failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser.close();
  }
}

export interface CodexInstanceSuiteOptions {
  threadId: string;
  secondaryTitle: string;
  secondaryRename: string;
  secondaryUploads: string;
  secondaryPath: string;
  secondaryBytes: Buffer;
  legacyId: string;
  legacyName: string;
  legacyPath: string;
  versions: { initial: string; next: string; name: string };
  adapter: (...args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

export async function verifyCodexInstances(
  session: Awaited<ReturnType<typeof nodeSession>>,
  device: string,
  options: CodexInstanceSuiteOptions,
) {
  const { secondaryId } = CODEX_SMOKE_IDS;
  const { threadId, secondaryTitle, secondaryUploads, secondaryPath, secondaryBytes, legacyId, legacyName, legacyPath } =
    options;
  const call = (path: string, method?: string, body?: unknown) => ({
    ...apiCall(path, method, body),
    backendId: secondaryId,
  });
  const backends = await session.rpc<{ backends: { id: string; name: string; profile: string }[] }>(
    apiCall('/backends'),
  );
  const backend = backends.backends.find(({ id }) => id === secondaryId);
  assert.equal(backend?.name, 'Codex secondary');
  assert.equal(backend?.profile, 'rust-native-plugin');
  const list = await session.rpc<{ threads: { id: string; title: string }[] }>(call('/threads'));
  assert.deepEqual(
    list.threads.map(({ id, title }) => [id, title]),
    [[threadId, secondaryTitle]],
  );
  const history = await session.rpc<{ messages: { text: string; attachments: { path: string }[] }[] }>(
    call(`/threads/${threadId}/history`),
  );
  assert.equal(history.messages[0].text, '第二个实例的历史');
  assert.equal(history.messages[0].attachments[0].path, secondaryPath);
  const metadata = join(secondaryUploads, legacyId + '.json');
  await writeFile(
    metadata,
    JSON.stringify({
      id: legacyId,
      device,
      thread: threadId,
      name: legacyName,
      file: secondaryPath,
      complete: true,
      size: secondaryBytes.length,
      sha256: createHash('sha256').update(secondaryBytes).digest('hex'),
    }),
    { mode: 0o600 },
  );
  if (process.platform === 'win32') platformRuntime().privateFile(metadata);
  const media = `/threads/${threadId}/media`;
  const manifest = await session.rpc<FileManifest>(call(media, 'POST', { path: secondaryPath }));
  await assert.rejects(session.rpc(call(media, 'POST', { path: legacyPath })));
  await assert.rejects(session.rpc(apiCall(media, 'POST', { path: secondaryPath })));
  const read = { threadId, fileId: manifest.id, action: 'read', index: 0 };
  await assert.rejects(session.request('file', { ...read, backendId: 'codex-local' }));
  assert.deepEqual(
    Buffer.from((await session.request('file', { ...read, backendId: secondaryId })).bytes!),
    secondaryBytes,
  );
}

export async function verifyLiveCodexInstances(
  session: Awaited<ReturnType<typeof nodeSession>>,
  main: CodexDesktopFixture,
  secondary: CodexDesktopFixture,
  options: CodexInstanceSuiteOptions,
) {
  const { secondaryId } = CODEX_SMOKE_IDS;
  const { threadId, secondaryRename, secondaryBytes, versions, adapter } = options;
  const views = new Map<string, { epoch: string; synchronized: boolean }>();
  const remove = session.onEvent((event) => {
    if (event.type !== 'sync' || !event.backendId) return;
    const view = event.updates.find((entry: { kind: string }) => entry.kind === 'manifest');
    if (view) views.set(event.backendId, { epoch: view.epoch, synchronized: view.thread.synchronized === true });
  });
  try {
    const backends = ['codex-local', secondaryId];
    for (const backendId of backends) await session.request('watch', { backendId, threadId });
    await session.rpc({
      ...apiCall(`/threads/${threadId}/open`, 'POST', { requestId: crypto.randomUUID() }),
      backendId: secondaryId,
    });
    await waitFor(() => backends.every((id) => views.get(id)?.synchronized === true), {
      description: 'Both Codex instances did not synchronize',
      timeoutMs: 12_000,
      intervalMs: 80,
    });
    const secondaryEpoch = views.get(secondaryId)?.epoch;
    assert.notEqual(views.get('codex-local')?.epoch, secondaryEpoch);

    const digest = createHash('sha256').update(secondaryBytes).digest('hex');
    const upload = await session.rpc<FileManifest>({
      ...apiCall(`/threads/${threadId}/uploads`, 'POST', {
        name: 'isolated.txt',
        size: secondaryBytes.length,
        sha256: digest,
        hashes: [digest],
      }),
      backendId: secondaryId,
    });
    const file = { fileId: upload.id, threadId, backendId: secondaryId };
    await assert.rejects(session.request('file', { ...file, backendId: 'codex-local', action: 'missing' }));
    await session.request('file', { ...file, action: 'write', index: 0 }, secondaryBytes);
    await session.request('file', { ...file, action: 'finish' });
    const read = { ...file, action: 'read', index: 0 };
    await assert.rejects(session.request('file', { ...read, backendId: 'codex-local' }));
    assert.deepEqual(Buffer.from((await session.request('file', read)).bytes!), secondaryBytes);

    const requestId = crypto.randomUUID();
    const actions = [main, secondary].map(
      (fixture) => fixture.actions.filter((name) => name === 'set_thread_title').length,
    );
    const rename = backends.map((backendId, index) => ({
      ...apiCall(`/threads/${threadId}/rename`, 'POST', {
        requestId,
        title: index === 0 ? '已改名' : secondaryRename,
      }),
      backendId,
    }));
    await Promise.all(rename.map((request) => session.rpc(request)));
    await waitFor(
      async () => {
        const results = await Promise.all(
          backends.map((backendId) =>
            session.rpc<{ backendId: string; state: string }>({
              ...apiCall(`/operations/${requestId}`),
              backendId,
            }),
          ),
        );
        return results.every(
          (result, index) => result.backendId === backends[index] && result.state === 'completed',
        );
      },
      { description: 'Dual Codex rename operations did not complete', timeoutMs: 12_000, intervalMs: 80 },
    );
    await Promise.all(rename.map((request) => session.rpc(request)));
    for (const [index, fixture] of [main, secondary].entries())
      assert.equal(fixture.actions.filter((name) => name === 'set_thread_title').length, actions[index] + 1);

    await verifyCodexSwitch(session, threadId, versions, adapter);
    assert.equal(views.get(secondaryId)?.epoch, secondaryEpoch);
    assert.equal(views.get(secondaryId)?.synchronized, true);
  } finally {
    remove();
  }
}

async function verifyCodexSwitch(
  session: Awaited<ReturnType<typeof nodeSession>>,
  threadId: string,
  versions: { initial: string; next: string; name: string },
  adapter: (...args: string[]) => Promise<{ stdout: string; stderr: string }>,
) {
  let current: { epoch: string; synchronized: boolean } | undefined;
  const remove = session.onEvent((event) => {
    if (event.type === 'sync' && event.backendId === 'codex-local') {
      const view = event.updates.find((entry: { kind: string }) => entry.kind === 'manifest');
      if (view) current = { epoch: view.epoch, synchronized: view.thread.synchronized === true };
    }
  });
  try {
    await session.request('watch', { threadId, backendId: 'codex-local' });
    await waitFor(() => current?.synchronized === true, {
      description: 'Codex watch did not synchronize before plugin switch',
      timeoutMs: 12_000,
      intervalMs: 80,
    });
    for (const [command, version] of [
      ['upgrade', versions.next],
      ['rollback', versions.initial],
    ] as const) {
      const previous = current!.epoch;
      const target = `${versions.name}@${version}`;
      await adapter(command, 'codex-local', ...(command === 'upgrade' ? [target] : []));
      const { stdout } = await adapter('list');
      const rows = JSON.parse(stdout).instances as { instance: string; current: string }[];
      assert.equal(rows.find(({ instance }) => instance === 'codex-local')?.current, target);
      await waitFor(() => current?.synchronized === true && current.epoch !== previous, {
        description: `Codex did not recover its live subscription after plugin ${command}`,
        timeoutMs: 12_000,
        intervalMs: 80,
      });
      const result = await session.rpc<{ threads: { id: string }[] }>(apiCall('/threads'));
      assert.equal(result.threads[0].id, threadId);
    }
  } finally {
    remove();
  }
}
