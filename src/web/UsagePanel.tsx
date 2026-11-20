import { tsxComponent } from './tsx-component';
import { nextTick, shallowRef, useId } from 'vue';
import { writeRef, watchRender } from './render-effects';

import type { UsageResetResult, UsageSnapshot } from '../shared/usage';
import { RpcError } from '../shared/rpc';
import { messaging, useMessaging } from './messaging/context';
import { deviceSession } from './device-session';
import { Icon } from './Icon';
import { Dialog } from './shell/Dialog';
import './usage.css';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });

function resetTime(value: number) {
  return new Date(value).toDateString() === new Date().toDateString()
    ? `今天 ${timeFormat.format(value)} 自动重置`
    : `${dateFormat.format(value)} ${timeFormat.format(value)} 自动重置`;
}

const resetOutcomes: Record<UsageResetResult['outcome'], string> = {
  reset: '已使用 1 次重置。',
  alreadyRedeemed: '这次重置已处理。',
  noCredit: '当前没有可用的重置次数。',
  nothingToReset: '当前没有可重置的额度。',
};

function remaining(used: number) {
  return Math.round(Math.max(0, Math.min(100, 100 - used)));
}

export const UsagePanel = tsxComponent(function UsagePanel(_props: {
  backendId: string;
  name: string;
  active: boolean;
  online: boolean;
  refreshOnOpen?: boolean;
}) {
  const snapshotState = shallowRef<UsageSnapshot>({ state: 'loading' });
  const setSnapshot = (next: UsageSnapshot) => {
    const previous = snapshotState.value;
    if (next.value && previous.value && next.value.updatedAt < previous.value.updatedAt) return;
    snapshotState.value =
      !next.value && next.state !== 'unavailable' && previous.value?.available
        ? { state: 'stale', value: previous.value }
        : next;
  };
  const mobileOpenState = shallowRef(false);
  const setMobileOpen = writeRef(mobileOpenState);
  const desktopOpenState = shallowRef(false);
  const setDesktopOpen = writeRef(desktopOpenState);
  const trigger = shallowRef<HTMLButtonElement | null>(null);
  const popover = shallowRef<HTMLDivElement | null>(null);
  const account = useMessaging();
  const passwordInput = shallowRef<HTMLInputElement | null>(null);
  const resetAction = shallowRef<HTMLButtonElement | null>(null);
  const resetOpen = shallowRef(false);
  const resetBusy = shallowRef(false);
  const resetError = shallowRef('');
  const resetNotice = shallowRef('');
  const pendingRequest = shallowRef('');
  const id = useId();
  const watchSnapshot = watchRender();
  const watchRefresh = watchRender();
  const watchMobileOpen = watchRender();
  const watchResize = watchRender();
  const watchResetScope = watchRender();
  return ({ backendId, name, active, online, refreshOnOpen }) => {
    const snapshot = snapshotState.value;
    const mobileOpen = mobileOpenState.value;
    const desktopOpen = desktopOpenState.value;

    const user = account.user;
    const host = deviceSession.host;
    const resetKey =
      user && host
        ? `pocket-usage-reset:${JSON.stringify([user.id, host.hostId, host.deviceId, backendId])}`
        : '';
    watchResetScope(() => {
      resetOpen.value = false;
      resetError.value = '';
      resetNotice.value = '';
      pendingRequest.value = '';
      if (resetKey) {
        try {
          pendingRequest.value = sessionStorage.getItem(resetKey) ?? '';
        } catch {}
      }
    }, [resetKey]);

    watchSnapshot(() => {
      if (!active) return;
      return deviceSession.watchUsage(backendId, setSnapshot);
    }, [active, backendId]);

    const panelOpen = mobileOpen || desktopOpen;
    watchRefresh(() => {
      if (!active || !online || !panelOpen || !refreshOnOpen) return;
      let open = true;
      void deviceSession
        .api<NonNullable<UsageSnapshot['value']>>('/usage?refresh=1', undefined, backendId)
        .then((latest) => {
          if (open) setSnapshot({ state: latest.available ? 'current' : 'unavailable', value: latest });
        })
        .catch(() => {});
      return () => {
        open = false;
      };
    }, [active, online, panelOpen, refreshOnOpen, backendId]);

    watchMobileOpen(() => {
      if (!active) {
        popover.value?.hidePopover();
        setMobileOpen(false);
        if (!resetBusy.value) resetOpen.value = false;
      }
    }, [active]);

    const position = () => {
      const box = trigger.value?.getBoundingClientRect();
      const panel = popover.value;
      if (!box || !panel) return;
      panel.style.top = `${box.bottom + 8}px`;
      panel.style.right = `${Math.max(12, window.innerWidth - box.right)}px`;
    };
    watchResize(() => {
      if (!desktopOpen) return;
      const closeAtMobile = () => {
        if (window.matchMedia('(max-width: 640px)').matches) popover.value?.hidePopover();
        else position();
      };
      window.addEventListener('resize', closeAtMobile);
      return () => window.removeEventListener('resize', closeAtMobile);
    }, [desktopOpen]);

    const value = snapshot.value;
    const state = online ? snapshot.state : 'stale';
    const buckets = value?.buckets ?? [];
    const codexBucket = buckets.find(({ id }) => id === 'codex');
    const summary =
      codexBucket?.windows.find(({ durationMinutes }) => durationMinutes === 300) ??
      codexBucket?.windows[0] ??
      (buckets.length === 1 && buckets[0].windows.length === 1 ? buckets[0].windows[0] : undefined);
    const credits = value?.credits;
    const resetCount = value?.rateLimitResetCredits?.availableCount;
    const eligible = codexBucket?.windows.some(
      (window) =>
        (window.durationMinutes === 300 || window.durationMinutes === 10080) && window.usedPercent >= 90,
    );
    const retrying = !!pendingRequest.value;
    const resetLabel = retrying ? '核对上次重置' : '使用一次重置';
    const resetReasonId = `${id}-reset-reason`;
    const resetBlocked = !user?.encrypted
      ? '登录后可使用重置次数'
      : !online || (!retrying && state !== 'current')
        ? '等待最新用量'
        : value?.canReset !== true && !retrying
          ? '当前桌面适配器未提供重置操作'
          : !retrying && !resetCount
            ? '暂无可用次数'
            : !retrying && !eligible
              ? '5 小时或每周额度剩余 10% 或更少时可用'
              : '';
    const storePending = (requestId: string) => {
      if (account.user?.id === user?.id && deviceSession.host === host) pendingRequest.value = requestId;
      if (!resetKey) return;
      try {
        if (requestId) sessionStorage.setItem(resetKey, requestId);
        else sessionStorage.removeItem(resetKey);
      } catch {}
    };
    const closeReset = () => {
      if (resetBusy.value) return;
      resetOpen.value = false;
      resetError.value = '';
      if (!mobileOpen && active) {
        void nextTick(() => {
          if (!popover.value?.isConnected) return;
          position();
          popover.value.showPopover();
          popover.value
            .querySelector<HTMLButtonElement>('.usage-reset-action')
            ?.focus({ preventScroll: true });
        });
      }
    };
    const submitReset = async (event: Event) => {
      event.preventDefault();
      const input = passwordInput.value;
      const password = input?.value;
      if (!user || !host || !input || !password || resetBusy.value) return;
      input.value = '';
      resetBusy.value = true;
      resetError.value = '';
      resetNotice.value = '';
      const previousRequest = pendingRequest.value;
      const requestId = previousRequest || crypto.randomUUID();
      let sent = false;
      const sameTarget = () => account.user?.id === user.id && deviceSession.host === host;
      try {
        const { proof } = await messaging.account.confirmUsageReset(user, password, {
          hostId: host.hostId,
          deviceId: host.deviceId,
          backendId,
          requestId,
        });
        if (!sameTarget()) throw Error('账号或电脑已切换，请重新确认');
        storePending(requestId);
        sent = true;
        const result = await deviceSession.api<UsageResetResult>(
          '/usage/reset',
          { method: 'POST', body: JSON.stringify({ proof, requestId }) },
          backendId,
        );
        if (!Object.hasOwn(resetOutcomes, result?.outcome)) throw Error('电脑未返回重置结果');
        storePending('');
        if (!sameTarget()) return;
        if (result.usage) {
          setSnapshot({ state: result.usage.available ? 'current' : 'unavailable', value: result.usage });
        } else {
          void deviceSession
            .api<NonNullable<UsageSnapshot['value']>>('/usage', undefined, backendId)
            .then((latest) => {
              if (sameTarget())
                setSnapshot({ state: latest.available ? 'current' : 'unavailable', value: latest });
            })
            .catch(() => {});
        }
        resetNotice.value = resetOutcomes[result.outcome];
        resetBusy.value = false;
        closeReset();
      } catch (error) {
        const rejected = error instanceof RpcError && error.status >= 400 && error.status < 500;
        if (sent && rejected && !previousRequest) storePending('');
        if (sameTarget()) {
          const message = error instanceof Error ? error.message : '重置请求失败';
          resetError.value =
            sent && (!rejected || previousRequest)
              ? `上次重置结果未确认。重新输入密码可核对同一次请求。 ${message}`
              : message;
          void nextTick(() => passwordInput.value?.focus());
        }
      } finally {
        resetBusy.value = false;
      }
    };
    const summaryPercent =
      summary && Number.isFinite(summary.usedPercent) ? remaining(summary.usedPercent) : undefined;
    const displayedPercent = state === 'current' ? summaryPercent : undefined;
    const summaryName = summary?.label.replace(/用量$/, '');
    const status = !online
      ? '等待电脑连接'
      : {
          loading: '正在同步用量',
          current: '自动更新',
          stale: '暂未同步，正在重试',
          unavailable: '用量暂不可用',
        }[state];
    const triggerLabel =
      displayedPercent === undefined
        ? `${name} 用量，${status}`
        : `${name} 用量，${summaryName}剩余 ${displayedPercent}%`;

    const content = (
      <section class="usage-panel" aria-label="账户用量">
        <p class="usage-subtitle">{name} · 账户共享额度</p>
        <p class="usage-status" data-state={state} role="status">
          <span aria-hidden="true" />
          {status}
        </p>
        {(credits || resetCount !== undefined || retrying) && (
          <div class="usage-account">
            <dl>
              {credits && (
                <div class="usage-account-value">
                  <dt>Credits 余额</dt>
                  <dd>
                    {credits.unlimited
                      ? '不限量'
                      : (credits.balance ?? (credits.hasCredits ? '有余额' : '0'))}
                  </dd>
                </div>
              )}
              {resetCount !== undefined && (
                <div class="usage-account-value">
                  <dt>可用重置次数</dt>
                  <dd>
                    {resetCount} <small>次</small>
                  </dd>
                </div>
              )}
            </dl>
            {(resetCount !== undefined || retrying) && (
              <div class="usage-reset-controls">
                <span
                  class="usage-reset-target"
                  tabindex={resetBlocked ? 0 : undefined}
                  role={resetBlocked ? 'group' : undefined}
                  aria-label={resetBlocked ? resetLabel : undefined}
                  aria-describedby={resetBlocked ? resetReasonId : undefined}
                >
                  <button
                    type="button"
                    class="secondary usage-reset-action"
                    ref={resetAction}
                    disabled={!!resetBlocked}
                    aria-describedby={resetBlocked ? resetReasonId : undefined}
                    onClick={() => {
                      resetOpen.value = true;
                      if (!mobileOpen) popover.value?.hidePopover();
                    }}
                  >
                    {resetLabel}
                  </button>
                </span>
                {resetBlocked && (
                  <small id={resetReasonId} class="usage-reset-reason" role="tooltip">
                    {resetBlocked}
                  </small>
                )}
              </div>
            )}
            {resetNotice.value && (
              <p class="usage-reset-notice" role="status">
                {resetNotice.value}
              </p>
            )}
          </div>
        )}
        {value?.available && buckets.length > 0 ? (
          <div class="usage-buckets">
            {buckets.map((bucket) => (
              <div class="usage-bucket" key={bucket.id}>
                {(buckets.length > 1 || bucket.plan || (bucket.id !== 'codex' && bucket.name !== name)) && (
                  <h3>
                    {bucket.name === 'codex' ? name : bucket.name}
                    {bucket.plan && <span> · {bucket.plan}</span>}
                  </h3>
                )}
                {bucket.windows.map((window, i) => {
                  const left = remaining(window.usedPercent);
                  const label = window.label.replace(/用量$/, '') || window.label;
                  return (
                    <div class="usage-window" key={i}>
                      <div class="usage-window-line">
                        <div>
                          <strong class="usage-window-label">{label}</strong>
                          {window.resetsAt && <small>{resetTime(window.resetsAt)}</small>}
                        </div>
                        <div class="usage-remaining">
                          <strong>{left}%</strong>
                          <span>剩余</span>
                        </div>
                      </div>
                      <div
                        class="usage-meter"
                        role="meter"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={left}
                        data-low={left <= 15}
                        aria-label={`${bucket.name} ${label}剩余额度`}
                        aria-valuetext={`剩余 ${left}%`}
                      >
                        <span style={{ width: `${left}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : state === 'unavailable' ? (
          <p class="usage-empty">{value?.reason ?? '此实例暂未提供用量信息'}</p>
        ) : null}
        {value?.available && (
          <footer>
            {state === 'current' ? '更新于 ' : '上次更新于 '}
            <time
              datetime={new Date(value.updatedAt).toISOString()}
              title={new Date(value.updatedAt).toLocaleString()}
            >
              {timeFormat.format(value.updatedAt)}
            </time>
          </footer>
        )}
      </section>
    );
    return (
      <div class="usage-control">
        <button
          ref={trigger}
          type="button"
          class="usage-trigger secondary"
          aria-label={triggerLabel}
          title={triggerLabel}
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          popovertarget={id}
          data-current={state === 'current'}
          data-loading={state === 'loading'}
          data-low={displayedPercent !== undefined && displayedPercent <= 15}
          data-empty={state !== 'loading' && !displayedPercent}
          onClick={(event) => {
            if (window.matchMedia('(max-width: 640px)').matches) {
              event.preventDefault();
              setMobileOpen(true);
            } else position();
          }}
        >
          <span class="usage-trigger-icon" aria-hidden="true">
            <Icon name="gauge" size={18} />
          </span>
          <span class="usage-trigger-label">用量</span>
          {displayedPercent !== undefined && (
            <span class="usage-trigger-percent" aria-hidden="true">
              {displayedPercent}%
            </span>
          )}
          <span class="usage-trigger-ring" aria-hidden="true">
            <svg width="38" height="38" viewBox="0 0 40 40" fill="none">
              <circle class="usage-ring-track" cx="20" cy="20" r="17" stroke-width="2" />
              <circle
                class="usage-ring-fill"
                cx="20"
                cy="20"
                r="17"
                pathLength="100"
                stroke-width="2.5"
                stroke-dasharray={`${state === 'loading' ? 24 : (displayedPercent ?? 0)} 100`}
              />
            </svg>
            <span>
              {displayedPercent ??
                (state === 'current' && value?.available ? <Icon name="gauge" size={18} /> : '—')}
            </span>
          </span>
        </button>
        <div
          ref={popover}
          id={id}
          popover="auto"
          role="dialog"
          aria-label={`${name} 用量`}
          class="usage-popover"
          tabindex={-1}
          onToggle={(event) => {
            const open = (event.currentTarget as HTMLDivElement).matches(':popover-open');
            setDesktopOpen(open);
            if (open) (event.currentTarget as HTMLDivElement).focus({ preventScroll: true });
          }}
        >
          <h2>用量</h2>
          {desktopOpen && content}
        </div>
        {active && mobileOpen && (
          <Dialog title="用量" className="usage-sheet" onClose={() => setMobileOpen(false)}>
            {() => <>{content}</>}
          </Dialog>
        )}
        {active && resetOpen.value && (
          <Dialog
            title={retrying ? '核对上次重置' : '确认使用一次重置'}
            className="usage-reset-dialog"
            returnFocus={mobileOpen ? resetAction.value : trigger.value}
            onClose={closeReset}
          >
            <form class="usage-reset-form" onSubmit={submitReset}>
              <p>{retrying ? '核对之前提交的同一次重置请求。' : '此操作将消耗 1 次重置次数。'}</p>
              <label>
                重新输入子虚亭账号密码
                <input
                  ref={passwordInput}
                  type="password"
                  autocomplete="current-password"
                  required
                  autofocus
                  disabled={resetBusy.value}
                />
              </label>
              {resetError.value && (
                <p class="usage-reset-error" role="alert">
                  {resetError.value}
                </p>
              )}
              <div class="usage-reset-buttons">
                <button type="button" class="secondary" onClick={closeReset} disabled={resetBusy.value}>
                  取消
                </button>
                <button type="submit" class="primary" disabled={resetBusy.value}>
                  {resetBusy.value ? '正在确认…' : retrying ? '确认核对' : '确认使用'}
                </button>
              </div>
            </form>
          </Dialog>
        )}
      </div>
    );
  };
});
