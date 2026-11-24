import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { saveRecoveryCode } from '../../lib/messaging-smoke.js';
import {
  ANTIGRAVITY_FIXTURE_CONSTANTS,
  type AntigravityFixture,
} from './antigravity-fixture.js';
import { stopChild, waitFor } from './native-helpers.js';

export interface AntigravityBrowserOptions {
  channel: 'msedge' | 'chrome';
  origin: string;
  host: string;
  pairingCode: string;
  fixture: AntigravityFixture;
  oldGateway: boolean;
  legacyQuestions: boolean;
  legacyHistory: boolean;
  recoverRenderer: boolean;
}

export async function testAntigravityBrowserSwitching(options: AntigravityBrowserOptions) {
  const {
    channel,
    origin,
    host,
    pairingCode,
    fixture,
    oldGateway,
    legacyQuestions,
    legacyHistory,
    recoverRenderer,
  } = options;
  const {
    backendId,
    threadId,
    switchId,
    initialTitle,
    switchTitle,
    recoveredAnswerMarker,
    fixtureImage,
    nativePlugin,
    extraQuestionOptions,
  } = ANTIGRAVITY_FIXTURE_CONSTANTS;

  const { chromium, expect } = await import('@playwright/test');
  const headed = process.env.POCKET_NATIVE_TEST_BROWSER_HEADED === '1';
  const browser = await chromium.launch({
    channel,
    headless: !headed,
    args: headed ? ['--window-size=3840,2160'] : [],
  });
  let page: import('@playwright/test').Page | undefined;
  try {
    page = await browser.newPage({ viewport: { width: 3680, height: 2000 }, locale: 'zh-CN' });
    await page.addInitScript({
      content: `
        (() => {
          const sockets = [];
          const Socket = window.WebSocket;
          window.closeSyntheticControlLinks = () => {
            for (const socket of sockets) socket.close();
          };
          window.WebSocket = class extends Socket {
            constructor(url, protocols) {
              super(url, protocols);
              if (new URL(url, location.href).pathname === '/connect') sockets.push(this);
            }
          };
        })();
      `,
    });
    const errors: Error[] = [];
    let crashed = false;
    page.on('pageerror', (error) => errors.push(error));
    page.on('crash', () => {
      crashed = true;
    });
    await page.goto(`${origin}/?page=messages`);
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    await page.getByLabel('昵称', { exact: true }).fill('Antigravity 验收');
    await page.getByLabel('用户名', { exact: true }).fill('antigravity-fixture');
    await page.getByLabel('密码', { exact: true }).fill('fixture-antigravity-password');
    await page.getByRole('button', { name: '创建账户', exact: true }).click();
    await saveRecoveryCode(page);
    await expect(page.getByText('还没有聊天记录')).toBeVisible();
    await page.goto(`${origin}/#pair=${pairingCode}&host=${host}`);
    await page.getByRole('button', { name: '连接电脑', exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('page') === 'workbench' && !url.hash);
    await page.goto(`${origin}/?page=workbench&backend=${backendId}&thread=${threadId}`);
    await page.getByRole('tab', { name: '最近', exact: true }).click();
    const transcript = page.getByRole('region', { name: '聊天记录' });
    const sparseMarker = transcript.getByText('fixture answer', { exact: true });
    const denseMarker = transcript.getByText('Synthetic history marker.', { exact: true });
    const sparseThread = page.getByRole('button', { name: new RegExp(initialTitle) });
    await expect(sparseMarker).toBeVisible({ timeout: 15000 });
    if (!oldGateway) {
      const permission = page.getByRole('button', { name: '会话权限', exact: true });
      await expect(permission).toHaveAttribute('title', /逐次审批/);
      await permission.click();
      const review = page.getByRole('menuitemradio', { name: /^逐次审批/ });
      const turbo = page.getByRole('menuitemradio', { name: /^Turbo/ });
      await expect(review).toHaveAttribute('aria-checked', 'true');
      await turbo.click();
      await expect(permission).toHaveAttribute('title', /Turbo/);
      await expect.poll(() => fixture.calls.permissionUpdates.length).toBe(1);
      await permission.click();
      await expect(turbo).toHaveAttribute('aria-checked', 'true');
      await review.click();
      await expect(permission).toHaveAttribute('title', /逐次审批/);
      await expect.poll(() => fixture.calls.permissionUpdates.length).toBe(2);
      assert(fixture.calls.permissionUpdates.every((update) => update.threadId === threadId));
    }
    fixture.failHistory(switchId);
    const denseThread = page.getByRole('button', { name: new RegExp(switchTitle) });
    await denseThread.click();
    const retry = transcript.getByRole('button', { name: '重新加载会话', exact: true });
    await expect(retry).toBeVisible({ timeout: 22000 });
    await expect(sparseMarker).toHaveCount(0);
    await retry.click();
    await expect(transcript.getByText('正在读取会话…', { exact: true })).toBeVisible();
    fixture.failHistory(undefined);
    await expect(denseMarker).toBeVisible({ timeout: 15000 });
    await sparseThread.click();
    await expect(sparseMarker).toBeVisible({ timeout: 15000 });
    for (let index = 0; index < 24; index++) {
      const dense = index % 2 === 0;
      await (dense ? denseThread : sparseThread).click();
      await page.waitForURL((url) => url.searchParams.get('thread') === (dense ? switchId : threadId));
      await expect(dense ? denseMarker : sparseMarker).toBeVisible({ timeout: 15000 });
      await expect(dense ? sparseMarker : denseMarker).toHaveCount(0);
      if (dense && index >= 12) {
        const tool = transcript.locator('.activity-group').last();
        await tool.locator('summary').click();
        await expect(tool.locator('.activity-body')).toBeVisible();
      }
    }
    await denseThread.click();
    await expect(denseMarker).toBeVisible({ timeout: 15000 });
    await page.reload();
    await page.getByRole('tab', { name: '最近', exact: true }).click();
    await expect(denseMarker).toBeVisible({ timeout: 15000 });
    const staleMarker = 'Synthetic delayed history from the other conversation.';
    const currentMarker = 'Synthetic history update after rapid switching.';
    const heldHistory = fixture.holdNextHistory(threadId, staleMarker);
    try {
      await sparseThread.click();
      await page.waitForURL((url) => url.searchParams.get('thread') === threadId);
      await expect.poll(() => heldHistory.started, { timeout: 15000 }).toBe(true);
      await denseThread.click();
      await page.waitForURL((url) => url.searchParams.get('thread') === switchId);
      await expect(denseMarker).toBeVisible({ timeout: 15000 });
    } finally {
      heldHistory.release();
    }
    await expect.poll(() => heldHistory.replied, { timeout: 15000 }).toBe(true);
    fixture.appendHistoryMarker(switchId, currentMarker);
    await expect(transcript.getByText(currentMarker, { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(transcript.getByText(staleMarker, { exact: true })).toHaveCount(0);
    await expect(sparseMarker).toHaveCount(0);
    assert.equal(new URL(page.url()).searchParams.get('thread'), switchId);
    assert.equal(crashed, false, 'Browser renderer crashed after rapid Antigravity session switching');
    await sparseThread.click();
    await expect(sparseMarker).toBeVisible({ timeout: 15000 });

    const pagedRow = (index: number) =>
      transcript.getByText(`Synthetic paged record ${index}.`, { exact: true });
    fixture.beginPagedHistory();
    await denseThread.click();
    await expect(pagedRow(159)).toBeVisible({ timeout: 15000 });
    await expect(pagedRow(59)).toHaveCount(0);
    const older = transcript.getByRole('button', { name: '更早记录', exact: true });
    await older.click();
    await expect(pagedRow(0)).toBeVisible();
    await expect(older).toHaveCount(0);
    fixture.advancePagedHistory(1);
    await expect(pagedRow(160)).toBeVisible();
    await expect(pagedRow(60)).toHaveCount(1);
    await expect(pagedRow(110)).toHaveCount(1);
    for (const last of [190, 220]) {
      fixture.advancePagedHistory(30);
      await expect(pagedRow(last)).toBeVisible();
    }
    const pagedRecords = transcript.getByText(/^Synthetic paged record \d+\.$/);
    await expect(pagedRecords).toHaveText(
      Array.from({ length: 221 }, (_, index) => `Synthetic paged record ${index}.`),
    );
    fixture.advancePagedHistory(65);
    await expect(pagedRow(285)).toBeVisible();
    await expect(pagedRow(170)).toHaveCount(legacyHistory ? 0 : 1);
    await expect(pagedRow(220)).toHaveCount(legacyHistory ? 0 : 1);
    await expect(pagedRow(221)).toHaveCount(0);
    if (!legacyHistory) {
      const network = page.getByRole('button', { name: /^网络连接 · / });
      await page.context().setOffline(true);
      try {
        await page.evaluate(() => {
          const close = (window as Window & { closeSyntheticControlLinks?: () => void }).closeSyntheticControlLinks;
          if (!close) throw new Error('Synthetic WebSocket hooks missing');
          close();
        });
        await expect(network).toHaveAttribute('data-quality', 'offline', { timeout: 15000 });
        await older.click();
        await expect(older).toBeEnabled();
        await expect(pagedRow(170)).toHaveCount(1);
        await expect(pagedRow(220)).toHaveCount(1);
      } finally {
        await page.context().setOffline(false);
        await page.evaluate(() => {
          window.dispatchEvent(new Event('online'));
          window.dispatchEvent(new Event('pageshow'));
        });
      }
      await expect(network).toHaveAttribute('data-quality', /^(relay|poor)$/, { timeout: 20000 });
    }
    for (const first of legacyHistory ? [136, 36, 0] : [221]) {
      await older.click();
      await expect(pagedRow(first)).toBeVisible();
    }
    await expect(pagedRecords).toHaveText(
      Array.from({ length: 286 }, (_, index) => `Synthetic paged record ${index}.`),
    );
    async function fillQuestions() {
      const activePage = page!;
      await activePage.getByRole('button', { name: '回答问题（3 题）' }).click();
      if (legacyQuestions) {
        await activePage.getByRole('radio', { name: '红', exact: true }).check();
      } else {
        await activePage.getByRole('radio', { name: '自行填写', exact: true }).check();
        await activePage.getByRole('textbox', { name: '你的回答', exact: true }).fill('红');
      }
      await activePage.getByRole('button', { name: '下一题' }).click();
      await activePage.getByRole('checkbox', { name: '甲', exact: true }).check();
      await activePage.getByRole('checkbox', { name: '乙', exact: true }).check();
      if (!legacyQuestions) {
        for (const { text } of extraQuestionOptions) {
          await activePage.getByRole('checkbox', { name: text, exact: true }).check();
        }
      }
      await activePage.getByRole('button', { name: '下一题' }).click();
      await activePage.getByRole('textbox', { name: '你的回答', exact: true }).fill('补充内容');
      await activePage.getByRole('button', { name: '核对答案' }).click();
      return activePage.getByRole('button', { name: '提交全部回答（3 题）' });
    }
    if (!legacyHistory) {
      const replacementRow = (index: number) =>
        transcript.getByText(`Synthetic replacement record ${index}.`, { exact: true });
      fixture.replacePagedHistory();
      await expect(replacementRow(285)).toBeVisible();
      await expect(pagedRecords).toHaveCount(0);
      await older.click();
      await expect(replacementRow(136)).toBeVisible();
      fixture.rewindPagedHistory(240);
      await expect(transcript.getByText('Synthetic rewind marker.', { exact: true })).toBeVisible();
      await expect(replacementRow(136)).toHaveCount(0);
      await expect(replacementRow(285)).toHaveCount(0);
      await expect(older).toBeVisible();
      if (!legacyQuestions) {
        await older.click();
        await expect(replacementRow(90)).toBeVisible();
        fixture.askQuestion(true, switchId);
        const answer = await fillQuestions();
        await expect(answer).toBeEnabled();
        const previousAnswers = fixture.calls.answer;
        fixture.failPagedHistory(true);
        try {
          await expect(answer).toBeDisabled();
        } finally {
          fixture.failPagedHistory(false);
        }
        await expect(answer).toBeEnabled();
        await answer.click();
        try {
          await expect.poll(() => fixture.calls.answer).toBe(previousAnswers + 1);
        } catch (error) {
          console.error('Synthetic bounded answer status:', {
            feedback: await page.locator('.question-feedback').allTextContents(),
            alerts: await page.getByRole('alert').allTextContents(),
            fixtureErrors: fixture.errors,
          });
          throw error;
        }
        await expect(transcript.getByText('fixture continued after answer', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: '回答问题（3 题）' })).toHaveCount(0);
        await expect(replacementRow(90)).toHaveCount(1);
      }
    }
    await page.getByRole('button', { name: new RegExp(initialTitle) }).click();
    await expect(sparseMarker).toBeVisible({ timeout: 15000 });
    await expect(pagedRow(160)).toHaveCount(0);
    await page.reload();
    await expect(sparseMarker).toBeVisible({ timeout: 15000 });
    fixture.askQuestion(!legacyQuestions);
    await (await fillQuestions()).click();
    await expect(transcript.getByText('fixture continued after answer', { exact: true })).toBeVisible();
    if (!oldGateway) {
      const picker = page.getByRole('button', { name: '选择下一条消息的模型' });
      await picker.click();
      await page.getByRole('button', { name: '选择模型', exact: true }).click();
      await page.getByRole('radio', { name: /Fixture next model/ }).click();
      await page.getByRole('button', { name: '用于下一条消息' }).click();
      await expect(picker).toHaveText('Fixture next model');
      await page.reload();
      await expect(transcript.getByText('fixture continued after answer', { exact: true })).toBeVisible();
      await expect(picker).toHaveText('Fixture next model');
    }

    await expect(page.getByLabel('添加附件', { exact: true })).toBeEnabled({ timeout: 20000 });
    const photoInput = page.getByLabel('添加照片', { exact: true });
    await expect(photoInput).toBeEnabled({ timeout: 20000 });
    await page.getByRole('button', { name: '工具', exact: true }).click();
    await page.getByRole('button', { name: '插件', exact: true }).click();
    await page.getByRole('checkbox', { name: new RegExp(nativePlugin.displayName) }).check();
    await page.getByRole('button', { name: '添加到消息', exact: true }).click();
    await expect(page.getByRole('button', { name: `移除插件 ${nativePlugin.displayName}` })).toBeVisible();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('Fixture browser plugin and photo');
    await photoInput.setInputFiles({
      name: 'browser-fixture.png',
      mimeType: 'application/octet-stream',
      buffer: fixtureImage,
    });
    try {
      await expect(page.locator('.composer-attachments').getByText('browser-fixture.png', { exact: true })).toBeVisible(
        { timeout: 20000 },
      );
      await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
    } catch (error) {
      console.error('Synthetic photo upload status:', await page.locator('.upload-progress-panel').allTextContents());
      throw error;
    }
    const image = transcript.getByRole('img', { name: 'browser-fixture.png' });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
    await expect(page.getByRole('button', { name: /^移除下一条消息的模型/ })).toHaveCount(0);
    fixture.startQueueTurn();
    const composer = page.getByRole('textbox', { name: '消息', exact: true });
    const appended = 'Fixture browser appendix';
    await composer.fill(appended);
    await page.getByRole('button', { name: '追加指令 ↑', exact: true }).click();
    await expect(transcript.getByText(appended, { exact: true })).toBeVisible();
    fixture.startQueueTurn();
    await expect(page.getByRole('button', { name: '中断任务', exact: true })).toBeEnabled();
    const queuedText = 'Fixture browser queue text';
    await composer.fill(queuedText);
    await page.getByRole('button', { name: '排队', exact: true }).click();
    await page.getByRole('button', { name: '会话工具', exact: true }).click();
    const toolDialog = page.getByRole('dialog', { name: '会话工具' });
    await expect(toolDialog.getByText(queuedText, { exact: true })).toBeVisible();
    await toolDialog.getByRole('button', { name: '移除', exact: true }).click();
    await expect(toolDialog.getByText(queuedText, { exact: true })).toHaveCount(0);
    assert.equal(crashed, false, 'Browser renderer crashed while using Antigravity');
    assert.deepEqual(errors, [], 'Antigravity workbench raised page errors');

    if (recoverRenderer) {
      await page.keyboard.press('Escape');
      await page.getByRole('tab', { name: '最近', exact: true }).click();
      fixture.beginPagedHistory();
      await denseThread.click();
      await page.waitForURL((url) => url.searchParams.get('thread') === switchId);
      const beforeCrash = 'Synthetic marker before renderer loss.';
      const updateWhileDown = 'Synthetic update during renderer loss.';
      fixture.appendHistoryMarker(switchId, beforeCrash);
      await expect(transcript.getByText(beforeCrash, { exact: true })).toBeVisible({ timeout: 15000 });
      const originalUrl = page.url();

      async function protocolDeadline<T>(pending: Promise<T>, label: string) {
        return Promise.race([
          pending,
          delay(7000, undefined, { ref: false }).then(() => {
            throw new Error(label + ' timed out');
          }),
        ]);
      }
      const originalSession = await page.context().newCDPSession(page);
      const targetBefore = await protocolDeadline(
        originalSession.send('Target.getTargetInfo'),
        'Original target lookup',
      );
      const rendererLoss = page.waitForEvent('crash', { timeout: 12000 });
      void originalSession.send('Page.crash').catch(() => {});
      await rendererLoss;
      assert.equal(crashed, true, 'The browser did not report a renderer crash');
      fixture.appendHistoryMarker(switchId, updateWhileDown);
      fixture.askQuestion(true, switchId);

      const recoverySession = await protocolDeadline(
        page.context().newCDPSession(page),
        'Attach to the crashed tab',
      );
      const targetAfter = await protocolDeadline(
        recoverySession.send('Target.getTargetInfo'),
        'Restored target lookup',
      );
      assert.equal(targetAfter.targetInfo.targetId, targetBefore.targetInfo.targetId);
      const started = performance.now();
      await protocolDeadline(recoverySession.send('Page.reload', { ignoreCache: true }), 'Reload the original tab');
      const inspect = `(() => {
        const transcript = document.querySelector('[aria-label="聊天记录"]');
        const text = transcript?.textContent ?? '';
        return {
          url: location.href,
          before: text.includes(${JSON.stringify(beforeCrash)}),
          during: text.includes(${JSON.stringify(updateWhileDown)}),
          freshQuestion: Boolean(transcript?.querySelector('.question-open[aria-label^="回答问题"]')),
          leakedOtherConversation: text.includes('fixture answer'),
        };
      })()`;
      await waitFor(
        async () => {
          try {
            const { result } = await protocolDeadline(
              recoverySession.send('Runtime.evaluate', { expression: inspect, returnByValue: true }),
              'Read restored history',
            );
            const snapshot = result.value;
            return (
              snapshot?.url === originalUrl &&
              snapshot.before &&
              snapshot.during &&
              snapshot.freshQuestion &&
              !snapshot.leakedOtherConversation
            );
          } catch {
            return false;
          }
        },
        { description: 'The refreshed tab did not restore the same history, live update and pending question', intervalMs: 75 },
      );

      const restoreMs = Math.round(performance.now() - started);

      async function actInRestoredRenderer(expression: string, label: string) {
        await waitFor(
          async () => {
            const { result } = await protocolDeadline(
              recoverySession.send('Runtime.evaluate', { expression, returnByValue: true }),
              'Use restored question',
            );
            return result.value === true;
          },
          { description: label, intervalMs: 75 },
        );
      }
      async function clickRestored(label: string, selector = '.question-dialog button') {
        await actInRestoredRenderer(
          `(() => {
          const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find((element) =>
            element.getAttribute('aria-label') === ${JSON.stringify(label)}
              || element.textContent.trim() === ${JSON.stringify(label)},
          );
          if (!button || button.matches(':disabled')) return false;
          button.click();
          return true;
        })()`,
          'Could not click restored ' + label,
        );
      }
      async function selectRestored(label: string) {
        await actInRestoredRenderer(
          `(() => {
          const option = [...document.querySelectorAll('.question-dialog .question-option')].find(
            (element) => element.textContent.trim() === ${JSON.stringify(label)},
          );
          const input = option?.querySelector('input');
          if (!input || input.matches(':disabled')) return false;
          input.click();
          return true;
        })()`,
          'Could not choose restored option ' + label,
        );
      }
      async function writeRestored(value: string) {
        await actInRestoredRenderer(
          `(() => {
          const textarea = document.querySelector('.question-dialog textarea[aria-label="你的回答"]');
          if (!textarea || textarea.matches(':disabled')) return false;
          textarea.value = ${JSON.stringify(value)};
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`,
          'Could not fill the restored question',
        );
      }
      const previousAnswers = fixture.calls.answer;
      const previousLostReceipts = fixture.calls.answerReplyLost;
      await clickRestored('回答问题（3 题）', '.question-open');
      await selectRestored('自行填写');
      await writeRestored('红');
      await clickRestored('下一题');
      for (const { text } of [{ text: '甲' }, { text: '乙' }, ...extraQuestionOptions]) {
        await selectRestored(text);
      }
      await clickRestored('下一题');
      await writeRestored('补充内容');
      await clickRestored('核对答案');
      fixture.loseNextQuestionReceipt('committed');
      await clickRestored('提交全部回答（3 题）');
      await actInRestoredRenderer(
        `(() => {
        const transcript = document.querySelector('[aria-label="聊天记录"]');
        return transcript?.textContent.includes(${JSON.stringify(recoveredAnswerMarker)}) &&
          !transcript.querySelector('.question-open');
      })()`,
        'The restored question did not reach native continuation',
      );
      assert.equal(fixture.calls.answer, previousAnswers + 1);
      assert.equal(fixture.calls.answerReplyLost, previousLostReceipts + 1);
      console.log(
        `Confirmed renderer loss and same-tab recovery in ${restoreMs} ms in ${channel} ${browser.version()} ` +
          `(${process.platform}, ${headed ? 'headed' : 'headless'}): selected paged conversation, existing messages, new native event; ` +
          `the original native task continued after one answer despite a lost acknowledgement.`,
      );
    }

    console.log(
      `Antigravity session switching (including a delayed response after reload), history retry and pagination, conversation permissions, questions, next-message model, plugins, photos, same-task append and queue UI passed in ${channel} ${browser.version()} (${process.platform}, ${headed ? 'headed' : 'headless'}).`,
    );
  } catch (error) {
    const outputDir = process.env.TEST_OUTPUT;
    if (outputDir && page && !page.isClosed()) {
      await mkdir(outputDir, { recursive: true }).catch(() => {});
      await page.screenshot({ path: join(outputDir, 'antigravity-browser-failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    await browser.close();
  }
}

export interface AntigravityPluginContractOptions {
  pluginExecutable: string;
  env: NodeJS.ProcessEnv;
  root: string;
  agentHome: string;
  fixture: AntigravityFixture;
  oldGateway: boolean;
  legacyHistory: boolean;
}

export async function testAntigravityPluginProcess(options: AntigravityPluginContractOptions) {
  const { pluginExecutable, env, root, agentHome, fixture, oldGateway, legacyHistory } = options;
  const { backendId, threadId, createdId, projectId, trajectoryId } = ANTIGRAVITY_FIXTURE_CONSTANTS;

  const child = spawn(pluginExecutable, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'close');
  void exited.catch(() => {});
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });
  const generation = randomUUID();
  const pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  let bytes = Buffer.alloc(0);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length) {
      const boundary = bytes.indexOf('\r\n\r\n');
      if (boundary < 0) {
        assert(bytes.length <= 128);
        return;
      }
      const size = Number(/^Content-Length: ([0-9]+)$/.exec(bytes.subarray(0, boundary).toString())?.[1]);
      assert(size > 0 && size <= 8 * 1024 * 1024, 'Invalid framed native response length');
      if (bytes.length < boundary + 4 + size) return;
      const reply = JSON.parse(bytes.subarray(boundary + 4, boundary + 4 + size).toString());
      bytes = bytes.subarray(boundary + 4 + size);
      if (reply.method) continue;
      const entry = pending.get(reply.id);
      assert(entry, 'Native plugin response lost correlation');
      assert.equal(reply.generation, generation);
      clearTimeout(entry.timer);
      pending.delete(reply.id);
      entry.resolve(reply);
    }
  });
  child.on('close', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Error(`Native plugin exited before replying${stderr ? `: ${stderr.trim()}` : ''}`));
    }
    pending.clear();
  });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = randomUUID();
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, generation } }),
    );
    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`Native plugin response timed out for ${method}`));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    return result;
  };
  try {
    assert.equal((await request('adapter/check', { sdk: 1 })).result.sdk, 1);
    assert.equal(
      (
        await request('adapter/initialize', {
          sdk: 1,
          id: backendId,
          name: 'Fixture Antigravity',
          stateDirectory: join(root, 'direct-plugin-state'),
          readOnly: false,
          config: { home: agentHome },
        })
      ).result.sdk,
      1,
    );
    const info = await request('adapter/status');
    assert.equal(info.result.info.id, backendId);
    assert.equal(info.result.info.product, 'antigravity');
    assert.equal(info.result.info.connected, true);
    assert.equal(info.result.status.writesEnabled, true);
    assert.equal(info.result.status.capabilities.renameThread, true);
    assert.equal(info.result.status.capabilities.nextMessageModel, undefined);
    const unsupportedModel = await request('adapter/write', {
      thread: threadId,
      requestId: randomUUID(),
      action: { Send: { text: 'fixture legacy host model violation', model: 'fixture-next' } },
    });
    assert.equal(unsupportedModel.result.state, 'rejected');
    assert.equal(fixture.calls.send, 0, 'A host without message model support sent the message');
    if (!oldGateway) {
      assert.equal(
        info.result.info.presentation.creation.empty,
        true,
        'Antigravity must allow creating its first conversation without an anchor thread',
      );
    }
    assert(!JSON.stringify(info).includes(fixture.token), 'Product credentials escaped plugin boundary');
    const history = await request('adapter/read', {
      method: 'history.read',
      params: { id: threadId },
      query: {},
    });
    assert(history.result.messages.some((message: { text: string }) => message.text === 'fixture answer'));
    assert.equal(history.result.thread.historyTrajectoryId, legacyHistory ? undefined : trajectoryId);
    assert.equal(history.result.thread.historyStepCount, legacyHistory ? undefined : 2);
    const watchId = randomUUID();
    await waitFor(
      async () => {
        const view = await request('adapter/view', { thread: threadId, watchId });
        return (
          view.result?.thread?.synchronized &&
          view.result.messages.some((message: { text: string }) => message.text === 'fixture answer')
        );
      },
      { description: 'Native plugin subscription did not become ready', intervalMs: 75 },
    );
    await request('adapter/unwatch', { thread: threadId, watchId });
    const unsupported = await request('GetAllCascadeTrajectories');
    assert.equal(typeof unsupported.error.message, 'string');
    assert.equal(
      (await request('adapter/status')).result.info.connected,
      true,
      'Business error corrupted plugin framing',
    );
    fixture.clearHistory();
    assert.deepEqual(
      (
        await request('adapter/read', {
          method: 'threads.list',
          params: {},
          query: {},
        })
      ).result.threads,
      [],
    );
    const firstChat = await request('adapter/write', {
      thread: 'new',
      requestId: randomUUID(),
      action: {
        Create: {
          title: null,
          prompt: 'fixture first conversation',
          project: projectId,
          settings: {},
        },
      },
    });
    assert.equal(firstChat.result.state, 'completed');
    assert.equal(
      firstChat.result.resultThreadId,
      createdId,
      'An empty Antigravity history could not create its first project conversation',
    );
    fixture.reset();
  } finally {
    child.stdin.end();
    await stopChild(child, exited, { signal: 'SIGTERM' });
    for (const entry of pending.values()) clearTimeout(entry.timer);
  }
}
