import { shallowRef } from 'vue';
import type { AdminDesktopEntry } from '../shared/messaging';
import { Icon } from '../web/Icon';
import { tsxComponent } from '../web/tsx-component';
import { formatDateTime } from './format';

export const DesktopsView = tsxComponent(function DesktopsView(_props: {
  desktops: AdminDesktopEntry[];
  loading: boolean;
  onRevoke: (desktop: AdminDesktopEntry) => void;
}) {
  const filter = shallowRef<'all' | 'active' | 'revoked'>('all');
  const query = shallowRef('');

  return ({ desktops, loading, onRevoke }) => {
    const q = query.value.trim().toLowerCase();
    const list = desktops.filter((d) => {
      if (filter.value === 'active' && d.revokedAt !== null) return false;
      if (filter.value === 'revoked' && d.revokedAt === null) return false;
      if (!q) return true;
      return (
        d.name.toLowerCase().includes(q) ||
        d.hostId.toLowerCase().includes(q) ||
        d.accountId.includes(q) ||
        (d.accountUsername ?? '').toLowerCase().includes(q) ||
        (d.accountDisplayName ?? '').toLowerCase().includes(q)
      );
    });
    const activeCount = desktops.filter((d) => d.revokedAt === null).length;

    return (
      <div class="adm-stack">
        <div class="adm-card">
          <div class="adm-filter-bar">
            <div class="adm-search">
              <Icon name="search" size={16} />
              <input
                type="search"
                value={query.value}
                placeholder="搜索电脑名、Host ID 或所属账号…"
                onInput={(e: Event) => (query.value = (e.target as HTMLInputElement).value)}
              />
            </div>

            <div class="adm-seg">
              <button
                type="button"
                class={filter.value === 'all' ? 'is-active' : ''}
                onClick={() => (filter.value = 'all')}
              >
                全部 ({desktops.length})
              </button>
              <button
                type="button"
                class={filter.value === 'active' ? 'is-active' : ''}
                onClick={() => (filter.value = 'active')}
              >
                已授权 ({activeCount})
              </button>
              <button
                type="button"
                class={filter.value === 'revoked' ? 'is-active' : ''}
                onClick={() => (filter.value = 'revoked')}
              >
                已吊销 ({desktops.length - activeCount})
              </button>
            </div>
          </div>

          <div class="adm-table-scroll">
            <table class="adm-table">
              <thead>
                <tr>
                  <th>电脑名称</th>
                  <th>Host ID</th>
                  <th>所属账号</th>
                  <th>状态</th>
                  <th>登记 / 吊销时间</th>
                  <th class="is-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {list.length === 0 ? (
                  <tr>
                    <td colspan={6} class="adm-table-empty">
                      {loading ? '正在加载桌面节点…' : '暂无匹配的电脑节点'}
                    </td>
                  </tr>
                ) : (
                  list.map((d) => (
                    <tr key={d.hostId}>
                      <td>
                        <strong>{d.name}</strong>
                      </td>
                      <td>
                        <code class="adm-mono" title={d.hostId}>
                          {d.hostId.length > 22 ? `${d.hostId.slice(0, 12)}…${d.hostId.slice(-8)}` : d.hostId}
                        </code>
                      </td>
                      <td>
                        <div class="adm-cell-stack">
                          <strong>{d.accountDisplayName || `UID ${d.accountId}`}</strong>
                          <small class="adm-muted">
                            {d.accountUsername ? `@${d.accountUsername} · ` : ''}UID {d.accountId}
                          </small>
                        </div>
                      </td>
                      <td>
                        <span class={`adm-badge${d.revokedAt ? '' : ' is-ok'}`}>
                          {d.revokedAt ? '已吊销' : '已授权'}
                        </span>
                      </td>
                      <td>
                        <div class="adm-cell-stack">
                          <span>登记 {formatDateTime(d.issuedAt)}</span>
                          {d.revokedAt && <small class="adm-muted">吊销 {formatDateTime(d.revokedAt)}</small>}
                        </div>
                      </td>
                      <td class="is-right">
                        <button
                          type="button"
                          class="adm-btn is-sm is-danger"
                          disabled={d.revokedAt !== null}
                          onClick={() => onRevoke(d)}
                        >
                          {d.revokedAt ? '已吊销' : '吊销节点'}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };
});
