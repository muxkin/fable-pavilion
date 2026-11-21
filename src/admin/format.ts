import { bcp47Locale, t } from '../shared/i18n';

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(bcp47Locale()).format(n);
}

export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatRelative(ms: number | null | undefined): string {
  if (!ms) return t('从未', 'Never');
  const diff = Date.now() - ms;
  if (diff < 60_000) return t('刚刚', 'Just now');
  if (diff < 3_600_000) {
    const mins = Math.floor(diff / 60_000);
    return t(`${mins} 分钟前`, `${mins}m ago`);
  }
  if (diff < 86_400_000) {
    const hrs = Math.floor(diff / 3_600_000);
    return t(`${hrs} 小时前`, `${hrs}h ago`);
  }
  if (diff < 30 * 86_400_000) {
    const days = Math.floor(diff / 86_400_000);
    return t(`${days} 天前`, `${days}d ago`);
  }
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
  const map: Record<string, [string, string]> = {
    admin_login: ['管理台登录', 'Admin Sign-In'],
    admin_auth_approve: ['批准登录授权', 'Approved Login Handoff'],
    cleanup: ['过期清理与 GC', 'Retention Cleanup & GC'],
    revoke_user_sessions: ['强制账号下线', 'Revoked User Sessions'],
    revoke_session: ['踢出单条会话', 'Revoked Session'],
    revoke_desktop: ['吊销桌面节点', 'Revoked Desktop Host'],
    delete_user: ['删除账号', 'Deleted Account'],
    migrate_uid: ['迁移账号 UID', 'Migrated Account UID'],
  };
  const pair = map[action];
  return pair ? t(pair[0], pair[1]) : action;
}
