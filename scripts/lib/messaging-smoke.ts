/** Synthetic browser fixtures use the same encrypted client as the application. */
import { createServer } from 'node:net';
import { once } from 'node:events';
import { expect, type Page } from '@playwright/test';
import { EncryptedMessagingClient } from '../../src/client/encrypted-messaging.js';
import { protectAccount, unlockAccount } from '../../src/shared/account-crypto.js';
import type { ChatUser, SendMessageOptions, MessageState } from '../../src/shared/messaging.js';

export async function allocateLocalPort(host = '127.0.0.1', explicit = process.env.TEST_PORT): Promise<number> {
  if (explicit && Number(explicit) > 0) return Number(explicit);
  const probe = createServer();
  probe.listen(0, host);
  await once(probe, 'listening');
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!port) throw Error(`Failed to allocate ephemeral port on ${host}`);
  return port;
}

export async function saveRecoveryCode(page: Page) {
  const backup = page.getByRole('heading', { name: /保存(账号)?恢复码/ });
  await expect(backup).toBeVisible();
  await page.getByLabel('我已安全保存恢复码').check();
  await page.getByRole('button', { name: /^(继续|保存后继续)$/ }).click();
  // Saving to known adapters is asynchronous. Wait for the backup step to finish
  // before distinguishing a completed one-step flow from the optional next step.
  await expect(backup).not.toBeVisible();
  const authenticator = page.getByRole('heading', { name: '添加身份验证器', exact: true });
  if (await authenticator.isVisible()) {
    await page.getByRole('button', { name: '暂时跳过，使用内置动态码', exact: true }).click();
    await expect(authenticator).not.toBeVisible();
  }
}

export async function registerWorkbenchFixture(page: Page, origin: string) {
  await page.goto(`${origin}/?page=messages`);
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.getByLabel('昵称', { exact: true }).fill('工作台自动验收');
  await page.getByLabel('用户名', { exact: true }).fill('workbench-fixture');
  await page.getByLabel('密码', { exact: true }).fill('workbench-fixture-password');
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await saveRecoveryCode(page);
  await expect(page.getByText('还没有聊天记录')).toBeVisible();
}

export async function openChatMore(page: Page, item: '发起交互请求') {
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  await page
    .getByRole('menu', { name: '更多功能' })
    .getByRole('menuitem', { name: item, exact: true })
    .click();
}

export async function registerAgentFixture(
  origin: string,
  registration: { invitation: string; username: string; displayName: string },
) {
  const protectedAccount = await protectAccount('synthetic-agent-fixture-password');
  const result = await new EncryptedMessagingClient(origin).raw<{
    user: ChatUser;
    owner: ChatUser;
    token: string;
  }>('/agents/register', 'POST', { ...registration, vault: protectedAccount.vault });
  const client = new EncryptedMessagingClient(origin, result.token);
  client.account.activate(result.user, protectedAccount.secrets, protectedAccount.vault);
  return { ...result, client, secrets: protectedAccount.secrets };
}

export async function browserAccountFixture(page: Page, origin: string, password: string) {
  const cookie = (await page.context().cookies(`${origin}/api/im`)).find(
    (c) => c.name === 'pocket_im_session',
  );
  if (!cookie) throw Error('Synthetic browser account is not signed in');
  const client = new EncryptedMessagingClient(origin, cookie.value);
  const { user } = await client.raw<{ user: ChatUser }>('/me');
  const { vault, revision } = await client.raw<{
    vault: Parameters<typeof unlockAccount>[0];
    revision: number;
  }>('/crypto/account');
  const { secrets } = await unlockAccount(vault, password);
  client.account.activate(user, secrets, vault, revision);
  await client.account.refreshItems();
  return client;
}

export function messagingFixtureRequest(
  client: EncryptedMessagingClient,
  path: string,
  method = 'GET',
  body?: Record<string, unknown>,
) {
  const message = /^\/conversations\/([^/]+)\/messages(?:\/([^/]+))?$/.exec(path);
  if (message && method === 'POST' && !message[2]) {
    const { text = '', clientId, ...options } = body!;
    return client.send(message[1], String(text), String(clientId), options as SendMessageOptions);
  }
  if (message && method === 'PATCH' && message[2]) {
    const { revision, text, state, activities } = body!;
    return client.updateMessage(
      message[1],
      message[2],
      Number(revision),
      String(text),
      state as MessageState,
      activities as Parameters<EncryptedMessagingClient['updateMessage']>[5],
    );
  }
  return client.request(path, method, body);
}
