export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatRelative(ms: number | null | undefined): string {
  if (!ms) return '从未';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDateTime(ms).slice(0, 10);
}

export function formatDayShort(day: string): string {
  const parts = day.split('-');
  if (parts.length === 3) return `${Number(parts[1])}/${Number(parts[2])}`;
  return day;
}

export function isPersistentSession(expiresAt: number): boolean {
  return expiresAt >= 4_000_000_000_000;
}

export function auditActionLabel(action: string): string {
  const map: Record<string, string> = {
    admin_login: '管理台登录',
    admin_auth_approve: '批准登录授权',
    cleanup: '过期清理与 GC',
    revoke_user_sessions: '强制账号下线',
    revoke_session: '踢出单条会话',
    revoke_desktop: '吊销桌面节点',
  };
  return map[action] ?? action;
}
