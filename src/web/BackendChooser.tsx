import { shallowRef } from 'vue';
import { tsxComponent } from './tsx-component';
import { watchRender } from './render-effects';
import { ComputerSetupGuide, WorkbenchAccountAccess } from './shell/ComputerSetup';
import { PageHeader } from './shell/PageHeader';
import { Icon } from './Icon';
import { BackendIcon } from './BackendIcon';
import BackendAppearanceEditor from './BackendAppearanceEditor';
import { deviceSession, type DeviceOverview } from './device-session';
import { messaging, useMessaging } from './messaging/context';
import { syncAccountHosts } from './account-session';
import { queueAdapterBackup } from './adapter-security-backup';
import type { PairedHost } from './sync-store';
import type { AppRoute } from './shell/routes';
import { recentWorkbenchDevices } from './shell/workbench-recency';
import { DEFAULT_BACKEND } from '../shared/backends';
import type { AccountDesktop } from '../shared/desktop-authorization';
import { backendAppearanceDefaults } from '../shared/backend-appearance';
import './shell/workbench.css';

type Action = 'rename' | 'details' | 'remove';
const empty: DeviceOverview = { online: null, toolsChecked: false, backends: [], recent: [] };

export const BackendChooser = tsxComponent(function BackendChooser(_props: {
  hosts: PairedHost[];
  pairingStorageError: boolean;
  busy: boolean;
  navigate: (route: AppRoute) => void;
  refreshHosts: () => Promise<void>;
  manage: boolean;
  back: () => void;
}) {
  const accountDesktops = shallowRef<AccountDesktop[]>([]);
  const authorizationsKnown = shallowRef(false);
  const authorizationsFailed = shallowRef(false);
  const overview = shallowRef(new Map<string, DeviceOverview>());
  const menu = shallowRef<string>();
  const action = shallowRef<{ hostId: string; kind: Action }>();
  const editing = shallowRef<{ hostId: string; backendId: string; product: string }>();
  const alias = shallowRef('');
  const working = shallowRef(false);
  const notice = shallowRef('');
  const query = shallowRef('');
  const refresh = shallowRef(0);
  const watchDesktops = watchRender();
  const watchHosts = watchRender();
  const watchAutoClaim = watchRender();
  const autoClaimed = new Set<string>();
  return ({ hosts, pairingStorageError, busy, navigate, refreshHosts, manage, back }) => {
    const { user } = useMessaging();
    const signature = JSON.stringify(
      hosts.map(({ hostId, deviceId, phoneId, ticket }) => [hostId, deviceId, phoneId, ticket]).sort(),
    );
    watchDesktops(() => {
      if (user?.kind !== 'human') return;
      authorizationsKnown.value = false;
      authorizationsFailed.value = false;
      const controller = new AbortController();
      void messaging
        .request<{ devices: AccountDesktop[] }>('/desktop-devices', 'GET', undefined, controller.signal)
        .then(({ devices }) => {
          if (!controller.signal.aborted) {
            accountDesktops.value = devices;
            authorizationsKnown.value = true;
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) authorizationsFailed.value = true;
        });
      return () => controller.abort();
    }, [user?.id, refresh.value]);
    watchHosts(() => {
      const controller = new AbortController();
      const ids = new Set(hosts.map(({ hostId }) => hostId));
      overview.value = new Map([...overview.value].filter(([id]) => ids.has(id)));
      let refreshing = false;
      const update = async () => {
        if (refreshing || document.visibilityState === 'hidden') return;
        refreshing = true;
        try {
          for (let start = 0; start < hosts.length && !controller.signal.aborted; start += 3) {
            await Promise.allSettled(
              hosts.slice(start, start + 3).map((host) =>
                deviceSession.overview(host, controller.signal, (value) => {
                  if (value.online !== null || !overview.value.has(host.hostId))
                    overview.value = new Map(overview.value).set(host.hostId, value);
                }),
              ),
            );
          }
        } finally {
          refreshing = false;
        }
      };
      void update();
      const interval = setInterval(update, 30000);
      window.addEventListener('focus', update);
      return () => {
        controller.abort();
        clearInterval(interval);
        window.removeEventListener('focus', update);
      };
    }, [signature, refresh.value]);
    const devices = new Map(accountDesktops.value.map((device) => [device.hostId, device]));
    const paired = new Map(hosts.map((host) => [host.hostId, host]));
    const onlineLegacyIds =
      user?.kind === 'human' && authorizationsKnown.value
        ? hosts
            .filter(
              (host) =>
                !devices.has(host.hostId) &&
                overview.value.get(host.hostId)?.online === true &&
                !autoClaimed.has(`${user.id}:${host.hostId}`),
            )
            .map((host) => host.hostId)
            .sort()
            .join(',')
        : '';
    watchAutoClaim(() => {
      if (!onlineLegacyIds || user?.kind !== 'human') return;
      const accountId = user.id;
      const controller = new AbortController();
      for (const hostId of onlineLegacyIds.split(',').filter(Boolean)) {
        const host = paired.get(hostId);
        if (!host) continue;
        autoClaimed.add(`${accountId}:${hostId}`);
        void deviceSession
          .claimDesktop(host, controller.signal)
          .then(async (authorization) => {
            if (controller.signal.aborted || messaging.account.user?.id !== accountId) return;
            await messaging.request(
              '/desktop-devices/approve',
              'POST',
              { accountId, authorization },
              controller.signal,
            );
            if (controller.signal.aborted || messaging.account.user?.id !== accountId) return;
            accountDesktops.value = [
              ...accountDesktops.value.filter((d) => d.hostId !== hostId),
              { hostId, name: host.name || authorization.name },
            ];
            if (host.name && host.name !== authorization.name) {
              void messaging
                .request(`/desktop-devices/${hostId}`, 'PATCH', { accountId, name: host.name })
                .catch(() => {});
            }
            queueAdapterBackup(messaging.account, messaging.raw.bind(messaging), host, authorization);
          })
          .catch(() => {});
      }
      return () => controller.abort();
    }, [onlineLegacyIds, user?.id]);
    const recent = recentWorkbenchDevices(user?.id ?? '').filter((id) => paired.has(id));
    const computers = [...new Set([...recent, ...paired.keys(), ...devices.keys()])];
    const filter = manage ? '' : query.value.trim().toLocaleLowerCase();
    const matches = (text: string) => text.toLocaleLowerCase().includes(filter);
    const visible = computers.filter((id) => {
      const snapshot = overview.value.get(id) ?? empty;
      return (
        matches(paired.get(id)?.name ?? devices.get(id)?.name ?? '') ||
        snapshot.backends.some((backend) => matches(backend.name)) ||
        snapshot.recent.some((thread) => matches(`${thread.title} ${thread.projectName ?? ''}`))
      );
    });

    async function run(task: () => Promise<void>) {
      working.value = true;
      notice.value = '';
      try {
        await task();
      } catch (error) {
        notice.value = error instanceof Error ? error.message : '操作未完成，请重试';
      } finally {
        working.value = false;
      }
    }

    function open(hostId: string, backend: string, thread?: string) {
      navigate({ page: 'workbench', host: hostId, backend, thread });
    }

    const storageNotice = pairingStorageError && (
      <section class="pavilion-flow-content workbench-device-read">
        <p role="alert">浏览器暂时无法读取本机配对记录，请检查此站点的存储权限。</p>
        <button class="secondary" onClick={() => void refreshHosts().catch(() => {})}>
          重新读取
        </button>
      </section>
    );

    if (!computers.length) {
      const loading = user?.kind === 'human' && !authorizationsKnown.value;
      return (
        <main class="workbench-onboarding pavilion-flow">
          <PageHeader title={manage ? '管理电脑' : '工作台'} back={manage ? back : undefined} />
          {storageNotice}
          {!user ? (
            <WorkbenchAccountAccess navigate={navigate} />
          ) : pairingStorageError ? null : loading ? (
            <section class="pavilion-flow-content workbench-device-read">
              {authorizationsFailed.value ? (
                <>
                  <p role="alert">无法读取账号中的电脑。</p>
                  <button class="secondary" onClick={() => refresh.value++}>
                    重新读取
                  </button>
                </>
              ) : (
                <p role="status">正在读取账号中的电脑…</p>
              )}
            </section>
          ) : (
            <ComputerSetupGuide title="连接第一台电脑" navigate={navigate} />
          )}
        </main>
      );
    }

    return (
      <main class="workbench-home">
        <header class="workbench-heading">
          <div class="workbench-title">
            {manage && (
              <button class="icon-button" aria-label="返回" onClick={back}>
                <Icon name="back" />
              </button>
            )}
            <h1>{manage ? '管理电脑' : '工作台'}</h1>
          </div>
          <div class="workbench-actions">
            {!manage && (
              <label class="workbench-search">
                <Icon name="search" size={18} />
                <input
                  type="search"
                  aria-label="搜索电脑、工具或最近会话"
                  placeholder="搜索电脑、工具或最近会话"
                  maxlength={120}
                  value={query.value}
                  onInput={(event) => {
                    query.value = (event.currentTarget as HTMLInputElement).value;
                  }}
                />
              </label>
            )}
            <div class="workbench-entry-actions">
              {!user && (
                <button class="secondary workbench-login" onClick={() => navigate({ page: 'account-login' })}>
                  登录账号
                </button>
              )}
              <button
                class="workbench-add"
                disabled={busy || working.value}
                onClick={() => navigate({ page: 'add-computer' })}
              >
                <Icon name="plus" size={18} />
                添加电脑
              </button>
            </div>
          </div>
        </header>
        {storageNotice}
        {!!computers.length && !visible.length && <p class="workbench-empty">没有匹配的电脑、工具或会话</p>}
        <div class="computer-grid">
          {visible.map((hostId) => {
            const host = paired.get(hostId);
            const authorized = devices.get(hostId);
            const name = host?.name ?? authorized?.name ?? '电脑';
            const snapshot = overview.value.get(hostId) ?? empty;
            const matchingRecents = filter
              ? snapshot.recent.filter((thread) => matches(`${thread.title} ${thread.projectName ?? ''}`))
              : [];
            const recents = matchingRecents.length ? matchingRecents : snapshot.recent;
            const online = snapshot.online;
            const status = !host ? '等待配对同步' : online === null ? '正在检查' : online ? '在线' : '离线';
            const selectedAction = action.value?.hostId === hostId ? action.value.kind : undefined;
            function choose(kind: Action) {
              menu.value = undefined;
              action.value = { hostId, kind };
              alias.value = name;
            }
            return (
              <article key={hostId} class="computer-card" aria-label={name}>
                <header class="computer-header">
                  <span class="computer-icon">
                    <Icon name="monitor" size={24} />
                  </span>
                  <h2>{name}</h2>
                  <span class="computer-status" data-online={online === true}>
                    <i />
                    {status}
                  </span>
                  <div class="computer-menu">
                    <button
                      class="icon-button"
                      aria-label={`管理 ${name}`}
                      aria-expanded={menu.value === hostId}
                      disabled={busy || working.value}
                      onClick={() => {
                        menu.value = menu.value === hostId ? undefined : hostId;
                      }}
                    >
                      <Icon name="more" size={21} />
                    </button>
                    {menu.value === hostId && (
                      <div
                        class="computer-menu-items"
                        onKeydown={(event) => {
                          if (event.key === 'Escape') {
                            menu.value = undefined;
                            (
                              (event.currentTarget as HTMLElement).previousElementSibling as HTMLElement
                            )?.focus();
                          }
                        }}
                      >
                        {host && <button onClick={() => choose('rename')}>重命名</button>}
                        <button onClick={() => choose('details')}>连接详情</button>
                        <button
                          class="danger"
                          disabled={user?.kind === 'human' && !authorizationsKnown.value}
                          onClick={() => choose('remove')}
                        >
                          {authorized ? '撤销授权' : '解除配对'}
                        </button>
                      </div>
                    )}
                  </div>
                </header>
                {selectedAction === 'details' && (
                  <div class="computer-action">
                    <p>
                      {status} · {authorized ? '账号已授权' : '通过配对码连接'}
                    </p>
                    <p>{host ? '此浏览器可访问这台电脑。' : '配对记录同步后即可打开工具。'}</p>
                    <button
                      class="text-button"
                      onClick={() => {
                        action.value = undefined;
                      }}
                    >
                      关闭
                    </button>
                  </div>
                )}
                {selectedAction === 'rename' && host && (
                  <form
                    class="computer-action"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const value = alias.value.trim();
                      if (!value) return;
                      void run(async () => {
                        await deviceSession.renameHost(host, value);
                        if (authorized && user) {
                          await messaging
                            .request(`/desktop-devices/${host.hostId}`, 'PATCH', {
                              accountId: user.id,
                              name: value,
                            })
                            .catch(() => {});
                          accountDesktops.value = accountDesktops.value.map((d) =>
                            d.hostId === host.hostId ? { ...d, name: value } : d,
                          );
                        }
                        await refreshHosts();
                        action.value = undefined;
                      });
                    }}
                  >
                    <label>
                      电脑名称
                      <input
                        required
                        maxlength={80}
                        value={alias.value}
                        onInput={(event) => {
                          alias.value = (event.currentTarget as HTMLInputElement).value;
                        }}
                      />
                    </label>
                    <div>
                      <button
                        type="button"
                        class="secondary"
                        onClick={() => {
                          action.value = undefined;
                        }}
                      >
                        取消
                      </button>
                      <button type="submit" disabled={busy || working.value || !alias.value.trim()}>
                        保存
                      </button>
                    </div>
                  </form>
                )}
                {selectedAction === 'remove' && (
                  <div class="computer-action">
                    <p>
                      {authorized
                        ? `撤销后，${name} 将失去此账号的授权。`
                        : `解除与 ${name} 的配对并移除此浏览器的缓存？`}
                    </p>
                    <div>
                      <button
                        class="secondary"
                        onClick={() => {
                          action.value = undefined;
                        }}
                      >
                        取消
                      </button>
                      <button
                        class="danger"
                        disabled={busy || working.value}
                        onClick={() =>
                          void run(async () => {
                            if (authorized && user) {
                              if (host) await deviceSession.forgetHost(host).catch(() => {});
                              await messaging.request(`/desktop-devices/${hostId}`, 'DELETE', {
                                accountId: user.id,
                              });
                              if (messaging.account.user?.id !== user.id) return;
                              if (deviceSession.host?.hostId === hostId) deviceSession.resetAccount(user.id);
                              await deviceSession.cache.forget(hostId);
                              accountDesktops.value = accountDesktops.value.filter(
                                (entry) => entry.hostId !== hostId,
                              );
                              await syncAccountHosts(messaging.account);
                            } else if (host) {
                              await deviceSession.forgetHost(host);
                            }
                            await deviceSession.init();
                            await refreshHosts();
                            action.value = undefined;
                            refresh.value++;
                          })
                        }
                      >
                        确认{authorized ? '撤销' : '解除'}
                      </button>
                    </div>
                  </div>
                )}
                {snapshot.backends.map((backend) => {
                  const appearance = backend.appearance ?? backendAppearanceDefaults(backend);
                  const cached = snapshot.recent.some((thread) => thread.backendId === backend.id);
                  const connected = snapshot.toolsChecked && backend.connected;
                  return (
                    <div class="computer-tool" key={backend.id}>
                      <BackendIcon icon={appearance.icon} product={backend.product} />
                      <div class="computer-tool-name">
                        <strong>{appearance.name}</strong>
                        {online === true && !connected && (
                          <small>{snapshot.toolsChecked ? '工具未连接' : '工具状态待确认'}</small>
                        )}
                      </div>
                      {online && host && (
                        <button
                          class="icon-button computer-tool-settings"
                          aria-label={`编辑 ${appearance.name}`}
                          title={`编辑 ${appearance.name} 外观`}
                          disabled={busy || working.value}
                          onClick={() =>
                            void run(async () => {
                              if (deviceSession.host?.hostId !== hostId || !deviceSession.online)
                                await deviceSession.select(host, true);
                              if (deviceSession.host?.hostId === hostId)
                                editing.value = { hostId, backendId: backend.id, product: backend.product };
                            })
                          }
                        >
                          <Icon name="sliders" size={16} />
                        </button>
                      )}
                      {(online || cached) && (
                        <button
                          class="computer-open"
                          aria-label={`打开 ${appearance.name}`}
                          disabled={busy || working.value}
                          onClick={() => open(hostId, backend.id)}
                        >
                          {backend.product === 'terminal'
                            ? '打开终端'
                            : online && connected
                              ? '打开会话'
                              : cached
                                ? '查看历史'
                                : '打开工作区'}
                          <Icon name="arrow" size={16} />
                        </button>
                      )}
                    </div>
                  );
                })}
                {!snapshot.backends.length && (
                  <p class="computer-empty">
                    {!host
                      ? '配对记录尚未同步。'
                      : online === null
                        ? '正在读取工具…'
                        : online
                          ? '暂时无法读取工具。'
                          : '电脑离线，暂无工具缓存。'}
                    {host && online === false && (
                      <button
                        class="text-button"
                        disabled={busy || working.value}
                        onClick={() => open(hostId, DEFAULT_BACKEND)}
                      >
                        打开工作区
                      </button>
                    )}
                  </p>
                )}
                {!manage && !!recents.length && (
                  <section class="computer-recents" aria-label={`${name}的最近会话`}>
                    <h3>
                      <Icon name="clock" size={17} />
                      最近会话
                    </h3>
                    <div
                      class="computer-recent-list"
                      role="group"
                      aria-label="会话列表"
                      tabindex={recents.length > 5 ? 0 : undefined}
                    >
                      {recents.map((thread) => {
                        const tool = snapshot.backends.find((b) => b.id === thread.backendId);
                        const appearance = tool ? (tool.appearance ?? backendAppearanceDefaults(tool)) : null;
                        const toolName = appearance?.name ?? thread.backendId;
                        const validUpdatedAt =
                          typeof thread.updatedAt === 'number' &&
                          Number.isFinite(thread.updatedAt) &&
                          thread.updatedAt > 0 &&
                          Math.abs(thread.updatedAt) <= 8.64e15;
                        const fullTime = validUpdatedAt
                          ? new Date(thread.updatedAt).toLocaleString('zh-CN')
                          : '';
                        return (
                          <button
                            key={JSON.stringify([thread.backendId, thread.id])}
                            disabled={busy || working.value}
                            onClick={() => open(hostId, thread.backendId, thread.id)}
                          >
                            <span class="computer-recent-icon" title={toolName} aria-label={toolName}>
                              <BackendIcon
                                icon={appearance?.icon ?? { kind: 'builtin', value: 'chat' }}
                                product={tool?.product}
                              />
                            </span>
                            <span class="computer-recent-title">{thread.title || '未命名会话'}</span>
                            {validUpdatedAt && (
                              <time
                                class="computer-recent-time"
                                datetime={new Date(thread.updatedAt).toISOString()}
                                title={fullTime}
                              >
                                {formatRecentTime(thread.updatedAt)}
                              </time>
                            )}
                            <Icon name="chevron" size={16} />
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}
              </article>
            );
          })}
        </div>
        {notice.value && (
          <p class="workbench-notice" role="status">
            {notice.value}
          </p>
        )}
        {editing.value && editing.value.hostId === deviceSession.host?.hostId && (
          <BackendAppearanceEditor
            key={JSON.stringify(editing.value)}
            id={editing.value.backendId}
            product={editing.value.product}
            onClose={() => {
              editing.value = undefined;
            }}
            onSaved={() => {
              refresh.value++;
            }}
          />
        )}
      </main>
    );
  };
});

function formatRecentTime(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const hhmm = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (date.toDateString() === now.toDateString()) return hhmm;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
