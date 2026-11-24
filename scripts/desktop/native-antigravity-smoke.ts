import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { nodeSession } from '../../src/client/node-session.js';
import { platformRuntime } from '../../src/server/platform.js';
import { buildRelay } from '../../src/server/relay.js';
import { apiCall, type RpcCall } from '../../src/shared/rpc.js';
import { createIdentity } from '../../src/shared/secure-channel.js';
import type { ControlCatalog } from '../../src/shared/controls.js';
import {
  testAntigravityBrowserSwitching,
  testAntigravityPluginProcess,
} from './lib/antigravity-browser.js';
import {
  ANTIGRAVITY_FIXTURE_CONSTANTS,
  createAntigravityFixture,
  type AntigravityFixture,
} from './lib/antigravity-fixture.js';
import { verifyAntigravityPermissions } from './lib/antigravity-permissions.js';
import {
  allocateLocalPort,
  normalizeWindowsStateFiles,
  runCleanups,
  spawnNativeAdapter,
  waitFor as waitForCondition,
  type RunningNativeAdapter,
} from './lib/native-helpers.js';

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
const browserChannel = (process.env.POCKET_NATIVE_TEST_BROWSER || undefined) as 'msedge' | 'chrome' | undefined;
const recoverRenderer = process.env.POCKET_NATIVE_TEST_RENDERER_RECOVERY === '1';
assert(
  browserChannel === undefined || browserChannel === 'msedge' || browserChannel === 'chrome',
  'Use msedge or chrome',
);
assert(!recoverRenderer || browserChannel, 'Renderer recovery requires a browser channel');
assert(
  !recoverRenderer || (!legacyQuestions && !legacyHistory),
  'Renderer recovery requires current question and history support',
);

const {
  backendId,
  threadId,
  createdId,
  projectId,
  switchId,
  fixtureImage,
  nativePlugin,
  recoveredAnswerMarker,
} = ANTIGRAVITY_FIXTURE_CONSTANTS;

const root = await mkdtemp(join(tmpdir(), 'native-antigravity-smoke-'));
const state = join(root, 'state');
const agentHome = join(root, 'antigravity');
const phone = await createIdentity();
let host: string | undefined;
let ticket: string | undefined;
let pairingCode: string | undefined;

type Session = Awaited<ReturnType<typeof nodeSession>>;
let fixture: AntigravityFixture | undefined;
let relay: Awaited<ReturnType<typeof buildRelay>> | undefined;
let adapter: RunningNativeAdapter | undefined;
let session: Session | undefined;
let phase = 'setup';
let browserFailure: unknown;

const waitFor = (check: () => unknown | Promise<unknown>, description: string) =>
  waitForCondition(check, { description, timeoutMs: 15_000, intervalMs: 75 });

const scoped = (path: string, method = 'GET', body?: unknown): RpcCall => ({
  ...apiCall(path, method, body),
  backendId,
});

