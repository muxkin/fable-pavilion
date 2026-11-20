import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { onScopeDispose, shallowRef, watch } from 'vue';
import { z } from 'zod';
import {
  desktopAuthorizationLifetime,
  desktopAuthorizationSchema,
  type AccountDesktop,
  type DesktopAuthorization,
} from '../../shared/desktop-authorization';
import { hostIdSchema } from '../../shared/relay-protocol';
import { RpcError } from '../../shared/rpc';
import { syncAccountHosts } from '../account-session';
import { deviceSession } from '../device-session';
import { AccountForm } from '../messaging/AccountPages';
import { messaging, useMessaging } from '../messaging/context';
import type { PairedHost } from '../sync-store';
import { appIconPath } from '../theme/app-icons';
import { tsxComponent } from '../tsx-component';
import './desktop-authorization.css';
import { queueAdapterBackup } from '../adapter-security-backup';

interface Start {
  kind: 'start';
  hostId: string;
  name: string;
  state: string;
  port: number;
}
interface Complete {
  kind: 'complete';
  authorization: DesktopAuthorization;
  code: string;
  accountId: string;
}
type Request = Start | Complete;
const intentKey = 'pocket-desktop-authorization';
const intentSchema = z.object({ state: z.string().uuid(), hostId: hostIdSchema, accountId: z.string() });

export function readDesktopAuthorization(fragment: string): Request | undefined {
  const params = new URLSearchParams(fragment.slice(1));
  const host = params.get('host');
  const name = params.get('name');
  const state = params.get('state');
  const initial = z
    .object({
      hostId: hostIdSchema,
      name: desktopAuthorizationSchema.shape.name,
      state: z.string().uuid(),
      port: z.number().int().min(1024).max(65535),
    })
    .safeParse({ hostId: host, name, state, port: Number(params.get('port')) });
  if (initial.success) return { kind: 'start', ...initial.data };

  const code = params.get('code') ?? '';
  if (!/^[A-Za-z0-9_-]{32}$/.test(code)) return;
  const result = desktopAuthorizationSchema.safeParse({
    hostId: host,
    name,
    ticket: bytesToHex(sha256(new TextEncoder().encode(code))),
    issuedAt: Number(params.get('issued')),
    signature: params.get('signature'),
  });
  if (!result.success) return;
  try {
    const intent = intentSchema.parse(JSON.parse(sessionStorage.getItem(intentKey) ?? 'null'));
    if (state !== intent.state || host !== intent.hostId) return;
    sessionStorage.removeItem(intentKey);
    return { kind: 'complete', authorization: result.data, code, accountId: intent.accountId };
  } catch {
    return;
  }
}

