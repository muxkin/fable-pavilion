import { onMounted, onScopeDispose, shallowRef } from 'vue';
import type { AdminCleanupResult, AdminOverview, AdminUserSummary } from '../../shared/messaging';
import { tsxComponent } from '../tsx-component';
import { Icon } from '../Icon';
import { messaging, useMessaging } from './context';
import { Confirm, Notice, errorText } from './ui';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDateTime(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default tsxComponent(function AdminConsole() {
  const overview = shallowRef<AdminOverview | null>(null);
  const users = shallowRef<AdminUserSummary[]>([]);
  const query = shallowRef('');
  const loading = shallowRef(false);
  const cleaning = shallowRef(false);
  const error = shallowRef('');
  const statusMessage = shallowRef('');
  const revokeTarget = shallowRef<AdminUserSummary | null>(null);
  const controller = new AbortController();
  onScopeDispose(() => controller.abort());

  async function loadOverview() {
    const data = await messaging.request<AdminOverview>(
      '/admin/overview',
      'GET',
      undefined,
      controller.signal,
    );
    if (!controller.signal.aborted) overview.value = data;
  }

  async function loadUsers(search = query.value) {
    const qs = search.trim() ? `?q=${encodeURIComponent(search.trim())}&limit=100` : '?limit=100';
    const data = await messaging.request<{ users: AdminUserSummary[] }>(
      `/admin/users${qs}`,
      'GET',
      undefined,
      controller.signal,
    );
    if (!controller.signal.aborted) users.value = data.users;
  }

  async function reloadAll() {
    loading.value = true;
    error.value = '';
    try {
      await Promise.all([loadOverview(), loadUsers()]);
    } catch (cause) {
      if (!controller.signal.aborted) error.value = errorText(cause);
    } finally {
      if (!controller.signal.aborted) loading.value = false;
    }
  }

  async function runCleanup() {
    if (cleaning.value) return;
    cleaning.value = true;
    error.value = '';
    statusMessage.value = '';
    try {
      const result = await messaging.request<AdminCleanupResult>('/admin/cleanup', 'POST', {});
      overview.value = result.overview;
      statusMessage.value = `清理完成：删除 ${result.deletedMessages} 条过期消息、${result.deletedFiles} 个过期附件、回收 ${result.deletedObjects} 个对象存储文件。`;
      await loadUsers();
    } catch (cause) {
      error.value = errorText(cause);
    } finally {
      cleaning.value = false;
    }
  }

  onMounted(() => void reloadAll());

  return () => {
    const { user } = useMessaging();
    const stats = overview.value;
    if (!user?.isAdmin) {
      return (
        <section class="admin-console" aria-label="管理后台">
          <Notice text="当前账号无管理员权限。" />
        </section>
      );
    }
    return (
      <section class="admin-console" aria-label="管理后台">
        <Notice text={error.value} />
        {statusMessage.value && (
          <p class="admin-status-banner" role="status">
            <Icon name="check" size={16} />
            <span>{statusMessage.value}</span>
          </p>
        )}

        <div class="admin-toolbar">
          <div class="admin-toolbar-copy">
            <strong>系统运行概览</strong>
            <small>
              端到端加密消息内容对管理员不可见；此后台仅展示脱敏运行指标、存储留存与会话管理。
            </small>
          </div>
          <div class="admin-toolbar-actions">
            <button
              type="button"
              class="secondary"
              disabled={loading.value}
              onClick={() => void reloadAll()}
            >
              <Icon name="refresh" size={15} />
              <span>{loading.value ? '刷新中…' : '刷新'}</span>
            </button>
            <button type="button" disabled={cleaning.value} onClick={() => void runCleanup()}>
              <Icon name="trash" size={15} />
              <span>{cleaning.value ? '清理中…' : '立即清理过期数据'}</span>
            </button>
          </div>
        </div>

        {stats && (
          <>
            <div class="admin-stats-grid">
              <article class="admin-stat-card">
                <span class="admin-stat-label">账号总数</span>
                <strong class="admin-stat-value">{stats.users.total}</strong>
                <small>
                  个人 {stats.users.humans} · Agent {stats.users.agents}
                </small>
              </article>
              <article class="admin-stat-card">
                <span class="admin-stat-label">有效登录会话</span>
                <strong class="admin-stat-value">{stats.sessions.active}</strong>
                <small>长期有效 · 支持按账号强制下线</small>
              </article>
              <article class="admin-stat-card">
                <span class="admin-stat-label">云端消息（保留 {stats.retentionDays} 天）</span>
                <strong class="admin-stat-value">{stats.messages.total}</strong>
                <small>
                  待清理 {stats.messages.expiredPending} · 最早 {formatDateTime(stats.messages.oldestAt)}
                </small>
              </article>
              <article class="admin-stat-card">
                <span class="admin-stat-label">云端附件（保留 {stats.retentionDays} 天）</span>
                <strong class="admin-stat-value">{formatBytes(stats.files.bytes)}</strong>
                <small>
                  {stats.files.total} 个文件 · 待清理 {stats.files.expiredPending}
                </small>
              </article>
              <article class="admin-stat-card">
                <span class="admin-stat-label">长期资源（表情包与头像）</span>
                <strong class="admin-stat-value">
                  {formatBytes(stats.stickers.bytes + stats.avatars.bytes)}
                </strong>
                <small>
                  表情包 {stats.stickers.total} · 头像 {stats.avatars.total}
                </small>
              </article>
              <article class="admin-stat-card">
                <span class="admin-stat-label">会话与对象回收</span>
                <strong class="admin-stat-value">{stats.conversations.total}</strong>
                <small>
                  私聊 {stats.conversations.direct} · 群聊 {stats.conversations.group} · 待 GC{' '}
                  {stats.gcQueue.pending}
                </small>
              </article>
            </div>

            <div class="admin-policy-card">
              <h3>数据留存与安全策略</h3>
              <ul>
                <li>
                  <strong>云端消息与附件</strong>：最多留存 {stats.retentionDays}{' '}
                  天，到期由后台定时任务与 Durable Object Alarm 自动删除并回收底层对象存储；客户端本地 IndexedDB 缓存不受影响，且支持导出 Markdown / JSON。
                </li>
                <li>
                  <strong>表情包与头像</strong>：长期保留，不会随 7 天周期清理。
                </li>
                <li>
                  <strong>登录会话</strong>：长期有效，仅在用户主动退出、设备移除、密码修改或管理员强制下线时失效。
                </li>
              </ul>
            </div>
          </>
        )}

        <section class="admin-users-panel" aria-label="用户管理">
          <div class="admin-users-header">
            <h3>用户与会话 ({users.value.length})</h3>
            <form
              class="admin-search-form"
              onSubmit={(e: Event) => {
                e.preventDefault();
                void loadUsers(query.value);
              }}
            >
              <input
                type="search"
                value={query.value}
                placeholder="按 UID、用户名或昵称搜索"
                onInput={(e: Event) => {
                  query.value = (e.target as HTMLInputElement).value;
                }}
              />
              <button type="submit" class="secondary" disabled={loading.value}>
                搜索
              </button>
            </form>
          </div>
          {users.value.length === 0 ? (
            <p class="admin-empty">{loading.value ? '正在加载用户列表…' : '未找到匹配的用户。'}</p>
          ) : (
            <ul class="admin-user-list">
              {users.value.map((item) => (
                <li key={item.id} class="admin-user-item">
                  <div class="admin-user-main">
                    <div class="admin-user-heading">
                      <strong>{item.displayName}</strong>
                      <span class="admin-user-handle">@{item.username}</span>
                      <span class="admin-badge">{item.kind === 'agent' ? 'Agent' : '个人'}</span>
                      {item.encrypted && <span class="admin-badge verified">E2EE</span>}
                      {item.id === user.id && <span class="admin-badge current">当前管理员</span>}
                    </div>
                    <div class="admin-user-meta">
                      <span>UID {item.id}</span>
                      <span>有效会话 {item.activeSessions}</span>
                      <span>最近活跃 {formatDateTime(item.lastActiveAt)}</span>
                      <span>
                        云端消息 {item.messageCount} · 附件 {item.fileCount} ({formatBytes(item.fileBytes)}) · 表情包{' '}
                        {item.stickerCount}
                      </span>
                    </div>
                  </div>
                  <div class="admin-user-actions">
                    <button
                      type="button"
                      class="secondary"
                      disabled={item.activeSessions === 0 || (item.id === user.id && item.activeSessions <= 1)}
                      onClick={() => (revokeTarget.value = item)}
                    >
                      {item.id === user.id ? '下线其他设备' : '强制下线'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {revokeTarget.value && (
          <Confirm
            title={revokeTarget.value.id === user.id ? '下线管理员其他设备' : '强制下线该账号'}
            onCancel={() => (revokeTarget.value = null)}
            onConfirm={async () => {
              const target = revokeTarget.value;
              if (!target) return;
              const result = await messaging.request<{ revoked: number }>(
                `/admin/users/${target.id}/revoke-sessions`,
                'POST',
                {},
              );
              statusMessage.value = `已吊销 ${target.displayName} (@${target.username}) 的 ${result.revoked} 个活跃会话。`;
              revokeTarget.value = null;
              await reloadAll();
            }}
          >
            {() =>
              revokeTarget.value?.id === user.id
                ? '将吊销除当前浏览器之外的所有登录会话，其他设备需重新登录。'
                : `将吊销 ${revokeTarget.value?.displayName} (@${revokeTarget.value?.username}) 的全部 ${revokeTarget.value?.activeSessions ?? 0} 个登录会话，所有设备需重新登录。`
            }
          </Confirm>
        )}
      </section>
    );
  };
});
