/** Isolated account DB and synthetic media; no personal microphone/camera. */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import sharp from 'sharp';
import { build } from 'esbuild';
import { RTCPeerConnection as AgentPeer } from 'werift';
import { buildRelay } from '../../src/server/relay.js';
import { AgentCallsClient } from '../../src/client/calls.js';
import {
  allocateLocalPort,
  saveRecoveryCode,
  registerAgentFixture,
  browserAccountFixture,
} from '../lib/messaging-smoke.js';
const cdp = process.env.TEST_CDP_URL;
const bind = cdp ? process.env.TEST_BIND : '127.0.0.1';
if (!bind) throw Error('Set TEST_BIND to a bindable IPv4 address reachable by the CDP browser');
const port = await allocateLocalPort(bind, process.env.TEST_PORT),
  origin = `${cdp ? 'https' : 'http'}://${bind}:${port}`;
const out = process.env.TEST_OUTPUT
  ? resolve(process.env.TEST_OUTPUT)
  : await mkdtemp(join(tmpdir(), 'rac-calls-out-'));
await mkdir(out, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'rac-calls-'));
if (cdp)
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(temp, 'key'),
      '-out',
      join(temp, 'cert'),
      '-days',
      '1',
      '-subj',
      '/CN=RAC isolated test',
      '-addext',
      `subjectAltName=IP:${bind}`,
    ],
    { stdio: 'ignore' },
  );
await cp(resolve(process.env.TEST_WEB_ROOT ?? 'dist/web'), join(temp, 'web'), { recursive: true });
await build({
  entryPoints: ['src/web/sync-store.ts'],
  outfile: join(temp, 'web/cache-probe.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2023',
});
const relay = await buildRelay({
  messaging: { totpKey: Buffer.alloc(32, 74).toString('base64url') }, // Disposable fixture only.
  origin,
  webRoot: join(temp, 'web'),
  database: join(temp, 'relay.sqlite'),
  enrollmentSecret: 'isolated-call-media-browser-fixture',
  assetOrigin: null,
  uploadOrigins: [],
});
const bodyReads = new Map<string, number>();
relay.app.addHook('onRequest', async (req) => {
  const url = new URL(req.url, origin);
  if (req.method === 'GET' && /\/files\/[^/]+\//.test(url.pathname) && !url.searchParams.has('meta'))
    bodyReads.set(url.pathname, (bodyReads.get(url.pathname) ?? 0) + 1);
});
const server = cdp
  ? createServer(
      { key: await readFile(join(temp, 'key')), cert: await readFile(join(temp, 'cert')) },
      relay.app.routing,
    )
  : undefined;
if (server) {
  await relay.app.ready();
  server.listen(port, bind);
  await once(server, 'listening');
} else await relay.app.listen({ port, host: bind });
const browser = cdp ? await chromium.connectOverCDP(cdp) : await chromium.launch({ channel: 'chrome' }),
  context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
await context.addInitScript('globalThis.__name = (value) => value;');
await context.addInitScript(() => {
  const tracks: MediaStreamTrack[] = [],
    pcs: RTCPeerConnection[] = [];
  (window as any).__qa = { tracks, pcs, gumCalls: 0, deny: false };
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(config?: RTCConfiguration) {
      super(config);
      pcs.push(this);
    }
  };
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    (window as any).__qa.gumCalls++;
    if ((window as any).__qa.deny) throw new DOMException('Denied', 'NotAllowedError');
    const audio = new AudioContext(),
      oscillator = audio.createOscillator(),
      output = audio.createMediaStreamDestination();
    oscillator.frequency.value = 220;
    oscillator.connect(output);
    oscillator.start();
    void audio.resume();
    const stream = new MediaStream(constraints?.audio ? output.stream.getAudioTracks() : []);
    if (!constraints?.audio) {
      output.stream.getTracks().forEach((t) => t.stop());
      void audio.close();
    }
    if (constraints?.video) {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext('2d')!;
      const draw = () => {
        ctx.fillStyle = '#345f52';
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = 'white';
        ctx.font = '24px sans-serif';
        ctx.fillText('Agent video test', 45, 120);
        requestAnimationFrame(draw);
      };
      draw();
      stream.addTrack(canvas.captureStream(15).getVideoTracks()[0]);
    }
    tracks.push(...stream.getTracks());
    return stream;
  };
});
const page = await context.newPage(),
  errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const callHeader = page.getByRole('group', { name: '与 Agent 通话' });
