import { passwordKeys, recoveryKeys } from '../shared/account-crypto';
import type {
  AdminAuditEntry,
  AdminCleanupResult,
  AdminConversationSummary,
  AdminDesktopEntry,
  AdminOverview,
  AdminSessionEntry,
  AdminStorageDetail,
  AdminUserDetail,
  AdminUserSummary,
  ChatUser,
} from '../shared/messaging';

export interface SiteStatus {
  registrationEnabled: boolean;
  registrationRequiresCode: boolean;
  deviceLoginOnly?: boolean;
}

export interface AdminAuthChallenge {
  id: string;
  secret: string;
  code: string;
  expiresAt: number;
  primaryOrigin: string;
  approveUrl: string;
}

export class AdminApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/im${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {}
  if (!response.ok) {
    throw new AdminApiError(
      response.status,
      typeof parsed?.error === 'string' ? parsed.error : `请求失败 (${response.status})`,
    );
  }
  return parsed as T;
}

export const adminApi = {
  status: (signal?: AbortSignal) => request<SiteStatus>('/status', 'GET', undefined, signal),
  me: (signal?: AbortSignal) => request<{ user: ChatUser | null }>('/me', 'GET', undefined, signal),
  logout: () => request<{ ok: boolean }>('/logout', 'POST', {}),

  // Zero-knowledge admin handoff login (no E2EE keys ever touch the admin origin)
  startAdminAuth: () => request<AdminAuthChallenge>('/admin/auth/start', 'POST', {}),
  pollAdminAuth: (id: string, secret: string) =>
    request<{ pending: boolean; user?: ChatUser }>('/admin/auth/poll', 'POST', { id, secret }),

  // Fallback recovery-code or password login (vault is discarded immediately after cookie sign-in)
  async loginWithSecret(identifier: string, secret: string, recovery: boolean): Promise<{ user: ChatUser }> {
    let auth: string;
    if (recovery) {
      auth = (await recoveryKeys(secret)).auth;
    } else {
      const { salt } = await request<{ salt: string }>('/crypto/parameters', 'POST', { identifier });
      auth = (await passwordKeys(secret, salt)).auth;
    }
    const result = await request<{ user?: ChatUser; trustedLogin?: unknown }>('/crypto/login', 'POST', {
      identifier,
      auth,
      recovery,
    });
    if (!result.user) {
      throw new AdminApiError(409, '该账号已开启可信设备验证，请使用「主站一键授权」或恢复码登录。');
    }
    return { user: result.user };
  },

  overview: (signal?: AbortSignal) => request<AdminOverview>('/admin/overview', 'GET', undefined, signal),
  users: (params: { q?: string; kind?: string; sort?: string; limit?: number } = {}, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    if (params.q?.trim()) qs.set('q', params.q.trim());
    if (params.kind && params.kind !== 'all') qs.set('kind', params.kind);
    if (params.sort) qs.set('sort', params.sort);
    if (params.limit) qs.set('limit', String(params.limit));
    return request<{ users: AdminUserSummary[] }>(`/admin/users?${qs}`, 'GET', undefined, signal);
  },
  userDetail: (userId: string, signal?: AbortSignal) =>
    request<AdminUserDetail>(`/admin/users/${encodeURIComponent(userId)}`, 'GET', undefined, signal),
  revokeUserSessions: (userId: string) =>
    request<{ revoked: number }>(`/admin/users/${encodeURIComponent(userId)}/revoke-sessions`, 'POST', {}),
  deleteUser: (userId: string) =>
    request<{ ok: boolean }>(`/admin/users/${encodeURIComponent(userId)}`, 'DELETE'),
  sessions: (q = '', limit = 150, signal?: AbortSignal) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (q.trim()) qs.set('q', q.trim());
    return request<{ sessions: AdminSessionEntry[] }>(`/admin/sessions?${qs}`, 'GET', undefined, signal);
  },
  revokeSession: (deviceId: string) =>
    request<{ ok: boolean; userId: string }>(`/admin/sessions/${encodeURIComponent(deviceId)}`, 'DELETE'),
  desktops: (signal?: AbortSignal) =>
    request<{ desktops: AdminDesktopEntry[] }>('/admin/desktops', 'GET', undefined, signal),
  revokeDesktop: (hostId: string) =>
    request<{ ok: boolean }>(`/admin/desktops/${encodeURIComponent(hostId)}`, 'DELETE'),
  conversations: (limit = 150, signal?: AbortSignal) =>
    request<{ conversations: AdminConversationSummary[] }>(
      `/admin/conversations?limit=${limit}`,
      'GET',
      undefined,
      signal,
    ),
  storage: (signal?: AbortSignal) => request<AdminStorageDetail>('/admin/storage', 'GET', undefined, signal),
  cleanup: () => request<AdminCleanupResult>('/admin/cleanup', 'POST', {}),
  audit: (limit = 120, signal?: AbortSignal) =>
    request<{ logs: AdminAuditEntry[] }>(`/admin/audit?limit=${limit}`, 'GET', undefined, signal),
};
