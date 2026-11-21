import { onMounted, shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import { messaging, useMessaging } from './context';
import { Dialog, Notice, errorText } from './ui';

interface AuthInfo {
  id: string;
  code: string;
  origin: string;
  deviceName: string;
  approved: boolean;
  expiresAt: number;
}

function readAdminAuthParams(): { id: string; code: string } | null {
  try {
    const url = new URL(location.href);
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

function clearAdminAuthParams() {
  try {
    const url = new URL(location.href);
    url.searchParams.delete('admin-auth');
    url.searchParams.delete('code');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  } catch {}
}

export const AdminAuthApproval = tsxComponent(function AdminAuthApproval() {
  const params = shallowRef<{ id: string; code: string } | null>(readAdminAuthParams());
  const info = shallowRef<AuthInfo | null>(null);
  const busy = shallowRef(false);
  const done = shallowRef(false);
  const error = shallowRef('');

  async function inspect() {
    const current = params.value;
    if (!current) return;
    error.value = '';
    try {
      info.value = await messaging.request<AuthInfo>(`/admin/auth/${current.id}`, 'GET');
    } catch (cause) {
      error.value = errorText(cause);
    }
  }

  async function approve() {
    const current = params.value;
    if (!current || busy.value) return;
    busy.value = true;
    error.value = '';
    try {
      await messaging.request('/admin/auth/approve', 'POST', current);
      done.value = true;
      clearAdminAuthParams();
    } catch (cause) {
      error.value = errorText(cause);
    } finally {
      busy.value = false;
    }
  }

  function close() {
    params.value = null;
    info.value = null;
    clearAdminAuthParams();
  }

  onMounted(() => {
    if (params.value) void inspect();
  });

  return () => {
    const { user } = useMessaging();
    if (!params.value || !user?.isAdmin) return null;
    const item = info.value;
    return (
      <Dialog title="管理后台登录授权" onClose={close}>
        {() => (
          <div style={{ display: 'grid', gap: '12px' }}>
            <Notice text={error.value} />
            {done.value ? (
              <>
                <p style={{ margin: 0, lineHeight: 1.6 }}>
                  已批准管理后台登录，请切回管理后台页面继续操作（可直接关闭此窗口）。
                </p>
                <button type="button" onClick={close}>
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
                    核对码：<strong style={{ fontSize: '18px', letterSpacing: '0.12em' }}>{params.value!.code}</strong>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                  <button type="button" class="secondary" disabled={busy.value} onClick={close}>
                    拒绝
                  </button>
                  <button
                    type="button"
                    disabled={busy.value || !item || item.approved || item.code !== params.value!.code}
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
