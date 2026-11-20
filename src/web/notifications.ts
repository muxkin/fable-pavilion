import { messaging } from './messaging/context';
import { notificationId, type NotificationConfig } from '../shared/notifications';

const storageKey = 'fable-notifications-v1';
const registrationChanged = 'fable-notifications-changed';
export const androidNotifications = /\bFablePavilionAndroid\//.test(navigator.userAgent);
interface Binding {
  id: string;
  account: string;
  kind: 'android' | 'web';
}
type AndroidRegistration = { id: string; endpoint?: string; key?: string; error?: string };
type AndroidAction = { id: string; action: 'answer' | 'decline' };
type NativeWindow = Window & {
  fableNotificationConnect?: (id: string) => void;
  fableNotificationDisconnect?: (id: string) => void;
  fableNotificationRegistration?: AndroidRegistration;
  fableNotificationAction?: AndroidAction;
};
const native = window as NativeWindow;

function savedBinding(): Binding | undefined {
  try {
    const current = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Binding | null;
    if (current && notificationId.test(current.id)) return current;
  } catch {}
}
function save(binding?: Binding) {
  if (binding) localStorage.setItem(storageKey, JSON.stringify(binding));
  else localStorage.removeItem(storageKey);
  window.dispatchEvent(new Event(registrationChanged));
}
async function registerWebWorker(id?: string) {
  if (!navigator.serviceWorker) return;
  const registration = await navigator.serviceWorker.ready;
  registration.active?.postMessage({ type: 'fable-push-binding', id: id ?? null });
}
export function notificationSettings() {
  const saved = savedBinding();
  return messaging.request<NotificationConfig>('/notifications' + (saved ? '?id=' + saved.id : ''));
}
function waitForNative(id: string) {
  return new Promise<{ endpoint: string; key: string }>((resolve, reject) => {
    function settled() {
      const registration = native.fableNotificationRegistration;
      if (!registration || registration.id !== id) return;
      stop();
      if (registration.endpoint && registration.key)
        resolve({ endpoint: registration.endpoint, key: registration.key });
      else reject(Error(registration.error || 'Android 推送暂不可用'));
    }
    function stop() {
      clearTimeout(timer);
      window.removeEventListener('fable-android-notification-registration', settled);
    }
    const timer = window.setTimeout(() => {
      stop();
      reject(Error('推送服务未响应，请稍后重试'));
    }, 25_000);
    window.addEventListener('fable-android-notification-registration', settled);
    native.fableNotificationConnect!(id);
  });
}
function vapidKey(value: string) {
  const encoded = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(encoded), (letter) => letter.charCodeAt(0));
}
export async function enableNotifications(settings: NotificationConfig) {
  const existing = savedBinding();
  if (existing && existing.account !== settings.account) await disableNotifications(false);
  const id = existing && existing.account === settings.account ? existing.id : crypto.randomUUID();
  const kind = androidNotifications ? 'android' : 'web';
  const route = '/notifications/' + id;
  if (androidNotifications) {
    if (!settings.android || !native.fableNotificationConnect)
      throw Error('此站点或安装包暂不支持 Android 推送');
    try {
      const registration = await waitForNative(id);
      await messaging.request(route, 'PUT', { kind, ...registration });
    } catch (error) {
      native.fableNotificationDisconnect?.(id);
      throw error;
    }
  } else {
    if (
      !settings.webKey ||
      !('Notification' in window) ||
      !('PushManager' in window) ||
      !navigator.serviceWorker
    )
      throw Error('请使用支持网页推送的浏览器');
    if ((await Notification.requestPermission()) !== 'granted') throw Error('请先允许此站点发送通知');
    const worker = await navigator.serviceWorker.ready;
    const subscription =
      (await worker.pushManager.getSubscription()) ??
      (await worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey(settings.webKey),
      }));
    const fields = subscription.toJSON();
    await messaging.request(route, 'PUT', {
      kind,
      endpoint: fields.endpoint,
      expirationTime: fields.expirationTime,
      keys: fields.keys,
    });
    await registerWebWorker(id);
  }
  save({ id, account: settings.account, kind });
}
export async function disableNotifications(revoke = true) {
  const binding = savedBinding();
  if (!binding) return;
  save();
  if (binding.kind === 'android') native.fableNotificationDisconnect?.(binding.id);
  else if (navigator.serviceWorker) {
    await registerWebWorker();
    const worker = await navigator.serviceWorker.ready;
    await (await worker.pushManager.getSubscription())?.unsubscribe();
  }
  if (revoke) await messaging.request('/notifications/' + binding.id, 'DELETE');
}
export function watchNotificationFocus(account: string | undefined, conversation: string | undefined) {
  let last: string | null | undefined;
  const refresh = (force = false) => {
    const binding = savedBinding();
    if (!binding || binding.account !== account) return;
    const focus = document.visibilityState === 'visible' && conversation ? conversation : null;
    if (!force && (focus === null || last === focus)) return;
    last = focus;
    void fetch('/api/im/notifications/' + binding.id + '/focus', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ conversation: focus }),
      keepalive: !focus,
    }).catch(() => {});
  };
  const changed = () => refresh(true);
  const timer = window.setInterval(() => refresh(!!last), 15_000);
  document.addEventListener('visibilitychange', changed);
  window.addEventListener(registrationChanged, changed);
  refresh(true);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', changed);
    window.removeEventListener(registrationChanged, changed);
  };
}
export function clearStaleNotificationAccount(account?: string) {
  const binding = savedBinding();
  if (binding && binding.account !== account) void disableNotifications(false).catch(() => {});
}
export function readAndroidCallAction() {
  const action = native.fableNotificationAction;
  delete native.fableNotificationAction;
  return action &&
    notificationId.test(action.id) &&
    (action.action === 'answer' || action.action === 'decline')
    ? action
    : undefined;
}
export async function clearCallNotifications(active: string | undefined) {
  const worker = await navigator.serviceWorker?.getRegistration();
  if (!worker) return;
  for (const notification of await worker.getNotifications())
    if (notification.tag.startsWith('fable-call:') && notification.tag !== 'fable-call:' + active)
      notification.close();
}

export function watchAndroidRegistration(account?: string) {
  if (!androidNotifications || !account) return;
  let submitted: string | undefined;
  const refresh = () => {
    const current = savedBinding();
    const registration = native.fableNotificationRegistration;
    if (
      !current ||
      current.account !== account ||
      !registration?.endpoint ||
      !registration.key ||
      registration.id !== current.id
    )
      return;
    if (submitted === registration.endpoint) return;
    submitted = registration.endpoint;
    void messaging
      .request('/notifications/' + current.id, 'PUT', {
        kind: 'android',
        endpoint: registration.endpoint,
        key: registration.key,
      })
      .catch(() => {
        submitted = undefined;
      });
  };
  window.addEventListener('fable-android-notification-registration', refresh);
  refresh();
  return () => window.removeEventListener('fable-android-notification-registration', refresh);
}
