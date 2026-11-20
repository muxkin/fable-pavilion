import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { PNG } from 'pngjs';
import { buildRelay } from '../src/server/relay.ts';
import {
  allocateLocalPort,
  saveRecoveryCode,
  registerAgentFixture,
  messagingFixtureRequest,
  openChatMore,
} from './lib/messaging-smoke.ts';
// Isolated accounts and local relay; no live desktop or personal IM state is touched.
const bind = process.env.TEST_BIND ?? '127.0.0.1',
  port = await allocateLocalPort(bind, process.env.TEST_PORT);
const origin = `http://${bind}:${port}`,
  out = process.env.TEST_OUTPUT ?? (await mkdtemp(join(tmpdir(), 'pocket-im-uid-qa-')));
await mkdir(out, { recursive: true });
const state = await mkdtemp(join(tmpdir(), 'pocket-im-smoke-'));
const relay = await buildRelay({
  messaging: {
    humanContacts: true, // Explicit optional social-mode fixture.
    totpKey: Buffer.alloc(32, 73).toString('base64url'), // Disposable fixture only.
  },
  origin,
  webRoot: resolve(process.env.TEST_WEB_ROOT ?? 'dist/web'),
  database: join(state, 'relay.sqlite'),
  assetOrigin: null,
  uploadOrigins: [],
  enrollmentSecret: 'isolated-messaging-fixture-secret',
});
await relay.app.listen({ host: bind, port });
const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    `--unsafely-treat-insecure-origin-as-secure=${origin}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});
const context = await browser.newContext({ viewport: { width: 1487, height: 1058 } }),
  page = await context.newPage();
const suffix = Date.now().toString().slice(-7),
  username = `qing${suffix}`,
  friend = `lin${suffix}`;
const errors = [],
  checks = {};
page.on('pageerror', (e) => errors.push(e.message));
const agentClients = new Map();
async function api(path, method = 'GET', data, token) {
  const client = agentClients.get(token);
  if (!client) throw Error('Missing encrypted fixture client');
  return messagingFixtureRequest(client, path, method, data);
}
async function humanAPI(path, method = 'GET', data) {
  const r = await page.request.fetch(origin + '/api/im' + path, {
    method,
    headers: { Origin: origin },
    ...(data ? { data } : {}),
  });
  if (!r.ok()) throw Error(`${path}: ${r.status()} ${await r.text()}`);
  return r.json();
}
async function nav(name) {
  await page.getByRole('navigation', { name: '主要功能' }).getByRole('button', { name, exact: true }).click();
}
async function noOverflow() {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
let friendContext, otherTab;
try {
  await page.goto(origin + '/?page=messages');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.getByLabel('昵称', { exact: true }).fill('小青');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill('isolated-qa-password-123');
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await saveRecoveryCode(page);
  await expect(page.getByText('还没有聊天记录', { exact: true })).toBeVisible();
  const registered = (await humanAPI('/me')).user;
  expect(registered.id).toBe('10000000');
  expect(registered.address).toBe(registered.id + '@' + new URL(origin).host);
  checks.register = true;
  await nav('联系人');
  await page.getByRole('button', { name: '接入 Agent', exact: true }).click();
  await page.getByRole('button', { name: '生成一次性邀请', exact: true }).click();
  const instructions = await page.getByLabel('Agent 注册说明').inputValue();
  const invitation = instructions.match(/一次性邀请：([^\s]+)/)?.[1];
  expect(invitation).toBeTruthy();
  const agent = await registerAgentFixture(origin, {
    invitation,
    username: `agent${suffix}`,
    displayName: '研究助手',
  });
  agentClients.set(agent.token, agent.client);
  await expect(page.locator('.im-agent-row')).toContainText('研究助手');
  // Keep invitation/credentials out of screenshots.
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '接入 Agent', exact: true }).click();
  await expect(page.locator('.im-agent-row')).toContainText('研究助手');
  await page.screenshot({ path: out + '/desktop-agent.png' });
  await page.getByRole('button', { name: '返回', exact: true }).click();
  friendContext = await browser.newContext();
  const friendPage = await friendContext.newPage();
  await friendPage.goto(origin + '/?page=messages');
  await friendPage.getByRole('button', { name: '创建账号', exact: true }).click();
  await friendPage.getByLabel('昵称', { exact: true }).fill('林同学');
  await friendPage.getByLabel('用户名', { exact: true }).fill(friend);
  await friendPage.getByLabel('密码', { exact: true }).fill('isolated-friend-password');
  await friendPage.getByRole('button', { name: '创建账户', exact: true }).click();
  await saveRecoveryCode(friendPage);
  await expect(friendPage.getByText('还没有聊天记录', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加联系人', exact: true }).click();
  await page.getByLabel('UID 或用户名').fill('@' + friend);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('heading', { name: '林同学', exact: true })).toBeVisible();
  await page.getByLabel('备注', { exact: true }).fill('同组的林同学');
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('.im-person-row').filter({ hasText: '同组的林同学' })).toHaveCount(1);
  await noOverflow();
  await page.screenshot({ path: out + '/desktop-contacts.png' });
  checks.contacts = true;
  await nav('消息');
  await page.getByRole('button', { name: '新建聊天' }).click();
  await page.getByRole('button', { name: '新建群聊', exact: true }).click();
  await page.getByLabel('群名称', { exact: true }).fill('研究讨论组');
  await page.getByRole('checkbox', { name: /同组的林同学/ }).check();
  await page.getByRole('checkbox', { name: /研究助手/ }).check();
  await page.getByRole('button', { name: '创建群聊（3 人）', exact: true }).click();
  await expect(page.getByRole('heading', { name: '研究讨论组', exact: true })).toBeVisible();
  const group = (await api('/conversations', 'GET', undefined, agent.token)).conversations.find(
    (c) => c.kind === 'group',
  );
  const id = group.id;
  const csvSource = 'sample,energy\ndemo_a,-0.31\n"demo_b, replicate",-0.29\n';
  await page.getByLabel('聊天消息').fill('请整理这批演示数据，给出检查思路。');
  await page.getByLabel('添加附件', { exact: true }).setInputFiles({
    name: '计算结果.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csvSource),
  });
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  let releaseSend;
  const holdSend = new Promise((resolve) => {
    releaseSend = resolve;
  });
  const sendPath = `**/api/im/conversations/${id}/messages`;
  const holdPost = async (route) => {
    if (route.request().method() === 'POST') await holdSend;
    await route.continue();
  };
  await page.route(sendPath, holdPost);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const outgoing = page.locator('.im-message.outgoing-message');
  const composer = page.getByLabel('聊天消息');
  await expect(outgoing.getByRole('status')).toHaveText('正在发送…');
  await expect(outgoing).toContainText('计算结果.csv');
  await expect(composer).toHaveValue('');
  await expect(composer).toBeEditable();
  await expect(page.locator('.im-compose-wrap .send-button')).toHaveAttribute('aria-busy', 'true');
  await composer.fill('另一条待写消息');
  await page.screenshot({ path: out + '/desktop-sending.png' });
  releaseSend();
  await expect(outgoing).toHaveCount(0);
  await page.unroute(sendPath, holdPost);
  await expect(composer).toHaveValue('另一条待写消息');
  await composer.clear();
  checks.sendingKeepsNewDraft = true;
  await expect(page.getByRole('log').getByText('请整理这批演示数据，给出检查思路。', { exact: true })).toBeVisible();
  await expect(page.locator('.im-message .file-attachment-card')).toBeVisible();
  let stream = (
    await api(
      `/conversations/${id}/messages`,
      'POST',
      { clientId: 'stream-' + suffix, state: 'streaming', text: '…' },
      agent.token,
    )
  ).message;
  await expect(page.getByText('正在回复…', { exact: true }).last()).toBeVisible();
  await api(
    `/conversations/${id}/messages/${stream.id}`,
    'PATCH',
    { revision: 1, text: '', state: 'streaming', activities: [{ kind: 'search', status: 'in_progress' }] },
    agent.token,
  );
  const progress = page.locator(`[data-message-id="${stream.id}"] .im-agent-activities`);
  await expect(progress.locator('summary')).toHaveText('正在搜索资料…');
  await progress.locator('summary').click();
  await expect(progress.getByText('进行中', { exact: true })).toBeVisible();
  const text =
    '已收到计算结果文件。这是一组演示数据，下面展示整理流程。\n\n### 检查思路\n\n1. 核对样本名称、单位与缺失值。\n2. 汇总能量分布，保留来源标识。\n\n```python\nimport pandas as pd\n\ndf = pd.read_csv("计算结果.csv")\nsummary = df["energy"].describe()\nprint(summary)\n```';
  stream = (
    await api(
      `/conversations/${id}/messages/${stream.id}`,
      'PATCH',
      { revision: 2, text, state: 'streaming', activities: [{ kind: 'search', status: 'completed' }] },
      agent.token,
    )
  ).message;
  await expect(page.getByRole('heading', { name: '检查思路', exact: true })).toBeVisible();
  await expect(page.locator('.im-message pre')).toContainText('import pandas');
  await expect(progress.getByText('已完成', { exact: true })).toBeVisible();
  await noOverflow();
  await page.screenshot({ path: out + '/desktop-chat.png' });
  checks.groupAndStreaming = true;
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByText('回复已停止', { exact: true })).toBeVisible();
  const stop = await api(`/conversations/${id}/messages/${stream.id}`, 'GET', undefined, agent.token);
  expect(stop.message.state).toBe('cancelled');
  checks.stop = true;
  const target = page.locator(`[data-message-id="${stream.id}"]`);
  await target.hover();
  await target.getByRole('button', { name: '引用回复', exact: true }).click();
  await page.getByLabel('提及成员').selectOption(agent.user.username);
  await page.getByLabel('聊天消息').fill(`@${agent.user.username} 请继续核对来源。`);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.im-message.mine[data-message-id] .im-quote')).toHaveCount(1);
  const messages = (await api(`/conversations/${id}/messages`, 'GET', undefined, agent.token)).messages;
  expect(messages.at(-1)).toMatchObject({ replyTo: stream.id, mentions: [agent.user.id] });
  checks.replyAndMention = true;
  await page.getByRole('button', { name: '搜索聊天记录', exact: true }).click();
  await page.getByLabel('搜索关键词').fill('核对');
  await page
    .getByRole('dialog', { name: '搜索聊天记录' })
    .getByRole('button', { name: '搜索', exact: true })
    .click();
  await expect(page.locator('.im-search-results>button')).toHaveCount(2);
  await page.locator('.im-search-results>button').first().click();
  await expect(page.getByRole('dialog', { name: '消息详情' })).toBeVisible();
  await page.getByRole('dialog', { name: '消息详情' }).getByRole('button', { name: '关闭' }).click();
  await page.getByRole('dialog', { name: '搜索聊天记录' }).getByRole('button', { name: '关闭' }).click();
  checks.search = true;
  await page.getByRole('button', { name: '成员', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '群资料与成员' }).locator('.im-member')).toHaveCount(3);
  await page.screenshot({ path: out + '/desktop-members.png' });
  await page.getByRole('dialog', { name: '群资料与成员' }).getByRole('button', { name: '关闭' }).click();
  await friendPage.getByRole('button', { name: /研究讨论组/ }).click();
  await expect(friendPage.getByText('请整理这批演示数据，给出检查思路。', { exact: true })).toBeVisible();
  await friendPage.getByLabel('聊天消息').fill('收到，我会补充样本说明。');
  await friendPage.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('log').getByText('收到，我会补充样本说明。', { exact: true })).toBeVisible();
  checks.humanGroupDelivery = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await page.screenshot({ path: out + '/mobile-chat.png' });
  await expect(page.getByRole('navigation', { name: '主要功能' })).not.toBeVisible();
  await page.getByLabel('聊天消息').fill('保留的草稿');
  await page.getByRole('button', { name: '返回消息列表' }).click();
  await expect(page.getByRole('navigation', { name: '主要功能' })).toBeVisible();
  const mobileNav = page.getByRole('navigation', { name: '主要功能' });
  const mobileTabs = mobileNav.getByRole('button');
  await expect(mobileTabs).toHaveCount(4);
  for (const [index, label] of ['消息', '联系人', '工作台', '我的'].entries())
    await expect(mobileTabs.nth(index)).toHaveAccessibleName(label);
  await expect(mobileNav.getByRole('button', { name: '我的', exact: true }).locator('.im-avatar')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('conversation')).toBeNull();
  await nav('联系人');
  await page.locator('.im-person-row').filter({ hasText: '同组的林同学' }).click();
  await expect(page.getByRole('heading', { name: '林同学', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.locator('.im-contact-list')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('contact')).toBeNull();
  await page.goForward();
  await expect(page.getByRole('heading', { name: '林同学', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回联系人列表', exact: true }).click();
  await expect(page.locator('.im-contact-list')).toBeVisible();
  await nav('消息');
  await expect(page.getByRole('heading', { name: '研究讨论组', exact: true })).toBeVisible();
  await expect(page.getByLabel('聊天消息')).toHaveValue('保留的草稿');
  await page.getByRole('button', { name: '聊天工具', exact: true }).click();
  await page.getByRole('dialog', { name: '聊天工具' }).getByRole('button', { name: '搜索聊天记录' }).click();
  const searchDialog = page.getByRole('dialog', { name: '搜索聊天记录' });
  await searchDialog.getByRole('textbox').fill('演示数据');
  await searchDialog.getByRole('button', { name: '搜索', exact: true }).click();
  await page.locator('.im-search-results>button').first().click();
  await expect(page.getByRole('dialog', { name: '消息详情' })).toBeVisible();
  await page.goBack();
  await expect(searchDialog).toBeVisible();
  await expect(page.getByRole('dialog', { name: '消息详情' })).toHaveCount(0);
  await page.goBack();
  await expect(searchDialog).toHaveCount(0);
  await expect(page.getByLabel('聊天消息')).toHaveValue('保留的草稿');
  await page.goBack();
  await expect(page.getByRole('navigation', { name: '主要功能' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('conversation')).toBeNull();
  expect(await page.evaluate(() => history.state?.pocketDepth)).toBe(0);
  await page.getByRole('button', { name: /研究讨论组/ }).click();
  await expect(page.getByLabel('聊天消息')).toHaveValue('保留的草稿');
  await page.getByLabel('聊天消息').fill('');
  await page.setViewportSize({ width: 320, height: 740 });
  await noOverflow();
  await page.screenshot({ path: out + '/mobile-320.png' });
  checks.mobileAndDraft = true;
  await page.setViewportSize({ width: 1487, height: 1058 });
  await nav('我的');
  await page.getByRole('button', { name: /个人资料/ }).click();
  await expect(page.getByLabel('UID', { exact: true })).toHaveText(registered.id);
  await expect(page.getByLabel('完整账号', { exact: true })).toHaveText(registered.address);
  await page.getByLabel('昵称', { exact: true }).fill('小青研究室');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  await page.screenshot({ path: out + '/desktop-account.png' });
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: /^登录与安全/ }).click();
  await page.getByRole('button', { name: /^密码与恢复码/ }).click();
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await page.getByLabel('当前密码', { exact: true }).fill('isolated-qa-password-123');
  await page.getByLabel('新密码', { exact: true }).fill('updated-qa-password-123');
  await page.getByLabel('确认新密码', { exact: true }).fill('updated-qa-password-123');
  await page.getByRole('button', { name: '更新密码', exact: true }).click();
  await saveRecoveryCode(page);
  await expect(page.getByRole('heading', { name: '密码与恢复码', exact: true })).toBeVisible();
  checks.accountSettings = true;
  await nav('我的');
  await page.getByRole('button', { name: /设置/ }).click();
  await page.getByRole('button', { name: /外观/ }).click();
  await page.getByLabel('深色', { exact: true }).check();
  await nav('消息');
  await page.getByRole('button', { name: /研究讨论组/ }).click();
  await expect(page.getByRole('log').getByText('收到，我会补充样本说明。', { exact: true })).toBeVisible();
  await page.screenshot({ path: out + '/desktop-dark.png' });
  await noOverflow();
  checks.darkTheme = true;
  await nav('我的');
  await page.getByRole('button', { name: /设置/ }).click();
  await page.getByRole('button', { name: /外观/ }).click();
  await page.getByLabel('浅色', { exact: true }).check();
  await nav('消息');
  await page.getByRole('button', { name: /研究讨论组/ }).click();

  // Shared image preview and byte-exact download use IM member authorization.
  const pic = new PNG({ width: 64, height: 48 });
  for (let i = 0; i < pic.data.length; i += 4) {
    pic.data[i] = 34;
    pic.data[i + 1] = 140;
    pic.data[i + 2] = 113;
    pic.data[i + 3] = 255;
  }
  const png = PNG.sync.write(pic);
  const fileReads = new Map();
  page.on('request', (request) => {
    const { pathname, searchParams } = new URL(request.url());
    if (pathname.includes('/files/') && !searchParams.has('meta') && request.method() === 'GET')
      fileReads.set(pathname, (fileReads.get(pathname) ?? 0) + 1);
  });
  const [uploadResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/im/conversations/${id}/files`,
    ),
    page
      .getByLabel('添加照片', { exact: true })
      .setInputFiles({ name: '演示图片.png', mimeType: 'application/octet-stream', buffer: png }),
  ]);
  expect(uploadResponse.ok()).toBe(true);
  const { file: uploadedImage } = await uploadResponse.json();
  const imagePath = new URL(uploadedImage.url, origin).pathname;
  await expect(page.locator('.im-compose-wrap img')).toBeVisible();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const image = page.locator('.im-message img[alt="演示图片.png"]');
  await expect(image).toBeVisible();
  await expect(page.getByRole('button', { name: '附件操作：演示图片.png', exact: true })).toHaveCount(0);
  await image.click();
  await expect(page.getByRole('button', { name: '关闭图片预览' })).toBeVisible();
  await expect(page.getByRole('button', { name: '下载图片', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭图片预览' }).click();
  const csv = page.locator('.im-message').filter({ hasText: '请整理这批演示数据，给出检查思路。' });
  await csv.getByRole('button', { name: '附件操作：计算结果.csv', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下载文件', exact: true }).click(),
  ]);
  expect(await readFile(await download.path(), 'utf8')).toBe(csvSource);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  checks.imageAndDownload = true;
  await image.evaluate((element) => element.decode());
  const downloadsBefore = fileReads.get(imagePath) ?? 0;
  expect(downloadsBefore).toBeGreaterThan(0);
  // A direct conversation link can render history before the conversation list arrives.
  const bootstrap = Promise.withResolvers();
  const bootstrapPath = '**/api/im/bootstrap';
  const holdBootstrap = async (route) => {
    await bootstrap.promise;
    await route.continue();
  };
  await page.route(bootstrapPath, holdBootstrap);
  try {
    const [authorization] = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === imagePath && url.searchParams.get('meta') === '1';
      }),
      page.reload(),
    ]);
    expect(authorization.ok()).toBe(true);
    await expect(image).toBeVisible();
    await image.evaluate((element) => element.decode());
    expect(fileReads.get(imagePath)).toBe(downloadsBefore);
  } finally {
    bootstrap.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
  checks.encryptedImageReload = true;
  await csv.getByRole('button', { name: '计算结果.csv 电子表格 · 预览', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '计算结果.csv', exact: true });
  const table = preview.getByRole('table', { name: '表格预览' });
  await expect(table.getByRole('cell', { name: 'demo_a', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '-0.31', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: 'demo_b, replicate', exact: true })).toBeVisible();
  await preview.screenshot({ path: `${out}/desktop-file-preview.png` });
  await preview.getByRole('button', { name: '查看原文', exact: true }).click();
  await expect(preview.locator('pre')).toContainText('demo_a,-0.31');
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  checks.textPreview = true;
  // Questions reuse the workspace answer panel; authorization remains recipient-scoped.
  const asked = (
    await api(
      `/conversations/${id}/messages`,
      'POST',
      {
        clientId: 'question-card',
        interaction: {
          kind: 'question',
          recipientId: registered.id,
          title: '确认交付方案',
          description: '请选择交付格式，并补充需要说明的事项。',
          questions: [
            {
              id: 'format',
              header: '格式',
              question: '希望使用哪种格式？',
              options: [
                { label: 'Markdown', description: '便于后续修改' },
                { label: 'PDF', description: '便于分享' },
              ],
            },
            { id: 'notes', header: '补充', question: '还有哪些要求？', options: [] },
          ],
        },
      },
      agent.token,
    )
  ).message;
  const questionCard = page.locator(`[data-message-id="${asked.id}"]`);
  await questionCard.getByRole('button', { name: '回答问题（2 题）' }).click();
  await page.getByRole('radio', { name: /Markdown/ }).check();
  await page.getByRole('button', { name: '下一题', exact: true }).click();
  await page.getByLabel('你的回答').fill('保留图表和来源说明');
  await page.getByRole('button', { name: '核对答案', exact: true }).click();
  await page.getByRole('button', { name: '提交全部回答（2 题）', exact: true }).click();
  await expect(questionCard).toContainText('已回答');
  const answered = (await api(`/conversations/${id}/messages/${asked.id}`, 'GET', undefined, agent.token))
    .message;
  expect(answered.interaction.response.answers).toEqual({
    format: ['Markdown'],
    notes: ['保留图表和来源说明'],
  });
  checks.questionCards = true;
  const approval = (
    await api(
      `/conversations/${id}/messages`,
      'POST',
      {
        clientId: 'approve-card',
        text: '导出研究摘要',
        interaction: {
          kind: 'approval',
          recipientId: registered.id,
          title: '导出研究摘要',
          description: '将已核对的摘要导出为 PDF 文件。本次仅创建附件，不修改原始研究数据。',
        },
      },
      agent.token,
    )
  ).message;
  const approvalTrigger = page.getByRole('button', { name: /^审批面板/ });
  const approvalPanel = page.getByRole('dialog', { name: '审批面板' });
  await expect(approvalTrigger).toHaveAccessibleName('审批面板，有待审批记录');
  const legacyReference = (
    await api(`/conversations/${id}/messages`, 'POST', {
      clientId: 'legacy-approval-reference', text: '历史消息引用审批', replyTo: approval.id,
    }, agent.token)
  ).message;
  const transcript = page.getByRole('log', { name: '聊天记录' });
  const approvalQuote = transcript.locator(`[data-message-id="${legacyReference.id}"]`)
    .getByRole('button', { name: '审批记录', exact: true });
  await expect(approvalQuote).toBeVisible();
  await expect(transcript).not.toContainText('导出研究摘要');

  const pendingApprovalRoute = new RegExp(`/api/im/conversations/${id}/approvals\\?status=pending$`);
  const unavailableApprovalPage = async (route) => route.fulfill({ status: 503,
    json: { error: '合成审批列表暂不可用' },
  });
  await page.route(pendingApprovalRoute, unavailableApprovalPage);
  await approvalQuote.click();
  await expect(approvalPanel.getByText('合成审批列表暂不可用')).toBeVisible();
  await expect(page.getByRole('dialog', { name: '消息详情' })).toHaveCount(0);
  await approvalPanel.getByRole('button', { name: /导出研究摘要/ }).click();
  await expect(approvalPanel.getByRole('button', { name: '允许本次', exact: true })).toHaveCount(0);
  await approvalPanel.getByRole('button', { name: '关闭', exact: true }).click();
  await page.unroute(pendingApprovalRoute, unavailableApprovalPage);

  const unverifiableApprovalPage = async (route) => route.fulfill({
    json: { messages: [{ ...approval, text: 'synthetic invalid ciphertext' }] },
  });
  await page.route(pendingApprovalRoute, unverifiableApprovalPage);
  await approvalQuote.click();
  await expect(approvalPanel.getByText('暂无待审批记录', { exact: true })).toBeVisible();
  await api(`/conversations/${id}/messages`, 'POST', {
    clientId: 'approval-cache-replay', text: '审批读取后收到普通消息',
  }, agent.token);
  await expect(transcript.getByText('审批读取后收到普通消息', { exact: true })).toHaveCount(1);
  await expect(approvalPanel.getByRole('button', { name: /导出研究摘要/ })).toHaveCount(0);
  await approvalPanel.getByRole('button', { name: '关闭', exact: true }).click();
  await page.unroute(pendingApprovalRoute, unverifiableApprovalPage);

  const declined = (
    await api(
      `/conversations/${id}/messages`,
      'POST',
      {
        clientId: 'decline-card',
        interaction: {
          kind: 'approval',
          recipientId: registered.id,
          title: '另一个操作',
          description: '请拒绝这项测试操作。',
        },
      },
      agent.token,
    )
  ).message;
  await approvalTrigger.click();
  await approvalPanel.getByRole('button', { name: /导出研究摘要/ }).click();
  await expect(approvalPanel.getByRole('button', { name: /另一个操作/ })).toBeVisible();
  await expect(approvalPanel.getByRole('region', { name: '审批详情' })).toContainText('本次仅创建附件');
  await page.screenshot({ path: out + '/desktop-approval-review.png' });
  await approvalPanel.getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(approvalPanel.getByRole('button', { name: '已处理', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(approvalPanel.getByRole('button', { name: /导出研究摘要.*已允许本次/ })).toBeVisible();
  expect(
    (await api(`/conversations/${id}/messages/${approval.id}`, 'GET', undefined, agent.token)).message
      .interaction.respondedBy,
  ).toBe(registered.id);
  await approvalPanel.getByRole('button', { name: '关闭', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 780 });
  await approvalTrigger.click();
  await approvalPanel.getByRole('button', { name: /另一个操作/ }).click();
  await expect(approvalPanel.getByRole('button', { name: '返回记录' })).toBeVisible();
  await noOverflow();
  await page.screenshot({ path: out + '/mobile-approval-review.png' });
  await approvalPanel.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(approvalPanel.getByRole('region', { name: '审批详情' })).toContainText('已拒绝');
  expect((await api(`/conversations/${id}/messages/${declined.id}`, 'GET', undefined, agent.token))
    .message.interaction.status).toBe('rejected');
  await approvalPanel.getByRole('button', { name: '关闭', exact: true }).click();
  await page.setViewportSize({ width: 1487, height: 1058 });
  await expect(page.locator(`[data-message-id="${declined.id}"]`)).toHaveCount(0);
  checks.approvals = true;
  await openChatMore(page, '发起交互请求');
  await page.getByLabel('请求标题').fill('补充信息');
  await page.getByLabel('问题说明').fill('请确认样本编号');
  await page.getByRole('button', { name: '发送请求', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '发起交互请求' })).toHaveCount(0);
  const humanCard = page.locator('.im-interaction').filter({ hasText: '补充信息' });
  await expect(humanCard).toContainText('等待 UID');
  await humanCard.getByRole('button', { name: '撤回请求' }).click();
  await expect(humanCard).toContainText('已撤回');
  checks.createAndWithdrawRequest = true;
  await page.getByLabel('聊天消息').fill('AB');
  await page.getByLabel('聊天消息').evaluate((el) => el.setSelectionRange(1, 1));
  const expressions = page.getByRole('button', { name: '表情与表情包', exact: true });
  await expressions.click();
  await expect(page.getByRole('region', { name: '表情与 Emoji' })).toBeVisible();
  expect(await page.locator('dialog[open]').count()).toBe(0);
  await page.getByLabel('聊天消息').click();
  await expect(page.getByRole('region', { name: '表情与 Emoji' })).toHaveCount(0);
  await page.getByLabel('聊天消息').evaluate((el) => el.setSelectionRange(1, 1));
  await expressions.click();
  await page.getByLabel('搜索 Emoji').fill('微笑');
  checks.nonModalEmojiPanel = true;
  await page.getByRole('button', { name: '微笑 😊', exact: true }).click();
  await expect(page.getByLabel('聊天消息')).toHaveValue('A😊B');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(friendPage.getByRole('log').getByText('A😊B', { exact: true })).toBeVisible();
  checks.emoji = true;
  const attemptedIds = [];
  const loseReceipt = async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attemptedIds.push(route.request().postDataJSON().clientId);
    if (attemptedIds.length === 1)
      return route.fulfill({ status: 503, json: { error: '测试网络中断' } });
    return route.continue();
  };
  await page.route(sendPath, loseReceipt);
  await composer.fill('需要核对的消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(outgoing.getByRole('alert')).toContainText('发送结果待确认');
  await composer.fill('重试时继续编辑');
  await outgoing.getByRole('button', { name: '重试', exact: true }).click();
  await expect(outgoing).toHaveCount(0);
  await expect(page.getByRole('log').getByText('需要核对的消息', { exact: true })).toHaveCount(1);
  expect(attemptedIds).toHaveLength(2);
  expect(attemptedIds[1]).toBe(attemptedIds[0]);
  await expect(composer).toHaveValue('重试时继续编辑');
  await composer.clear();
  await page.unroute(sendPath, loseReceipt);
  checks.sendingRetryReusesId = true;
  await page.getByRole('button', { name: '收藏表情 演示图片.png' }).click();
  await expressions.click();
  await page.getByRole('tab', { name: '收藏', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送表情 演示图片.png' })).toBeVisible();
  await page.getByLabel('导入表情包').setInputFiles({
    name: '挥手.gif',
    mimeType: 'image/gif',
    buffer: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
  });
  await expect(page.getByRole('button', { name: '发送表情 挥手.gif' })).toBeVisible();
  await page.getByRole('button', { name: '发送表情 挥手.gif' }).click();
  await expect(page.locator('.is-sticker img[alt="挥手.gif"]')).toBeVisible();
  await friendPage.locator('.is-sticker').last().scrollIntoViewIfNeeded();
  await expect(friendPage.locator('.is-sticker img[alt="挥手.gif"]')).toBeVisible();
  checks.stickerFavoritesAndGif = true;
  // The browser records its synthetic microphone through the real MediaRecorder API.
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await original(...args);
      window.__qaTracks = stream.getTracks();
      return stream;
    };
  });
  const voice = page.getByRole('button', { name: '语音消息', exact: true });
  await voice.click();
  await page.getByRole('button', { name: '也可以点击录音', exact: true }).click();
  await expect(page.locator('.im-voice-time')).toHaveText(/^0:0[2-9] \/ 2:00$/);
  await page.getByRole('button', { name: '停止录音', exact: true }).click();
  await expect(page.getByLabel('试听语音')).toBeVisible();
  expect(await page.evaluate(() => window.__qaTracks.every((t) => t.readyState === 'ended'))).toBe(true);
  await page.getByLabel('试听语音').evaluate((el) => el.play());
  await expect.poll(() => page.getByLabel('试听语音').evaluate((el) => el.currentTime)).toBeGreaterThan(0);
  await page.screenshot({ path: out + '/desktop-voice-preview.png' });
  await page.getByRole('button', { name: '发送语音', exact: true }).click();
  await expect(page.getByRole('region', { name: '语音消息' })).toHaveCount(0);
  await friendPage.locator('.im-message [data-media-type=audio]').last().scrollIntoViewIfNeeded();
  const audio = friendPage.locator('.im-message audio').last();
  await expect(audio).toBeVisible();
  await audio.evaluate((el) => el.play());
  await expect.poll(() => audio.evaluate((el) => el.currentTime)).toBeGreaterThan(0);
  checks.voiceRecordPreviewSendPlayback = true;
  await voice.click();
  await page.getByRole('button', { name: '也可以点击录音', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止录音' })).toBeVisible();
  await page
    .getByRole('region', { name: '语音消息' })
    .getByRole('button', { name: '关闭语音', exact: true })
    .click();
  expect(await page.evaluate(() => window.__qaTracks.every((t) => t.readyState === 'ended'))).toBe(true);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Denied for QA', 'NotAllowedError');
    };
  });
  await voice.click();
  await page.getByRole('button', { name: '也可以点击录音', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('麦克风权限未开启');
  await page
    .getByRole('region', { name: '语音消息' })
    .getByRole('button', { name: '关闭语音', exact: true })
    .click();
  checks.voiceCancelAndPermissionFailure = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await page.screenshot({ path: out + '/mobile-interactions.png' });
  await expressions.click();
  await noOverflow();
  await page.screenshot({ path: out + '/mobile-emoji.png' });
  await page.getByRole('tab', { name: '收藏', exact: true }).click();
  await noOverflow();
  await page.screenshot({ path: out + '/mobile-stickers.png' });
  await page
    .getByRole('region', { name: '表情与 Emoji' })
    .getByRole('button', { name: '关闭表情', exact: true })
    .click();
  await page.setViewportSize({ width: 320, height: 740 });
  await noOverflow();
  await expect(expressions).toBeVisible();
  await page.screenshot({ path: out + '/mobile-tools-320.png' });
  await page.setViewportSize({ width: 1487, height: 1058 });
  checks.mobileTools = true;

  // Offline gaps larger than one history page, followed by loading older messages.
  await context.setOffline(true);
  for (let i = 0; i < 65; i++)
    await api(
      `/conversations/${id}/messages`,
      'POST',
      { clientId: `offline-${suffix}-${i}`, text: `离线进度 ${i + 1}` },
      agent.token,
    );
  await context.setOffline(false);
  await expect(page.getByRole('log').getByText('离线进度 65', { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByRole('log').getByText('离线进度 1', { exact: true })).toHaveCount(1);
  checks.reconnect = true;
  // Keep the reconnect check above, then exercise manual pagination from a cold history cache.
  await page.evaluate(
    (key) => new Promise((resolve, reject) => {
      const open = indexedDB.open('pocket-im-history');
      open.onupgradeneeded = () => open.transaction.abort();
      open.onerror = () => (open.error?.name === 'AbortError' ? resolve() : reject(open.error));
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('latest', 'readwrite');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
        tx.objectStore('latest').delete(key);
      };
    }),
    `im-history:${registered.id}:${id}`,
  );
  await page.reload();
  await expect(page.getByRole('log').getByText('离线进度 65', { exact: true })).toBeVisible();
  const earliestOffline = page.getByRole('log').getByText('离线进度 1', { exact: true });
  const loadOlder = page.getByRole('button', { name: '加载更早消息', exact: true });
  await expect(loadOlder).toBeEnabled();
  await expect(earliestOffline).toHaveCount(0);
  await loadOlder.click();
  await expect(earliestOffline).toHaveCount(1);
  checks.historyPagination = true;
  await page.locator('.im-transcript').evaluate((el) => (el.scrollTop = 0));
  const scrollBefore = await page.locator('.im-transcript').evaluate((el) => el.scrollTop);
  const extraStream = (
    await api(
      `/conversations/${id}/messages`,
      'POST',
      { clientId: `scroll-stream-${suffix}`, state: 'streaming', text: 'scroll test' },
      agent.token,
    )
  ).message;
  await api(
    `/conversations/${id}/messages/${extraStream.id}`,
    'PATCH',
    { revision: 1, text: 'scroll test updated', state: 'complete' },
    agent.token,
  );
  await expect(page.getByRole('log').getByText('scroll test updated', { exact: true })).toHaveCount(1);
  expect(await page.locator('.im-transcript').evaluate((el) => el.scrollTop)).toBe(scrollBefore);
  const jump = page.getByRole('button', { name: '跳到最新消息', exact: true });
  await expect(jump).toBeVisible();
  await expect(jump).toHaveText('');
  expect(await jump.evaluate((button) => {
    const { width, height } = button.getBoundingClientRect();
    return width === height;
  })).toBe(true);
  await jump.click();
  await expect(jump).toHaveCount(0);
  checks.scrollStaysWhileReading = true;
  // The CLI exercises group mutation, files and ordered streaming against the same fixture.
  const credentials = join(state, 'agent.json');
  await writeFile(
    credentials,
    JSON.stringify({ origin, token: agent.token, user: agent.user, secrets: agent.secrets }),
    { mode: 0o600 },
  );
  const execute = promisify(execFile);
  async function cli(...args) {
    const { stdout } = await execute(process.execPath, [
      '--import',
      'tsx',
      'scripts/im-agent.ts',
      ...args,
      '--state',
      credentials,
    ]);
    expect(stdout).not.toContain(agent.token);
    return JSON.parse(stdout);
  }
  expect((await stat(credentials)).mode & 0o777).toBe(0o600);
  const cliGroup = (await cli('group', '--name', 'CLI 测试群', '--members', agent.owner.id)).conversation;
  await cli('group-update', '--conversation', cliGroup.id, '--name', 'CLI 已改名');
  const started = (await cli('stream-start', '--conversation', cliGroup.id, '--request-id', 'cli-stream'))
    .message;
  await cli(
    'stream-update',
    '--conversation',
    cliGroup.id,
    '--message',
    started.id,
    '--revision',
    '1',
    '--text',
    'CLI 回复',
    '--status',
    'complete',
  );
  expect((await cli('search', '--conversation', cliGroup.id, '--query', '回复')).messages).toHaveLength(1);
  const path = join(state, 'binary.dat');
  await writeFile(path, Buffer.from([0, 1, 2, 255]));
  const uploaded = (await cli('upload', '--conversation', cliGroup.id, '--file', path)).file;
  await cli('send', '--conversation', cliGroup.id, '--attachments', uploaded.id, '--request-id', 'cli-file');
  checks.cli = true;
  // Owner/member management is exercised through the rendered dialog.
  await page.getByRole('button', { name: '成员', exact: true }).click();
  await page.getByLabel('群名称', { exact: true }).fill('研究讨论组 · 已更新');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '研究讨论组 · 已更新', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '移除成员 林同学', exact: true }).click();
  await page
    .getByRole('dialog', { name: '移除成员', exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: '群资料与成员' }).locator('.im-member')).toHaveCount(2);
  await expect(
    friendPage.getByRole('log').getByText('收到，我会补充样本说明。', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('dialog', { name: '群资料与成员' }).getByRole('button', { name: '关闭' }).click();
  checks.groupRemove = true;
  await nav('联系人');
  await page.locator('.im-person-row').filter({ hasText: '同组的林同学' }).click();
  await page.getByRole('button', { name: '屏蔽私聊', exact: true }).click();
  await page
    .getByRole('dialog', { name: '屏蔽私聊' })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '发消息', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '解除屏蔽', exact: true }).click();
  await page
    .getByRole('dialog', { name: '解除屏蔽' })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '发消息', exact: true })).toBeEnabled();
  checks.contactBlock = true;
  otherTab = await context.newPage();
  await otherTab.goto(origin + '/?page=messages');
  await expect(otherTab.getByRole('button', { name: /研究讨论组/ })).toBeVisible();
  // Only this already authenticated device may read the code used after its deliberate logout.
  let loginCode = await humanAPI('/crypto/totp/display', 'POST', {});
  if (loginCode.expiresAt - Date.now() < 10000) {
    await new Promise((resolve) => setTimeout(resolve, loginCode.expiresAt - Date.now() + 120));
    loginCode = await humanAPI('/crypto/totp/display', 'POST', {});
  }
  await nav('我的');
  await page.getByRole('button', { name: /^设置/ }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(otherTab.getByRole('heading', { name: '登录子虚亭' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async (uid) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('pocket-im-media');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return await new Promise((resolve, reject) => {
          const request = db.transaction('blobs').objectStore('blobs').index('account').count(uid);
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
          request.onerror = () => reject(request.error);
        });
      }, registered.id),
    )
    .toBe(0);
  checks.logoutClearsPrivateImageCache = true;
  checks.crossTabLogout = true;
  await page.getByRole('button', { name: '使用账号密码', exact: true }).click();
  await page.getByLabel('UID 或用户名', { exact: true }).fill(registered.id);
  await page.getByLabel('密码', { exact: true }).fill('updated-qa-password-123');
  const passwordLogin = page.waitForResponse((response) => response.url().endsWith('/crypto/login'));
  await page.getByRole('button', { name: '登录账户', exact: true }).click();
  const pendingLogin = await (await passwordLogin).json();
  expect(!!pendingLogin.trustedLogin && !pendingLogin.vault).toBe(true);
  expect((await context.cookies()).some((cookie) => cookie.name === 'pocket_im_session')).toBe(false);
  await page.getByLabel('6 位登录动态码', { exact: true }).fill(loginCode.code);
  await page.getByRole('button', { name: '验证并继续', exact: true }).click();
  await expect(page.getByRole('button', { name: /研究讨论组/ }).first()).toBeVisible();
  checks.uidLogin = true;
  await otherTab.close();
  await friendContext.close();
  expect(errors).toEqual([]);
  await writeFile(out + '/result.json', JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (e) {
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  console.error(e);
  console.log(JSON.stringify({ checks, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await otherTab?.close().catch(() => {});
  await friendContext?.close().catch(() => {});
  await browser.close();
  await relay.app.close();
  await rm(state, { recursive: true, force: true });
}