const voiceEntry = callHeader.getByRole('button', { name: '语音通话', exact: true });
const videoEntry = callHeader.getByRole('button', { name: '视频通话', exact: true });
const checks: Record<string, unknown> = {};
let peer: AgentPeer | undefined,
  answerTask: Promise<void> | undefined,
  agentCalls: AgentCallsClient | undefined;
let incomingAudio = 0,
  incomingVideo = 0,
  stopping = false;
let answerFailure: unknown;
try {
  await page.goto(origin + '/?page=messages');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.getByLabel('昵称', { exact: true }).fill('测试用户');
  await page.getByLabel('用户名', { exact: true }).fill('callbrowser');
  await page.getByLabel('密码', { exact: true }).fill('isolated-browser-password');
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await saveRecoveryCode(page);
  const human = await browserAccountFixture(page, origin, 'isolated-browser-password');
  const { invitation } = await human.raw<{ invitation: string }>('/agent-invitations', 'POST');
  const agent = await registerAgentFixture(origin, {
    invitation,
    username: 'callagent',
    displayName: '视频测试助手',
  });
  agentCalls = new AgentCallsClient(agent.client);
  const { conversation } = await human.direct(agent.user.id);
  const png = await sharp({ create: { width: 320, height: 120, channels: 3, background: '#d7eee5' } })
    .png()
    .toBuffer();
  const { file } = await agent.client.upload(conversation.id, '缓存验证.png', new Blob([png]));
  await agent.client.send(conversation.id, '音视频测试已准备', 'browser-call-test', {
    attachmentIds: [file.id],
  });
  await page.goto(origin + `/?page=messages&conversation=${conversation.id}`);
  await expect(voiceEntry).toBeVisible();
  await expect(videoEntry).toBeVisible();
  await expect(page.locator('.im-compose-wrap .upload-button')).toHaveCount(0);
  const voiceMessage = page.getByRole('button', { name: '语音消息', exact: true });
  await voiceMessage.click();
  await expect(page.getByRole('region', { name: '语音消息' })).toBeVisible();
  await page.getByRole('button', { name: '关闭语音', exact: true }).click();
  const more = page.getByRole('button', { name: '更多功能', exact: true });
  await more.click();
  const moreMenu = page.getByRole('menu', { name: '更多功能' });
  await expect(moreMenu.getByRole('menuitem')).toHaveText(['照片', '附件']);
  await page.screenshot({ path: join(out, 'im-more-mobile.png') });
  await page.keyboard.press('Escape');
  await expect(moreMenu).toBeHidden();
  await expect(more).toBeFocused();
  const closedMenuLayoutReads = await page.evaluate(() => {
    const original = Element.prototype.getBoundingClientRect;
    let reads = 0;
    Element.prototype.getBoundingClientRect = function () {
      if (this.matches('.im-compose-wrap .composer-box')) reads++;
      return original.call(this);
    };
    try {
      window.dispatchEvent(new Event('resize'));
      return reads;
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });
  expect(closedMenuLayoutReads).toBe(0);
  for (const [label, accept] of [
    ['照片', 'image/*'],
    ['附件', null],
  ] as const) {
    await more.tap();
    const [picker] = await Promise.all([
      page.waitForEvent('filechooser'),
      moreMenu.getByRole('menuitem', { name: label, exact: true }).tap(),
    ]);
    expect(await picker.element().getAttribute('accept')).toBe(accept);
    expect(await picker.element().getAttribute('capture')).toBe(null);
    expect(picker.isMultiple()).toBe(true);
    await expect(moreMenu).toBeHidden();
    expect(
      await picker
        .element()
        .evaluate(
          (input) => input instanceof HTMLInputElement && input.isConnected && !input.closest('[popover]'),
        ),
    ).toBe(true);
    if (label === '附件') {
      const contents = '手机文件路径验收';
      await picker.setFiles({ name: '手机文件.txt', mimeType: 'text/plain', buffer: Buffer.from(contents) });
      await expect(
        page.locator('.im-compose-wrap').getByRole('button', { name: '移除 手机文件.txt', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(
        page.getByRole('log').getByRole('button', { name: '附件操作：手机文件.txt' }),
      ).toBeVisible();
    } else {
      const large = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#d7eee5' } })
        .png({ compressionLevel: 0 })
        .toBuffer();
      const webp = await sharp(png).webp().toBuffer();
      expect(large.length).toBeGreaterThan(10 * 1024 * 1024);
      await picker.setFiles([
        { name: '大照片.png', mimeType: 'application/octet-stream', buffer: large },
        { name: '相册照片.webp', mimeType: '', buffer: webp },
      ]);
      const composer = page.locator('.im-compose-wrap');
      await expect(composer.getByRole('button', { name: '放大预览：大照片.jpg' })).toBeVisible();
      await expect(composer.getByRole('button', { name: '放大预览：相册照片.webp' })).toBeVisible();
      await expect(composer.getByRole('alert')).toHaveCount(0);
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(composer.getByRole('button', { name: '移除 大照片.jpg' })).toHaveCount(0);
      const galleryMessage = page.getByRole('log').getByRole('button', { name: '放大预览：大照片.jpg' });
      await expect(galleryMessage).toBeVisible();
      const history = await agent.client.history(conversation.id);
      const received = history.messages.find((message) =>
        message.attachments.some((file) => file.name === '大照片.jpg'),
      );
      const resized = received?.attachments.find((file) => file.name === '大照片.jpg');
      const unchanged = received?.attachments.find((file) => file.name === '相册照片.webp');
      if (!resized || !unchanged) throw Error('Both gallery attachments should reach the recipient');
      expect(resized.mime).toBe('image/jpeg');
      expect(resized.size).toBeLessThan(10 * 1024 * 1024);
      expect(unchanged.mime).toBe('image/webp');
      const original = await agent.client.download(unchanged.url);
      expect(Buffer.from(original.data)).toEqual(webp);
      checks.oversizedGalleryPhotoFitsEncryptedUpload = true;
    }
  }
  await expect(page.getByRole('button', { name: '表情与表情包', exact: true })).toBeVisible();
  checks.composerAttachmentAndMore = true;
  // The gallery attachments can finish loading independently of the cache probe.
  const cacheProbe = page.getByRole('img', { name: '缓存验证.png', exact: true });
  const cacheProbePath = new URL(file.url, origin).pathname;
  await expect(cacheProbe).toBeVisible();
  await cacheProbe.evaluate((img: HTMLImageElement) => img.decode());
  const firstReads = bodyReads.get(cacheProbePath) ?? 0;
  expect(firstReads).toBeGreaterThan(0);
  await page.reload();
  await expect(voiceEntry).toBeVisible();
  await expect(videoEntry).toBeVisible();
  await expect(cacheProbe).toBeVisible();
  await cacheProbe.evaluate((img: HTMLImageElement) => img.decode());
  expect(bodyReads.get(cacheProbePath)).toBe(firstReads);
  checks.encryptedCacheSurvivesReload = true;
  checks.workspaceCache = await page.evaluate(async () => {
    const probePath = '/cache-probe.js';
    const { SyncStore } = await import(probePath);
    const first = new SyncStore(),
      key = 'qa-block-persistence';
    const bytes = new Uint8Array([4, 5, 6, 7]);
    await first.block(key, bytes);
    await first.flush();
    const reloaded = new SyncStore(),
      found = await reloaded.get(key);
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(key);
    const missing = new SyncStore(),
      absent = await missing.get(key);
    await reloaded.clear();
    return {
      persisted: Array.from(found).join(',') === '4,5,6,7',
      hitBytes: reloaded.metrics.hitBytes,
      missing: absent === undefined,
      falseHitBytes: missing.metrics.hitBytes,
    };
  });
  expect(checks.workspaceCache).toMatchObject({ persisted: true, missing: true, falseHitBytes: 0 });

  const { cacheKey, encrypted } = await human.raw<{ cacheKey: string; encrypted: string }>(
    `${cacheProbePath.slice('/api/im'.length)}?meta=1`,
  );
  expect(cacheKey).toMatch(/^[0-9a-f]{64}$/);
  expect(encrypted).toBeTruthy();
  const saved = await page.evaluate(
    async ({ account, path, cacheKey, encrypted, plaintextHash, plaintextSize }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('pocket-im-media');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise<
        { key: string; account: string; blob: Blob; encrypted?: string; cacheKey?: string }[]
      >((resolve, reject) => {
        const request = db.transaction('blobs').objectStore('blobs').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).finally(() => db.close());
      const hash = async (blob: Blob) =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
      const previewKey = `${account}:preview:v2:${path}`;
      const cipherKey = `${account}:cipher:v1:${cacheKey}`;
      const probeRows = rows.filter((row) => row.key === previewKey || row.key === cipherKey);
      const validRows = await Promise.all(
        probeRows.map(
          async (row) =>
            row.account === account &&
            (row.key === cipherKey || (row.cacheKey === cacheKey && row.encrypted === encrypted)) &&
            (await hash(row.blob)) === cacheKey,
        ),
      );
      const possiblePlaintext = await Promise.all(
        rows.filter((row) => row.blob.size === plaintextSize).map((row) => hash(row.blob)),
      );
      return {
        persisted: validRows.length > 0 && validRows.every(Boolean),
        plaintext: possiblePlaintext.includes(plaintextHash),
      };
    },
    {
      account: human.account.user!.id,
      path: cacheProbePath,
      cacheKey,
      encrypted,
      plaintextHash: createHash('sha256').update(png).digest('hex'),
      plaintextSize: png.length,
    },
  );
  expect(saved).toEqual({ persisted: true, plaintext: false });
  checks.persistentBytesAreCiphertext = true;
  await voiceEntry.click();
  await expect(page.getByText('Agent 尚未开启通话或目前离线，文字聊天仍可使用。')).toBeVisible();
  await expect(page.getByRole('button', { name: '开始语音通话', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__qa.gumCalls)).toBe(0);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await agentCalls.ready(false);
  await videoEntry.click();
  await expect(page.getByText('这个 Agent 当前只支持语音通话。')).toBeVisible();
  await expect(page.getByRole('button', { name: '开始视频通话', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await agentCalls.ready(true);
  await videoEntry.click();
  const startVideo = page.getByRole('button', { name: '开始视频通话', exact: true });
  await expect(startVideo).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__qa.gumCalls)).toBe(0);
  checks.explicitEntriesAndReadiness = true;
  await page.screenshot({ path: join(out, 'call-choice-mobile.png') });
  await startVideo.click();
  await expect.poll(async () => (await agentCalls!.list()).calls.length, { timeout: 15000 }).toBe(1);
  const call = (await agentCalls.list()).calls[0];
  peer = new AgentPeer({ iceServers: [] });
  peer.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe(() => {
      if (track.kind === 'audio') incomingAudio++;
      else incomingVideo++;
    });
    peer!.addTrack(track);
  });
  peer.onIceCandidate.subscribe((candidate) => {
    if (candidate)
      void agentCalls!.send(call, { type: 'candidate', candidate: candidate.toJSON() }).catch(() => {});
  });
  await agentCalls.update(call.id, 'accept');
  answerTask = (async () => {
    let cursor = 0;
    const queued: any[] = [];
    for (let n = 0; n < 100 && !stopping; n++) {
      const result = await agentCalls!.poll(call.id, cursor);
      if (result.call.state === 'ended') return;
      for (const item of result.signals) {
        if (item.senderId !== call.callerId) continue;
        const data = await agentCalls!.decode(call, item);
        if (data.type === 'description') {
          await peer!.setRemoteDescription(data.description);
          for (const candidate of queued.splice(0)) await peer!.addIceCandidate(candidate);
          await peer!.setLocalDescription(await peer!.createAnswer());
          await agentCalls!.send(call, {
            type: 'description',
            description: { type: 'answer', sdp: peer!.localDescription!.sdp },
          });
        } else if (peer!.remoteDescription) await peer!.addIceCandidate(data.candidate);
        else queued.push(data.candidate);
      }
      cursor = result.cursor;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!stopping) throw Error('Call test timed out');
  })().catch((e) => {
    answerFailure = e;
  });
  await expect.poll(() => incomingAudio, { timeout: 25000 }).toBeGreaterThan(5);
  await expect.poll(() => incomingVideo, { timeout: 25000 }).toBeGreaterThan(5);
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const pc = (window as any).__qa.pcs.at(-1);
          if (!pc) return 0;
          let bytes = 0;
          (await pc.getStats()).forEach((r: any) => {
            if (r.type === 'inbound-rtp') bytes += r.bytesReceived ?? 0;
          });
          return bytes;
        }),
      { timeout: 20000 },
    )
    .toBeGreaterThan(100);
  checks.bidirectionalAudioVideo = { incomingAudio, incomingVideo };
  await expect(page.locator('.call-timer')).toContainText('直连');
  checks.directMediaRoute = true;
  await page.getByRole('button', { name: '静音', exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).__qa.tracks
        .filter((t: MediaStreamTrack) => t.kind === 'audio')
        .every((t: MediaStreamTrack) => !t.enabled),
    ),
  ).toBe(true);
  await page.getByRole('button', { name: '关闭画面', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__qa.tracks
          .filter((t: MediaStreamTrack) => t.kind === 'video')
          .every((t: MediaStreamTrack) => t.readyState === 'ended'),
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: '开启画面', exact: true }).click();
  await expect(page.getByRole('button', { name: '关闭画面', exact: true })).toBeVisible();
  await page.screenshot({ path: join(out, 'video-call-mobile.png') });
  await page.getByRole('button', { name: '挂断', exact: true }).click();
  await expect(page.getByRole('button', { name: '返回聊天', exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).__qa.tracks.every((t: MediaStreamTrack) => t.readyState === 'ended'),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() =>
      (window as any).__qa.pcs.every((p: RTCPeerConnection) => p.connectionState === 'closed'),
    ),
  ).toBe(true);
  await answerTask;
  if (answerFailure) throw answerFailure;
  checks.hangupReleasesDevices = true;
  await page.getByRole('button', { name: '返回聊天', exact: true }).click();
  for (const mode of ['audio', 'video'] as const) {
    const capturedBefore = await page.evaluate(() => (window as any).__qa.gumCalls);
    const { call: incoming } = await agentCalls!.create(conversation.id, mode);
    const dialog = page.getByRole('dialog', { name: mode === 'video' ? '视频来电' : '语音来电' });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => (window as any).__qa.gumCalls)).toBe(capturedBefore);
    const caller = new AgentPeer({ iceServers: [] });
    const abort = new AbortController();
    try {
      caller.addTransceiver('audio', { direction: 'sendrecv' });
      if (mode === 'video') caller.addTransceiver('video', { direction: 'sendrecv' });
      caller.onIceCandidate.subscribe((candidate) => {
        if (candidate)
          void agentCalls!
            .send(incoming, { type: 'candidate', candidate: candidate.toJSON() })
            .catch(() => {});
      });
      await caller.setLocalDescription(await caller.createOffer());
      await agentCalls!.send(incoming, {
        type: 'description',
        description: { type: 'offer', sdp: caller.localDescription!.sdp },
      });
      await dialog.getByRole('button', { name: '接听' }).click();
      let cursor = 0;
      const candidates: Parameters<typeof caller.addIceCandidate>[0][] = [];
      await expect
        .poll(
          async () => {
            const response = await agentCalls!.poll(incoming.id, cursor, abort.signal);
            for (const item of response.signals) {
              if (item.senderId === incoming.callerId) continue;
              const signal = await agentCalls!.decode(incoming, item);
              if (signal.type === 'description') {
                await caller.setRemoteDescription(signal.description);
                for (const candidate of candidates.splice(0)) await caller.addIceCandidate(candidate);
              } else if (caller.remoteDescription) await caller.addIceCandidate(signal.candidate);
              else candidates.push(signal.candidate);
            }
            cursor = response.cursor;
            return caller.connectionState;
          },
          { timeout: 20000 },
        )
        .toBe('connected');
      await expect(dialog.getByRole('timer')).toBeVisible();
      await agentCalls!.update(incoming.id, 'end');
      await dialog.getByRole('button', { name: '返回聊天' }).click();
    } finally {
      abort.abort();
      await caller.close();
      await agentCalls!.update(incoming.id, 'end').catch(() => {});
    }
  }
  checks.assistantOriginatedAudioAndVideo = true;
  await page.evaluate(() => {
    (window as any).__qa.deny = true;
  });
  await voiceEntry.click();
  await page.getByRole('button', { name: '开始语音通话', exact: true }).click();
  await expect(page.getByText('未获得麦克风或摄像头权限，请在浏览器中允许后重试')).toBeVisible();
  expect((await agentCalls.list()).calls).toHaveLength(0);
  checks.permissionDeniedNoCall = true;
  await page.getByRole('button', { name: '返回聊天', exact: true }).click();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(voiceEntry).toBeInViewport();
    await expect(videoEntry).toBeInViewport();
    if (width < 701) {
      const header = page.locator('.im-chat-header');
      const title = await header.locator('.conversation-heading').boundingBox();
      const call = await voiceEntry.boundingBox();
      const toolbar = await header.boundingBox();
      expect(toolbar!.height).toBeLessThanOrEqual(76);
      expect(Math.abs(title!.y + title!.height / 2 - call!.y - call!.height / 2)).toBeLessThan(4);
      await expect(header.getByRole('button', { name: '聊天工具', exact: true })).toBeVisible();
      const composer = page.locator('.im-compose-wrap .composer-box');
      const { panel, input, send, gap, radius } = await composer.evaluate((el) => {
        const panel = el.getBoundingClientRect();
        return {
          panel: panel.width,
          input: el.querySelector('textarea')!.getBoundingClientRect().width,
          send: el.querySelector('.send-button')!.getBoundingClientRect().width,
          gap: el.closest('.app-shell')!.getBoundingClientRect().bottom - panel.bottom,
          radius: Number.parseFloat(getComputedStyle(el).borderRadius),
        };
      });
      expect(input / panel).toBeGreaterThan(0.9);
      expect(send).toBeGreaterThanOrEqual(44);
      expect(gap).toBeLessThanOrEqual(12);
      expect(radius).toBeGreaterThanOrEqual(18);
    }
    if (width === 320)
      expect(
        await page
          .locator('.im-chat-header .conversation-title')
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    await page.locator('.im-chat-header').screenshot({ path: join(out, `call-header-${width}.png`) });
    await voiceEntry.click();
    expect(await page.locator('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: join(out, `call-${width}.png`) });
    await page.getByRole('button', { name: '关闭', exact: true }).click();
  }
  checks.responsive = [320, 390, 1440];
  await page.goto(origin + '/?page=contacts');
  await expect(page.getByRole('button', { name: '添加联系人', exact: true })).toHaveCount(0);
  await expect(page.getByText('朋友', { exact: true })).toHaveCount(0);
  checks.noHumanFriendEntry = true;
  await page.reload();
  checks.serviceWorker = await page.evaluate(async () => ({
    controlled: !!navigator.serviceWorker.controller,
    caches: await caches.keys(),
  }));
  await page.goto(origin + '/?page=settings');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('pocket-im-media');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return new Promise<number>((resolve) => {
          const request = db.transaction('blobs').objectStore('blobs').count();
          request.onsuccess = () => resolve(request.result);
        });
      }),
    )
    .toBe(0);
  checks.logoutPurgesAccountMedia = true;
  expect(errors).toEqual([]);
  await writeFile(join(out, 'result.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }));
} catch (error) {
  console.log(String(error));
  console.log(
    JSON.stringify({
      dialog: await page
        .locator('dialog')
        .innerText()
        .catch(() => ''),
      errors,
    }),
  );
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  stopping = true;
  await answerTask;
  await agentCalls?.ready(false, false).catch(() => {});
  await peer?.close();
  await context.close();
  await browser.close();
  server?.close();
  await relay.app.close();
  await rm(temp, { recursive: true, force: true });
}
