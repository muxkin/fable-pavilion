import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ControlAction, ControlCatalog } from '../../../src/shared/controls.js';
import type { DeviceLink } from '../../../src/shared/device-link.js';
import { apiCall } from '../../../src/shared/rpc.js';
import type { CodexDesktopFixture } from './codex-fixture.js';
import type { CodexGoalFixture } from './codex-goal-fixture.js';
import { waitFor } from './native-helpers.js';

export async function verifyCodexGoalLifecycle(
  session: DeviceLink,
  threadId: string,
  fixture: CodexGoalFixture,
  desktop: CodexDesktopFixture,
) {
  const path = `/threads/${threadId}`;
  const earlierMutations = fixture.mutations.length;
  const read = () => session.rpc<ControlCatalog>(apiCall(`${path}/controls`));
  const operation = (id: string) =>
    session.rpc<{ state: string; error?: string }>(apiCall(`/operations/${id}`));
  const submit = async (
    control: Extract<ControlAction, { action: 'goal' }>,
    expectedState: 'completed' | 'rejected' = 'completed',
  ) => {
    const requestId = crypto.randomUUID();
    const call = apiCall(`${path}/control`, 'POST', { requestId, control });
    await session.rpc(call);
    const result = await waitFor(async () => {
      const result = await operation(requestId);
      return ['completed', 'rejected', 'uncertain'].includes(result.state) ? result : undefined;
    }, `Codex goal ${control.operation} did not reach a final delivery state`);
    assert.equal(
      result.state,
      expectedState,
      `Codex goal ${control.operation}: ${result.error ?? result.state}`,
    );
    return { call, requestId };
  };
  const goalAt = (phase: string) =>
    waitFor(async () => {
      const { goal } = await read();
      return goal?.phase === phase ? goal : undefined;
    }, `Codex goal did not reach ${phase}`);

  const initial = await waitFor(async () => {
    const catalog = await read();
    return catalog.actions.includes('goal') ? catalog : undefined;
  }, 'Codex goal controls were not advertised for a writable live conversation');
  assert.equal(initial.goal, null);

  const objective = '验证长期目标在加密会话中往返';
  const original = await submit({ action: 'goal', operation: 'create', objective });
  const created = await goalAt('active');
  assert.equal(created.objective, objective);

  await submit({ action: 'goal', operation: 'pause', ref: created.ref });
  const paused = await goalAt('paused');
  assert.notDeepEqual(paused.ref, created.ref);
  await session.rpc(original.call);
  assert.equal((await operation(original.requestId)).state, 'completed');
  assert.deepEqual((await goalAt('paused')).ref, paused.ref);
  await submit({ action: 'goal', operation: 'clear', ref: created.ref }, 'rejected');

  fixture.account(125, 8);
  const accounted = await waitFor(async () => {
    const { goal } = await read();
    return goal?.tokensUsed === 125 ? goal : undefined;
  }, 'Codex goal accounting did not update');
  assert.equal(accounted.timeUsedSeconds, 8);
  assert.deepEqual(accounted.ref, paused.ref);

  const newObjective = '核对修改后的目标与暂停状态';
  await submit({ action: 'goal', operation: 'edit', ref: paused.ref, objective: newObjective });
  const edited = await waitFor(async () => {
    const { goal } = await read();
    return goal?.objective === newObjective ? goal : undefined;
  }, 'Codex goal text was not updated');
  assert.equal(edited.phase, 'paused');

  desktop.setGoalSnapshot(fixture.snapshot());
  fixture.setOwnerPresent(false);
  try {
    const fallback = await waitFor(async () => {
      const catalog = await read();
      return catalog.goal?.objective === newObjective ? catalog : undefined;
    }, 'Codex did not expose the read-only desktop goal snapshot');
    assert(
      !fallback.actions.includes('goal'),
      'Codex advertised writes through a daemon without this thread',
    );
    assert.equal(fallback.goal?.phase, 'paused');
    assert.equal(fallback.state.goalRevision, fallback.goal?.ref.revision);
    await submit({ action: 'goal', operation: 'resume', ref: edited.ref }, 'rejected');
  } finally {
    fixture.setOwnerPresent(true);
    desktop.setGoalSnapshot(undefined);
  }
  fixture.setHomeMatches(false);
  try {
    assert(!(await read()).actions.includes('goal'), 'Codex advertised writes through another account home');
    await submit({ action: 'goal', operation: 'resume', ref: edited.ref }, 'rejected');
  } finally {
    fixture.setHomeMatches(true);
  }
  await submit({ action: 'goal', operation: 'resume', ref: edited.ref });
  const resumed = await goalAt('active');
  await submit({ action: 'goal', operation: 'complete', ref: resumed.ref });
  const completed = await goalAt('complete');
  await submit({ action: 'goal', operation: 'clear', ref: completed.ref });
  await waitFor(async () => (await read()).goal === null, 'Codex goal did not clear');
  const mutations = fixture.mutations.slice(earlierMutations);
  const set = (change: Record<string, unknown>) => ({
    method: 'thread/goal/set',
    params: { threadId, origin: 'user', ...change },
  });
  assert.deepEqual(mutations, [
    set({ objective, status: 'active' }),
    set({ status: 'paused' }),
    set({ objective: newObjective }),
    set({ status: 'active' }),
    set({ status: 'complete' }),
    { method: 'thread/goal/clear', params: { threadId, origin: 'user' } },
  ]);
  console.log(
    'Native Codex goals verified lifecycle, stale references, and encrypted operation deduplication.',
  );
}

export async function verifyCodexGoalUi(page: import('@playwright/test').Page) {
  const { expect } = await import('@playwright/test');
  const objective = '通过浏览器验证工作台目标';
  const summary = page.getByRole('button', { name: '管理目标', exact: true });
  await page.getByRole('button', { name: '工具', exact: true }).click();
  await page.getByRole('button', { name: '目标', exact: true }).click();
  const input = page.getByLabel('目标内容', { exact: true });
  await expect(input).toBeEditable();
  await input.fill(objective);
  await page.getByRole('button', { name: '创建目标', exact: true }).click();
  await expect(summary).toContainText(objective);
  await expect(summary).toContainText('进行中');
  await page.keyboard.press('Escape');
  const output = process.env.POCKET_NATIVE_TEST_BROWSER_MEDIA_DIR ?? process.env.TEST_OUTPUT;
  const viewport = page.viewportSize();
  if (output && viewport) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, 'codex-goal-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(summary).toBeVisible();
    await page.screenshot({ path: join(output, 'codex-goal-desktop.png') });
    await page.setViewportSize(viewport);
  }
  await summary.click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(summary).toContainText('已暂停');
  if (output) await page.screenshot({ path: join(output, 'codex-goal-panel.png') });
  await page.getByRole('button', { name: '清除', exact: true }).click();
  await page.getByRole('button', { name: '确认清除', exact: true }).click();
  await expect(summary).toHaveCount(0);
  await page.keyboard.press('Escape');
  console.log('Chromium created, paused and cleared a goal through the native Codex plugin.');
}
