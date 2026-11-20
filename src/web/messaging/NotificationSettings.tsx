import { onMounted, shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import type { NotificationConfig } from '../../shared/notifications';
import {
  androidNotifications,
  disableNotifications,
  enableNotifications,
  notificationSettings,
} from '../notifications';
import { Notice, errorText } from './ui';

export const NotificationSettings = tsxComponent(function NotificationSettings() {
  const settings = shallowRef<NotificationConfig>();
  const busy = shallowRef(false);
  const error = shallowRef('');
  async function read() {
    try {
      settings.value = await notificationSettings();
    } catch (cause) {
      error.value = errorText(cause);
    }
  }
  onMounted(() => void read());
  return () => {
    const status = settings.value;
    const supported = androidNotifications ? status?.android : !!status?.webKey;
    return (
      <section class="settings-section" aria-label="通知设置">
        <p class="im-help">接收助手消息和语音、视频来电提醒。锁屏只显示提醒类型。</p>
        {status && supported && (
          <button
            class="secondary"
            disabled={busy.value}
            onClick={async () => {
              busy.value = true;
              error.value = '';
              try {
                if (status.registered) await disableNotifications();
                else await enableNotifications(status);
              } catch (cause) {
                error.value = errorText(cause);
              } finally {
                busy.value = false;
              }
              await read();
            }}
          >
            {busy.value ? '正在处理…' : status.registered ? '关闭本机通知' : '开启本机通知'}
          </button>
        )}
        {status && !supported && <p class="im-help">当前站点暂未配置此设备的后台推送。</p>}
        <Notice text={error.value} />
      </section>
    );
  };
});
