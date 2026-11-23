import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import type { DeviceLink } from '../../../src/shared/device-link.js';
import { apiCall } from '../../../src/shared/rpc.js';
import type { Operation } from '../../../src/shared/types.js';
import { MODERN_CODEX, type ModernCodexFixture } from './codex-modern-fixture.js';
import { waitFor } from './native-helpers.js';

export async function verifyModernCodexRpc(
  session: DeviceLink,
  threadId: string,
  fixture: ModernCodexFixture,
) {
  const backendId = MODERN_CODEX.id;
  const rpc = (path: string, method = 'GET', body?: unknown) => ({
    ...apiCall(path, method, body),
    backendId,
  });
  const path = `/threads/${threadId}`;
  const currentOperation = (requestId: string) => session.rpc<Operation>(rpc(`/operations/${requestId}`));
  const submit = async (
    suffix: string,
    body: Record<string, unknown>,
    expected: 'completed' | 'rejected' | 'uncertain',
  ) => {
    const requestId = crypto.randomUUID();
    const call = rpc(`${path}/${suffix}`, 'POST', { requestId, ...body });
    await session.rpc(call);
    const operation = await waitFor(async () => {
      const observed = await currentOperation(requestId);
      return ['completed', 'rejected', 'uncertain'].includes(observed.state) ? observed : undefined;
    }, `Codex app-tools operation ${suffix} did not settle`);
    assert.equal(operation.state, expected, operation.error ?? operation.state);
    return call;
  };
  let view:
    | {
        owner: boolean;
        synchronized: boolean;
        runtimeStatus: string;
        canSend: boolean;
        canResumeForSend?: boolean;
        textOnlySend?: boolean;
      }
    | undefined;
  const renderedInputs = new Set<string>();
  const unsubscribe = session.onEvent((event) => {
    if (event.type !== 'sync' || event.backendId !== backendId) return;
    const update = event.updates[0];
    view = update?.thread;
    for (const message of update?.changed ?? [])
      if (message.role === 'user') renderedInputs.add(message.text);
  });
  const status = () =>
    session.rpc<{
      desktopIpcConnected: boolean;
      writesEnabled: boolean;
      capabilities: { openThread: boolean; send: boolean; steer: boolean; interrupt: boolean };
    }>(rpc('/status'));
  try {
    fixture.setStatus('notLoaded');
    const existingSends = fixture.sends.length;
    const cold = await waitFor(async () => {
      const current = await status();
      return current.capabilities.openThread ? current : undefined;
    }, 'Codex did not advertise historical resume through app tools');
    assert.equal(cold.desktopIpcConnected, false);
    assert.equal(cold.writesEnabled, true);
    assert.equal(cold.capabilities.send, false);
    await session.request('watch', { threadId, backendId });
    const historical = await waitFor(
      () => (view?.canResumeForSend ? view : undefined),
      'Codex did not project the modern historical conversation',
    );
    assert.equal(historical.runtimeStatus, 'notLoaded');
    assert.equal(historical.owner, false);
    assert.equal(historical.synchronized, true);
    assert.equal(historical.canSend, true);
    assert.equal(historical.textOnlySend, true);
    const ready = await waitFor(async () => {
      const current = await status();
      return current.capabilities.send ? current : undefined;
    }, 'Codex did not advertise send after verifying the historical conversation');
    assert.equal(ready.capabilities.steer, false);
    assert.equal(ready.capabilities.interrupt, false);

    await submit('open', {}, 'completed');
    assert.equal(fixture.navCalls.length, 0, 'Modern app tools required desktop navigation');
    const text = '新版 Codex 加密发送验收';
    const send = await submit('messages', { text }, 'completed');
    await session.rpc(send);
    assert.equal(fixture.sends.length, existingSends + 1, 'Stable request replay duplicated a Desktop send');
    assert.equal(fixture.sends.at(-1)?.prompt, text);
    assert.equal(fixture.sends.at(-1)?.callId, `pocket-${(send.body as { requestId: string }).requestId}`);
    await waitFor(
      () => renderedInputs.has(text),
      'Codex delegated send was not rendered as the user message',
    );

    fixture.setStatus('active');
    await submit('messages', { text: '运行中的会话拒绝发送' }, 'rejected');
    assert.equal(fixture.sends.length, existingSends + 1);
    fixture.setStatus('idle');
    const idle = await waitFor(
      () => (view?.runtimeStatus === 'idle' && view.canSend ? view : undefined),
      'Codex conversation did not return to idle',
    );
    assert.equal(idle.owner, false);
    fixture.mismatchNextAcknowledgement();
    const uncertain = await submit('messages', { text: '目标不匹配的回执待核对' }, 'uncertain');
    await session.rpc(uncertain);
    assert.equal(fixture.sends.length, existingSends + 2, 'Uncertain app-tools send was repeated');
    console.log(
      'Native Codex app-tools fallback sent once without follower IPC and rejected an active thread.',
    );
  } finally {
    await session.request('unwatch', { threadId, backendId }).catch(() => {});
    unsubscribe();
  }
}

export async function verifyModernCodexBrowser(
  page: Page,
  options: {
    origin: string;
    hostPeerId: string;
    threadId: string;
    fixture: ModernCodexFixture;
  },
) {
  const { expect } = await import('@playwright/test');
  const { origin, hostPeerId, threadId, fixture } = options;
  const query = new URLSearchParams({
    page: 'workbench',
    host: hostPeerId,
    backend: MODERN_CODEX.id,
    thread: threadId,
  });
  fixture.setStatus('notLoaded');
  const existingSends = fixture.sends.length;
  await page.goto(`${origin}/?${query}`);
  const compose = page.getByLabel('消息', { exact: true });
  const text = '从新版 Codex 历史会话直接发送';
  await expect(compose).toBeEnabled({ timeout: 20_000 });
  await compose.fill(text);
  await page.locator('.composer .send-button').click();
  await expect.poll(() => fixture.sends.length, { timeout: 20_000 }).toBe(existingSends + 1);
  await expect(compose).toHaveValue('');
  await expect(page.locator('.transcript').getByText(text, { exact: true })).toBeVisible();
  assert.equal(fixture.sends.at(-1)?.prompt, text);
  assert.equal(fixture.navCalls.length, 0);
  console.log('Chromium sent to a historical Codex conversation using only verified desktop app tools.');
}
