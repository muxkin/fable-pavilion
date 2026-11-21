import { shallowRef } from 'vue';
import type { AdminAuditEntry, AdminConversationSummary } from '../shared/messaging';
import { tsxComponent } from '../web/tsx-component';
import { auditActionLabel, formatBytes, formatDateTime, formatRelative } from './format';

export const ConversationsAuditView = tsxComponent(function ConversationsAuditView(_props: {
  conversations: AdminConversationSummary[];
  auditLogs: AdminAuditEntry[];
  loading: boolean;
}) {
  const subtab = shallowRef<'audit' | 'conversations'>('audit');

  return ({ conversations, auditLogs, loading }) => (
    <div class="adm-stack">
      <div class="adm-card">
        <div class="adm-card-head">
          <div>
            <h2>{subtab.value === 'audit' ? '运维操作审计日志' : '会话目录（零知识元数据）'}</h2>
            <p class="adm-muted">
              {subtab.value === 'audit'
                ? '记录管理员登录、强制下线、节点吊销与清理操作，最多保留最近 500 条。'
                : '仅展示会话结构与 7 天留存期内消息/附件统计，消息正文与文件内容全程端到端加密不可见。'}
            </p>
          </div>
          <div class="adm-seg">
            <button
              type="button"
              class={subtab.value === 'audit' ? 'is-active' : ''}
              onClick={() => (subtab.value = 'audit')}
            >
              审计日志 ({auditLogs.length})
            </button>
            <button
              type="button"
              class={subtab.value === 'conversations' ? 'is-active' : ''}
              onClick={() => (subtab.value = 'conversations')}
            >
              会话目录 ({conversations.length})
            </button>
          </div>
        </div>

        {subtab.value === 'audit' ? (
          <div class="adm-table-scroll">
            <table class="adm-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作人</th>
                  <th>类型</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.length === 0 ? (
                  <tr>
                    <td colspan={4} class="adm-table-empty">
                      {loading ? '正在加载审计日志…' : '暂无管理员操作日志'}
                    </td>
                  </tr>
                ) : (
                  auditLogs.map((log) => (
                    <tr key={log.id}>
                      <td title={formatDateTime(log.createdAt)}>
                        <div class="adm-cell-stack">
                          <span>{formatRelative(log.createdAt)}</span>
                          <small class="adm-muted">{formatDateTime(log.createdAt)}</small>
                        </div>
                      </td>
                      <td>
                        <div class="adm-cell-stack">
                          <strong>{log.actorDisplayName || `UID ${log.actorId}`}</strong>
                          <small class="adm-muted">
                            {log.actorUsername ? `@${log.actorUsername} · ` : ''}UID {log.actorId}
                          </small>
                        </div>
                      </td>
                      <td>
                        <span class="adm-badge is-accent">{auditActionLabel(log.action)}</span>
                      </td>
                      <td>{log.detail}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div class="adm-table-scroll">
            <table class="adm-table">
              <thead>
                <tr>
                  <th>会话名称</th>
                  <th>类型</th>
                  <th>成员数</th>
                  <th>近 7 天消息</th>
                  <th>近 7 天附件</th>
                  <th class="is-right">最近消息时间</th>
                </tr>
              </thead>
              <tbody>
                {conversations.length === 0 ? (
                  <tr>
                    <td colspan={6} class="adm-table-empty">
                      {loading ? '正在加载会话目录…' : '暂无会话记录'}
                    </td>
                  </tr>
                ) : (
                  conversations.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <div class="adm-cell-stack">
                          <strong>
                            {c.name}
                            {c.closed && <span class="adm-badge">已解散</span>}
                          </strong>
                          <small class="adm-mono adm-muted">{c.id}</small>
                        </div>
                      </td>
                      <td>
                        <span class={`adm-badge${c.kind === 'group' ? ' is-accent' : ''}`}>
                          {c.kind === 'group' ? '群聊' : '私聊'}
                        </span>
                      </td>
                      <td>{c.memberCount}</td>
                      <td>{c.messageCount}</td>
                      <td>
                        {c.fileCount} 个 · {formatBytes(c.fileBytes)}
                      </td>
                      <td class="is-right" title={formatDateTime(c.lastMessageAt)}>
                        {formatRelative(c.lastMessageAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
});