export const DesktopAuthorizationPage = tsxComponent(function DesktopAuthorizationPage(props: {
  request?: Request;
  finish: () => void;
}) {
  const session = useMessaging();
  const phase = shallowRef<'idle' | 'opening' | 'connecting' | 'syncing' | 'complete'>('idle');
  const error = shallowRef('');
  const checking = shallowRef(false);
  const controller = new AbortController();
  onScopeDispose(() => controller.abort());
  let pairedTicket: string | undefined;

  function confirm(request: Start, accountId: string) {
    if (phase.value !== 'idle') return;
    if (session.loading || session.user?.id !== accountId || messaging.account.user?.id !== accountId) {
      error.value = '登录账号已切换，请重新核对授权账号';
      return;
    }
    try {
      const { state, hostId, port } = request;
      sessionStorage.setItem(intentKey, JSON.stringify({ state, hostId, accountId }));
      phase.value = 'opening';
      location.replace(`http://127.0.0.1:${port}/authorize/callback?state=${state}`);
    } catch {
      phase.value = 'idle';
      error.value = '浏览器无法保留本次授权，请检查站点存储权限';
    }
  }

  async function authorize({ authorization, code, accountId }: Complete) {
    if (phase.value !== 'idle' || !messaging.account.secrets) return;
    const { signal } = controller;
    const deadline = authorization.issuedAt + desktopAuthorizationLifetime;
    const expired = '授权请求已过期，请在适配器重新打开登录页';
    const assertAccount = () => {
      signal.throwIfAborted();
      if (session.loading || session.user?.id !== accountId || messaging.account.user?.id !== accountId)
        throw Error('登录账号已切换，请在适配器重新打开登录页');
    };
    error.value = '';
    try {
      assertAccount();
      if (!pairedTicket) {
        phase.value = 'connecting';
        await messaging.request('/desktop-devices/approve', 'POST', { accountId, authorization }, signal);
        for (;;) {
          assertAccount();
          if (Date.now() >= deadline) throw Error(expired);
          const { ready } = await messaging.request<{ ready: boolean }>(
            '/desktop-devices/ready',
            'POST',
            {
              accountId,
              hostId: authorization.hostId,
              ticket: authorization.ticket,
            },
            signal,
          );
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
        assertAccount();
        const host = await deviceSession.pair(authorization.hostId, code, '账号工作台', authorization.name, {
          signal,
          retryUntil: deadline,
        });
        pairedTicket = host.ticket;
      }
      assertAccount();
      phase.value = 'syncing';
      await syncAccountHosts(messaging.account);
      await messaging.account.refreshItems();
      const item = await messaging.account.readItem<{ kind: string; host: PairedHost }>(
        `host:${authorization.hostId}`,
      );
      assertAccount();
      if (item?.kind !== 'host' || item.host.ticket !== pairedTicket)
        throw Error('电脑已连接，账号同步尚未完成。请重试同步。');
      phase.value = 'complete';
      queueAdapterBackup(messaging.account, messaging.raw.bind(messaging), item.host, authorization);
    } catch (cause) {
      if (!signal.aborted) {
        if (!pairedTicket && Date.now() >= deadline) error.value = expired;
        else if (cause instanceof RpcError && cause.status === 0)
          console.debug('Desktop pairing transport ended.', cause.message);
        else error.value = cause instanceof Error ? cause.message : '连接未完成，请重试';
        phase.value = 'idle';
      }
    }
  }

  const request = props.request;
  if (request) {
    watch(
      [() => session.loading, () => session.user?.id],
      ([loading, userId], _previous, onCleanup) => {
        if (loading || !userId) return;
        if (request.kind === 'complete') {
          void authorize(request);
          return;
        }
        const check = new AbortController();
        onCleanup(() => check.abort());
        phase.value = 'idle';
        checking.value = true;
        const signal = AbortSignal.any([check.signal, controller.signal, AbortSignal.timeout(4000)]);
        void Promise.all([
          messaging.request<{ devices: AccountDesktop[] }>('/desktop-devices', 'GET', undefined, signal),
          messaging.account
            .refreshItems()
            .then(() =>
              messaging.account.readItem<{ kind: string; host: PairedHost }>(`host:${request.hostId}`),
            ),
        ])
          .then(([{ devices }, item]) => {
            if (signal.aborted || session.user?.id !== userId || phase.value !== 'idle') return;
            if (item?.kind !== 'host' || !devices.some(({ hostId }) => hostId === request.hostId)) return;
            phase.value = 'complete';
            queueAdapterBackup(messaging.account, messaging.raw.bind(messaging), item.host);
          })
          .catch(() => {})
          .finally(() => {
            if (!check.signal.aborted) checking.value = false;
          });
      },
      { immediate: true },
    );
  }

  return ({ finish }) => {
    const user = session.user;
    if (request && !user) {
      return (
        <main class="pavilion-flow desktop-authorization-flow">
          <AccountForm description="登录后即可授权这台电脑。" />
        </main>
      );
    }

    const start = request?.kind === 'start' ? request : undefined;
    const completion = request?.kind === 'complete' ? request : undefined;
    const device = start ?? completion?.authorization;
    const account = user && (!completion || user.id === completion.accountId) ? user : undefined;
    const isComplete = phase.value === 'complete';
    const isOpening = phase.value === 'opening';
    const isPending = (checking.value || !!completion) && !isComplete && !error.value;
    const heading = !request
      ? '授权链接已失效'
      : isComplete
        ? '电脑已授权'
        : checking.value
          ? '正在检查授权'
          : '授权这台电脑';
    return (
      <main class="pavilion-flow desktop-authorization-flow">
        <section
          class="pavilion-flow-content desktop-authorization-content"
          aria-labelledby="desktop-authorization-title"
        >
          <div class="desktop-authorization-brand">
            <img src={appIconPath('pavilion')} width="48" height="48" alt="" />
            <span>子虚亭</span>
          </div>
          <h1 id="desktop-authorization-title" class="pavilion-flow-title">
            {heading}
          </h1>
          {!request ? (
            <p class="pavilion-flow-description">请从电脑适配器点击「授权这台电脑」，重新打开授权页面。</p>
          ) : isComplete ? (
            <p class="pavilion-flow-description" role="status">
              配对已同步到当前账号，可在工作台打开这台电脑。
            </p>
          ) : (
            <p class="pavilion-flow-description">授权后，这台电脑会出现在当前账号的工作台。</p>
          )}
          {device && (
            <>
              <div class="desktop-authorization-divider" aria-hidden="true">
                <i />
                <i />
              </div>
              <dl class="desktop-authorization-details">
                <div>
                  <dt>电脑</dt>
                  <dd>{device.name}</dd>
                </div>
                {account && (
                  <div>
                    <dt>授权账号</dt>
                    <dd>
                      {account.displayName}
                      <small>UID {account.id}</small>
                    </dd>
                  </div>
                )}
                <div>
                  <dt>设备指纹</dt>
                  <dd>
                    <code title={device.hostId}>…{device.hostId.slice(-12)}</code>
                  </dd>
                </div>
              </dl>
            </>
          )}
          {completion && !isComplete && isPending && (
            <p class="desktop-authorization-progress" role="status">
              {phase.value === 'syncing' ? '正在同步配对记录…' : '正在连接这台电脑…'}
            </p>
          )}
          {error.value && (
            <p class="error" role="alert">
              {error.value}
            </p>
          )}
          <div class="desktop-authorization-actions">
            {start && account && !isComplete && !checking.value && (
              <button
                type="button"
                class="primary"
                disabled={isOpening}
                onClick={() => confirm(start, account.id)}
              >
                {isOpening ? '正在打开适配器…' : '确认授权'}
              </button>
            )}
            {completion && !isComplete && !isPending && error.value && (
              <button type="button" class="primary" onClick={() => void authorize(completion)}>
                {pairedTicket ? '重试同步' : '重新连接'}
              </button>
            )}
            <button
              type="button"
              class={isComplete || !request ? 'primary' : 'text-button'}
              disabled={isPending || isOpening}
              onClick={finish}
            >
              {isComplete ? '打开工作台' : !request ? '返回工作台' : '取消'}
            </button>
          </div>
        </section>
      </main>
    );
  };
});
