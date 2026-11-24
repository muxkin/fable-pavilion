import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { zstdCompressSync } from 'node:zlib';
import { nodeSession } from '../../src/client/node-session.js';
import type { Config } from '../../src/server/config.js';
import { hostIdentity } from '../../src/server/device-identity.js';
import { FileService } from '../../src/server/file-service.js';
import { platformRuntime } from '../../src/server/platform.js';
import { buildRelay } from '../../src/server/relay.js';
import { Store } from '../../src/server/store.js';
import { Uploads } from '../../src/server/uploads.js';
import type { BackendAppearanceDocument, BackendInfo } from '../../src/shared/backends.js';
import { DeviceLink } from '../../src/shared/device-link.js';
import { BLOCK_SIZE, decryptBlock, type FileManifest } from '../../src/shared/files.js';
import { apiCall } from '../../src/shared/rpc.js';
import { createIdentity, type Identity } from '../../src/shared/secure-channel.js';
import { historyFixture, THREAD } from '../../test/helpers.js';
import {
  CODEX_SMOKE_IDS,
  createCodexDesktopFixture,
  writeCodexForkCliFixture,
  type CodexDesktopFixture,
  type QueueStateControl,
} from './lib/codex-fixture.js';
import { createCodexGoalFixture, type CodexGoalFixture } from './lib/codex-goal-fixture.js';
import { createModernCodexFixture, MODERN_CODEX, type ModernCodexFixture } from './lib/codex-modern-fixture.js';
import { verifyModernCodexRpc } from './lib/codex-modern-suite.js';
import {
  testCodexLive,
  verifyCodexBrowserDirect,
  verifyCodexInstances,
  verifyCodexVoice,
  verifyLiveCodexInstances,
} from './lib/codex-suites.js';
import {
  allocateLocalPort,
  normalizeWindowsStateFiles,
  runCleanups,
  spawnNativeAdapter,
  stopChild,
  waitFor,
  type RunningNativeAdapter,
} from './lib/native-helpers.js';

// Leave a locally installed Antigravity outside the Codex fixture.
process.env.POCKET_NATIVE_ANTIGRAVITY = '0';

const executable = resolve(process.argv[2] ?? 'desktop/native/target/release/agent-space-native');
assert(existsSync(executable), `Rust desktop adapter executable not found: ${executable}`);
const codexPackage = process.argv[3] ? resolve(process.argv[3]) : undefined;
const storageFixture = process.env.POCKET_NATIVE_TEST_STORAGE_PLUGIN;
const bundled = process.env.POCKET_NATIVE_TEST_BUNDLED_PLUGINS === '1';
assert(bundled || codexPackage, 'Supply the Codex plugin directory or test an installer with bundled plugins');

const useIpc = process.env.POCKET_NATIVE_TEST_IPC === '1';
const browserExecutable = process.env.POCKET_NATIVE_TEST_BROWSER_EXECUTABLE;
const testStorage = process.env.POCKET_NATIVE_TEST_STORAGE === '1';
const cloudflare = process.env.POCKET_NATIVE_TEST_RELAY === 'cloudflare';
const { FORK_REPLY, secondaryId } = CODEX_SMOKE_IDS;

const directory = await mkdtemp(
  join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'native-adapter-smoke-'),
);
const state = join(directory, 'state');
const legacyState = join(directory, 'legacy');
const codexHome = join(directory, 'codex');
const projectPath = join(directory, 'project');
const secondaryHome = join(directory, secondaryId);
const modernHome = join(directory, MODERN_CODEX.id);
const secondaryUploads = join(legacyState, 'backends', secondaryId, 'uploads');

const adapter = (...args: string[]) =>
  promisify(execFile)(executable, ['--adapter', ...args], {
    env: { ...process.env, POCKET_NATIVE_STATE_DIR: state },
  });
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let ipc: CodexDesktopFixture | undefined;
let secondaryIpc: CodexDesktopFixture | undefined;
let goalFixture: CodexGoalFixture | undefined;
let modernFixture: ModernCodexFixture | undefined;
let relay: { listen: () => Promise<unknown>; close: () => Promise<unknown> } | undefined;
let activeGateway: RunningNativeAdapter | undefined;
let phase = 'setup';

async function stopGateway() {
  const current = activeGateway;
  activeGateway = undefined;
  await current?.stop();
}

async function cloudflareRelay(origin: string, enrollment: string, port: number) {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  // The Worker bundle is produced by npm run check:deployments.
  const worker = new Miniflare({
    ...convertV4MiniflareOptions({
      name: 'native-relay-smoke',
      modules: true,
      scriptPath: '.implementation/cloudflare/index.js',
      compatibilityDate: '2026-11-04',
      compatibilityFlags: ['nodejs_compat'],
      host: '127.0.0.1',
      port,
      bindings: {
        POCKET_PUBLIC_ORIGIN: origin,
        POCKET_RELAY_ENROLLMENT: enrollment,
      },
      durableObjects: {
        RELAY: { className: 'RelayHub', useSQLite: true },
        MESSAGING: { className: 'MessagingHub', useSQLite: true },
      },
      r2Buckets: ['IM_MEDIA'],
      images: { binding: 'IMAGES' },
      serviceBindings: { ASSETS: () => new Response(null, { status: 404 }) },
    }),
  });
  return { listen: () => worker.ready, close: () => worker.dispose() };
}

async function verifyTlsClient() {
  const probe = createServer();
  const hello = new Promise<Buffer>((resolveHello, rejectHello) => {
    probe.on('connection', (socket) => {
      // The probe only reads the ClientHello. The adapter may reset a connection during teardown.
      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ECONNRESET') rejectHello(error);
      });
      socket.once('data', (bytes) => {
        resolveHello(bytes);
        socket.destroy();
      });
    });
  });
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert(address && typeof address !== 'string');
  const child = spawn(executable, ['--headless'], {
    env: {
      ...process.env,
      POCKET_NATIVE_STATE_DIR: join(directory, 'tls-probe'),
      POCKET_NATIVE_ORIGIN: `https://127.0.0.1:${address.port}`,
      POCKET_NATIVE_ENROLLMENT: '',
      POCKET_NATIVE_CODEX_HOME: codexHome,
      POCKET_NATIVE_READ_ONLY: '1',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const closed = once(child, 'close');
  void closed.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bytes = await Promise.race([
      hello,
      closed.then(() => {
        throw Error('Native gateway exited before sending a TLS ClientHello');
      }),
      new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(Error('Native gateway did not send a TLS ClientHello')), 5000);
      }),
    ]);
    assert.equal(bytes[0], 0x16, 'Expected a TLS handshake record');
  } finally {
    clearTimeout(timer);
    await stopChild(child, closed);
    await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  }
}

async function seedBundledUpgrade() {
  const root = join(state, 'native-plugins');
  const db = new DatabaseSync(join(root, 'registry.sqlite'));
  try {
    const row = db
      .prepare(
        `
      SELECT p.key, p.directory, p.manifest FROM bindings b JOIN packages p ON b.current = p.key
      WHERE b.instance = 'codex-local'
    `,
      )
      .get() as { key: string; directory: string; manifest: string };
    const manifest = JSON.parse(row.manifest);
    const old = { ...manifest, version: '0.0.1' };
    const oldDir = join(state, 'old-official-fixture');
    await mkdir(oldDir, { mode: 0o700 });
    await copyFile(join(root, 'packages', row.directory, manifest.entry), join(oldDir, manifest.entry));
    await writeFile(join(oldDir, 'adapter.json'), JSON.stringify(old));
    await adapter('install', oldDir);
    const previous = old.name + '@' + old.version;
    db.prepare("UPDATE bindings SET current=?,previous=NULL WHERE instance='codex-local'").run(previous);
    return { current: row.key, previous };
  } finally {
    db.close();
  }
}

