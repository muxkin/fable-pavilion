/** Bounded app layout and foreground recovery, with isolated native state. */
import { chromium, expect, type Locator } from '@playwright/test';
import { registerWorkbenchFixture } from '../lib/messaging-smoke.js';
import { writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, host, store, native, registry, close } from './v2-fixture.js';
const output = process.env.TEST_OUTPUT ?? (await mkdtemp(join(tmpdir(), 'agent-space-layout-')));
await mkdir(output, { recursive: true });
import { DeliveryError } from '../../src/server/delivery-error.js';
import { RpcError } from '../../src/shared/rpc.js';
import { TERMINAL_BACKEND_ID } from '../../src/shared/plugins.js';
const backend = registry.get();
const status = backend.status.bind(backend);
backend.status = () => {
  const value = status();
  return { ...value, capabilities: { ...value.capabilities, newThread: true } };
};
backend.projects = async () => [];
const browser = await chromium.launch({
  channel: 'chrome',
  args: [`--unsafely-treat-insecure-origin-as-secure=${config.origin}`],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const checks: Record<string, boolean> = {},
  errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(`(() => {
  const original = window.visualViewport;
  const viewport = new EventTarget();
  let override;
  Object.defineProperties(viewport, {
    width: { get: () => original.width },
    height: { get: () => override?.height ?? original.height },
    offsetLeft: { get: () => original.offsetLeft },
    offsetTop: { get: () => override?.offsetTop ?? original.offsetTop },
    scale: { get: () => 1 },
  });
  window.__setVisibleViewport = (height, offsetTop = 0) => {
    override = { height, offsetTop };
    viewport.dispatchEvent(new Event('resize'));
  };
  Object.defineProperty(window, 'visualViewport', { get: () => viewport });
})();`);
async function bounds(selector: string, bottom: number, top = 0) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(top - 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(bottom + 1);
}
async function measuredWidth(target: Locator) {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  return box!.width;
}
async function expectZoom(target: Locator, baseWidth: number, percent: number) {
  await expect.poll(async () => Math.round(((await measuredWidth(target)) / baseWidth) * 100)).toBe(percent);
}
async function expectAppZoom(percent: number) {
  await expect
    .poll(() => page.evaluate(() => Math.round(Number(getComputedStyle(document.documentElement).zoom) * 100)))
    .toBe(percent);
}
async function expectShellViewport(width: number, height: number, top = 0) {
  await expect
    .poll(async () => {
      const box = await page.locator('.app-shell').boundingBox();
      return box && [box.x, box.y, box.width, box.height].map(Math.round);
    })
    .toEqual([0, top, width, height]);
  expect(await page.evaluate(() => [scrollX, scrollY])).toEqual([0, 0]);
}
try {
  const pair = store.mintPairing();
  await registerWorkbenchFixture(page, config.origin);
  await page.goto(`${config.origin}/#pair=${pair.code}&host=${host.identity.peerId}`);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('navigation', { name: '主要功能' }).waitFor();
  // Long project lists cannot expand the app shell and push the bottom navigation away.
  await page.locator('.sidebar nav').evaluate((el) => {
    const original = el.querySelector('.thread-button');
    if (original) for (let i = 0; i < 100; i++) el.append(original.cloneNode(true));
  });
  for (const size of [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
    { width: 320, height: 500 },
  ]) {
    await page.setViewportSize(size);
    await page.evaluate((height) => (window as any).__setVisibleViewport(height), size.height);
    await expect
      .poll(() => page.locator('.app-shell').evaluate((el) => Math.round(el.getBoundingClientRect().height)))
      .toBe(size.height);
    await bounds('.bottom-navigation', size.height);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollHeight <= innerHeight &&
          document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  checks.longListsKeepNavigationInViewport = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (window as any).__setVisibleViewport(844));
  await page
    .getByRole('button', { name: /测试会话/ })
    .first()
    .click();
  await expect(page.getByLabel('消息', { exact: true })).toBeEnabled({ timeout: 20000 });

  const collapse = page.getByRole('button', { name: '收起工作台', exact: true });
  const expand = page.getByRole('button', { name: '展开工作台', exact: true });
  const nav = page.getByRole('navigation', { name: '会话列表' });
  const search = page.getByRole('searchbox', { name: '搜索项目或会话' });
  const composer = page.getByLabel('消息', { exact: true });
  const chat = page.locator('.workspace-module .chat');
  const conversationUrl = page.url();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => (window as any).__setVisibleViewport(900));
  await expect(nav).toBeVisible();
  await search.fill('测试');
  await composer.fill('侧栏折叠测试草稿');
  const expandedWidth = (await chat.boundingBox())!.width;
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({ path: join(output, 'workbench-sidebar-expanded.png') });
  await collapse.press('Enter');
  await expect(expand).toBeFocused();
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(nav).toBeHidden();
  expect((await chat.boundingBox())!.width).toBeGreaterThan(expandedWidth);
  await expect(composer).toHaveValue('侧栏折叠测试草稿');
  await expect(page).toHaveURL(conversationUrl);
  await page.screenshot({ path: join(output, 'workbench-sidebar-collapsed.png') });
  await expand.click();
  await expect(search).toHaveValue('测试');
  await collapse.click();
  await page.reload();
  await expect(expand).toBeVisible();
  await expect(composer).toHaveValue('侧栏折叠测试草稿');

  const sendButton = page.locator('.composer .send-button');
  const desktopSendWidth = await measuredWidth(sendButton);
  await composer.focus();
  await page.keyboard.press('Control+Equal');
  await expectZoom(sendButton, desktopSendWidth, 120);
  await expectShellViewport(1440, 900);
  await bounds('.composer .send-button', 900);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('侧栏折叠测试草稿');
  await expect(nav).toBeHidden();
  await expect(page).toHaveURL(conversationUrl);
  await page.screenshot({ path: join(output, 'ui-zoom-desktop-120.png') });

  await page.keyboard.press('Control+Shift+Equal');
  await expectZoom(sendButton, desktopSendWidth, 144);
  await page.keyboard.press('Control+NumpadSubtract');
  await expectZoom(sendButton, desktopSendWidth, 120);
  await page.reload();
  await expect(composer).toHaveValue('侧栏折叠测试草稿');
  await expect(expand).toBeVisible();
  await expectZoom(sendButton, desktopSendWidth, 120);
  await expect(page).toHaveURL(conversationUrl);

  await composer.focus();
  await page.keyboard.press('Control+Digit0');
  await expectZoom(sendButton, desktopSendWidth, 100);
  await page.keyboard.press('Control+Minus');
  await expectZoom(sendButton, desktopSendWidth, 83);
  await expectShellViewport(1440, 900);
  await page.keyboard.press('Control+Digit0');
  await expectZoom(sendButton, desktopSendWidth, 100);
  await page.reload();
  await expect(composer).toHaveValue('侧栏折叠测试草稿');
  await expectZoom(sendButton, desktopSendWidth, 100);
  checks.interfaceZoomShortcutsPreserveConversationAndPersist = true;

  for (let step = 0; step < 4; step++) await page.keyboard.press('Control+Equal');
  await expectAppZoom(207);
  await expectShellViewport(1440, 900);
  await page.reload();
  await expectAppZoom(207);
  await expect(composer).toHaveValue('侧栏折叠测试草稿');
  await expect(page).toHaveURL(conversationUrl);
  await page.keyboard.press('Control+Digit0');
  await expectAppZoom(100);

  await composer.clear();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (window as any).__setVisibleViewport(844));
  await expect(expand).toBeHidden();
  await expect(page.getByRole('button', { name: '返回会话列表', exact: true })).toBeVisible();
  checks.workbenchSidebarCollapsesWithoutNavigation = true;

  const mobileSendWidth = await measuredWidth(sendButton);
  await page.keyboard.press('Meta+NumpadAdd');
  await expectZoom(sendButton, mobileSendWidth, 120);
  await expectShellViewport(390, 844);
  await page.screenshot({ path: join(output, 'ui-zoom-mobile-120.png') });
  await page.evaluate(() => (window as any).__setVisibleViewport(390, 24));
  await expectShellViewport(390, 390, 24);
  await bounds('.composer-box', 414, 24);
  await bounds('.composer .send-button', 414, 24);
  await expect(page.getByRole('button', { name: '返回会话列表', exact: true })).toBeVisible();
  await page.screenshot({ path: join(output, 'ui-zoom-mobile-keyboard-120.png') });
  await page.getByRole('button', { name: '工具', exact: true }).click();
  const toolPanel = page.getByRole('dialog', { name: '工具', exact: true });
  await expect(toolPanel).toBeVisible();
  const toolBox = (await toolPanel.boundingBox())!;
  expect(toolBox.x).toBeGreaterThanOrEqual(0);
  expect(toolBox.x + toolBox.width).toBeLessThanOrEqual(391);
  expect(toolBox.y).toBeGreaterThanOrEqual(23);
  expect(toolBox.y + toolBox.height).toBeLessThanOrEqual(415);
  await page.keyboard.press('Escape');
  await expect(toolPanel).toBeHidden();

  for (const percent of [144, 173]) {
    await page.keyboard.press('Meta+NumpadAdd');
    await expectZoom(sendButton, mobileSendWidth, percent);
  }
  await expectShellViewport(390, 390, 24);
  await bounds('.composer .send-button', 414, 24);
  const highZoomSend = (await sendButton.boundingBox())!;
  expect(highZoomSend.x).toBeGreaterThanOrEqual(0);
  expect(highZoomSend.x + highZoomSend.width).toBeLessThanOrEqual(391);
  await page.keyboard.press('Meta+Digit0');
  await expectZoom(sendButton, mobileSendWidth, 100);
  await page.evaluate(() => (window as any).__setVisibleViewport(844));
  checks.interfaceZoomFitsReducedMobileViewport = true;

  native.current.turnHistory.history.entitiesByKey.one.items.push({
    type: 'agentMessage',
    id: 'long-layout',
    text: 'Long content '.repeat(20000),
  });
  native.revision++;
  native.snapshot();
  for (const visible of [
    { height: 700, top: 0 },
    { height: 390, top: 24 },
    { height: 280, top: 0 },
  ]) {
    await page.evaluate((v) => (window as any).__setVisibleViewport(v.height, v.top), visible);
    await expect
      .poll(() => page.locator('.app-shell').evaluate((el) => Math.round(el.getBoundingClientRect().height)))
      .toBe(visible.height);
    await page.getByLabel('消息', { exact: true }).fill('Unsaved input');
    await bounds('.composer-box', visible.top + visible.height, visible.top);
    await bounds('.composer .send-button', visible.top + visible.height, visible.top);
    expect(await page.evaluate(() => scrollY)).toBe(0);
  }
  checks.visualViewportKeepsComposerAndSendVisible = true;
  await page.evaluate(() => (window as any).__setVisibleViewport(844));
  function publishConversation(runtime: 'notLoaded' | 'idle', label: string) {
    native.current.threadRuntimeStatus = { type: runtime };
    native.current.turnHistory.history.entitiesByKey.one.items.push({ type: 'agentMessage', id: label, text: label });
    native.revision++;
    native.snapshot();
    return expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  // Desktop state advances while a foreground/background transition loses a sync delivery.
  await publishConversation('notLoaded', 'Cold conversation before foreground recovery');
  await expect(page.getByRole('button', { name: '继续此会话', exact: true })).toHaveCount(0);
  const service = host as any,
    send = service.send;
  let dropped = false;
  service.send = function (session: any, event: any) {
    if (event.type !== 'sync') return send.call(this, session, event);
    dropped = true;
  };
  native.current.threadRuntimeStatus = { type: 'idle' };
  native.revision++;
  native.snapshot();
  await expect.poll(() => dropped).toBe(true);
  service.send = send;
  const watch = service.watch;
  let attempts = 0;
  service.watch = function (...args: any[]) {
    if (++attempts === 1) throw new RpcError('Transient watch failure', 503);
    return watch.apply(this, args);
  };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => attempts, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Unsaved input');
  await expect(page.locator('.composer [role="alert"]')).toHaveCount(0);
  checks.foregroundResyncAndSubscriptionRetryRestoreControls = true;
  service.watch = watch;

  const openThread = backend.openThread;
  const routerCall = host.core.router.call;
  const rejectedCause = '请先在电脑上的 Codex 桌面打开此会话，工作台同步后即可控制。';
  let opens = 0;
  const sends: string[] = [];
  const openIds: string[] = [];
  host.core.router.call = function (...args) {
    if (args[0].method === 'thread.open') openIds.push((args[0].body as { requestId: string }).requestId);
    if (args[0].method === 'message.send') sends.push((args[0].body as { text: string }).text);
    return routerCall.apply(this, args);
  };
  backend.openThread = async () => {
    if (++opens === 1) throw new DeliveryError('Fixture open result not observed');
    throw new DeliveryError(rejectedCause, true);
  };
  try {
    await publishConversation('notLoaded', 'Cold conversation ready for an explicit send');
    const send = page.locator('.composer .send-button');
    const draft = page.getByLabel('消息', { exact: true });
    const composer = page.locator('.composer');
    expect(opens).toBe(0);
    await expect(draft).toHaveValue('Unsaved input');
    await expect(send).toBeEnabled();
    await send.click();
    await expect(send).toHaveAccessibleName('正在等待会话同步…');
    expect(store.operation(openIds[0])?.state).toBe('uncertain');
    await expect(page.locator('.transcript').getByText('世界', { exact: true })).toBeVisible();
    await expect(draft).toHaveValue('Unsaved input');
    await expect(send).toBeDisabled();
    expect(opens).toBe(1);
    expect(sends).toEqual([]);
    await publishConversation('idle', 'Delayed desktop snapshot');
    await expect(draft).toHaveValue('');
    await publishConversation('idle', 'Repeated idle snapshot');
    expect(opens).toBe(1);
    expect(sends).toEqual(['Unsaved input']);
    checks.coldSendAcceptsLateReadySnapshotOnlyOnce = true;

    await publishConversation('notLoaded', 'Cold conversation with an explicitly rejected open');
    await draft.fill('Draft after explicit rejection');
    await send.click();
    const failure = composer.getByText(rejectedCause, { exact: false });
    await expect(failure).toContainText('消息未发送，草稿已保留。');
    expect(store.operation(openIds[1])?.state).toBe('rejected');
    await expect(draft).toHaveValue('Draft after explicit rejection');
    await expect(send).toBeEnabled();
    expect(sends).toEqual(['Unsaved input']);
    await publishConversation('idle', 'Desktop opened after the rejected request');
    expect(sends).toEqual(['Unsaved input']);
    await send.click();
    await expect(draft).toHaveValue('');
    await expect(failure).toHaveCount(0);
    expect(opens).toBe(2);
    expect(sends).toEqual(['Unsaved input', 'Draft after explicit rejection']);
    checks.coldSendSurfacesExplicitRejectionAndPreservesDraft = true;
  } finally {
    backend.openThread = openThread;
    host.core.router.call = routerCall;
  }
  for (const height of [720, 400]) {
    await page.setViewportSize({ width: 1280, height });
    await page.evaluate((h) => (window as any).__setVisibleViewport(h), height);
    await expect
      .poll(() => page.locator('.app-shell').evaluate((el) => Math.round(el.getBoundingClientRect().height)))
      .toBe(height);
    await bounds('.composer .send-button', height);
  }
  checks.desktopComposerFitsShortWindows = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (window as any).__setVisibleViewport(844));
  await expect
    .poll(() => page.locator('.app-shell').evaluate((el) => Math.round(el.getBoundingClientRect().height)))
    .toBe(844);
  await page.screenshot({ path: join(output, 'chat-mobile.png') });
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => (window as any).__setVisibleViewport(720));
  await expect
    .poll(() => page.locator('.app-shell').evaluate((el) => Math.round(el.getBoundingClientRect().height)))
    .toBe(720);
  await bounds('.bottom-navigation', 720);
  await page.screenshot({ path: join(output, 'workbench-desktop.png') });
  await page.getByRole('button', { name: '新会话', exact: true }).click();
  await expect(page.getByPlaceholder('发送第一条消息，开始新会话…')).toBeVisible();
  await page.evaluate(() => (window as any).__setVisibleViewport(390, 24));
  await expect
    .poll(() => page.locator('.app-shell').evaluate((el) => Math.round(el.getBoundingClientRect().height)))
    .toBe(390);
  await bounds('.new-conversation-sheet', 414, 24);
  await bounds('.new-conversation .send-button', 414, 24);
  checks.newConversationFitsVisibleViewport = true;

  const terminalUrl = new URL(conversationUrl);
  terminalUrl.searchParams.set('backend', TERMINAL_BACKEND_ID);
  terminalUrl.searchParams.delete('thread');
  await page.goto(terminalUrl.href);
  await expect(page.getByRole('heading', { name: '终端插件当前不可用', exact: true })).toBeVisible();
  const terminalIcon = page.locator('.term-disabled-card > svg');
  const terminalIconWidth = await measuredWidth(terminalIcon);
  await page.keyboard.press('Control+Equal');
  await expectZoom(terminalIcon, terminalIconWidth, 120);
  await expectShellViewport(1280, 720);
  await bounds('.term-ws', 720);
  await bounds('.term-disabled-card', 720);
  await page.keyboard.press('Control+Digit0');
  await expectZoom(terminalIcon, terminalIconWidth, 100);
  checks.interfaceZoomScalesTerminalWorkspace = true;

  await page.goto(`${config.origin}/?page=appearance`);
  const zoomOut = page.getByRole('button', { name: '缩小界面', exact: true });
  const zoomIn = page.getByRole('button', { name: '放大界面', exact: true });
  const resetZoom = (percent: number) =>
    page.getByRole('button', { name: `重置界面缩放，当前 ${percent}%`, exact: true });
  await expect(resetZoom(100)).toBeVisible();
  await zoomIn.click();
  await expect(resetZoom(120)).toBeVisible();
  await page.screenshot({ path: join(output, 'ui-zoom-settings-120.png') });
  await zoomOut.click();
  await expect(resetZoom(100)).toBeVisible();
  await zoomOut.click();
  await expect(resetZoom(83)).toBeVisible();
  for (let step = 0; step < 3; step++) await zoomOut.click();
  await expectAppZoom(48);
  await page.reload();
  await expect(resetZoom(48)).toBeVisible();
  await resetZoom(48).click();
  await expect(resetZoom(100)).toBeVisible();
  checks.appearanceSettingsAdjustAndResetInterfaceZoom = true;

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (window as any).__setVisibleViewport(844));
  for (let step = 0; step < 6; step++) await page.keyboard.press('Control+Equal');
  await expectAppZoom(299);
  await page.getByRole('button', { name: '恢复 100% 缩放', exact: true }).tap();
  await expectAppZoom(100);
  await page.evaluate(() => localStorage.setItem('pocket-app-zoom-level', '9007199254740991'));
  await page.reload();
  await expect(resetZoom(100)).toBeVisible();
  checks.interfaceZoomBeyondPreviousLimitsAndRecovery = true;
  expect(errors).toEqual([]);
  checks.noBrowserErrors = true;
} catch (error) {
  errors.push((error as Error).message);
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify({ checks, errors, physicalPhone: false }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }));
  await browser.close();
  await close();
}