try {
  platformRuntime().privateDirectory(state);
  await mkdir(join(agentHome, 'daemon'), { recursive: true, mode: 0o700 });
  fixture = await createAntigravityFixture({ agentHome, browserChannel, oldGateway });

  const port = await allocateLocalPort();
  const origin = `http://127.0.0.1:${port}`;
  const enrollment = randomBytes(32).toString('hex');
  relay = await buildRelay({
    origin,
    enrollmentSecret: enrollment,
    webRoot: browserChannel ? resolve(process.env.TEST_WEB_ROOT ?? 'dist/web') : join(root, 'no-web'),
    assetOrigin: null,
    uploadOrigins: [],
    messaging: {
      registrationEnabled: true,
      deviceLoginOnly: false,
      totpKey: randomBytes(32).toString('base64url'),
    },
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

  async function launch(readOnly = false) {
    normalizeWindowsStateFiles(state, [
      'device-identity-v2.json',
      'state.sqlite',
      'state.sqlite-wal',
      'state.sqlite-shm',
    ]);
    const started = await spawnNativeAdapter({
      command: executable,
      args: ['--headless', '--print-pair'],
      env: { ...env, POCKET_NATIVE_READ_ONLY: readOnly ? '1' : '0' },
      origin,
      timeoutMs: 15_000,
      stopSignal: 'SIGTERM',
      stdin: 'pipe',
    });
    if (host) assert.equal(started.host, host, 'Native adapter replaced the existing device identity');
    host ??= started.host;
    pairingCode = started.pairCode;
    return started;
  }

  async function connect() {
    assert(host && pairingCode);
    const first = !ticket;
    const connected = await nodeSession(
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
    const ready = await connected.ready;
    ticket = ready.ticket;
    return connected;
  }

  phase = 'install';
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
  await relay.app.listen({ host: '127.0.0.1', port });

  phase = 'direct plugin contract';
  await testAntigravityPluginProcess({
    pluginExecutable,
    env,
    root,
    agentHome,
    fixture,
    oldGateway,
    legacyHistory,
  });

  phase = 'gateway startup and encrypted history';
  adapter = await launch();
  if (browserChannel) {
    phase = 'browser session switching';
    try {
      await testAntigravityBrowserSwitching({
        channel: browserChannel,
        origin,
        host: host!,
        pairingCode: pairingCode!,
        fixture,
        oldGateway,
        legacyQuestions,
        legacyHistory,
        recoverRenderer,
      });
    } catch (error) {
      // Keep the encrypted protocol result available to distinguish a browser
      // failure from a native transfer failure. The suite still fails below.
      browserFailure = error;
      console.error('Antigravity browser acceptance failed:', error);
    }
    // Browser pairing consumes the first enrollment code. Start the protocol
    // tests with a fresh code and the same temporary gateway identity.
    await adapter.stop();
    adapter = undefined;
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
  assert(history.messages.some((message) => message.role === 'assistant' && message.text === 'fixture answer'));

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

  if (!oldGateway) {
    phase = 'native conversation permission, inheritance and stale guards';
    await session.request('watch', { backendId, threadId: switchId });
    try {
      await verifyAntigravityPermissions({ rpc: (call) => session!.rpc(call), scoped, fixture });
    } finally {
      await session.request('unwatch', { backendId, threadId: switchId });
    }
  }

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
    for (const [fault, expected] of [
      ['committed', 'completed'],
      ['uncommitted', 'uncertain'],
    ] as const) {
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
      const previousDrops: number = fixture.calls.answerReplyLost;
      fixture.loseNextQuestionReceipt(fault);
      await session.rpc(call);
      await waitFor(
        async () => (await operation(requestId)).state === expected,
        `A lost native answer receipt should settle as ${expected} when ${fault}`,
      );
      assert.equal(
        (await session.rpc<{ state: string }>(call)).state,
        expected,
        'The same answer operation lost its recorded state',
      );
      assert.equal(fixture.calls.answer, previousAnswers + 1, 'Lost receipt replayed the native answer');
      assert.equal(fixture.calls.answerReplyLost, previousDrops + 1, 'Native fixture did not drop the HTTP reply');
      if (fault === 'committed') {
        await waitFor(
          () =>
            latest?.canSend === true &&
            [...updates.values()].some((message) => message.text === recoveredAnswerMarker),
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
    const approval: { id: string; turnId: string; fingerprint: string; description: string; decisions: string[] } =
      latest!.requests[0];
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
        await session.rpc(
          scoped(`/threads/${threadId}/responses`, 'POST', {
            ...scope,
            decision,
            ...invalid,
            requestId,
          }),
        );
        await waitFor(
          async () => (await operation(requestId)).state === 'rejected',
          'Invalid command approval was accepted',
        );
      }
      assert.equal(fixture.calls.approval, previousApprovals, 'An invalid approval reached Antigravity');
    }
    const requestId = randomUUID();
    const call = scoped(`/threads/${threadId}/responses`, 'POST', { ...scope, decision, requestId });
    await session.rpc(call);
    await waitFor(
      async () => (await operation(requestId)).state === 'completed',
      `Command ${decision} did not complete`,
    );
    await session.rpc(call);
    assert.equal(fixture.calls.approval, previousApprovals + 1, `Command ${decision} dispatched more than once`);
    await waitFor(() => latest?.canSend === true, 'Command decision did not close the request');
  }

  phase = 'one-time file approval';
  for (const decision of ['decline', 'accept'] as const) {
    const previousApprovals: number = fixture.calls.approval;
    fixture.requestFileApproval(decision === 'accept');
    await waitFor(
      () => latest?.requests?.some((request: any) => request.kind === 'file' && request.actionable),
      'Native file approval was not projected',
    );
    const approval: { id: string; turnId: string; fingerprint: string; changes?: { path: string; kind: string }[] } =
      latest!.requests[0];
    assert.equal(approval.changes?.[0]?.kind, 'update');
    const requestId = randomUUID();
    await session.rpc(
      scoped(`/threads/${threadId}/responses`, 'POST', {
        targetRequestId: approval.id,
        expectedTurnId: approval.turnId,
        expectedFingerprint: approval.fingerprint,
        decision,
        requestId,
      }),
    );
    await waitFor(
      async () => (await operation(requestId)).state === 'completed',
      `File approval ${decision} did not complete`,
    );
    assert.equal(fixture.calls.approval, previousApprovals + 1);
    await waitFor(() => latest?.canSend === true, 'File approval did not close the request');
  }

  phase = 'workspace file references, cited artifact download, and sanitized log export';
  const references = await session.rpc<{ files: { name: string; path: string }[] }>(
    scoped(`/threads/${threadId}/references?q=demo`),
  );
  assert.deepEqual(references.files, [{ name: 'demo.ts', path: 'src/demo.ts' }]);
  const allRefs = await session.rpc<{ files: { name: string; path: string }[] }>(
    scoped(`/threads/${threadId}/references`),
  );
  assert(!allRefs.files.some((f) => f.name === '.env'), 'Secret .env leaked into workspace references');
  fixture.citeArtifact();
  const artifactManifest = await session.rpc<{ id: string; name: string }>(
    scoped(`/threads/${threadId}/media`, 'POST', { path: fixture.citedArtifact }),
  );
  assert.equal(artifactManifest.name, 'artifact.md');
  const exportManifest = await session.rpc<{ id: string; name: string }>(
    scoped(`/threads/${threadId}/export`, 'POST'),
  );
  assert.equal(exportManifest.name, `antigravity-${threadId}.json`);
  const exportBulk = await connect();
  try {
    const exported = await exportBulk.request('file', {
      backendId,
      threadId,
      fileId: exportManifest.id,
      action: 'read',
      index: 0,
    });
    const exportText = Buffer.from(exported.bytes!).toString('utf8');
    assert(exportText.includes('fixture answer'), 'Export missing visible assistant response');
    assert(!exportText.includes('private synthetic reasoning'), 'Export leaked private thinking');
    assert(!exportText.includes('private synthetic signature'), 'Export leaked private signature');
  } finally {
    exportBulk.close();
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
    id: plugin.id,
    name: nativePlugin.displayName,
    description: 'Fixture plugin description',
  });
  assert.notEqual(plugin.id, (await readPlugins(switchId)).plugins[0].id);
  fixture.setPluginEnabled(false);
  const stalePluginId = randomUUID();
  await session.rpc(
    scoped(`/threads/${threadId}/messages`, 'POST', {
      requestId: stalePluginId,
      text: 'fixture stale plugin',
      pluginIds: [plugin.id],
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
    await session.rpc(
      scoped('/threads/' + threadId + '/messages', 'POST', {
        requestId: staleModelId,
        text: 'fixture removed model',
        model: 'fixture-next',
      }),
    );
    await waitFor(
      async () => (await operation(staleModelId)).state === 'rejected',
      'Removed message model was not rejected',
    );
    assert.equal(fixture.calls.send, 0, 'Removed model reached SendUserCascadeMessage');
    fixture.setNextModelEnabled(true);
  }
  const digest = createHash('sha256').update(fixtureImage).digest('hex');
  const upload = await session.rpc<{ id: string }>(
    scoped(`/threads/${threadId}/uploads`, 'POST', {
      name: 'fixture.png',
      size: fixtureImage.length,
      sha256: digest,
      hashes: [digest],
    }),
  );
  const data = { backendId, threadId, fileId: upload.id };
  assert(host);
  const ready = await session.ready;
  const bulk = await nodeSession(
    origin,
    host,
    phone,
    ready.ticket,
    { type: 'authenticate', protocol: 2, sessionId: ready.sessionId },
    'bulk',
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
    origin,
    host,
    phone,
    ready.ticket,
    { type: 'authenticate', protocol: 2, sessionId: ready.sessionId },
    'bulk',
  );
  try {
    const fetched = await verifyBulk.request('file', {
      backendId,
      threadId,
      fileId: download.id,
      action: 'read',
      index: 0,
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
      requestId,
      expectedTurnId,
      text: 'fixture append to active execution',
    });
  const staleSteerId = randomUUID();
  await session.rpc(steer(staleSteerId, 'stale-turn'));
  await waitFor(
    async () => (await operation(staleSteerId)).state === 'rejected',
    'Stale append operation was not rejected',
  );
  const photoSteerId = randomUUID();
  await session.rpc(
    scoped(`/threads/${threadId}/steer`, 'POST', {
      requestId: photoSteerId,
      expectedTurnId: turn,
      text: 'fixture append with photo',
      uploadIds: [upload.id],
    }),
  );
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
  const createDraftId = randomUUID();
  phase = 'create with first-message model, image, tools and duplicate create';
  const createSkills = await session.rpc<{ skills: { id: string; name: string }[] }>(
    scoped(`/threads/new/skills?creation=1&projectId=${projectId}`),
  );
  const createPlugins = await session.rpc<{ plugins: { id: string; name: string }[] }>(
    scoped(`/threads/new/plugins?creation=1&projectId=${projectId}`),
  );
  assert.equal(createSkills.skills.length, 1);
  assert.equal(createPlugins.plugins.length, 1);
  const createImageHash = createHash('sha256').update(fixtureImage).digest('hex');
  const createUpload = await session.rpc<{ id: string }>(
    scoped(`/threads/new:${createDraftId}/uploads`, 'POST', {
      name: 'create-photo.png',
      size: fixtureImage.length,
      sha256: createImageHash,
      hashes: [createImageHash],
    }),
  );
  const createBulk = await connect();
  try {
    await createBulk.request(
      'file',
      { backendId, threadId: `new:${createDraftId}`, fileId: createUpload.id, action: 'write', index: 0 },
      fixtureImage,
    );
    await createBulk.request('file', {
      backendId,
      threadId: `new:${createDraftId}`,
      fileId: createUpload.id,
      action: 'finish',
    });
  } finally {
    createBulk.close();
  }
  const create = scoped('/threads/new/create', 'POST', {
    requestId: createId,
    prompt: 'fixture create once',
    projectId,
    title: '原生测试会话',
    model: 'fixture-next',
    draftId: createDraftId,
    uploadIds: [createUpload.id],
    skillIds: [createSkills.skills[0].id],
    pluginIds: [createPlugins.plugins[0].id],
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
  adapter = undefined;

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
  adapter = undefined;

  phase = 'read-only gateway';
  adapter = await launch(true);
  session = await connect();
  const status = await session.rpc<{
    connected: boolean;
    writesEnabled: boolean;
    capabilities: {
      questions: boolean;
      renameThread: boolean;
      queue: boolean;
      steer: boolean;
      nextMessageModel?: boolean;
    };
  }>(scoped('/status'));
  assert.equal(status.connected, true);
  assert.equal(status.writesEnabled, false, 'Read-only mode still advertised writes');
  assert.equal(status.capabilities.questions, false, 'Read-only mode still advertised question responses');
  assert.equal(status.capabilities.nextMessageModel, oldGateway ? undefined : false);
  assert.equal(status.capabilities.renameThread, false, 'Read-only mode still advertised rename');
  assert.equal(status.capabilities.queue, false, 'Read-only mode still advertised queue');
  assert.equal(status.capabilities.steer, false, 'Read-only mode still advertised append');
  if (!oldGateway) {
    const permission = await session.rpc<ControlCatalog>(scoped(`/threads/${threadId}/controls`));
    assert.deepEqual(permission.actions, []);
    assert.equal(permission.state.permission, 'antigravity:request-review');
    assert.match(permission.permissionUnavailableReason ?? '', /只读/);
  }
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
    adapter = undefined;
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
    adapter = undefined;
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
    'Native Antigravity: framed SDK plugin, encrypted history/watch, grouped quotas, conversation permissions, selectable skills and plugins, scoped stale-ID rejection, structured questions and continuation, one-time command approval, next-message model, verified photos, native queue, guarded same-execution append and interrupt, durable deduplication, daemon rotation, Rust process recovery, identity/pairing restart and read-only checks passed.',
  );
  if (browserFailure) {
    phase = 'browser acceptance';
    throw browserFailure;
  }
} catch (error) {
  const stderr = adapter?.stderrTail();
  console.error(
    `Native Antigravity smoke failed during ${phase}${stderr ? `\n--- adapter stderr ---\n${stderr}` : ''}`,
  );
  throw error;
} finally {
  await runCleanups([
    () => session?.close(),
    () => adapter?.stop(),
    () => relay?.app.close(),
    () => fixture?.close(),
    () => rm(root, { recursive: true, force: true }),
  ]);
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
