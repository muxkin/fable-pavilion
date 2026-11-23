/** Mobile Chromium history traversal against the isolated desktop fixture. */
import { chromium, expect } from '@playwright/test';
import { registerWorkbenchFixture } from '../lib/messaging-smoke.js';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { close, config, host, store } from './v2-fixture.js';

const browser = await chromium.launch({
  channel: 'chrome',
  args: [`--unsafely-treat-insecure-origin-as-secure=${config.origin}`],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const output = process.env.TEST_OUTPUT ?? (await mkdtemp(join(tmpdir(), 'pocket-mobile-back-')));
await mkdir(output, { recursive: true });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const entry = () => new URL(page.url());
const conversation = () => entry().searchParams.get('thread');
const backend = () => entry().searchParams.get('backend');
const currentHost = () => entry().searchParams.get('host');
const chooser = page.getByRole('searchbox', { name: '搜索电脑、工具或最近会话' });
const list = page.getByRole('navigation', { name: '会话列表' });
const draft = page.getByRole('textbox', { name: '消息', exact: true });
const tools = page.getByRole('button', { name: '会话工具', exact: true });

try {
  await registerWorkbenchFixture(page, config.origin);
  await page.goto(`${config.origin}/#pair=${store.mintPairing().code}&host=${host.identity.peerId}`);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await expect(list).toBeVisible();
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(chooser).toBeVisible();
  const navButtons = page.getByRole('navigation', { name: '主要功能' }).getByRole('button');
  const modules = ['消息', '联系人', '工作台', '我的'];
  await expect(navButtons).toHaveCount(modules.length);
  for (const [index, label] of modules.entries())
    await expect(navButtons.nth(index)).toHaveAccessibleName(label);
  await page
    .locator('.computer-card .computer-recent-list')
    .getByRole('button')
    .filter({ has: page.getByText('测试会话', { exact: true }) })
    .click();
  await expect(draft).toBeEnabled();
  const id = conversation();
  const threadURL = page.url();
  expect(id).toBeTruthy();
  await draft.fill('草稿随会话保留');

  await page.goBack();
  await expect(list).toBeVisible();
  expect(conversation()).toBeNull();
  expect(backend()).toBe('codex-local');
  expect(currentHost()).toBe(host.identity.peerId);
  await page.goForward();
  await expect(draft).toHaveValue('草稿随会话保留');
  expect(conversation()).toBe(id);

  await tools.click();
  await expect(page.getByRole('dialog', { name: '会话工具' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(draft).toHaveValue('草稿随会话保留');
  expect(conversation()).toBe(id);

  await tools.click();
  await page.getByRole('dialog', { name: '会话工具' })
    .getByRole('button', { name: /^模型设置/ }).click();
  await expect(page.getByRole('dialog', { name: '模型设置', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(conversation()).toBe(id);

  await page.getByRole('button', { name: /^网络连接 · / }).click();
  await expect(page.getByRole('dialog', { name: '网络连接', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state?.pocketDialogs?.length ?? 0)).toBe(0);
  await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
  await expect(list).toBeVisible();
  await page.getByRole('navigation', { name: '主要功能' })
    .getByRole('button', { name: '工作台', exact: true }).click();
  await expect(chooser).toBeVisible();
  await page.goForward();
  await expect(list).toBeVisible();
  await page.goForward();
  await expect(draft).toHaveValue('草稿随会话保留');
  await expect(page).toHaveTitle('子虚亭 · Fable Pavilion');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.screenshot({ path: join(output, 'conversation.png') });

  // A tab that upgrades from the old app may still have a chooser-to-chat history entry.
  await page.goBack();
  await page.goBack();
  await expect(chooser).toBeVisible();
  await page.evaluate((url) => {
    history.pushState({ pocket: true, previousRoute: '/?page=workbench' }, '', url);
  }, threadURL);
  await page.reload();
  await expect(draft).toHaveValue('草稿随会话保留');
  await page.goBack();
  await expect(list).toBeVisible();
  expect(currentHost()).toBe(host.identity.peerId);

  await page.goto(`${config.origin}/?page=appearance`);
  await expect(page.getByRole('heading', { name: '外观', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect.poll(() => entry().searchParams.get('page')).toBe('me');

  const previousDocument = `${config.origin}/health?before=app`;
  await page.goto(previousDocument);
  await page.goto(`${config.origin}/?page=appearance`);
  await expect(page.getByRole('heading', { name: '外观', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await page.goBack();
  await expect.poll(() => entry().searchParams.get('page')).toBe('me');
  await page.goBack();
  await expect(page).toHaveURL(previousDocument);

  await page.goto(`${config.origin}/?page=messages`);
  const navigation = page.getByRole('navigation', { name: '主要功能' });
  for (const [label, route] of [['工作台', 'workbench'], ['联系人', 'contacts'], ['消息', 'messages'], ['我的', 'me']]) {
    await navigation.getByRole('button', { name: label, exact: true }).click();
    await expect.poll(() => entry().searchParams.get('page')).toBe(route);
    expect(await page.evaluate(() => history.state?.pocketDepth)).toBe(0);
  }
  await page.goBack();
  await expect(page).toHaveURL(previousDocument);

  await page.goto(`${config.origin}/?page=messages`);
  await expect(navigation).toBeVisible();
  await page.evaluate(() => {
    history.replaceState({ pocket: true }, '', '/?page=messages');
    history.pushState({ pocket: true, previousRoute: '/?page=messages' }, '', '/?page=contacts');
    history.pushState({ pocket: true, previousRoute: '/?page=contacts' }, '', '/?page=workbench');
  });
  await page.reload();
  await expect(chooser).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(previousDocument);
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ workbenchHierarchy: true, modalBack: true, explicitClose: true, settingsDeepLink: true, rootExits: true, legacyStackExits: true, draftPreserved: true, output }));
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  console.error(JSON.stringify({ errors, output }));
  throw error;
} finally {
  await browser.close();
  await close();
}
