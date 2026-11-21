import { onMounted, onScopeDispose, shallowRef } from 'vue';
import type {
  AdminAuditEntry,
  AdminConversationSummary,
  AdminDesktopEntry,
  AdminOverview,
  AdminSessionEntry,
  AdminStorageDetail,
  AdminUserSummary,
  ChatUser,
} from '../shared/messaging';
import { Icon } from '../web/Icon';
import type { IconName } from '../web/icon-paths';
import { tsxComponent } from '../web/tsx-component';
import { resolvedLocale, t, toggleLocale } from '../shared/i18n';
import { AdminLogin } from './AdminLogin';
import { adminApi, type SiteStatus } from './api';
import { ConversationsAuditView } from './ConversationsAuditView';
import { DashboardView } from './DashboardView';
import { DesktopsView } from './DesktopsView';
import { SessionsView } from './SessionsView';
import { StorageView } from './StorageView';
import { UsersView } from './UsersView';

type AdminTab = 'dashboard' | 'users' | 'sessions' | 'desktops' | 'storage' | 'audit';
type ThemeMode = 'dark' | 'light';

interface ConfirmState {
  title: string;
  body: string;
  danger?: boolean;
  action: () => Promise<void>;
}

const NAV_ITEMS: { id: AdminTab; label: string; icon: IconName }[] = [
  { id: 'dashboard', label: '总览仪表盘', icon: 'gauge' },
  { id: 'users', label: '用户管理', icon: 'contacts' },
  { id: 'sessions', label: '在线会话', icon: 'phone' },
  { id: 'desktops', label: '桌面节点', icon: 'monitor' },
  { id: 'storage', label: '存储与清理', icon: 'folder' },
  { id: 'audit', label: '会话与审计', icon: 'shield' },
];

function initialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem('fp-admin-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {}
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export const AdminApp = tsxComponent(function AdminApp() {
  const theme = shallowRef<ThemeMode>(initialTheme());
  const booting = shallowRef(true);
  const siteStatus = shallowRef<SiteStatus | null>(null);
  const user = shallowRef<ChatUser | null>(null);
  const activeTab = shallowRef<AdminTab>('dashboard');
  const mobileNavOpen = shallowRef(false);
  const autoRefresh = shallowRef(false);

  const overview = shallowRef<AdminOverview | null>(null);
  const users = shallowRef<AdminUserSummary[]>([]);
  const sessions = shallowRef<AdminSessionEntry[]>([]);
  const desktops = shallowRef<AdminDesktopEntry[]>([]);
  const conversations = shallowRef<AdminConversationSummary[]>([]);
  const storage = shallowRef<AdminStorageDetail | null>(null);
  const auditLogs = shallowRef<AdminAuditEntry[]>([]);

  const userQuery = shallowRef('');
  const userKind = shallowRef<'all' | 'human' | 'agent'>('all');
  const userSort = shallowRef<'created' | 'active' | 'messages' | 'storage'>('created');
  const sessionQuery = shallowRef('');

  const loading = shallowRef(false);
  const cleaning = shallowRef(false);
  const error = shallowRef('');
  const toast = shallowRef('');
  const confirm = shallowRef<ConfirmState | null>(null);
  const confirmBusy = shallowRef(false);

  let toastTimer: number | undefined;
  let refreshTimer: number | undefined;

  function applyTheme(next: ThemeMode) {
    theme.value = next;
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('fp-admin-theme', next);
    } catch {}
  }

  function showToast(msg: string) {
    toast.value = msg;
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.value = ''), 4200);
  }

  function stopAutoRefresh() {
    if (refreshTimer !== undefined) {
      window.clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  }

  function toggleAutoRefresh() {
    autoRefresh.value = !autoRefresh.value;
    stopAutoRefresh();
    if (autoRefresh.value) {
      refreshTimer = window.setInterval(() => {
        if (user.value?.isAdmin && document.visibilityState === 'visible') {
          void loadCurrentTab(true);
        }
      }, 30_000);
    }
  }

  onScopeDispose(() => {
    stopAutoRefresh();
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  });

  async function loadOverviewAndAudit() {
    const [ov, au] = await Promise.all([adminApi.overview(), adminApi.audit(120)]);
    overview.value = ov;
    auditLogs.value = au.logs;
  }

  async function loadUsers() {
    const res = await adminApi.users({
      q: userQuery.value,
      kind: userKind.value,
      sort: userSort.value,
      limit: 150,
    });
    users.value = res.users;
  }

  async function loadSessions() {
    const res = await adminApi.sessions(sessionQuery.value, 150);
    sessions.value = res.sessions;
  }

  async function loadCurrentTab(silent = false) {
    if (!user.value?.isAdmin) return;
    if (!silent) loading.value = true;
    error.value = '';
    try {
      const tab = activeTab.value;
      if (tab === 'dashboard') {
        await loadOverviewAndAudit();
      } else if (tab === 'users') {
        await Promise.all([loadUsers(), adminApi.overview().then((ov) => (overview.value = ov))]);
      } else if (tab === 'sessions') {
        await Promise.all([loadSessions(), adminApi.overview().then((ov) => (overview.value = ov))]);
      } else if (tab === 'desktops') {
        const [d, ov] = await Promise.all([adminApi.desktops(), adminApi.overview()]);
        desktops.value = d.desktops;
        overview.value = ov;
      } else if (tab === 'storage') {
        const [st, ov] = await Promise.all([adminApi.storage(), adminApi.overview()]);
        storage.value = st;
        overview.value = ov;
      } else if (tab === 'audit') {
        const [conv, au, ov] = await Promise.all([
          adminApi.conversations(150),
          adminApi.audit(150),
          adminApi.overview(),
        ]);
        conversations.value = conv.conversations;
        auditLogs.value = au.logs;
        overview.value = ov;
      }
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '数据加载失败，请重试';
    } finally {
      if (!silent) loading.value = false;
    }
  }

  async function switchTab(next: AdminTab) {
    activeTab.value = next;
    mobileNavOpen.value = false;
    await loadCurrentTab();
  }

  async function runCleanup() {
    if (cleaning.value) return;
    cleaning.value = true;
    error.value = '';
    try {
      const res = await adminApi.cleanup();
      overview.value = res.overview;
      showToast(
        `清理完成：删除 ${res.deletedMessages} 条消息、${res.deletedFiles} 个附件、回收 ${res.deletedObjects} 个对象`,
      );
      await loadCurrentTab(true);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '清理失败';
    } finally {
      cleaning.value = false;
    }
  }

  async function boot() {
    applyTheme(theme.value);
    booting.value = true;
    try {
      const [st, meRes] = await Promise.all([
        adminApi.status().catch(() => null),
        adminApi.me().catch(() => ({ user: null })),
      ]);
      siteStatus.value = st;
      user.value = meRes.user;
      if (meRes.user?.isAdmin) {
        await loadCurrentTab();
      }
    } finally {
      booting.value = false;
    }
  }

  onMounted(() => void boot());

  function askConfirm(next: ConfirmState) {
    confirm.value = next;
  }

  async function runConfirmed() {
    const current = confirm.value;
    if (!current || confirmBusy.value) return;
    confirmBusy.value = true;
    error.value = '';
    try {
      await current.action();
      confirm.value = null;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '操作失败';
    } finally {
      confirmBusy.value = false;
    }
  }

  async function signOut() {
    stopAutoRefresh();
    autoRefresh.value = false;
    await adminApi.logout().catch(() => {});
    user.value = null;
    overview.value = null;
  }

  return () => {
    if (booting.value) {
      return (
        <div class="adm-boot">
          <span class="adm-brand-mark">亭</span>
          <p>正在连接子虚亭管理台…</p>
        </div>
      );
    }

    if (!user.value) {
      return (
        <AdminLogin
          status={siteStatus.value}
          onAuthenticated={(signedIn) => {
            user.value = signedIn;
            if (signedIn.isAdmin) void loadCurrentTab();
          }}
        />
      );
    }

    if (!user.value.isAdmin) {
      return (
        <div class="adm-auth-shell">
          <div class="adm-auth-card adm-denied-card">
            <div class="adm-auth-brand">
              <span class="adm-brand-mark">亭</span>
              <div>
                <h1>无管理员权限</h1>
                <p>
                  当前账号 {user.value.displayName} (@{user.value.username} · UID {user.value.id}) 未列入管理员白名单。
                </p>
              </div>
            </div>
            <button type="button" class="adm-btn is-danger" onClick={() => void signOut()}>
              退出并切换账号
            </button>
          </div>
        </div>
      );
    }

    const ov = overview.value;
    const currentNav = NAV_ITEMS.find((i) => i.id === activeTab.value)!;
    const badgeCount = (id: AdminTab): number | null => {
      if (!ov) return null;
      if (id === 'users') return ov.users.total;
      if (id === 'sessions') return ov.sessions.active;
      if (id === 'desktops') return ov.desktops?.active ?? null;
      if (id === 'storage') {
        const pending = ov.messages.expiredPending + ov.files.expiredPending + ov.files.orphanPending;
        return pending > 0 ? pending : null;
      }
      return null;
    };

    return (
      <div class={`adm-layout${mobileNavOpen.value ? ' nav-open' : ''}`}>
        {mobileNavOpen.value && (
          <div class="adm-nav-backdrop" onClick={() => (mobileNavOpen.value = false)} />
        )}

        <aside class="adm-sidebar" aria-label="管理台导航">
          <div class="adm-sidebar-brand">
            <span class="adm-brand-mark" aria-hidden="true">
              亭
            </span>
            <div>
              <strong>子虚亭 · 管理台</strong>
              <small>{ov?.authority ?? location.host}</small>
            </div>
          </div>

          <nav class="adm-nav">
            {NAV_ITEMS.map((item) => {
              const count = badgeCount(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  class={`adm-nav-item${activeTab.value === item.id ? ' is-active' : ''}`}
                  aria-current={activeTab.value === item.id ? 'page' : undefined}
                  onClick={() => void switchTab(item.id)}
                >
                  <Icon name={item.icon} size={18} />
                  <span>{item.label}</span>
                  {count !== null && (
                    <em class={`adm-nav-badge${item.id === 'storage' ? ' is-warn' : ''}`}>{count}</em>
                  )}
                </button>
              );
            })}
          </nav>

          <div class="adm-sidebar-footer">
            <div class="adm-admin-chip">
              <span class="adm-avatar-chip">{(user.value.displayName || user.value.username).slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{user.value.displayName}</strong>
                <small>UID {user.value.id} · 管理员</small>
              </div>
            </div>
            <button type="button" class="adm-btn is-sm is-full" onClick={() => void signOut()}>
              退出登录
            </button>
          </div>
        </aside>

        <div class="adm-main">
          <header class="adm-topbar">
            <div class="adm-topbar-left">
              <button
                type="button"
                class="adm-icon-btn adm-mobile-menu-btn"
                aria-label="打开导航"
                onClick={() => (mobileNavOpen.value = !mobileNavOpen.value)}
              >
                <Icon name="grid" size={18} />
              </button>
              <div>
                <h1>{currentNav.label}</h1>
                <div class="adm-status-line">
                  <i class="adm-live-dot" />
                  <span>运行正常</span>
                  {ov?.runtime && <span>· {ov.runtime === 'cloudflare' ? 'Cloudflare Edge' : 'Node Relay'}</span>}
                </div>
              </div>
            </div>

            <div class="adm-topbar-actions">
              <button
                type="button"
                class={`adm-btn is-sm${autoRefresh.value ? ' is-active' : ''}`}
                title="每 30 秒自动刷新"
                onClick={toggleAutoRefresh}
              >
                <Icon name="clock" size={14} />
                <span>{autoRefresh.value ? '自动刷新开' : '自动刷新'}</span>
              </button>
              <button
                type="button"
                class="adm-btn is-sm"
                disabled={loading.value}
                onClick={() => void loadCurrentTab()}
              >
                <Icon name="refresh" size={14} />
                <span>{loading.value ? '刷新中…' : '刷新'}</span>
              </button>
              <button
                type="button"
                class="adm-btn is-sm"
                aria-label={t('切换语言为 English', 'Switch language to Chinese')}
                title={t('切换界面语言', 'Switch Language')}
                onClick={toggleLocale}
              >
                <Icon name="globe" size={14} />
                <span>{resolvedLocale.value === 'en' ? '中文' : 'EN'}</span>
              </button>
              <button
                type="button"
                class="adm-icon-btn"
                aria-label={t('切换明暗主题', 'Toggle light/dark theme')}
                title={theme.value === 'dark' ? t('切换浅色主题', 'Switch to light theme') : t('切换深色主题', 'Switch to dark theme')}
                onClick={() => applyTheme(theme.value === 'dark' ? 'light' : 'dark')}
              >
                <Icon name={theme.value === 'dark' ? 'sun' : 'moon'} size={17} />
              </button>
            </div>
          </header>

          <main class="adm-content">
            {error.value && (
              <div class="adm-alert is-error" role="alert">
                <Icon name="info" size={16} />
                <span>{error.value}</span>
              </div>
            )}

            {activeTab.value === 'dashboard' && ov && (
              <DashboardView
                overview={ov}
                auditLogs={auditLogs.value}
                cleaning={cleaning.value}
                onCleanup={() =>
                  askConfirm({
                    title: '立即清理过期数据与对象回收',
                    body: '将立即删除云端超过 7 天的聊天记录与附件，并触发对象存储垃圾回收（表情包、头像及客户端本地缓存不受影响）。',
                    action: runCleanup,
                  })
                }
                onNavigate={(tab) => void switchTab(tab)}
              />
            )}

            {activeTab.value === 'users' && (
              <UsersView
                currentAdminId={user.value.id}
                users={users.value}
                loading={loading.value}
                query={userQuery.value}
                kind={userKind.value}
                sort={userSort.value}
                onFilterChange={(next) => {
                  if (next.q !== undefined) userQuery.value = next.q;
                  if (next.kind !== undefined) userKind.value = next.kind;
                  if (next.sort !== undefined) userSort.value = next.sort;
                  void loadUsers();
                }}
                onRevokeUser={async (target) => {
                  await new Promise<void>((resolve) => {
                    askConfirm({
                      title: target.id === user.value?.id ? '下线管理员其他设备' : `强制下线 ${target.displayName}`,
                      body:
                        target.id === user.value?.id
                          ? '将吊销除当前管理台浏览器以外的所有会话。'
                          : `将吊销 ${target.displayName} (@${target.username}) 的全部 ${target.activeSessions} 个活跃登录会话。`,
                      danger: true,
                      action: async () => {
                        const res = await adminApi.revokeUserSessions(target.id);
                        showToast(`已吊销 ${target.displayName} 的 ${res.revoked} 个会话`);
                        await loadCurrentTab(true);
                        resolve();
                      },
                    });
                  });
                }}
                onDeleteUser={async (target) => {
                  await new Promise<void>((resolve) => {
                    askConfirm({
                      title: `永久删除账号 ${target.displayName}`,
                      body: `确认彻底删除 ${target.displayName} (@${target.username} · UID ${target.id}) 及其全部云端会话与数据？此操作不可撤销。`,
                      danger: true,
                      action: async () => {
                        await adminApi.deleteUser(target.id);
                        showToast(`已永久删除账号 ${target.displayName} (UID ${target.id})`);
                        await loadCurrentTab(true);
                        resolve();
                      },
                    });
                  });
                }}
                onRevokeSession={async (deviceId) => {
                  await adminApi.revokeSession(deviceId);
                  showToast('已踢出该设备会话');
                  await loadCurrentTab(true);
                }}
                onRevokeDesktop={async (hostId) => {
                  await adminApi.revokeDesktop(hostId);
                  showToast('已吊销该桌面节点');
                  await loadCurrentTab(true);
                }}
              />
            )}

            {activeTab.value === 'sessions' && (
              <SessionsView
                sessions={sessions.value}
                loading={loading.value}
                onSearch={(q) => {
                  sessionQuery.value = q;
                  void loadSessions();
                }}
                onRevoke={(s) =>
                  askConfirm({
                    title: '踢出单条设备会话',
                    body: `确认将 ${s.displayName} (@${s.username}) 的「${s.customName || s.name}」强制下线？`,
                    danger: true,
                    action: async () => {
                      await adminApi.revokeSession(s.deviceId);
                      showToast(`已踢出 ${s.displayName} 的设备会话`);
                      await loadCurrentTab(true);
                    },
                  })
                }
              />
            )}

            {activeTab.value === 'desktops' && (
              <DesktopsView
                desktops={desktops.value}
                loading={loading.value}
                onRevoke={(d) =>
                  askConfirm({
                    title: `吊销桌面节点「${d.name}」`,
                    body: `确认吊销属于 ${d.accountDisplayName || `UID ${d.accountId}`} 的桌面适配器（${d.hostId.slice(0, 16)}…）？吊销后该电脑将立即断开中继连接。`,
                    danger: true,
                    action: async () => {
                      await adminApi.revokeDesktop(d.hostId);
                      showToast(`已吊销桌面节点「${d.name}」`);
                      await loadCurrentTab(true);
                    },
                  })
                }
              />
            )}

            {activeTab.value === 'storage' && (
              <StorageView
                storage={storage.value}
                cleaning={cleaning.value}
                onCleanup={() =>
                  askConfirm({
                    title: '执行云端 7 天过期清理与对象回收',
                    body: '将立即删除所有满 7 天的云端聊天记录与附件、超过 24 小时的未发出孤儿附件，并执行对象存储 GC。表情包与头像永久保留。',
                    action: runCleanup,
                  })
                }
              />
            )}

            {activeTab.value === 'audit' && (
              <ConversationsAuditView
                conversations={conversations.value}
                auditLogs={auditLogs.value}
                loading={loading.value}
              />
            )}
          </main>
        </div>

        {toast.value && (
          <div class="adm-toast" role="status">
            <Icon name="check" size={16} />
            <span>{toast.value}</span>
          </div>
        )}

        {confirm.value && (
          <div
            class="adm-modal-backdrop"
            onClick={() => {
              if (!confirmBusy.value) confirm.value = null;
            }}
          >
            <div class="adm-modal" role="dialog" aria-modal="true" onClick={(e: Event) => e.stopPropagation()}>
              <h3>{confirm.value.title}</h3>
              <p>{confirm.value.body}</p>
              <div class="adm-modal-actions">
                <button
                  type="button"
                  class="adm-btn"
                  disabled={confirmBusy.value}
                  onClick={() => (confirm.value = null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  class={`adm-btn${confirm.value.danger ? ' is-danger' : ' is-primary'}`}
                  disabled={confirmBusy.value}
                  onClick={() => void runConfirmed()}
                >
                  {confirmBusy.value ? '处理中…' : '确认执行'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };
});
