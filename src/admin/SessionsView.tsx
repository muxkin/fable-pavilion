import { shallowRef } from 'vue';
import type { AdminSessionEntry } from '../shared/messaging';
import { Icon } from '../web/Icon';
import { tsxComponent } from '../web/tsx-component';
import { formatDateTime, formatRelative, isPersistentSession } from './format';

export const SessionsView = tsxComponent(function SessionsView(_props: {
  sessions: AdminSessionEntry[];
  loading: boolean;
  onSearch: (q: string) => void;
  onRevoke: (session: AdminSessionEntry) => void;
}) {
  const query = shallowRef('');

  return ({ sessions, loading, onSearch, onRevoke }) => {
    const recentCount = sessions.filter((s) => s.lastActiveAt && Date.now() - s.lastActiveAt < 10 * 60_000).length;
    return (
      <div class="adm-stack">
        <div class="adm-card">
          <div class="adm-filter-bar">
            <form
              class="adm-search"
              onSubmit={(e: Event) => {
                e.preventDefault();
                onSearch(query.value);
              }}
            >
              <Icon name="search" size={16} />
              <input
                type="search"
                value={query.value}
                placeholder="按 UID、用户名、设备名、IP 或来源域名搜索…"
                onInput={(e: Event) => {
                  const val = (e.target as HTMLInputElement).value;
                  query.value = val;
                  if (!val) onSearch('');
                }}
              />
              <button type="submit" class="adm-btn" disabled={loading}>
                筛选
              </button>
            </form>
            <div class="adm-tag-row">
              <span class="adm-badge is-accent">总会话 {sessions.length}</span>
              <span class="adm-badge is-ok">10 分钟内活跃 {recentCount}</span>
            </div>
          </div>

          <div class="adm-table-scroll">
            <table class="adm-table">
              <thead>
                <tr>
                  <th>所属账号</th>
                  <th>设备 / 客户端</th>
                  <th>网络与来源</th>
                  <th>最近活跃</th>
                  <th>有效期</th>
                  <th class="is-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {sessions.length === 0 ? (
                  <tr>
                    <td colspan={6} class="adm-table-empty">
                      {loading ? '正在加载活跃会话…' : '暂无活跃会话'}
                    </td>
                  </tr>
                ) : (
                  sessions.map((s) => {
                    const fresh = !!s.lastActiveAt && Date.now() - s.lastActiveAt <= 10 * 60_000;
                    return (
                      <tr key={s.deviceId}>
                        <td>
                          <div class="adm-cell-stack">
                            <strong>
                              {s.displayName}
                              <span class="adm-badge">{s.userKind === 'agent' ? 'Agent' : '个人'}</span>
                            </strong>
                            <small class="adm-muted">
                              @{s.username} · UID {s.userId}
                            </small>
                          </div>
                        </td>
                        <td>
                          <div class="adm-cell-stack">
                            <strong>
                              {s.customName || s.name}
                              {s.current && <span class="adm-badge is-accent">当前</span>}
                              {fresh && <span class="adm-badge is-ok">在线</span>}
                            </strong>
                            <small class="adm-muted">
                              {[s.os, s.browser].filter(Boolean).join(' · ') || `会话 #${s.deviceId.slice(0, 6)}`}
                            </small>
                          </div>
                        </td>
                        <td>
                          <div class="adm-cell-stack">
                            <span>{[s.ip, s.location].filter(Boolean).join(' · ') || '—'}</span>
                            <small class="adm-muted">{s.origin || '—'}</small>
                          </div>
                        </td>
                        <td>
                          <div class="adm-cell-stack">
                            <span>{formatRelative(s.lastActiveAt)}</span>
                            <small class="adm-muted">登录 {formatDateTime(s.createdAt)}</small>
                          </div>
                        </td>
                        <td>
                          <span class={`adm-badge${isPersistentSession(s.expiresAt) ? ' is-ok' : ''}`}>
                            {isPersistentSession(s.expiresAt) ? '长期有效' : formatDateTime(s.expiresAt)}
                          </span>
                        </td>
                        <td class="is-right">
                          <button
                            type="button"
                            class="adm-btn is-sm is-danger"
                            disabled={s.current}
                            onClick={() => onRevoke(s)}
                          >
                            {s.current ? '当前' : '踢出'}
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };
});
