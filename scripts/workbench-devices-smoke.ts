/** Exercise host routing with two independent simulated desktops sharing the same conversation ID. */
import { chromium, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { CodexBackend } from '../packages/adapter-codex/src/backend.js';
import { DesktopAdapter } from '../packages/adapter-codex/src/desktop.js';
import { HistoryIndex } from '../packages/adapter-codex/src/history.js';
import { BackendRegistry } from '../src/server/backends/registry.js';
import { HostService } from '../src/server/host-service.js';
import { Store } from '../src/server/store.js';
import { createIdentity } from '../src/shared/secure-channel.js';
import { FakeTransport, fixtureConfig, historyFixture, THREAD } from '../test/helpers.js';
import { saveRecoveryCode } from './lib/messaging-smoke.js';

const { config, host, store, native, close } = await import('./v2-fixture.js');
const other = fixtureConfig();
other.relay = config.relay;
historyFixture(other);
const db = new DatabaseSync(join(other.codexHome, 'state_5.sqlite'));
const addRecent = db.prepare(
  'INSERT INTO threads (id, title, cwd, updated_at_ms, archived, thread_source, rollout_path) SELECT ?, ?, cwd, ?, archived, thread_source, rollout_path FROM threads WHERE id = ?',
);
for (let index = 1; index <= 12; index++)
  addRecent.run(randomUUID(), `实验记录 ${String(index).padStart(2, '0')}`, 100 - index, THREAD);
db.close();
const otherStore = new Store(other.stateDir);
const otherTransport = new FakeTransport();
const registry = new BackendRegistry().register(
  new CodexBackend(other, new DesktopAdapter(other, () => otherTransport), new HistoryIndex(other.codexHome)),
);
const otherHost = new HostService(other, await createIdentity(), { store: otherStore, registry });
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : { channel: 'chrome' }),
  args: [`--unsafely-treat-insecure-origin-as-secure=${config.origin}`],
});
const screenshots = process.env.WORKBENCH_SCREENSHOT_DIR;
const workbenchURL = `${config.origin}/?page=workbench`;
const username = 'workbench-fixture';
const password = 'workbench-fixture-password';
async function signup(page: Awaited<ReturnType<typeof browser.newPage>>, name: string, identifier: string) {
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.getByLabel('昵称', { exact: true }).fill(name);
  await page.getByLabel('用户名', { exact: true }).fill(identifier);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await saveRecoveryCode(page);
}
try {
  await registry.start();
  otherHost.start();
  for (const [transport, text] of [
    [native, '办公电脑的回复'],
    [otherTransport, '实验室电脑的回复'],
  ] as const) {
    transport.current.turnHistory.history.entitiesByKey.one.items.push({
      type: 'agentMessage',
      id: 'shared-message-id',
      text,
    });
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(workbenchURL);
  await expect(page.getByRole('button', { name: '扫码登录', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '使用账号密码', exact: true }).click();
  await expect(page.getByRole('button', { name: '登录账户', exact: true })).toBeVisible();
  await expect(page.getByLabel('昵称', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: '扫码或输入配对码', exact: true })).toBeHidden();
  if (screenshots) await page.screenshot({ path: join(screenshots, 'workbench-first-login.png') });

  let resumeDeviceList!: () => void;
  const holdDeviceList = new Promise<void>((resolve) => {
    resumeDeviceList = resolve;
  });
  let firstDeviceList = true;
  await page.route('**/api/im/desktop-devices', async (route) => {
    if (firstDeviceList) {
      firstDeviceList = false;
      await holdDeviceList;
      await route.fulfill({ status: 503, json: { error: 'fixture temporarily unavailable' } });
    } else {
      await route.continue();
    }
  });
  await signup(page, '测试账户', username);
  try {
    await expect(page.getByText('正在读取账号中的电脑…', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '连接第一台电脑', exact: true })).toBeHidden();
  } finally {
    resumeDeviceList();
  }
  await expect(page.getByRole('alert').filter({ hasText: '无法读取账号中的电脑。' })).toBeVisible();
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  const firstComputer = page.getByRole('heading', { name: '连接第一台电脑', exact: true });
  await expect(firstComputer).toBeVisible();
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/?page=workbench');
  if (screenshots) {
    await page.screenshot({ path: join(screenshots, 'workbench-first-computer.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'pavilion-dark');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(screenshots, 'workbench-first-computer-mobile-dark.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'light' });
  }
  await page.getByRole('button', { name: '下载电脑适配器', exact: true }).click();
  await expect(page.getByRole('heading', { name: '电脑适配器', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(firstComputer).toBeVisible();

  const stateToken = randomUUID();
  const callbackPort = 32189;
  const authorization = new URL('/?page=desktop-authorization', config.origin);
  authorization.hash = new URLSearchParams({
    host: host.identity.peerId,
    name: '验收电脑',
    state: stateToken,
    port: String(callbackPort),
  }).toString();
  await page.goto(authorization.href);
  await expect(page.getByRole('heading', { name: '授权这台电脑', exact: true })).toBeVisible();
  await expect(page.getByText('验收电脑', { exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  if (screenshots) await page.screenshot({ path: join(screenshots, 'workbench-desktop-consent.png') });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(firstComputer).toBeVisible();
  const callback = `http://127.0.0.1:${callbackPort}/authorize/callback?state=${stateToken}`;
  await page.route(callback, (route) => route.fulfill({ body: 'Fixture callback received' }));
  await page.goto(authorization.href);
  await page.getByRole('button', { name: '确认授权', exact: true }).click();
  await expect(page).toHaveURL(callback);
  await page.goto(workbenchURL);
  await expect(firstComputer).toBeVisible();

  const workbench = () =>
    page
      .getByRole('navigation', { name: '主要功能' })
      .getByRole('button', { name: '工作台', exact: true })
      .click();
  async function pair(service: HostService, data: Store, name: string) {
    const pair = data.mintPairing();
    await page.goto(`${config.origin}/#pair=${pair.code}&host=${service.identity.peerId}`);
    await page.getByRole('button', { name: '连接电脑', exact: true }).click();
    await page.getByRole('tab', { name: '最近', exact: true }).waitFor();
    await workbench();
    const card = page
      .locator('.computer-card')
      .filter({ hasNotText: /^办公电脑/ })
      .last();
    await card.getByRole('button', { name: /^管理 / }).click();
    await card.getByRole('button', { name: '重命名' }).click();
    await card.getByLabel('电脑名称').fill(name);
    await card.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('article', { name, exact: true })).toBeVisible();
  }
  await pair(host, store, '办公电脑');
  await pair(otherHost, otherStore, '实验室电脑');
  await page.getByRole('button', { name: '添加电脑', exact: true }).click();
  await expect(page.getByRole('heading', { name: '添加电脑', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '下载电脑适配器', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '扫描配对二维码', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  const office = page.getByRole('article', { name: '办公电脑', exact: true });
  const lab = page.getByRole('article', { name: '实验室电脑', exact: true });
  await expect(office.getByRole('button', { name: '打开 Codex', exact: true })).toBeVisible();
  await expect(lab.getByRole('button', { name: '打开 Codex', exact: true })).toBeVisible();
  const search = page.getByRole('searchbox', { name: '搜索电脑、工具或最近会话' });
  await search.fill('实验室');
  await expect(lab).toBeVisible();
  await expect(office).toHaveCount(0);
  await search.clear();
  const recentList = lab.locator('.computer-recent-list');
  await expect(recentList.getByRole('button')).toHaveCount(13);
  expect(
    await recentList.evaluate((element) => ({
      scrollable: element.scrollHeight > element.clientHeight,
      width: getComputedStyle(element, '::-webkit-scrollbar').width,
      radius: getComputedStyle(element, '::-webkit-scrollbar-thumb').borderRadius,
    })),
  ).toEqual({ scrollable: true, width: '8px', radius: '10px' });
  await recentList.focus();
  await page.keyboard.press('End');
  await expect.poll(() => recentList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Home');
  await expect.poll(() => recentList.evaluate((element) => element.scrollTop)).toBe(0);
  await recentList.blur();
  await page.mouse.move(2, 2);
  if (screenshots) await page.screenshot({ path: join(screenshots, 'workbench-desktop.png') });
  const desktopColumns = await page
    .locator('.computer-grid')
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(desktopColumns.split(' ')).toHaveLength(2);

  const officeHistory = new DatabaseSync(join(config.codexHome, 'state_5.sqlite'));
  officeHistory.exec(`INSERT INTO projects VALUES
    ('z', 'Z 项目', 0), ('b', 'B 项目', 1), ('a', 'A 项目', 2), ('c', 'AA 空项目', 3)`);
  officeHistory.prepare("UPDATE threads SET project_id = 'z' WHERE id = ?").run(THREAD);
  const addOfficeThread = officeHistory.prepare(
    'INSERT INTO threads SELECT ?, NULL, ?, cwd, ?, archived, thread_source, rollout_path, ? FROM threads WHERE id = ?',
  );
  for (let i = 1; i <= 32; i++) addOfficeThread.run(randomUUID(), `办公记录 ${i}`, 100 - i, 'z', THREAD);
  const older = randomUUID();
  addOfficeThread.run(older, '旧的 B 会话', 25, 'b', THREAD);
  addOfficeThread.run(randomUUID(), '旧的 A 会话', 10, 'a', THREAD);

  await office.getByRole('button', { name: '打开 Codex', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('host')).toBe(host.identity.peerId);
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await page.getByRole('button', { name: /测试会话/ }).click();
  await expect(page.getByText('办公电脑的回复', { exact: true })).toBeVisible();
  await expect(page.getByText('实验室电脑的回复', { exact: true })).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: '会话列表' });
  await nav.getByRole('button', { name: '加载更多会话' }).click();
  await expect(nav.getByRole('button', { name: /旧的 A 会话/ })).toBeVisible();
  const newThread = randomUUID();
  addOfficeThread.run(newThread, '首条消息', 110, 'z', THREAD);
  await expect(nav.locator('.thread-button').first()).toContainText('首条消息', { timeout: 15_000 });
  officeHistory.prepare('UPDATE threads SET name=? WHERE id=?').run('自动生成的会话标题', newThread);
  officeHistory.prepare('UPDATE threads SET name=? WHERE id=?').run('桌面更新的标题', THREAD);
  officeHistory.prepare('UPDATE threads SET updated_at_ms=? WHERE id=?').run(120, older);
  await expect(nav.locator('.thread-button').first()).toContainText('旧的 B 会话', { timeout: 15_000 });
  await expect(nav.getByRole('button', { name: /旧的 B 会话/ })).toHaveCount(1);
  await expect(nav.getByRole('button', { name: /自动生成的会话标题/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: '桌面更新的标题' })).toBeVisible();
  await expect(nav.getByRole('button', { name: /旧的 A 会话/ })).toBeVisible();
  officeHistory.close();

  const projectTab = page.getByRole('tab', { name: '项目', exact: true });
  await projectTab.click();
  const ordering = page.getByRole('combobox', { name: '项目排序', exact: true });
  const projects = nav.locator('.project-heading strong');
  await expect(projects).toHaveText(['Z 项目', 'B 项目', 'A 项目', 'AA 空项目', '未分类']);
  await ordering.selectOption('name');
  await expect(projects).toHaveText(['A 项目', 'AA 空项目', 'B 项目', 'Z 项目', '未分类']);
  await page.reload();
  await projectTab.click();
  await expect(ordering).toHaveValue('name');
  await ordering.selectOption('activity');
  await expect(projects).toHaveText(['B 项目', 'Z 项目', 'A 项目', 'AA 空项目', '未分类']);
  if (screenshots) await page.screenshot({ path: join(screenshots, 'workbench-project-sort-desktop.png') });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
  await expect(ordering).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (screenshots) await page.screenshot({ path: join(screenshots, 'workbench-project-sort-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  await workbench();
  await expect(page.locator('.computer-card').first()).toHaveAttribute('aria-label', '办公电脑');
  await lab.getByRole('button', { name: '测试会话', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('host')).toBe(otherHost.identity.peerId);
  await expect.poll(() => new URL(page.url()).searchParams.get('thread')).toBe(THREAD);
  await expect(page.getByText('实验室电脑的回复', { exact: true })).toBeVisible();
  await expect(page.getByText('办公电脑的回复', { exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(lab).toBeVisible();
  await expect(page.locator('.computer-card').first()).toHaveAttribute('aria-label', '实验室电脑');
  await page.goForward();
  await expect(page.getByText('实验室电脑的回复', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('实验室电脑的回复', { exact: true })).toBeVisible();

  // Exercise the device-opening deadline, before a conversation subscription exists.
  const { user } = await (await page.request.get(`${config.origin}/api/im/me`)).json();
  const vaultItems = '**/api/im/crypto/items?*';
  await page.route(vaultItems, (route) => route.fulfill({ status: 503 }));
  await page.evaluate(
    ({ account, target, active }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('pocket-device-v2', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('private', 'readwrite');
          const records = tx.objectStore('private');
          const scope = `account:${account}:`;
          const stored = records.get(`${scope}hosts`);
          stored.onsuccess = () => {
            const hosts = stored.result;
            const legacy = hosts.find((host: { hostId: string }) => host.hostId === target);
            if (!legacy?.identity) {
              reject(new Error('Expected a saved fixture pairing'));
              tx.abort();
              return;
            }
            delete legacy.identity;
            records.put(hosts, `${scope}hosts`);
            records.put(active, `${scope}active`);
            sessionStorage.setItem('fixture-pending-host-identity', `${scope}identity`);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      }),
    { account: user.id, target: otherHost.identity.peerId, active: host.identity.peerId },
  );
  await page.addInitScript(() => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      const request = get.call(this, key);
      if (
        this.name === 'private' &&
        this.transaction.db.name === 'pocket-device-v2' &&
        key === sessionStorage.getItem('fixture-pending-host-identity')
      )
        request.addEventListener = () => {};
      return request;
    };
  });
  const bookmarkedConversation = page.url();
  await page.reload();
  await expect(page.getByText('正在打开电脑…', { exact: true })).toBeVisible();
  await expect(page.getByText('打开这台电脑超时，可重试。', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await page.evaluate(() => sessionStorage.removeItem('fixture-pending-host-identity'));
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('实验室电脑的回复', { exact: true })).toBeVisible();
  await expect(page.getByText('办公电脑的回复', { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(bookmarkedConversation);
  await page.unroute(vaultItems);

  otherHost.stop();
  await workbench();
  await expect(lab.getByText('离线', { exact: true })).toBeVisible();
  await expect(lab.getByRole('button', { name: '打开 Codex', exact: true })).toHaveText('查看历史');
  await lab.getByRole('button', { name: '测试会话', exact: true }).click();
  await expect(page.getByText('实验室电脑的回复', { exact: true })).toBeVisible();
  await expect(page.locator('.composer .send-button')).toBeDisabled();

  await workbench();
  await page.reload();
  await expect(page.locator('.computer-card').first()).toHaveAttribute('aria-label', '实验室电脑');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(lab.getByText('离线', { exact: true })).toBeVisible();
  const mobileColumns = await page
    .locator('.computer-grid')
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(mobileColumns.split(' ')).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const add = await page.getByRole('button', { name: '添加电脑', exact: true }).boundingBox();
  const mobileSearch = await page.getByRole('searchbox').boundingBox();
  expect(mobileSearch!.y).toBeGreaterThan(add!.y + add!.height);
  if (screenshots) await page.screenshot({ path: join(screenshots, 'workbench-mobile.png') });

  const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
  guest.on('pageerror', (error) => errors.push(error.message));
  const oldPair = store.mintPairing();
  const legacyPairURL = `${config.origin}/#pair=${oldPair.code}&host=${host.identity.peerId}`;
  await guest.goto(legacyPairURL);
  await expect(guest.getByRole('button', { name: '扫码登录', exact: true })).toBeVisible();
  await expect(guest.getByRole('button', { name: '连接电脑', exact: true })).toHaveCount(0);
  await signup(guest, '受保护的配对测试', 'workbench-guest-fixture');
  await guest.goto(legacyPairURL);
  await expect(guest.getByRole('heading', { name: '手动配对', exact: true })).toBeVisible();
  await guest.getByRole('button', { name: '连接电脑', exact: true }).click();
  await guest.getByRole('tab', { name: '最近', exact: true }).waitFor();
  await guest
    .getByRole('navigation', { name: '主要功能' })
    .getByRole('button', {
      name: '工作台',
      exact: true,
    })
    .click();
  await expect(guest.getByRole('article')).toBeVisible();
  await expect(guest).toHaveURL(workbenchURL);
  await guest.context().close();
  expect(errors).toEqual([]);
  console.log(
    'Workbench first login, device-list and pending host retries, desktop consent, authenticated legacy pairing, scoped tools, offline history and mobile grid.',
  );
} finally {
  await browser.close();
  otherHost.stop();
  await registry.stop();
  otherStore.close();
  await rm(other.desktopRoot, { recursive: true, force: true });
  await close();
}
