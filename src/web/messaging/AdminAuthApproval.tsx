import { onMounted, shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import { messaging, useMessaging } from './context';
import { Dialog, Notice, errorText } from './ui';

export interface AdminAuthParams {
  id: string;
  code: string;
}

interface AuthInfo {
  id: string;
  code: string;
  origin: string;
  deviceName: string;
  approved: boolean;
  expiresAt: number;
}

/** Parse an admin-auth handoff URL scanned from the standalone Admin Console QR code. */
export function parseAdminAuthUrl(text: string): AdminAuthParams | null {
  try {
    const url = new URL(text.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const id = url.searchParams.get('admin-auth') ?? '';
    const code = url.searchParams.get('code') ?? '';
    if (
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) &&
      /^\d{6}$/.test(code)
    ) {
      return { id, code };
    }
  } catch {}
  return null;
}

/** Capture ?admin-auth=...&code=... synchronously at boot before router history replaces the URL. */
export function takeAdminAuthParams(): AdminAuthParams | null {
  try {
    const parsed = parseAdminAuthUrl(location.href);
    if (parsed) {
      const url = new URL(location.href);
      url.searchParams.delete('admin-auth');
      url.searchParams.delete('code');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
      return parsed;
    }
  } catch {}
  return null;
}

export const AdminAuthApproval = tsxComponent(function AdminAuthApproval(props: {
  request: AdminAuthParams;
  onClose: () => void;
}) {
  const info = shallowRef<AuthInfo | null>(null);
  const busy = shallowRef(false);
  const done = shallowRef(false);
  const error = shallowRef('');

  async function inspect(request: AdminAuthParams) {
    error.value = '';
    try {
      info.value = await messaging.request<AuthInfo>(`/admin/auth/${request.id}`, 'GET');
    } catch (cause) {
      error.value = errorText(cause);
    }
  }

  onMounted(() => {
    const { user } = useMessaging();
    if (user?.isAdmin) void inspect(props.request);
  });

  return ({ request, onClose }) => {
    const { user } = useMessaging();
    if (!user) return null;

    async function approve() {
      if (busy.value) return;
      busy.value = true;
      error.value = '';
      try {
        await messaging.request('/admin/auth/approve', 'POST', request);
        done.value = true;
      } catch (cause) {
        error.value = errorText(cause);
      } finally {
        busy.value = false;
      }
    }

    if (!user.isAdmin) {
      return (
        <Dialog title="无法批准管理后台登录" onClose={onClose}>
          {() => (
            <div style={{ display: 'grid', gap: '12px' }}>
              <p style={{ margin: 0, lineHeight: 1.6 }}>
                当前登录账号 <strong>{user.displayName}</strong>（@{user.username} · UID{' '}
                <strong>{user.id}</strong>）未列入本站管理员白名单（<code>POCKET_ADMIN_UIDS</code>），无法批准管理后台授权。
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button type="button" onClick={onClose}>
                  知道了
                </button>
              </div>
            </div>
          )}
        </Dialog>
      );
    }

    const item = info.value;
    return (
      <Dialog title="管理后台登录授权" onClose={onClose}>
        {() => (
          <div style={{ display: 'grid', gap: '12px' }}>
            <Notice text={error.value} />
            {done.value ? (
              <>
                <p style={{ margin: 0, lineHeight: 1.6 }}>
                  已批准管理后台登录，请切回管理后台页面继续操作（可直接关闭此窗口）。
                </p>
                <button type="button" onClick={onClose}>
                  完成
                </button>
              </>
            ) : (
              <>
                <p style={{ margin: 0, lineHeight: 1.6 }}>
                  独立管理后台正在请求签发管理员会话。此授权<strong>不会</strong>向管理后台传输任何端到端加密私钥。
                </p>
                <div
                  style={{
                    display: 'grid',
                    gap: '6px',
                    padding: '12px',
                    borderRadius: '10px',
                    background: 'var(--soft)',
                    fontSize: '13px',
                  }}
                >
                  <div>
                    来源站点：<strong>{item?.origin ?? '校验中…'}</strong>
                  </div>
                  <div>
                    请求设备：<strong>{item?.deviceName ?? '校验中…'}</strong>
                  </div>
                  <div>
                    核对码：
                    <strong style={{ fontSize: '18px', letterSpacing: '0.12em' }}>{request.code}</strong>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                  <button type="button" class="secondary" disabled={busy.value} onClick={onClose}>
                    拒绝
                  </button>
                  <button
                    type="button"
                    disabled={busy.value || !item || item.approved || item.code !== request.code}
                    onClick={() => void approve()}
                  >
                    {busy.value ? '授权中…' : '确认授权'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </Dialog>
    );
  };
});
