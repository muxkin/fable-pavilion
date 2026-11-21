import { onMounted, onScopeDispose, shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import { Icon } from '../Icon';
import type { IconName } from '../icon-paths';
import { messaging } from './context';
import { Confirm, Notice, errorText } from './ui';

type Device = {
  id: string;
  name: string;
  customName?: string | null;
  platform?: string | null;
  os?: string | null;
  browser?: string | null;
  ip?: string | null;
  location?: string | null;
  origin?: string | null;
  createdAt?: number | null;
  lastActiveAt: number | null;
  verifiedAt?: number | null;
  expiresAt?: number | null;
  current: boolean;
};

function deviceIcon(device: Device): IconName {
  const text = `${device.os ?? ''} ${device.name} ${device.platform ?? ''}`.toLowerCase();
  if (device.platform === 'app' || device.platform === 'mobile' || /android|iphone|鸿蒙/.test(text)) {
    return 'phone';
  }
  if (/windows/.test(text)) return 'windows';
  if (/mac|ipad|ios/.test(text)) return 'apple';
  if (/linux/.test(text)) return 'linux';
  if (device.platform === 'desktop') return 'monitor';
  return 'globe';
}

function formatDateTime(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const hhmm = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (date.toDateString() === now.toDateString()) return `今天 ${hhmm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${hhmm}`;
}

function formatDateOnly(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function formatExpiry(ms: number): string {
  if (ms >= 4_000_000_000_000) return '长期有效';
  return `有效期至 ${formatDateOnly(ms)}`;
}

function recentlyActive(device: Device): boolean {
  return !!device.lastActiveAt && Date.now() - device.lastActiveAt <= 10 * 60_000;
}

export const LoginDevices = tsxComponent(function LoginDevices() {
  const devices = shallowRef<Device[]>();
  const target = shallowRef<Device | 'others'>();
  const editingId = shallowRef<string | null>(null);
  const editValue = shallowRef('');
  const savingId = shallowRef<string | null>(null);
  const loading = shallowRef(false);
  const error = shallowRef('');
  const controller = new AbortController();
  onScopeDispose(() => controller.abort());

  async function reload() {
    loading.value = true;
    error.value = '';
    try {
      const result = await messaging.request<{ devices: Device[] }>(
        '/login-devices',
        'GET',
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted) devices.value = result.devices;
    } catch (cause) {
      if (!controller.signal.aborted) error.value = errorText(cause);
    } finally {
      if (!controller.signal.aborted) loading.value = false;
    }
  }

  async function saveName(device: Device) {
    if (savingId.value) return;
    savingId.value = device.id;
    error.value = '';
    try {
      await messaging.request(`/login-devices/${device.id}`, 'PATCH', { name: editValue.value.trim() });
      editingId.value = null;
      await reload();
    } catch (cause) {
      error.value = errorText(cause);
    } finally {
      savingId.value = null;
    }
  }

  onMounted(() => void reload());
  return () => {
    const list = devices.value ?? [];
    const othersCount = list.filter((d) => !d.current).length;
    return (
      <section class="login-devices-section" aria-label="登录设备">
        <Notice text={error.value} />
        {!devices.value && error.value && (
          <button class="secondary" onClick={() => void reload()}>
            重试
          </button>
        )}
        {!!list.length && (
          <div class="login-devices-toolbar">
            <span class="login-devices-count">
              共 {list.length} 台活跃设备{othersCount > 0 ? `（含 ${othersCount} 台其他设备）` : ''}
            </span>
            <div class="login-devices-toolbar-actions">
              <button
                type="button"
                class="secondary"
                disabled={loading.value}
                onClick={() => void reload()}
              >
                <Icon name="refresh" size={15} />
                刷新
              </button>
              {othersCount > 0 && (
                <button type="button" class="secondary" onClick={() => (target.value = 'others')}>
                  退出其他设备
                </button>
              )}
            </div>
          </div>
        )}
        {!!list.length && (
          <ul class="login-device-list">
            {list.map((device) => {
              const title = device.customName || device.name;
              const clientSpec = [device.os, device.browser].filter(Boolean).join(' · ');
              const networkParts = [device.ip, device.location, device.origin].filter(Boolean);
              const isEditing = editingId.value === device.id;
              const isRecent = !device.current && recentlyActive(device);
              return (
                <li
                  key={device.id}
                  class={`login-device-card${device.current ? ' is-current' : ''}`}
                >
                  <span class="login-device-icon" aria-hidden="true">
                    <Icon name={deviceIcon(device)} size={20} />
                  </span>
                  <div class="login-device-body">
                    {isEditing ? (
                      <form
                        class="login-device-rename"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void saveName(device);
                        }}
                      >
                        <input
                          type="text"
                          maxlength={60}
                          placeholder={device.name}
                          aria-label="设备备注名称"
                          value={editValue.value}
                          onInput={(e) => (editValue.value = (e.currentTarget as HTMLInputElement).value)}
                        />
                        <button type="submit" disabled={savingId.value === device.id}>
                          保存
                        </button>
                        <button
                          type="button"
                          class="secondary"
                          disabled={savingId.value === device.id}
                          onClick={() => (editingId.value = null)}
                        >
                          取消
                        </button>
                      </form>
                    ) : (
                      <div class="login-device-heading">
                        <strong>{title}</strong>
                        {device.current && <span class="login-device-badge current">当前设备</span>}
                        {isRecent && <span class="login-device-badge active">刚刚活跃</span>}
                        {device.verifiedAt && <span class="login-device-badge verified">安全已验</span>}
                      </div>
                    )}
                    <div class="login-device-meta">
                      <span>
                        {clientSpec || device.name}
                        {' · '}会话 #{device.id.slice(0, 6)}
                      </span>
                      {networkParts.length > 0 && (
                        <span>
                          <Icon name="globe" size={13} />
                          {networkParts.join(' · ')}
                        </span>
                      )}
                      <span>
                        <Icon name="clock" size={13} />
                        {device.lastActiveAt
                          ? `最近活跃 ${formatDateTime(device.lastActiveAt)}`
                          : '较早登录'}
                        {device.createdAt ? ` · 登录于 ${formatDateTime(device.createdAt)}` : ''}
                        {device.expiresAt ? ` · ${formatExpiry(device.expiresAt)}` : ''}
                      </span>
                    </div>
                  </div>
                  {!isEditing && (
                    <div class="login-device-actions">
                      <button
                        type="button"
                        class="secondary"
                        onClick={() => {
                          editingId.value = device.id;
                          editValue.value = device.customName ?? '';
                        }}
                      >
                        备注
                      </button>
                      {!device.current && (
                        <button type="button" class="secondary" onClick={() => (target.value = device)}>
                          退出
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {target.value && (
          <Confirm
            title={target.value === 'others' ? '退出其他设备' : '退出此设备'}
            onCancel={() => (target.value = undefined)}
            onConfirm={async () => {
              const device = target.value;
              if (!device) return;
              if (device === 'others') await messaging.request('/logout-others', 'POST');
              else await messaging.request(`/login-devices/${device.id}`, 'DELETE');
              await reload();
            }}
          >
            {() =>
              target.value === 'others'
                ? '其他设备需要重新登录。'
                : `${target.value?.customName || target.value?.name || ''} 下次使用时需要重新登录。`
            }
          </Confirm>
        )}
      </section>
    );
  };
});
