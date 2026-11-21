import { shallowRef } from 'vue';
import type { AdminAuditEntry, AdminOverview } from '../shared/messaging';
import { Icon } from '../web/Icon';
import { tsxComponent } from '../web/tsx-component';
import {
  auditActionLabel,
  formatBytes,
  formatDateTime,
  formatDayShort,
  formatNumber,
  formatRelative,
} from './format';

type TrendMetric = 'messages' | 'files' | 'newUsers';

export const DashboardView = tsxComponent(function DashboardView(_props: {
  overview: AdminOverview;
  auditLogs: AdminAuditEntry[];
  cleaning: boolean;
  onCleanup: () => void;
  onNavigate: (tab: 'users' | 'sessions' | 'desktops' | 'storage' | 'audit') => void;
}) {
  const metric = shallowRef<TrendMetric>('messages');

  return ({ overview, auditLogs, cleaning, onCleanup, onNavigate }) => {
    const totalMediaBytes = overview.files.bytes + overview.stickers.bytes + overview.avatars.bytes;
    const filePct = totalMediaBytes ? (overview.files.bytes / totalMediaBytes) * 100 : 0;
    const stickerPct = totalMediaBytes ? (overview.stickers.bytes / totalMediaBytes) * 100 : 0;
    const avatarPct = totalMediaBytes ? (overview.avatars.bytes / totalMediaBytes) * 100 : 0;

    const series = overview.dailyActivity;
    const values = series.map((d) =>
      metric.value === 'messages' ? d.messages : metric.value === 'files' ? d.files : d.newUsers,
    );
    const maxVal = Math.max(1, ...values);
    const pendingTotal =
      overview.messages.expiredPending + overview.files.expiredPending + overview.files.orphanPending;

    return (
      <div class="adm-stack">
        {/* KPI Row */}
        <div class="adm-kpi-grid">
          <button type="button" class="adm-kpi-card" onClick={() => onNavigate('users')}>
            <div class="adm-kpi-top">
              <span>注册账号</span>
              <span class="adm-kpi-icon">
                <Icon name="contacts" size={18} />
              </span>
            </div>
            <strong class="adm-kpi-value">{formatNumber(overview.users.total)}</strong>
            <div class="adm-kpi-sub">
              <span>个人 {overview.users.humans} · Agent {overview.users.agents}</span>
              {overview.users.new7d > 0 && <em class="adm-delta">7天 +{overview.users.new7d}</em>}
            </div>
          </button>

          <button type="button" class="adm-kpi-card" onClick={() => onNavigate('sessions')}>
            <div class="adm-kpi-top">
              <span>活跃会话</span>
              <span class="adm-kpi-icon">
                <Icon name="phone" size={18} />
              </span>
            </div>
            <strong class="adm-kpi-value">{formatNumber(overview.sessions.active)}</strong>
            <div class="adm-kpi-sub">
              <span>24h 活跃 {overview.sessions.active24h}</span>
              <em class="adm-delta">长期有效</em>
            </div>
          </button>

          <button type="button" class="adm-kpi-card" onClick={() => onNavigate('storage')}>
            <div class="adm-kpi-top">
              <span>云端消息（{overview.retentionDays}天内）</span>
              <span class="adm-kpi-icon">
                <Icon name="chat" size={18} />
              </span>
            </div>
            <strong class="adm-kpi-value">{formatNumber(overview.messages.total)}</strong>
            <div class="adm-kpi-sub">
              <span>24h 新增 {overview.messages.last24h}</span>
              {overview.messages.expiredPending > 0 ? (
                <em class="adm-delta is-warn">待清理 {overview.messages.expiredPending}</em>
              ) : (
                <span>最早 {formatRelative(overview.messages.oldestAt)}</span>
              )}
            </div>
          </button>

          <button type="button" class="adm-kpi-card" onClick={() => onNavigate('storage')}>
            <div class="adm-kpi-top">
              <span>云端媒体占用</span>
              <span class="adm-kpi-icon">
                <Icon name="folder" size={18} />
              </span>
            </div>
            <strong class="adm-kpi-value">{formatBytes(totalMediaBytes)}</strong>
            <div class="adm-kpi-sub">
              <span>7天附件 {formatBytes(overview.files.bytes)}</span>
              <span>永久 {formatBytes(overview.stickers.bytes + overview.avatars.bytes)}</span>
            </div>
          </button>

          <button type="button" class="adm-kpi-card" onClick={() => onNavigate('desktops')}>
            <div class="adm-kpi-top">
              <span>已登记电脑节点</span>
              <span class="adm-kpi-icon">
                <Icon name="monitor" size={18} />
              </span>
            </div>
            <strong class="adm-kpi-value">
              {overview.desktops ? formatNumber(overview.desktops.active) : '—'}
            </strong>
            <div class="adm-kpi-sub">
              <span>
                {overview.desktops
                  ? `累计 ${overview.desktops.total} · 已吊销 ${overview.desktops.revoked}`
                  : '未挂载桌面注册表'}
              </span>
            </div>
          </button>

          <button type="button" class="adm-kpi-card" onClick={() => onNavigate('audit')}>
            <div class="adm-kpi-top">
              <span>会话与 GC 状态</span>
              <span class="adm-kpi-icon">
                <Icon name="gauge" size={18} />
              </span>
            </div>
            <strong class="adm-kpi-value">{formatNumber(overview.conversations.total)}</strong>
            <div class="adm-kpi-sub">
              <span>私聊 {overview.conversations.direct} · 群聊 {overview.conversations.group}</span>
              <span>待 GC {overview.gcQueue.pending + overview.gcQueue.orphanMedia}</span>
            </div>
          </button>
        </div>

        {/* Main 2-column grid */}
        <div class="adm-two-col">
          {/* 7-day trend chart */}
          <section class="adm-card">
            <div class="adm-card-head">
              <div>
                <h2>近 7 天活跃趋势</h2>
                <p class="adm-muted">按 UTC 日期统计云端留存窗口内的实时流量与新增账号</p>
              </div>
              <div class="adm-seg">
                <button
                  type="button"
                  class={metric.value === 'messages' ? 'is-active' : ''}
                  onClick={() => (metric.value = 'messages')}
                >
                  消息
                </button>
                <button
                  type="button"
                  class={metric.value === 'files' ? 'is-active' : ''}
                  onClick={() => (metric.value = 'files')}
                >
                  附件
                </button>
                <button
                  type="button"
                  class={metric.value === 'newUsers' ? 'is-active' : ''}
                  onClick={() => (metric.value = 'newUsers')}
                >
                  新用户
                </button>
              </div>
            </div>

            <div class="adm-chart-wrap">
              <div class="adm-bar-chart" role="img" aria-label="近 7 天活跃趋势柱状图">
                {series.map((day, i) => {
                  const v = values[i];
                  const pct = Math.max(v > 0 ? 8 : 2, Math.round((v / maxVal) * 100));
                  return (
                    <div
                      key={day.day}
                      class="adm-bar-col"
                      title={`${day.day}: ${v} ${metric.value === 'messages' ? '条消息' : metric.value === 'files' ? `个附件 (${formatBytes(day.fileBytes)})` : '位新用户'}`}
                    >
                      <span class="adm-bar-val">{v}</span>
                      <div class="adm-bar-track">
                        <div class={`adm-bar-fill${v === 0 ? ' is-zero' : ''}`} style={{ height: `${pct}%` }} />
                      </div>
                      <span class="adm-bar-label">{formatDayShort(day.day)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {/* Storage distribution & quick maintenance */}
          <section class="adm-card">
            <div class="adm-card-head">
              <div>
                <h2>存储分布与留存策略</h2>
                <p class="adm-muted">聊天记录与附件保留 {overview.retentionDays} 天 · 表情包与头像永久保留</p>
              </div>
              <button
                type="button"
                class="adm-btn is-primary"
                disabled={cleaning}
                onClick={onCleanup}
              >
                <Icon name="trash" size={15} />
                <span>{cleaning ? '清理中…' : '立即清理过期数据'}</span>
              </button>
            </div>

            <div class="adm-storage-bar" aria-label="云端存储构成">
              <span class="seg-files" style={{ width: `${filePct}%` }} title={`7天附件 ${formatBytes(overview.files.bytes)}`} />
              <span class="seg-stickers" style={{ width: `${stickerPct}%` }} title={`永久表情包 ${formatBytes(overview.stickers.bytes)}`} />
              <span class="seg-avatars" style={{ width: `${avatarPct}%` }} title={`永久头像 ${formatBytes(overview.avatars.bytes)}`} />
            </div>

            <div class="adm-legend-grid">
              <div class="adm-legend-item">
                <i class="dot-files" />
                <div>
                  <strong>7 天临时附件</strong>
                  <small>{overview.files.total} 个 · {formatBytes(overview.files.bytes)}</small>
                </div>
              </div>
              <div class="adm-legend-item">
                <i class="dot-stickers" />
                <div>
                  <strong>长期表情包</strong>
                  <small>{overview.stickers.total} 个 · {formatBytes(overview.stickers.bytes)}</small>
                </div>
              </div>
              <div class="adm-legend-item">
                <i class="dot-avatars" />
                <div>
                  <strong>长期头像</strong>
                  <small>{overview.avatars.total} 个 · {formatBytes(overview.avatars.bytes)}</small>
                </div>
              </div>
            </div>

            <div class="adm-health-strip">
              <div class={`adm-pill${pendingTotal > 0 ? ' is-warn' : ' is-ok'}`}>
                {pendingTotal > 0 ? `待清理 ${pendingTotal} 项` : '过期队列干净'}
              </div>
              <div class="adm-pill">流式进行中 {overview.messages.streaming}</div>
              <div class="adm-pill">待处理审批 {overview.messages.pendingInteractions}</div>
              <div class="adm-pill">待回收对象 {overview.gcQueue.pending + overview.gcQueue.orphanMedia}</div>
            </div>
          </section>
        </div>

        {/* Bottom 2-column grid: Runtime Policy + Recent Audit */}
        <div class="adm-two-col">
          <section class="adm-card">
            <div class="adm-card-head">
              <h2>运行环境与安全策略</h2>
              <span class="adm-badge is-accent">
                {overview.runtime === 'cloudflare' ? 'Cloudflare Workers + DO' : overview.runtime === 'node' ? 'Node.js Relay' : 'Self-Hosted'}
              </span>
            </div>
            <dl class="adm-kv-list">
              <div>
                <dt>身份主域</dt>
                <dd>{overview.authority}</dd>
              </div>
              <div>
                <dt>开放注册</dt>
                <dd>
                  <span class={`adm-badge${overview.policy?.registrationEnabled ? ' is-ok' : ''}`}>
                    {overview.policy?.registrationEnabled
                      ? overview.policy.registrationRequiresCode
                        ? '需注册码'
                        : '已开放'
                      : '已关闭'}
                  </span>
                </dd>
              </div>
              <div>
                <dt>仅可信设备登录</dt>
                <dd>
                  <span class={`adm-badge${overview.policy?.deviceLoginOnly ? ' is-accent' : ''}`}>
                    {overview.policy?.deviceLoginOnly ? '已启用（无密码）' : '允许密码 + 2FA'}
                  </span>
                </dd>
              </div>
              <div>
                <dt>个人互加联系人</dt>
                <dd>{overview.policy?.humanContacts ? '已开启' : '仅个人与 Agent'}</dd>
              </div>
              <div>
                <dt>数据加密边界</dt>
                <dd>全链路 E2EE · 管理台零明文权限</dd>
              </div>
              <div>
                <dt>统计快照时间</dt>
                <dd>{formatDateTime(overview.generatedAt)}</dd>
              </div>
            </dl>
          </section>

          <section class="adm-card">
            <div class="adm-card-head">
              <h2>最近运维审计</h2>
              <button type="button" class="adm-link-btn" onClick={() => onNavigate('audit')}>
                查看全部 →
              </button>
            </div>
            {auditLogs.length === 0 ? (
              <p class="adm-empty">暂无管理员操作记录。</p>
            ) : (
              <ul class="adm-audit-mini">
                {auditLogs.slice(0, 6).map((item) => (
                  <li key={item.id}>
                    <span class="adm-badge">{auditActionLabel(item.action)}</span>
                    <span class="adm-audit-text">{item.detail}</span>
                    <time title={formatDateTime(item.createdAt)}>{formatRelative(item.createdAt)}</time>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    );
  };
});
