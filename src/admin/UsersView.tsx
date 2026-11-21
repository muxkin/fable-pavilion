import { shallowRef } from 'vue';
import type { AdminUserDetail, AdminUserSummary } from '../shared/messaging';
import { Icon } from '../web/Icon';
import { tsxComponent } from '../web/tsx-component';
import { adminApi } from './api';
import { formatBytes, formatDateTime, formatRelative, isPersistentSession } from './format';

export const UsersView = tsxComponent(function UsersView(_props: {
  currentAdminId: string;
  users: AdminUserSummary[];
  loading: boolean;
  query: string;
  kind: 'all' | 'human' | 'agent';
  sort: 'created' | 'active' | 'messages' | 'storage';
  onFilterChange: (next: {
    q?: string;
    kind?: 'all' | 'human' | 'agent';
    sort?: 'created' | 'active' | 'messages' | 'storage';
  }) => void;
  onRevokeUser: (user: AdminUserSummary) => Promise<void>;
  onDeleteUser: (user: AdminUserSummary) => Promise<void>;
  onRevokeSession: (deviceId: string) => Promise<void>;
  onRevokeDesktop: (hostId: string) => Promise<void>;
}) {
  const selectedId = shallowRef<string | null>(null);
  const detail = shallowRef<AdminUserDetail | null>(null);
  const detailLoading = shallowRef(false);
  const detailError = shallowRef('');
  const localSearch = shallowRef('');

  async function openDetail(userId: string) {
    selectedId.value = userId;
    detailLoading.value = true;
    detailError.value = '';
    try {
      detail.value = await adminApi.userDetail(userId);
    } catch (cause) {
      detailError.value = cause instanceof Error ? cause.message : '加载用户详情失败';
    } finally {
      detailLoading.value = false;
    }
  }

  async function refreshDetail() {
    if (selectedId.value) await openDetail(selectedId.value);
  }

  return ({
    currentAdminId,
    users,
    loading,
    query,
    kind,
    sort,
    onFilterChange,
    onRevokeUser,
    onDeleteUser,
    onRevokeSession,
    onRevokeDesktop,
  }) => {
    const activeDetail = detail.value;
    return (
      <div class="adm-stack">
        <div class="adm-card">
          <div class="adm-filter-bar">
            <form
              class="adm-search"
              onSubmit={(e: Event) => {
                e.preventDefault();
                onFilterChange({ q: localSearch.value });
              }}
            >
              <Icon name="search" size={16} />
              <input
                type="search"
                value={localSearch.value || query}
                placeholder="搜索 UID、用户名或昵称…"
                onInput={(e: Event) => {
                  const val = (e.target as HTMLInputElement).value;
                  localSearch.value = val;
                  if (!val) onFilterChange({ q: '' });
                }}
              />
              <button type="submit" class="adm-btn" disabled={loading}>
                搜索
              </button>
            </form>

            <div class="adm-seg">
              {(['all', 'human', 'agent'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  class={kind === k ? 'is-active' : ''}
                  onClick={() => onFilterChange({ kind: k })}
                >
                  {k === 'all' ? '全部' : k === 'human' ? '个人' : 'Agent'}
                </button>
              ))}
            </div>

            <label class="adm-select-wrap">
              <span>排序</span>
              <select
                value={sort}
                onChange={(e: Event) =>
                  onFilterChange({
                    sort: (e.target as HTMLSelectElement).value as 'created' | 'active' | 'messages' | 'storage',
                  })
                }
              >
                <option value="created">注册顺序</option>
                <option value="active">最近活跃</option>
                <option value="messages">云端消息数</option>
                <option value="storage">存储占用</option>
              </select>
            </label>
          </div>

          <div class="adm-table-scroll">
            <table class="adm-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>UID / 类型</th>
                  <th>活跃会话</th>
                  <th>最近活跃</th>
                  <th>云端消息</th>
                  <th>存储占用</th>
                  <th class="is-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr>
                    <td colspan={7} class="adm-table-empty">
                      {loading ? '正在加载用户数据…' : '没有匹配的用户记录'}
                    </td>
                  </tr>
                ) : (
                  users.map((u) => (
                    <tr
                      key={u.id}
                      class={selectedId.value === u.id ? 'is-selected' : ''}
                      onClick={() => void openDetail(u.id)}
                    >
                      <td>
                        <div class="adm-user-cell">
                          <span class="adm-avatar-chip">{(u.displayName || u.username).slice(0, 1).toUpperCase()}</span>
                          <div>
                            <strong>
                              {u.displayName}
                              {u.id === currentAdminId && <span class="adm-badge is-accent">我</span>}
                            </strong>
                            <small>@{u.username}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div class="adm-cell-stack">
                          <code class="adm-mono">{u.id}</code>
                          <div class="adm-tag-row">
                            <span class="adm-badge">{u.kind === 'agent' ? 'Agent' : '个人'}</span>
                            {u.encrypted && <span class="adm-badge is-ok">E2EE</span>}
                          </div>
                        </div>
                      </td>
                      <td>
                        <span class={`adm-badge${u.activeSessions > 0 ? ' is-accent' : ''}`}>
                          {u.activeSessions} 个
                        </span>
                      </td>
                      <td title={formatDateTime(u.lastActiveAt)}>{formatRelative(u.lastActiveAt)}</td>
                      <td>{u.messageCount}</td>
                      <td>
                        <div class="adm-cell-stack">
                          <span>{formatBytes(u.fileBytes + u.stickerBytes)}</span>
                          <small class="adm-muted">
                            附件 {u.fileCount} · 表情 {u.stickerCount}
                          </small>
                        </div>
                      </td>
                      <td class="is-right" onClick={(e: Event) => e.stopPropagation()}>
                        <button
                          type="button"
                          class="adm-btn is-sm"
                          onClick={() => void openDetail(u.id)}
                        >
                          详情
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Slide-over User Detail Drawer */}
        {selectedId.value && (
          <div class="adm-drawer-backdrop" onClick={() => (selectedId.value = null)}>
            <aside
              class="adm-drawer"
              aria-label="用户详情"
              onClick={(e: Event) => e.stopPropagation()}
            >
              <header class="adm-drawer-head">
                <div>
                  <h2>{activeDetail?.user.displayName ?? '用户详情'}</h2>
                  <p class="adm-muted">
                    {activeDetail ? `UID ${activeDetail.user.id} · @${activeDetail.user.username}` : '加载中…'}
                  </p>
                </div>
                <button
                  type="button"
                  class="adm-icon-btn"
                  aria-label="关闭详情"
                  onClick={() => (selectedId.value = null)}
                >
                  <Icon name="close" size={18} />
                </button>
              </header>

              <div class="adm-drawer-body">
                {detailError.value && <div class="adm-alert is-error">{detailError.value}</div>}
                {detailLoading.value && !activeDetail && <p class="adm-empty">正在加载详情…</p>}

                {activeDetail && (
                  <>
                    <div class="adm-drawer-summary">
                      <div>
                        <span>账号身份</span>
                        <strong>{activeDetail.user.kind === 'agent' ? 'Agent 账号' : '个人账号'}</strong>
                      </div>
                      <div>
                        <span>注册时间</span>
                        <strong>{formatDateTime(activeDetail.user.createdAt)}</strong>
                      </div>
                      <div>
                        <span>7天消息 / 附件</span>
                        <strong>
                          {activeDetail.user.messageCount} 条 / {formatBytes(activeDetail.user.fileBytes)}
                        </strong>
                      </div>
                      <div>
                        <span>长期表情包</span>
                        <strong>
                          {activeDetail.user.stickerCount} 个 / {formatBytes(activeDetail.user.stickerBytes)}
                        </strong>
                      </div>
                    </div>

                    {activeDetail.owner && (
                      <section class="adm-drawer-sec">
                        <h3>所属个人账号</h3>
                        <button
                          type="button"
                          class="adm-mini-row"
                          onClick={() => void openDetail(activeDetail.owner!.id)}
                        >
                          <strong>{activeDetail.owner.displayName}</strong>
                          <span class="adm-muted">
                            @{activeDetail.owner.username} · UID {activeDetail.owner.id}
                          </span>
                        </button>
                      </section>
                    )}

                    {activeDetail.ownedAgents.length > 0 && (
                      <section class="adm-drawer-sec">
                        <h3>名下 Agent ({activeDetail.ownedAgents.length})</h3>
                        <div class="adm-mini-list">
                          {activeDetail.ownedAgents.map((ag) => (
                            <button
                              key={ag.id}
                              type="button"
                              class="adm-mini-row"
                              onClick={() => void openDetail(ag.id)}
                            >
                              <strong>{ag.displayName}</strong>
                              <span class="adm-muted">
                                @{ag.username} · 会话 {ag.activeSessions}
                              </span>
                            </button>
                          ))}
                        </div>
                      </section>
                    )}

                    <section class="adm-drawer-sec">
                      <div class="adm-drawer-sec-head">
                        <h3>活跃登录会话 ({activeDetail.sessions.length})</h3>
                        <button
                          type="button"
                          class="adm-btn is-sm is-danger"
                          disabled={
                            activeDetail.sessions.length === 0 ||
                            (activeDetail.user.id === currentAdminId && activeDetail.sessions.length <= 1)
                          }
                          onClick={() =>
                            void onRevokeUser(activeDetail.user).then(() => refreshDetail())
                          }
                        >
                          {activeDetail.user.id === currentAdminId ? '下线其他设备' : '全部强制下线'}
                        </button>
                      </div>
                      {activeDetail.sessions.length === 0 ? (
                        <p class="adm-empty">当前无活跃会话。</p>
                      ) : (
                        <ul class="adm-device-list">
                          {activeDetail.sessions.map((s) => (
                            <li key={s.deviceId} class="adm-device-item">
                              <div class="adm-device-info">
                                <strong>
                                  {s.customName || s.name}
                                  {s.current && <span class="adm-badge is-accent">当前会话</span>}
                                  {isPersistentSession(s.expiresAt) && <span class="adm-badge is-ok">长期有效</span>}
                                </strong>
                                <small>
                                  {[s.os, s.browser, s.ip, s.location, s.origin].filter(Boolean).join(' · ') || '基础会话'}
                                </small>
                                <small>
                                  活跃 {formatRelative(s.lastActiveAt)} · 登录 {formatDateTime(s.createdAt)}
                                </small>
                              </div>
                              {!s.current && (
                                <button
                                  type="button"
                                  class="adm-btn is-sm is-danger"
                                  onClick={() =>
                                    void onRevokeSession(s.deviceId).then(() => refreshDetail())
                                  }
                                >
                                  踢出
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    <section class="adm-drawer-sec">
                      <h3>已登记电脑节点 ({activeDetail.desktops.length})</h3>
                      {activeDetail.desktops.length === 0 ? (
                        <p class="adm-empty">该账号暂无已登记桌面适配器。</p>
                      ) : (
                        <ul class="adm-device-list">
                          {activeDetail.desktops.map((d) => (
                            <li key={d.hostId} class="adm-device-item">
                              <div class="adm-device-info">
                                <strong>
                                  {d.name}
                                  <span class={`adm-badge${d.revokedAt ? '' : ' is-ok'}`}>
                                    {d.revokedAt ? '已吊销' : '活跃'}
                                  </span>
                                </strong>
                                <small class="adm-mono">{d.hostId}</small>
                                <small>登记于 {formatDateTime(d.issuedAt)}</small>
                              </div>
                              {!d.revokedAt && (
                                <button
                                  type="button"
                                  class="adm-btn is-sm is-danger"
                                  onClick={() =>
                                    void onRevokeDesktop(d.hostId).then(() => refreshDetail())
                                  }
                                >
                                  吊销
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    {activeDetail.user.id !== currentAdminId && (
                      <section class="adm-drawer-sec">
                        <div class="adm-drawer-sec-head">
                          <h3>危险操作</h3>
                          <button
                            type="button"
                            class="adm-btn is-sm is-danger"
                            onClick={() =>
                              void onDeleteUser(activeDetail.user).then(() => {
                                selectedId.value = null;
                                detail.value = null;
                              })
                            }
                          >
                            永久删除账号
                          </button>
                        </div>
                      </section>
                    )}
                  </>
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
    );
  };
});