async function waitForBundledBinding(current: string, previous: string) {
  await waitFor(
    async () => {
      const { stdout } = await adapter('list');
      const binding = JSON.parse(stdout).instances.find(
        ({ instance }: { instance: string }) => instance === 'codex-local',
      );
      return binding?.current === current && binding.previous === previous;
    },
    {
      description: `Bundled Codex binding did not reach ${current} with rollback to ${previous}`,
      timeoutMs: 10_000,
      intervalMs: 100,
    },
  );
}

async function installStorageFixture(fixturePath: string) {
  const storageDir = join(state, 'storage-fixture');
  await mkdir(storageDir, { mode: 0o700 });
  const entry = process.platform === 'win32' ? 'fixture.exe' : 'fixture';
  await copyFile(resolve(fixturePath), join(storageDir, entry));
  const sha256 = digest(await readFile(join(storageDir, entry)));
  await writeFile(
    join(storageDir, 'adapter.json'),
    JSON.stringify({
      sdk: 1,
      name: 'native-storage-fixture',
      version: '1.0.0',
      product: 'object-storage',
      stateVersion: 1,
      entry,
      sha256,
    }),
    { mode: 0o600 },
  );
  await adapter('install', storageDir);
  const config = join(state, 'storage-config.json');
  const profile = join(state, 'transport.env');
  await writeFile(config, '{"token":"fixture-only"}', { mode: 0o600 });
  await writeFile(
    profile,
    [
      'POCKET_NATIVE_STORAGE_PLUGIN=native-storage-fixture@1.0.0',
      'POCKET_NATIVE_STORAGE_PLUGIN_CONFIG=' + JSON.stringify(config),
      'POCKET_MEDIA_PREFIX=fixture',
    ].join('\n'),
    { mode: 0o600 },
  );
  if (process.platform === 'win32') {
    platformRuntime().privateFile(config);
    platformRuntime().privateFile(profile);
  }
}

