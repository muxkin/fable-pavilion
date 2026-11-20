import { onMounted, onScopeDispose, shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import { messaging } from './context';
import { Confirm, Notice, errorText, time } from './ui';

type Device = { id: string; name: string; current: boolean; lastActiveAt: number | null };

export const LoginDevices = tsxComponent(function LoginDevices() {
  const devices = shallowRef<Device[]>();
  const target = shallowRef<Device | 'others'>();
  const error = shallowRef('');
  const controller = new AbortController();
  onScopeDispose(() => controller.abort());

  async function reload() {
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
    }
  }

  onMounted(() => void reload());
  return () => (
    <section aria-label="登录设备">
      <Notice text={error.value} />
      {!devices.value && error.value && (
        <button class="secondary" onClick={() => void reload()}>
          重试
        </button>
      )}
      {!!devices.value?.length && (
        <ul class="im-trusted-list">
          {devices.value.map((device) => (
            <li key={device.id}>
              <div>
                <strong>{device.name}</strong>
                <small>
                  {device.current
                    ? '当前设备'
                    : device.lastActiveAt
                      ? `最近使用 ${time(device.lastActiveAt)}`
                      : '较早登录'}
                </small>
              </div>
              {!device.current && (
                <button class="secondary" onClick={() => (target.value = device)}>
                  退出
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {devices.value?.some((device) => !device.current) && (
        <button class="secondary" onClick={() => (target.value = 'others')}>
          退出其他设备
        </button>
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
              : `${target.value?.name ?? ''} 下次使用时需要重新登录。`
          }
        </Confirm>
      )}
    </section>
  );
});