try {
  const legacyOperation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await mkdir(legacyState, { mode: 0o700 });
  const host = await hostIdentity(legacyState);
  const existingPhone = await createIdentity();
  const store = new Store(legacyState);
  let old: NonNullable<ReturnType<Store['pair']>>;
  let oldRouteTicket: string;
  try {
    const paired = store.pair(store.mintPairing().code, 'Existing phone', existingPhone.peerId);
    assert(paired?.routeTicket);
    old = paired;
    oldRouteTicket = paired.routeTicket;
    store.updateBackendAppearance('codex-local', {
      description: '旧版显示说明',
      icon: { kind: 'builtin', value: 'monitor' },
    });
    if (codexPackage) {
      store.beginOperation(
        legacyOperation,
        old.deviceId,
        THREAD,
        'rename',
        JSON.stringify({ title: '旧操作' }),
        secondaryId,
      );
      store.updateOperation(legacyOperation, 'completed', null, null, secondaryId);
    }
  } finally {
    store.close();
  }

  const rollout = historyFixture({ codexHome } as Parameters<typeof historyFixture>[0]);
  const legacyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const legacyName = '旧附件.txt';
  const legacyPath = join(legacyState, 'uploads', legacyId, legacyName);
  const legacyBytes = Buffer.from('旧附件校验数据');
  const migratedDraftId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const migratedDraftPath = join(legacyState, 'uploads', migratedDraftId, legacyName);
  const migratedNativeId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const migratedNativeDir = join(legacyState, 'native-uploads', migratedNativeId);
  const migratedNativePath = join(migratedNativeDir, 'attachment.txt');
  const inlineBytes = Buffer.alloc(420_000, 37);
  const inlineSource = 'data:image/png;base64,' + inlineBytes.toString('base64');
  const inlineRef = 'pocket-inline:' + createHash('sha256').update(inlineSource).digest('hex') + '.png';
  const projectFile = join(projectPath, 'report.txt');
  const projectPdf = 'main.pdf';
  const projectPng = 'wphase-ce-search-page-5.png';
  const pdfObjects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = pdfObjects.map((body, index) => {
    const start = pdf.length;
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return String(start).padStart(10, '0') + ' 00000 n \n';
  });
  const xref = pdf.length;
  pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const pdfBytes = Buffer.from(pdf);
  const pngBytes = await readFile('src/web/public/app-icon-32.png');
  const unrelatedFile = join(projectPath, 'unrelated.txt');
  const outsidePng = join(directory, 'outside-settings.png');
  await mkdir(projectPath, { recursive: true });
  await writeFile(projectFile, 'project attachment');
  await writeFile(join(projectPath, projectPdf), pdfBytes);
  await writeFile(join(projectPath, projectPng), pngBytes);
  await writeFile(unrelatedFile, 'unmentioned file');
  await writeFile(outsidePng, pngBytes);
  await mkdir(join(legacyState, 'uploads', legacyId), { mode: 0o700, recursive: true });
  await writeFile(legacyPath, legacyBytes, { mode: 0o600 });
  if (process.platform === 'win32') platformRuntime().privateFile(legacyPath);
  await mkdir(join(migratedDraftPath, '..'), { mode: 0o700 });
  await writeFile(migratedDraftPath, legacyBytes, { mode: 0o600 });
  const migratedReceipt = join(legacyState, 'uploads', migratedDraftId + '.json');
  const migratedDigest = digest(legacyBytes);
  await writeFile(
    migratedReceipt,
    JSON.stringify({
      id: migratedDraftId,
      device: old.deviceId,
      thread: THREAD,
      name: legacyName,
      file: migratedDraftPath,
      size: legacyBytes.length,
      sha256: migratedDigest,
      complete: true,
    }),
    { mode: 0o600 },
  );
  await mkdir(migratedNativeDir, { mode: 0o700, recursive: true });
  await writeFile(migratedNativePath, legacyBytes, { mode: 0o600 });
  if (process.platform === 'win32') {
    const runtime = platformRuntime();
    for (const dir of [join(legacyState, 'native-uploads'), migratedNativeDir]) runtime.privateDirectory(dir);
    for (const path of [migratedReceipt, migratedDraftPath, migratedNativePath]) runtime.privateFile(path);
  }

  const legacyBlocks = [Buffer.alloc(BLOCK_SIZE, 43), Buffer.alloc(BLOCK_SIZE, 92), Buffer.from('最后一块')];
  const legacyBlockBytes = Buffer.concat(legacyBlocks);
  const legacyRawBytes = Buffer.from('old upload in three pieces');
  const legacyConfig = { stateDir: legacyState } as Config;
  const legacyUploads = new Uploads(legacyConfig);
  const legacyFiles = new FileService(legacyConfig, legacyUploads);
  let legacyManifest: FileManifest;
  try {
    legacyManifest = await legacyFiles.begin(
      {
        name: 'old-blocks.bin',
        size: legacyBlockBytes.length,
        sha256: digest(legacyBlockBytes),
        hashes: legacyBlocks.map(digest),
      },
      old.deviceId,
      THREAD,
    );
    for (const index of [0, 1]) {
      await legacyFiles.handle(
        'write',
        { threadId: THREAD, fileId: legacyManifest.id, index },
        old.deviceId,
        legacyBlocks[index],
      );
    }
  } finally {
    legacyFiles.close();
  }
  const legacyBlockUpload = await legacyUploads.get(legacyManifest.id, old.deviceId, THREAD);
  const legacyBlockPart = legacyBlockUpload.file + '.part';
  const corruptBlock = await open(legacyBlockPart, 'r+');
  try {
    await corruptBlock.write(Buffer.from([0]), 0, 1, BLOCK_SIZE);
  } finally {
    await corruptBlock.close();
  }
  const legacyRawUpload = await legacyUploads.begin(
    { name: 'old-offset.txt', size: legacyRawBytes.length, sha256: digest(legacyRawBytes) },
    old.deviceId,
    THREAD,
  );
  await legacyUploads.chunk(legacyRawUpload.id, old.deviceId, THREAD, 0, legacyRawBytes.subarray(0, 4));
  const legacyRawPart = (await legacyUploads.get(legacyRawUpload.id, old.deviceId, THREAD)).file + '.part';
  const legacyRenamedUpload = await legacyUploads.begin(
    { name: 'old-renamed.txt', size: legacyRawBytes.length, sha256: digest(legacyRawBytes) },
    old.deviceId,
    THREAD,
  );
  await legacyUploads.chunk(legacyRenamedUpload.id, old.deviceId, THREAD, 0, legacyRawBytes);
  const legacyRenamedPath = (await legacyUploads.get(legacyRenamedUpload.id, old.deviceId, THREAD)).file;
  await rename(legacyRenamedPath + '.part', legacyRenamedPath);
  const transfersDir = join(legacyState, 'transfers-v2');
  const legacyUploadSources = [
    legacyBlockPart,
    legacyRawPart,
    legacyRenamedPath,
    join(transfersDir, legacyManifest.id + '.json'),
    ...[legacyManifest.id, legacyRawUpload.id, legacyRenamedUpload.id].map((id) =>
      join(legacyState, 'uploads', id + '.json'),
    ),
  ];
  if (process.platform === 'win32') {
    const runtime = platformRuntime();
    runtime.privateDirectory(transfersDir);
    for (const path of [legacyBlockPart, legacyRawPart, legacyRenamedPath])
      runtime.privateDirectory(join(path, '..'));
    for (const path of legacyUploadSources) runtime.privateFile(path);
  }
  const legacyUploadSnapshots = await Promise.all(legacyUploadSources.map((path) => readFile(path)));
  const legacyTransfer = { backendId: 'codex-local', threadId: THREAD, fileId: legacyManifest.id };
  const legacyMissing = { ...legacyTransfer, action: 'missing' };
  const rawChunk = (offset: number) =>
    apiCall(`/threads/${THREAD}/uploads/${legacyRawUpload.id}/chunk?offset=${offset}`, 'POST');
  const rawFinish = apiCall(`/threads/${THREAD}/uploads/${legacyRawUpload.id}/complete`, 'POST');
  const legacyNativeDb = new DatabaseSync(join(legacyState, 'state.sqlite'));
  try {
    legacyNativeDb.exec(`CREATE TABLE native_uploads (
      id TEXT PRIMARY KEY, device TEXT NOT NULL, thread TEXT NOT NULL, manifest TEXT NOT NULL,
      present TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL
    )`);
    legacyNativeDb.prepare('INSERT INTO native_uploads VALUES (?,?,?,?,?,1,0)').run(
      migratedNativeId,
      old.deviceId,
      THREAD,
      JSON.stringify({
        id: migratedNativeId,
        name: legacyName,
        size: legacyBytes.length,
        sha256: migratedDigest,
        hashes: [migratedDigest],
        version: migratedNativeId,
        storage: false,
        key: randomBytes(32).toString('base64'),
        nonce: randomBytes(8).toString('base64'),
      }),
      '[0]',
    );
  } finally {
    legacyNativeDb.close();
  }

  const legacyRecord = JSON.parse(await readFile(rollout, 'utf8'));
  legacyRecord.payload.content[0].text +=
    '\n\n手机上传的附件（保留原始文件）：\n' + JSON.stringify({ name: legacyName, path: legacyPath });
  const hiddenGoalRecord = {
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'goal-fixture-message',
      role: 'user',
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['goal.internal_context'] },
      content: [{ type: 'input_text', text: 'Fixture-only internal goal context.' }],
    },
  };
  const hiddenGoalOffset = Buffer.byteLength(JSON.stringify(legacyRecord) + '\n');
  const historicalReply =
    ':codex-file-citation{path="./report.txt" purpose="open"}\n' +
    `[${projectPdf}](sandbox:./${projectPdf})\n![${projectPng}](sandbox:./${projectPng})\n` +
    `[临时目录截图](<${outsidePng}>)\n` +
    '`:codex-file-citation{path="./unrelated.txt"}`\n' +
    'Earlier history. '.repeat(800);
  const assistantRecord = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: historicalReply },
        { type: 'input_image', image_url: inlineSource },
      ],
    },
  };
  const viewed = await Promise.all(
    [32, 192].map(async (width, index) => ({
      path: pathToFileURL(join(directory, `removed-page-${5 + index}.png`)).href,
      bytes: await readFile(`src/web/public/app-icon-${width}.png`),
      width,
    })),
  );
  const unpaired = pathToFileURL(join(directory, 'unpaired.png')).href;
  const activityEvent = (item: Record<string, unknown>) => ({
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: THREAD, turn_id: 'earlier-turn', item },
  });
  const imageCall = (id: string, paths: string[], outputs: Buffer[]) => [
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: id } },
    ...paths.map((path) => activityEvent({ type: 'ImageView', path })),
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: id,
        output: [
          { type: 'input_text', text: 'test fixture' },
          ...outputs.map((bytes) => ({
            type: 'input_image',
            image_url: 'data:image/png;base64,' + bytes.toString('base64'),
          })),
        ],
      },
    },
  ];
  const generatedBytes = await readFile('src/web/public/app-icon-180.png');
  const generatedData = generatedBytes.toString('base64');
  const generatedRef = (data: string) =>
    'pocket-inline:' + createHash('sha256').update('data:image/png;base64,' + data).digest('hex') + '.png';
  const generatedEvent = activityEvent({
    type: 'Extension',
    kind: 'image_gen.generation',
    status: 'completed',
    result: generatedData,
    savedPath: join(directory, 'moved-generated-image.png'),
  });
  const foreignData = (await readFile('src/web/public/app-icon-512.png')).toString('base64');
  const foreignGeneratedEvent = {
    ...generatedEvent,
    payload: {
      ...generatedEvent.payload,
      thread_id: FORK_REPLY,
      item: { ...generatedEvent.payload.item, result: foreignData },
    },
  };
  const historicalTool = activityEvent({
    type: 'CommandExecution',
    command: ['printf', 'historical tool'],
    status: 'completed',
    aggregated_output: 'historical output',
    exit_code: 0,
  });
  await writeFile(
    rollout + '.zst',
    zstdCompressSync(
      Buffer.from(
        [
          legacyRecord,
          hiddenGoalRecord,
          historicalTool,
          activityEvent({ type: 'ContextCompaction', id: 'history-compaction', summary: 'fixture-private-summary' }),
          activityEvent({
            type: 'SubAgentActivity',
            id: 'history-agent',
            kind: 'completed',
            agent_thread_id: 'fixture-agent',
            agent_path: '/验证',
          }),
          { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'historical-turn', duration_ms: 1056000 } },
          generatedEvent,
          foreignGeneratedEvent,
          ...imageCall(
            'viewed',
            viewed.map((item) => item.path),
            viewed.map((item) => item.bytes),
          ),
          ...imageCall(
            'unpaired',
            [unpaired],
            viewed.map((item) => item.bytes),
          ),
          assistantRecord,
          ...Array.from({ length: 9 }, () => ({
            type: 'event_msg',
            payload: { type: 'internal', trace: 'x'.repeat(80_000) },
          })),
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      ),
    ),
  );
  const historyDb = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
  try {
    historyDb.exec("INSERT INTO projects VALUES ('native-project','材料研究',0),('empty-project','空项目',1)");
    historyDb
      .prepare('UPDATE threads SET rollout_path=?,cwd=? WHERE id=?')
      .run(relative(codexHome, rollout), projectPath, THREAD);
  } finally {
    historyDb.close();
  }
  await rm(rollout);

  const globalPath = join(codexHome, '.codex-global-state.json');
  const globalFixture = {
    'app-server-project-id-by-legacy-project-id-by-host': {
      ['local:' + codexHome]: { 'legacy-project': 'native-project' },
    },
    'thread-project-assignments': { [THREAD]: { projectKind: 'local', projectId: 'legacy-project' } },
    'queued-follow-ups': {} as Record<string, any[]>,
  };
  let queueProtocolVersion = 1;
  const queueControl: QueueStateControl = {
    globalPath,
    globalFixture,
    getProtocolVersion: () => queueProtocolVersion,
    setProtocolVersion: (version: number) => {
      queueProtocolVersion = version;
    },
    protocolAttempts: [],
  };
  await writeFile(globalPath, JSON.stringify(globalFixture));
  await writeFile(
    join(codexHome, 'models_cache.codex_work_desktop.json'),
    JSON.stringify({
      models: [
        {
          slug: 'fixture-model',
          display_name: 'Fixture Model',
          visibility: 'list',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }],
          service_tiers: [{ id: 'fast', name: '快速' }],
        },
        { slug: 'hidden-model', visibility: 'hide' },
      ],
    }),
  );
  const skillRoot = join(codexHome, 'skills', 'fixture');
  const pluginRoot = join(codexHome, 'plugins', 'cache', 'fixture-market', 'fixture-plugin');
  await mkdir(skillRoot, { recursive: true });
  await mkdir(join(pluginRoot, '1.0.0', '.codex-plugin'), { recursive: true });
  await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: fixture\ndescription: a native skill\n---\n');
  await writeFile(join(pluginRoot, '.codex-remote-plugin-install.json'), '{"remote_plugin_id":"fixture"}');
  await writeFile(join(pluginRoot, '1.0.0', '.codex-plugin', 'plugin.json'), '{"name":"Fixture Plugin"}');

  const voiceStopped = join(directory, 'voice-stopped');
  const forkCli = await writeCodexForkCliFixture({ directory, threadId: THREAD, projectPath, voiceStopped });
  if (useIpc && process.platform !== 'win32') goalFixture = await createCodexGoalFixture(codexHome, THREAD);
  ipc = useIpc
    ? await createCodexDesktopFixture({
        directory,
        threadId: THREAD,
        projectPath,
        legacyName,
        legacyPath,
        viewed,
        queue: queueControl,
      })
    : undefined;
  const secondaryTitle = '第二个 Codex 会话';
  const secondaryRename = '第二个 Codex 已改名';
  secondaryIpc =
    ipc && codexPackage
      ? await createCodexDesktopFixture({
          id: secondaryId,
          initialTitle: secondaryTitle,
          renameTitle: secondaryRename,
          directory,
          threadId: THREAD,
          projectPath,
          legacyName,
          legacyPath,
          viewed,
          queue: queueControl,
        })
      : undefined;
  const secondaryPath = join(secondaryUploads, legacyId, legacyName);
  const secondaryBytes = Buffer.from('第二个实例的附件');
  if (ipc && codexPackage) {
    const rollout = historyFixture({ codexHome: modernHome } as Parameters<typeof historyFixture>[0]);
    const otherRollout = join(modernHome, 'sessions', `rollout-${MODERN_CODEX.otherThreadId}.jsonl`);
    await writeFile(otherRollout, '');
    const db = new DatabaseSync(join(modernHome, 'state_5.sqlite'));
    try {
      db.prepare('UPDATE threads SET title = ?, cwd = ? WHERE id = ?').run(MODERN_CODEX.title, directory, THREAD);
      db.prepare(`
        INSERT INTO threads (id, title, cwd, updated_at_ms, archived, thread_source, rollout_path)
        VALUES (?, ?, ?, 100, 0, 'user', ?)
      `).run(MODERN_CODEX.otherThreadId, '第二个新版 Codex 测试会话', directory, otherRollout);
    } finally {
      db.close();
    }
    modernFixture = await createModernCodexFixture(directory, THREAD, rollout);
  }

  const port = await allocateLocalPort();
  const origin = `http://127.0.0.1:${port}`;
  const enrollment = randomBytes(32).toString('hex');
  const activeRelay = cloudflare
    ? await cloudflareRelay(origin, enrollment, port)
    : await buildRelay({
        origin,
        enrollmentSecret: enrollment,
        webRoot: browserExecutable
          ? resolve(process.env.TEST_WEB_ROOT ?? '.implementation/deployment-parity/node-web')
          : join(directory, 'no-web'),
        assetOrigin: null,
        uploadOrigins: [],
        ...(browserExecutable && {
          messaging: {
            registrationEnabled: true,
            deviceLoginOnly: false,
            totpKey: randomBytes(32).toString('base64url'),
          },
        }),
      }).then(({ app }) => ({
        listen: () => app.listen({ host: '127.0.0.1', port }),
        close: () => app.close(),
      }));
  relay = activeRelay;

  async function launch(useSaved = false, extraEnvironment: NodeJS.ProcessEnv = {}) {
    normalizeWindowsStateFiles(state, [
      'device-identity-v2.json',
      'state.sqlite-wal',
      'state.sqlite-shm',
      'state.sqlite-journal',
    ]);
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          key.toUpperCase() !== 'POCKET_NATIVE_LEGACY_STATE' &&
          (!codexPackage || !/^POCKET_NATIVE_CODEX_/i.test(key)),
      ),
    );
    const started = await spawnNativeAdapter({
      command: executable,
      args: ['--headless', '--print-pair'],
      origin,
      timeoutMs: 20_000,
      env: {
        ...inherited,
        POCKET_NATIVE_ORIGIN: useSaved ? '' : origin,
        POCKET_NATIVE_ENROLLMENT: useSaved ? '' : enrollment,
        POCKET_NATIVE_STATE_DIR: state,
        POCKET_NATIVE_P2P: '1',
        ...(!codexPackage ? { POCKET_NATIVE_CODEX_HOME: codexHome } : {}),
        POCKET_NATIVE_READ_ONLY: ipc ? '0' : '1',
        ...(ipc && !codexPackage
          ? {
              POCKET_NATIVE_CODEX_SOCKET: ipc.path,
              POCKET_NATIVE_CODEX_EXECUTABLE: process.execPath,
              ...(forkCli ? { POCKET_NATIVE_CODEX_CLI: forkCli } : {}),
            }
          : {}),
        ...extraEnvironment,
      },
    });
    assert.equal(started.host, host.peerId, 'Native adapter changed the existing host identity');
    activeGateway = started;
    return started;
  }

  const reconnect = (phone: Identity, ticket: string) =>
    nodeSession(origin, host.peerId, phone, ticket, {
      type: 'authenticate',
      protocol: 2,
      sessionId: crypto.randomUUID(),
    });

  async function installCodexVariants(folder: string) {
    const manifest: { name: string; version: string; entry: string } = JSON.parse(
      await readFile(join(folder, 'adapter.json'), 'utf8'),
    );
    assert.equal(manifest.name, '@agent-remote/adapter-codex');
    await adapter('install', folder);
    const replacement = join(directory, 'codex-plugin-replacement');
    await mkdir(replacement);
    await copyFile(join(folder, manifest.entry), join(replacement, manifest.entry));
    const next = { ...manifest, version: manifest.version + '-qa.1' };
    await writeFile(join(replacement, 'adapter.json'), JSON.stringify(next));
    await adapter('install', replacement);
    const secondaryRollout = historyFixture({ codexHome: secondaryHome } as Parameters<typeof historyFixture>[0]);
    const secondaryDb = new DatabaseSync(join(secondaryHome, 'state_5.sqlite'));
    try {
      secondaryDb.prepare('UPDATE threads SET title = ?, cwd = ? WHERE id = ?').run(secondaryTitle, directory, THREAD);
    } finally {
      secondaryDb.close();
    }
    const record = JSON.parse(await readFile(secondaryRollout, 'utf8'));
    record.payload.content[0].text =
      '第二个实例的历史' +
      '\n\n手机上传的附件（保留原始文件）：\n' +
      [secondaryPath, legacyPath].map((path) => JSON.stringify({ name: legacyName, path })).join('\n');
    await writeFile(secondaryRollout, JSON.stringify(record) + '\n');
    await mkdir(join(secondaryUploads, legacyId), { mode: 0o700, recursive: true });
    await writeFile(secondaryPath, secondaryBytes, { mode: 0o600 });
    if (process.platform === 'win32') platformRuntime().privateFile(secondaryPath);
    const configPath = join(state, 'instances.json');
    await writeFile(
      configPath,
      JSON.stringify([
        {
          id: 'codex-local',
          name: 'Codex fixture',
          plugin: manifest.name,
          version: manifest.version,
          config: {
            home: codexHome,
            socket: ipc?.path,
            appTools: browserExecutable ? ipc?.path : undefined,
            executable: ipc ? process.execPath : undefined,
            cli: forkCli,
          },
        },
        {
          id: secondaryId,
          name: 'Codex secondary',
          plugin: manifest.name,
          version: manifest.version,
          config: {
            home: secondaryHome,
            socket: secondaryIpc?.path,
            appTools: secondaryIpc?.path,
            executable: secondaryIpc ? process.execPath : undefined,
          },
        },
        ...(modernFixture ? [{
          id: MODERN_CODEX.id,
          name: 'Modern Codex fixture',
          plugin: manifest.name,
          version: manifest.version,
          config: {
            home: modernHome,
            socket: process.platform === 'win32'
              ? '\\\\.\\pipe\\agent-space-native-missing-' + crypto.randomUUID()
              : join(directory, 'missing-follower.sock'),
            appTools: modernFixture.path,
            executable: process.execPath,
          },
        }] : []),
      ]),
      { mode: 0o600 },
    );
    if (process.platform === 'win32') platformRuntime().privateFile(configPath);
    return { initial: manifest.version, next: next.version, name: manifest.name };
  }

  async function verifyStorageFixture(session: DeviceLink, downloaded: FileManifest) {
    const download = { backendId: 'codex-local', threadId: THREAD, fileId: downloaded.id };
    const { value: plan } = await session.request('file', { ...download, action: 'storage-plan', indices: [0] });
    assert.equal(plan.url, `https://objects.example.org/${plan.objectId}?signed=fixture`);
    const plugin = join(state, 'native-storage-plugin');
    const stored = join(plugin, plan.objectId);
    const encrypted = await readFile(stored);
    assert.equal(encrypted.length, legacyBytes.length + 16);
    assert.deepEqual(Buffer.from(await decryptBlock(downloaded, 0, encrypted)), legacyBytes);
    await session.request('file', { ...download, action: 'storage-done', objectId: plan.objectId });
    assert(!existsSync(stored));
    for (const [index, encoding] of [
      [1, 'raw'],
      [2, 'multipart'],
    ] as const) {
      const { value } = await session.request('file', {
        ...legacyTransfer,
        action: 'storage-plan',
        indices: [index],
      });
      assert.equal(value.upload.encoding, encoding);
      assert.equal(new URL(value.upload.url).origin, 'https://uploads.example.org');
    }
    console.log('Native storage plugin verified encrypted put, signed download, both upload grant types, and cleanup.');
  }

  phase = 'legacy state import';
  const legacyDesktop = join(directory, 'old-desktop-settings.json');
  if (bundled) {
    const work = join(directory, 'old-working-directory');
    const environment = join(directory, 'old-external.env');
    const instances = join(work, 'configured-instances.json');
    await mkdir(work, { mode: 0o700 });
    await writeFile(environment, 'POCKET_ADAPTERS_FILE=configured-instances.json\n', { mode: 0o600 });
    await writeFile(
      instances,
      JSON.stringify([
        {
          id: 'codex-local',
          name: 'Migrated Codex fixture',
          plugin: '@agent-remote/adapter-codex',
        },
      ]),
      { mode: 0o600 },
    );
    await writeFile(
      legacyDesktop,
      JSON.stringify({
        origin,
        legacyGateway: { environmentFile: environment, workingDirectory: work },
      }),
      { mode: 0o600 },
    );
    if (process.platform === 'win32') {
      platformRuntime().privateFile(environment);
      platformRuntime().privateFile(instances);
    }
  }
  const importer = () =>
    promisify(execFile)(executable, ['--import-node-state', legacyState, ...(bundled ? [] : ['--origin', origin])], {
      env: {
        ...process.env,
        POCKET_NATIVE_STATE_DIR: state,
        ...(bundled ? { POCKET_NATIVE_LEGACY_DESKTOP_SETTINGS: legacyDesktop } : {}),
      },
    });
  const supervisor = join(legacyState, 'adapters', 'supervisor.json');
  await mkdir(join(legacyState, 'adapters'), { mode: 0o700 });
  await writeFile(supervisor, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  await assert.rejects(importer(), /监督器记录/);
  assert(!existsSync(state), 'An active legacy gateway created a partial destination');
  await rm(supervisor);
  const identityBefore = await readFile(join(legacyState, 'device-identity-v2.json'));
  const databaseBefore = await readFile(join(legacyState, 'state.sqlite'));
  await importer();
  assert.equal(await readFile(join(state, 'service-origin'), 'utf8'), origin);
  assert.deepEqual(await readFile(join(state, 'device-identity-v2.json')), identityBefore);
  assert.deepEqual(await readFile(join(legacyState, 'state.sqlite')), databaseBefore);
  await assert.rejects(importer(), /目标状态目录已存在/);
  if (storageFixture) await installStorageFixture(storageFixture);

  phase = 'TLS handshake and relay startup';
  await verifyTlsClient();
  await activeRelay.listen();

  if (codexPackage && !bundled) {
    phase = 'missing plugin rejection';
    await launch(false, { POCKET_NATIVE_CODEX_HOME: codexHome });
    try {
      const session = await reconnect(existingPhone, oldRouteTicket);
      try {
        const ready = await session.ready;
        assert.equal(ready.status.reason, '尚未安装 Codex 插件');
        assert.equal(ready.status.writesEnabled, false);
        assert.equal(ready.p2p.enabled, true);
        const { backends } = await session.rpc<{ backends: { id: string }[] }>(apiCall('/backends'));
        assert(!backends.some(({ id }) => id === 'codex-local'), 'Codex opened local history without a plugin');
      } finally {
        session.close();
      }
    } finally {
      await stopGateway();
    }
  }

  phase = 'plugin installation and gateway startup';
  const versions = codexPackage ? await installCodexVariants(codexPackage) : undefined;
  let gateway = await launch();

  if (bundled) {
    const { stdout } = await adapter('list');
    const { packages, instances } = JSON.parse(stdout) as {
      packages: string[];
      instances: { instance: string; current: string; previous: string | null }[];
    };
    const official = packages.filter((key) => /^@agent-remote\/adapter-(codex|dsh|antigravity)@/.test(key));
    const codex = official.find((key) => key.startsWith('@agent-remote/adapter-codex@'));
    assert(codex);
    const version = codex.split('@').at(-1);
    assert.deepEqual(
      official.sort(),
      ['antigravity', 'codex', 'dsh'].map((product) => `@agent-remote/adapter-${product}@${version}`),
    );
    assert.deepEqual(instances, [{ instance: 'codex-local', current: codex, previous: null }]);
    console.log('Installed desktop adapter automatically registered all three official plugins and bound Codex.');
  }

  if (browserExecutable) {
    phase = 'browser direct WebRTC and media verification';
    assert(ipc && !cloudflare, 'Browser smoke requires the Node relay and desktop fixture');
    await verifyCodexBrowserDirect({
      code: gateway.pairCode,
      executablePath: browserExecutable,
      fixture: ipc,
      origin,
      hostPeerId: host.peerId,
      goalControls: !!goalFixture,
      modern: modernFixture ? { fixture: modernFixture, threadId: THREAD } : undefined,
      projectPdf,
      projectPng,
      pdfBytes,
      viewed,
    });
    await stopGateway();
    ipc.closeConversation();
    ipc.actions.length = 0;
    gateway = await launch(true);
  }

  phase = 'migrated device reconnect, uploads and appearance';
  const appearancePath = '/backends/codex-local/appearance';
  const getAppearance = (client: DeviceLink) => client.rpc<BackendAppearanceDocument>(apiCall(appearancePath));
  const cliAppearance = (...args: string[]) =>
    promisify(execFile)(executable, ['--instance', ...args], {
      env: { ...process.env, POCKET_NATIVE_STATE_DIR: state },
    });
  const restoreDraft = apiCall(`/threads/${THREAD}/uploads/${migratedDraftId}/complete`, 'POST');
  let savedAppearance: BackendAppearanceDocument;

  const existing = await reconnect(existingPhone, oldRouteTicket);
  try {
    assert.equal((await existing.ready).device.id, old.deviceId);
    assert.deepEqual(await existing.rpc(restoreDraft), {
      id: migratedDraftId,
      name: legacyName,
      path: migratedDraftPath,
    });
    for (const path of [migratedDraftPath, migratedNativePath]) {
      const manifest = await existing.rpc<FileManifest>(apiCall(`/threads/${THREAD}/media`, 'POST', { path }));
      if (path === migratedNativePath) {
        assert.equal(manifest.id, migratedNativeId);
        if (storageFixture) await verifyStorageFixture(existing, manifest);
      }
      const bytes = await existing.request('file', {
        backendId: 'codex-local',
        threadId: THREAD,
        fileId: manifest.id,
        action: 'read',
        index: 0,
      });
      assert.deepEqual(Buffer.from(bytes.bytes!), legacyBytes);
    }
    const importedTransfer = (await existing.request('file', legacyMissing)).value;
    assert.deepEqual(importedTransfer.missing, [1, 2]);
    for (const field of ['id', 'version', 'key', 'nonce'] as const)
      assert.equal(importedTransfer.manifest[field], legacyManifest[field]);
    await existing.request('file', { ...legacyTransfer, action: 'write', index: 1 }, legacyBlocks[1]);
    await assert.rejects(existing.rpc(rawChunk(0), legacyRawBytes.subarray(4, 9)));
    assert.deepEqual(await existing.rpc(rawChunk(4), legacyRawBytes.subarray(4, 9)), { offset: 9 });
    await assert.rejects(existing.rpc(rawFinish));
    const corruptedDraft = Buffer.from(legacyBytes);
    corruptedDraft[0] ^= 1;
    await writeFile(migratedDraftPath, corruptedDraft);
    try {
      await assert.rejects(
        existing.rpc(apiCall(`/threads/${THREAD}/media`, 'POST', { path: migratedDraftPath })),
        { status: 400 },
      );
    } finally {
      await writeFile(migratedDraftPath, legacyBytes);
    }
    const updateAppearance = (revision: number, patch: unknown) =>
      existing.rpc<BackendAppearanceDocument>(apiCall(appearancePath, 'POST', { revision, patch }));
    const importedAppearance = await getAppearance(existing);
    assert.equal(importedAppearance.revision, 1);
    assert.equal(importedAppearance.values.description, '旧版显示说明');
    assert.deepEqual(importedAppearance.values.icon, { kind: 'builtin', value: 'monitor' });
    const changedAppearance = await updateAppearance(1, {
      description: ' Rust 保存的说明 ',
      icon: { kind: 'emoji', value: '👩🏽‍💻' },
    });
    assert.equal(changedAppearance.revision, 2);
    assert.equal(changedAppearance.values.description, 'Rust 保存的说明');
    assert.deepEqual(changedAppearance.values.icon, { kind: 'emoji', value: '👩🏽‍💻' });
    await assert.rejects(updateAppearance(1, { description: '过期修改' }), { status: 409 });
    await assert.rejects(
      existing.rpc(apiCall('/backends/nonexistent/appearance', 'POST', { revision: 0, patch: { name: 'X' } })),
      { status: 404 },
    );
    await assert.rejects(
      updateAppearance(2, { icon: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zz4=' } }),
      { status: 400 },
    );
    const raster = await updateAppearance(2, {
      icon: { kind: 'image', value: 'data:image/png;base64,' + pngBytes.toString('base64') },
    });
    assert.equal(raster.revision, 3);
    assert.equal(raster.values.icon.kind, 'image');
    assert.match(raster.values.icon.value, /^data:image\/webp;base64,/);
    const appearanceList = await existing.rpc<{ backends: BackendInfo[] }>(apiCall('/backends'));
    const appearedCodex = appearanceList.backends.find(({ id }) => id === 'codex-local');
    assert.deepEqual(appearedCodex?.appearance, raster.values);
    if (bundled) assert.equal(appearedCodex?.name, 'Migrated Codex fixture');
    const resetAppearance = await updateAppearance(3, { icon: null });
    assert.deepEqual(resetAppearance.values.icon, importedAppearance.defaults.icon);
    const { stdout: cliSaved } = await cliAppearance(
      'set',
      'codex-local',
      '--description',
      '命令行同步说明',
      '--revision',
      '4',
    );
    assert.deepEqual(JSON.parse(cliSaved), { id: 'codex-local', revision: 5, saved: true });
    await assert.rejects(updateAppearance(4, { description: '旧网页副本' }), { status: 409 });
    savedAppearance = await getAppearance(existing);
    assert.equal(savedAppearance.values.description, '命令行同步说明');
    const { stdout: cliCurrent } = await cliAppearance('show', 'codex-local');
    assert.equal(JSON.parse(cliCurrent).overrides.description, savedAppearance.values.description);
    const { stdout: cliList } = await cliAppearance('list');
    assert(
      JSON.parse(cliList).some(
        (entry: { id: string; revision: number }) => entry.id === 'codex-local' && entry.revision === 5,
      ),
    );
    if (versions) {
      const operation = apiCall(`/operations/${legacyOperation}`);
      await assert.rejects(existing.rpc(operation));
      const prior = await existing.rpc<{ backendId: string; state: string }>({
        ...operation,
        backendId: secondaryId,
      });
      assert.equal(prior.backendId, secondaryId);
      assert.equal(prior.state, 'completed');
    }
  } finally {
    existing.close();
  }

  phase = 'fresh device pairing, history, media, voice and live controls';
  const phone = await createIdentity();
  const route = createHash('sha256').update(gateway.pairCode).digest('hex');
  const pair = () =>
    nodeSession(origin, host.peerId, phone, route, {
      type: 'pair',
      protocol: 2,
      sessionId: crypto.randomUUID(),
      name: 'Native smoke phone',
      code: gateway.pairCode,
    });
  const completeOldDraft = apiCall(`/threads/${THREAD}/uploads/${legacyId}/complete`, 'POST');
  let readyTicket: string;
  let readyDeviceId: string;

  const session = await pair();
  try {
    const ready = await session.ready;
    readyTicket = ready.ticket;
    readyDeviceId = ready.device.id;
    const simultaneous: DeviceLink[] = [];
    try {
      for (let i = 0; i < 32; i++) simultaneous.push(await reconnect(phone, ready.ticket));
      await simultaneous.at(-1)!.request('ping', {});
      await session.request('ping', {});
    } finally {
      for (const link of simultaneous) link.close();
    }
    await assert.rejects(session.rpc(restoreDraft));
    await assert.rejects(session.request('file', legacyMissing));
    await assert.rejects(session.rpc(rawChunk(9), legacyRawBytes.subarray(9)));
    await assert.rejects(session.rpc(apiCall(`/threads/${THREAD}/media`, 'POST', { path: migratedNativePath })));
    assert.equal(ready.status.writesEnabled, !!ipc);
    assert.equal(ready.status.capabilities.openThread, !!ipc);
    if (versions) {
      const { backends } = await session.rpc<{
        backends: { id: string; name: string; profile: string; adapterVersion?: string }[];
      }>(apiCall('/backends'));
      const codex = backends.find(({ id }) => id === 'codex-local');
      assert.equal(codex?.profile, 'rust-native-plugin');
      assert.equal(codex?.name, 'Codex fixture');
      assert.equal(codex?.adapterVersion, versions.initial);
    }
    const list = await session.rpc<{ threads: { id: string; title: string }[] }>(apiCall('/threads'));
    assert.deepEqual(
      list.threads.map(({ id, title }) => [id, title]),
      [[THREAD, '测试会话']],
    );
    const projects = await session.rpc<{ projects: { id: string; name: string; count: number }[] }>(
      apiCall('/projects'),
    );
    assert.deepEqual(projects.projects, [
      { id: 'native-project', name: '材料研究', count: 1 },
      { id: 'empty-project', name: '空项目', count: 0 },
    ]);
    const searched = await session.rpc<{ threads: { projectName: string }[] }>(
      apiCall('/threads?q=材料研究&project=native-project'),
    );
    assert.equal(searched.threads[0]?.projectName, '材料研究');
    const history = await session.rpc<{
      messages: {
        id: string;
        text: string;
        codex?: unknown;
        deferred?: boolean;
        truncated: boolean;
        attachments: { path: string }[];
      }[];
    }>(apiCall(`/threads/${THREAD}/history`));
    assert.deepEqual(history.messages.map(({ text }) => text).filter(Boolean), [
      '历史消息',
      '命令 · printf historical tool · completed',
      '已压缩上下文',
      '子 Agent 已完成',
      '本轮用时',
      Buffer.from(historicalReply).subarray(0, 12_000).toString(),
    ]);
    assert.equal(history.messages[0].attachments[0].path, legacyPath);
    assert.deepEqual(history.messages.find((message) => message.id === 'history-compaction')?.codex, {
      kind: 'compaction',
      state: 'completed',
    });
    assert.deepEqual(history.messages.find((message) => message.id === 'history-agent')?.codex, {
      kind: 'subagent',
      state: 'completed',
      agentId: 'fixture-agent',
      name: '验证',
    });
    assert.doesNotMatch(JSON.stringify(history), /fixture-private-summary/);
    await assert.rejects(
      session.rpc(apiCall(`/threads/${THREAD}/content?messageId=rollout-${hiddenGoalOffset}`)),
      /会话或功能不可用/,
    );
    const historicalActivity = history.messages[1];
    assert.equal(historicalActivity.deferred, true);
    const historicalDetails = await session.rpc<{ message: Record<string, unknown> }>(
      apiCall(`/threads/${THREAD}/content?messageId=${historicalActivity.id}`),
    );
    assert.equal(historicalDetails.message.output, 'historical output');
    assert.equal(historicalDetails.message.deferred, false);
    const earlierReply = history.messages.at(-1)!;
    assert.equal(earlierReply.truncated, true);
    const historic = await session.rpc<{ message: { text: string } }>(
      apiCall(`/threads/${THREAD}/content?messageId=${earlierReply.id}`),
    );
    assert.equal(historic.message.text, historicalReply);
    assert.equal(earlierReply.attachments[0].path, inlineRef);
    await rename(rollout + '.zst', rollout + '.held');
    try {
      await assert.rejects(session.rpc(apiCall(`/threads/${THREAD}/history`)), /无法读取本机历史记录/);
    } finally {
      await rename(rollout + '.held', rollout + '.zst');
    }
    await writeFile(
      join(legacyState, 'uploads', legacyId + '.json'),
      JSON.stringify({
        id: legacyId,
        device: ready.device.id,
        thread: THREAD,
        name: legacyName,
        file: legacyPath,
        complete: true,
        size: legacyBytes.length,
        sha256: digest(legacyBytes),
      }),
      { mode: 0o600 },
    );
    if (process.platform === 'win32')
      platformRuntime().privateFile(join(legacyState, 'uploads', legacyId + '.json'));
    assert.deepEqual(await session.rpc(completeOldDraft), {
      id: legacyId,
      name: legacyName,
      path: legacyPath,
    });
    await assert.rejects(session.rpc(apiCall(`/threads/${FORK_REPLY}/uploads/${legacyId}/complete`, 'POST')));
    const describe = (path: string) =>
      session.rpc<FileManifest>(apiCall(`/threads/${THREAD}/media`, 'POST', { path }));
    await assert.rejects(describe(generatedRef(foreignData)));
    await assert.rejects(describe(unpaired), /没有可恢复的数据/);
    for (const [path, expected, mime] of [
      [legacyPath, legacyBytes],
      [inlineRef, inlineBytes],
      [generatedRef(generatedData), generatedBytes, 'image/png'],
      [projectFile, Buffer.from('project attachment')],
      [`sandbox:./${projectPdf}`, pdfBytes, 'application/pdf'],
      [`sandbox:./${projectPng}`, pngBytes, 'image/png'],
      [outsidePng, pngBytes, 'image/png'],
      ...viewed.map(({ path, bytes }) => [path, bytes] as const),
    ] as const) {
      const manifest = await describe(path);
      if (mime) assert.equal(manifest.mime, mime);
      const data = await session.request('file', {
        backendId: 'codex-local',
        threadId: THREAD,
        fileId: manifest.id,
        action: 'read',
        index: 0,
      });
      assert.deepEqual(Buffer.from(data.bytes!), expected);
      const other = await reconnect(existingPhone, oldRouteTicket);
      try {
        await assert.rejects(
          other.request('file', {
            backendId: 'codex-local',
            threadId: THREAD,
            fileId: manifest.id,
            action: 'read',
            index: 0,
          }),
        );
        if (path === legacyPath) {
          await assert.rejects(other.rpc(apiCall(`/threads/${THREAD}/media`, 'POST', { path })));
          await assert.rejects(other.rpc(completeOldDraft));
        }
      } finally {
        other.close();
      }
    }
    await assert.rejects(describe(unrelatedFile));
    await assert.rejects(session.rpc(apiCall(`/threads/${THREAD}/messages`, 'POST', { text: 'blocked' })));

    const instanceSuiteOptions = versions
      ? {
          threadId: THREAD,
          secondaryTitle,
          secondaryRename,
          secondaryUploads,
          secondaryPath,
          secondaryBytes,
          legacyId,
          legacyName,
          legacyPath,
          versions,
          adapter,
        }
      : undefined;
    if (instanceSuiteOptions) await verifyCodexInstances(session, ready.device.id, instanceSuiteOptions);
    if (versions && forkCli && ipc) {
      const other = await reconnect(existingPhone, oldRouteTicket);
      try {
        await verifyCodexVoice(session, other, { threadId: THREAD, voiceStopped });
        console.log('Native Codex Voice verified scoped signaling, safe fork permissions, hangup, and upstream errors.');
      } finally {
        other.close();
      }
    }
    if (ipc) {
      await testCodexLive(session, ipc, phone, {
        origin,
        hostPeerId: host.peerId,
        stateDir: state,
        directory,
        threadId: THREAD,
        legacyId,
        codexPackage,
        forkCli,
        testStorage,
        queue: queueControl,
        goalFixture,
      });
      if (instanceSuiteOptions && secondaryIpc)
        await verifyLiveCodexInstances(session, ipc, secondaryIpc, instanceSuiteOptions);
      if (modernFixture) await verifyModernCodexRpc(session, THREAD, modernFixture);
    }
  } finally {
    session.close();
  }
  await assert.rejects(pair(), 'Pairing code was not single-use');

  phase = 'gateway restart, upload resumption and bundled upgrade';
  await stopGateway();
  gateway = await launch(true);
  const resumedLegacy = await reconnect(existingPhone, oldRouteTicket);
  try {
    assert.deepEqual((await resumedLegacy.request('file', legacyMissing)).value.missing, [2]);
    await resumedLegacy.request('file', { ...legacyTransfer, action: 'write', index: 2 }, legacyBlocks[2]);
    const blockResult = await resumedLegacy.request('file', { ...legacyTransfer, action: 'finish' });
    assert.deepEqual(await readFile(blockResult.value.path), legacyBlockBytes);
    assert.deepEqual(await resumedLegacy.rpc(rawChunk(9), legacyRawBytes.subarray(9)), {
      offset: legacyRawBytes.length,
    });
    const rawResult = await resumedLegacy.rpc<{ path: string }>(rawFinish);
    assert.deepEqual(await readFile(rawResult.path), legacyRawBytes);
    assert.deepEqual(await resumedLegacy.rpc(rawFinish), rawResult);
    const recovered = await resumedLegacy.rpc<{ path: string }>(
      apiCall(`/threads/${THREAD}/uploads/${legacyRenamedUpload.id}/complete`, 'POST'),
    );
    assert.deepEqual(await readFile(recovered.path), legacyRawBytes);
    assert.deepEqual(await Promise.all(legacyUploadSources.map((path) => readFile(path))), legacyUploadSnapshots);
  } finally {
    resumedLegacy.close();
  }

  const resumed = await reconnect(phone, readyTicket);
  try {
    assert.equal((await resumed.ready).device.id, readyDeviceId);
    assert.equal((await resumed.rpc<{ path: string }>(completeOldDraft)).path, legacyPath);
    assert.deepEqual(await getAppearance(resumed), savedAppearance);
    await cliAppearance('reset', 'codex-local', '--revision', '5');
    const restored = await getAppearance(resumed);
    assert.equal(restored.revision, 6);
    assert.deepEqual(restored.overrides, {});
    assert.deepEqual(restored.values, restored.defaults);
  } finally {
    resumed.close();
  }

  if (bundled) {
    await stopGateway();
    const { current, previous } = await seedBundledUpgrade();
    gateway = await launch(true);
    await waitForBundledBinding(current, previous);
    await adapter('rollback', 'codex-local');
    await waitForBundledBinding(previous, current);
    await stopGateway();
    gateway = await launch(true);
    await waitForBundledBinding(previous, current);
    console.log('The bundled Codex upgrade used the plugin supervisor and a rollback survived restart.');
  }

  assert.deepEqual(ipc?.errors ?? [], [], 'Primary Codex IPC fixture recorded unexpected errors');
  assert.deepEqual(secondaryIpc?.errors ?? [], [], 'Secondary Codex IPC fixture recorded unexpected errors');
  assert.deepEqual(goalFixture?.errors ?? [], [], 'Codex App Server goal fixture recorded unexpected errors');
  assert.deepEqual(modernFixture?.errors ?? [], [], 'Codex app-tools fallback fixture recorded unexpected errors');
  console.log(
    `Native gateway (${cloudflare ? 'Cloudflare' : 'Node'} relay): TLS startup, pairing, history, legacy draft recovery and upload resumption, replay rejection, appearance settings and restart passed${ipc ? ', including native Codex live controls' : ''}${versions ? ' with two isolated instances of the independently installed Codex plugin' : ''}.`,
  );
} catch (error) {
  const stderr = activeGateway?.stderrTail();
  console.error(
    `Native Codex smoke failed during ${phase}${stderr ? `\n--- adapter stderr ---\n${stderr}` : ''}`,
  );
  throw error;
} finally {
  await runCleanups([
    () => stopGateway(),
    () => relay?.close(),
    () => secondaryIpc?.close(),
    () => ipc?.close(),
    () => goalFixture?.close(),
    () => modernFixture?.close(),
    () => rm(directory, { recursive: true, force: true }),
  ]);
}
